// odieDungeon
// Global tuning: multiplier applied to all damage dealt BY enemies (1.0 = unchanged, 0.5 = -50%)
const ENEMY_DAMAGE_MULTIPLIER = 0.75;
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const utils = require('./utils');
const { saveCharacter, loadCharacter } = require('./database.js');
const characters = require('./characters');
const WebRTCServer = require('./appWebRTC');
const { extractDelta, buildSnapshot } = require('./utilities/deltaTracker');
const { generateEnemies } = require('./enemies.js');
const skillEngine = require('./public/skills/skillEngine');
const { loadAbilities } = require('./loadAbilities');
const abilities = loadAbilities();
const weaponMelee = require('./public/gear/weaponMelee.json');
const weaponRanged = require('./public/gear/weaponRanged.json');
const weaponMagic = require('./public/gear/weaponMagic.json');
const weapons = [...weaponMelee, ...weaponRanged, ...weaponMagic];
const armorLight = require('./public/gear/armorLight.json');
const armorMedium = require('./public/gear/armorMedium.json');
const armorHeavy = require('./public/gear/armorHeavy.json');
const armors = [...armorLight, ...armorMedium, ...armorHeavy];
const headgearLight = require('./public/gear/headgearLight.json');
const headgearMedium = require('./public/gear/headgearMedium.json');
const headgearHeavy = require('./public/gear/headgearHeavy.json');
const headgear = [...headgearLight, ...headgearMedium, ...headgearHeavy];
const feetWearLight = require('./public/gear/feetWearLight.json');
const feetWearMedium = require('./public/gear/feetWearMedium.json');
const feetWearHeavy = require('./public/gear/feetWearHeavy.json');
const feetWear = [...feetWearLight, ...feetWearMedium, ...feetWearHeavy];
const itemGenerator = require('./public/gear/itemGenerator');

function assert(condition, message) {
    if (!condition) throw new Error(`[ASSERT] ${message}`);
}

// Load dungeons configuration
const dungeons = require('./public/dungeons.json');

// ═══════════════════════════════════════════════════════════════════
// UNIFIED BROADCAST SYSTEM
// A single consolidated delta emitter (emitPartyDeltas) drives periodic
// player + enemy updates. Full-state syncs (reconnect, embark, escape,
// death, level-up) use buildFullStatePacket. Gear/shop changes use
// broadcastCriticalGearUpdate (single WebRTC-first emit).
// ═══════════════════════════════════════════════════════════════════

// Socket.IO fallback batching: when WebRTC is unavailable (or disabled), the
// per-tick gameDelta + per-hit combatEvent would otherwise each be a separate
// TCP packet (~14-28 pkt/s in combat). Coalesce batchable event types into a
// single `batchUpdate` envelope flushed on a ~50ms window, mirroring the
// WebRTC path so the client handler is identical.
const BATCHABLE_TYPES = new Set([
    'gameDelta', 'combatEvent', 'eventLog', 'dungeonChange',
    'combatStart', 'combatEnd', 'nextFloor', 'autoEmbark'
]);
const SOCKET_BATCH_INTERVAL = 50;
const socketBatchQueues = new Map(); // partyId -> { messages: [{type,data}], timer }
const socketBatchTimers = new Set();

function flushSocketBatch(partyId) {
    const q = socketBatchQueues.get(partyId);
    socketBatchTimers.delete(q?.timer);
    socketBatchQueues.delete(partyId);
    if (!q || q.messages.length === 0) return;
    const envelope = { priority: 'default', messages: q.messages };
    utils.trackSocketIoSent('batchUpdate', envelope);
    io.to(partyId).emit('batchUpdate', envelope);
}

function enqueueSocketBatch(partyId, eventType, packet) {
    let q = socketBatchQueues.get(partyId);
    if (!q) {
        q = { messages: [], timer: null };
        socketBatchQueues.set(partyId, q);
    }
    q.messages.push({ type: eventType, data: packet });
    if (!q.timer) {
        q.timer = setTimeout(() => flushSocketBatch(partyId), SOCKET_BATCH_INTERVAL);
        socketBatchTimers.add(q.timer);
    }
}

function broadcastToParty(partyId, eventType, packet, options = {}) {
    const sent = broadcastToPartyWebRTC(partyId, eventType, packet, null, options);
    if (sent === 0) {
        // Full-state syncs and explicitly no-batch one-shots must arrive
        // immediately and reliably (not coalesced with other traffic).
        if (eventType === 'partyUpdate' || options.noBatch) {
            utils.trackSocketIoSent(eventType, packet);
            io.to(partyId).emit(eventType, packet);
        } else if (BATCHABLE_TYPES.has(eventType)) {
            enqueueSocketBatch(partyId, eventType, packet);
        } else {
            utils.trackSocketIoSent(eventType, packet);
            io.to(partyId).emit(eventType, packet);
        }
    }
    // WebRTC delivered the message; nothing to fall back to on Socket.IO.
}

// Full-state packet used for reconnect / lifecycle syncs. Iterates
// party.players entries directly (no O(n²) find) and uses the Map key as
// each player's canonical id.
function buildFullStatePacket(party, partyId) {
    const packet = { partyId, timestamp: Date.now() };
    packet.players = Array.from(party.players, ([socketId, p]) => ({ ...p, id: socketId }));
    packet.enemies = party.enemies || [];
    packet.floor = party.floor;
    packet.dungeon = party.dungeon || 'field';
    packet.dungeonFloors = party.dungeonFloors || {};
    packet.highestVisitedFloors = party.highestVisitedFloors || {};
    packet.completedDungeons = party.completedDungeons || {};
    packet.combatActive = party.combatActive || false;
    packet.combatTurn = party.combatTurn || 0;
    packet.autoEmbark = party.autoEmbark || false;
    packet.shopStock = party.shopStock || [];
    packet._fullState = true;
    return packet;
}

function broadcastFullState(partyId, party) {
    broadcastToParty(partyId, 'partyUpdate', buildFullStatePacket(party, partyId));
}

function broadcastCriticalUpdate(partyId, party, targetInfo = null) {
    const room = io.sockets.adapter.rooms.get(partyId);
    if (!room || room.size === 0) return;
    const now = Date.now();

    if (targetInfo) {
        const packet = { partyId, timestamp: now, delta: true, critical: true };
        if (targetInfo.actor) packet.actor = { id: targetInfo.actor.id, name: targetInfo.actor.name, hp: targetInfo.actor.hp, maxHp: targetInfo.actor.maxHp, ap: targetInfo.actor.ap, maxAp: targetInfo.actor.maxAp, actionBar: targetInfo.actor.actionBar, isDead: targetInfo.actor.hp <= 0 };
        if (targetInfo.target) packet.target = { id: targetInfo.target.id, name: targetInfo.target.name, isEnemy: targetInfo.target.isEnemy || false, hp: targetInfo.target.hp, maxHp: targetInfo.target.maxHp, ap: targetInfo.target.ap, maxAp: targetInfo.target.maxAp, isDead: targetInfo.target.hp <= 0 };
        if (targetInfo.hit !== undefined) packet.hit = targetInfo.hit;
        if (targetInfo.crit !== undefined) packet.crit = targetInfo.crit;
        if (targetInfo.damage !== undefined) packet.damage = targetInfo.damage;
        if (targetInfo.roll !== undefined) packet.roll = targetInfo.roll;
        if (targetInfo.leveledUp) packet.leveledUp = targetInfo.leveledUp;
        broadcastToParty(partyId, 'combatEvent', packet);
        return;
    }

    // No explicit target: force an immediate flush via the consolidated emitter
    // so HP/AP changes land right away (bypasses the 50ms coalescing gate).
    lastGameDelta.delete(partyId);
    emitPartyDeltas(partyId, party, now);
}

// Send shop stock + every player's inventory/equipment (+ recomputed stats) over the
// critical path (WebRTC-preferred, Socket.IO fallback). Single emit: broadcastToParty
// already falls back to Socket.IO when WebRTC delivers nothing (see broadcastToParty),
// so the previous second io.to(...) emit was redundant and bypassed WebRTC batching.
function broadcastCriticalGearUpdate(partyId, party) {
    const packet = { partyId, timestamp: Date.now(), gear: true };
    packet.shopStock = party.shopStock || [];
    packet.playerUpdates = {};
    for (const [socketId, player] of party.players) {
        packet.playerUpdates[socketId] = {
            id: socketId, name: player.name,
            hp: player.hp, maxHp: player.maxHp,
            ap: player.ap, maxAp: player.maxAp,
            mp: player.mp, maxMp: player.maxMp, isDead: player.hp <= 0,
            gold: player.gold,
            inventory: player.inventory, equipment: player.equipment
        };
    }
    // Send immediately (noBatch) and NOT through the coalescing batch pool:
    // `gameDelta` is in the WebRTC COALESCE_TYPES set, so a queued periodic
    // stats delta would shallow-merge into this packet via Object.assign and
    // overwrite playerUpdates, silently dropping the inventory/equipment/gold
    // payload and leaving the frames unrefreshed. Gear changes are structural
    // and low-frequency, so immediate delivery is correct and cheap.
    broadcastToParty(partyId, 'gameDelta', packet, { noBatch: true });
}

    // Rebuild a shop-stock-compatible item from a compact inventory entry so a
    // player-sold item can be listed in the store again. The result matches the
    // shape produced by generateScaledItem (full item with base* fields, price,
    // and a timestamp), which the client already renders via calculateItemStats.
    function makeShopItemFromInventory(inventoryItem) {
        if (!inventoryItem || !inventoryItem.id) return null;
        const resolved = itemGenerator.resolveItem(
            inventoryItem.slot,
            inventoryItem.id,
            inventoryItem.level,
            inventoryItem.rarity
        );
        if (!resolved || typeof resolved.baseValue !== 'number') return null;

        // List at full value (same formula as the dungeon restock), min 10g.
        resolved.price = Math.max(
            10,
            itemGenerator.calculateItemPrice(resolved.baseValue, resolved.level, resolved.rarity)
        );
        resolved.timestamp = Date.now();
        return resolved;
    }

    function handleGearPurchase(socket, gearType, partyId) {
        const party = parties.get(partyId);
        if (!party || party.combatActive || party.floor !== 0) {
            const errorMsg = !party ? 'Party not found!' : 'You can only buy gear in town!';
            socket.emit('eventLog', { message: errorMsg, type: 'error' });
            return;
        }
        const player = party.players.get(socket.id);
        if (!player) {
            return;
        }

        let item;
        let slot;
        let cost = 30;
        let itemIndex = -1; // For identifying items from shop stock

        if (gearType === 'randomGear') {
            const categoryPool = ['weapon', 'armor', 'headgear', 'shoes'];
            const category = categoryPool[Math.floor(Math.random() * categoryPool.length)];
            const level = Math.max(1, Math.min(99, (player.level || 1) + Math.floor(Math.random() * 5) - 2));
            const rarity = 1 + Math.floor(Math.random() * 6);
            item = itemGenerator.generateRandomItem(category, { level, rarity });
            slot = category === 'weapon' ? 'weapon' : category === 'armor' ? 'armour' : category === 'shoes' ? 'shoes' : 'helmet';
            const calculatedValue = itemGenerator.calculateItemPrice(item.baseValue, item.level, item.rarity);
            cost = Math.max(10, Number.isFinite(calculatedValue) ? calculatedValue : 10);
        } else if (gearType.startsWith('shop_')) {
            // Handle purchase from shop stock
            const index = parseInt(gearType.split('_')[1]);
            if (isNaN(index) || index < 0 || index >= party.shopStock.length) {
                socket.emit('eventLog', { message: 'Invalid item selection.', type: 'error' });
                return;
            }

            item = party.shopStock[index];
            cost = item.price || 40; // Use the item's price if available
            itemIndex = index;
        } else {
            const catalog = {
                armour: armors,
                weapon: weapons,
                weaponMelee: weaponMelee,
                weaponRanged: weaponRanged,
                weaponMagic: weaponMagic,
                helmet: headgear,
                shoes: feetWear
            };
            const itemPool = catalog[gearType] || [];
            item = itemPool[0];
            slot = gearType === 'weapon' || gearType === 'weaponMelee' || gearType === 'weaponRanged' || gearType === 'weaponMagic'
                ? 'weapon'
                : gearType === 'armour'
                    ? 'armour'
                    : gearType === 'helmet'
                        ? 'helmet'
                        : gearType === 'shoes'
                            ? 'shoes'
                            : null;
        }

        if (!item) {
            socket.emit('eventLog', { message: 'No gear available for that slot.', type: 'error' });
            return;
        }

        if (player.gold < cost) {
            socket.emit('eventLog', { message: `Not enough gold for ${gearType}!`, type: 'error' });
            return;
        }

        player.gold -= cost;
        player.equipment = player.equipment || {};
        player.inventory = Array.isArray(player.inventory) ? player.inventory : [];

        // If this is a shop stock item, remove it from the stock
        if (itemIndex !== -1) {
            party.shopStock.splice(itemIndex, 1);
        }

        const inventoryItem = utils.toInventoryItem(item, slot);
        player.inventory.push(inventoryItem);

        // Force a new array reference to ensure change detection by the delta system
        player.inventory = [...player.inventory];

        saveCharacter(player.name, player);

        const displayName = item.displayName || item.name || item.id || 'gear';
        const rarityText = item.rarity ? ` (${item.rarity}★)` : '';
        socket.emit('eventLog', { message: `Added ${displayName}${rarityText} to inventory.`, type: 'success' });

        assert(player.gold >= 0, 'gold negative after purchase');

            // Send gear/inventory on the critical path so the client refreshes panels immediately.
            broadcastCriticalGearUpdate(partyId, party);
    }

    function handleEquipItem(socket, data) {
        utils.trackSocketIoReceived('equipItem', data);
        const { partyId, slot, itemId } = data || {};
        const party = parties.get(partyId);
        if (!party) return;
        const player = party.players.get(socket.id);
        if (!player) return;

        player.inventory = Array.isArray(player.inventory) ? player.inventory : [];
        const inventoryItem = player.inventory.find(entry => entry && (entry.id === itemId || entry.baseItem === itemId || entry.name === itemId || entry.displayName === itemId));
        if (!inventoryItem) {
            socket.emit('eventLog', { message: 'You do not own that item.', type: 'error' });
            return;
        }

        const normalizedSlot = slot === 'headgear' ? 'helmet' : slot === 'armor' ? 'armour' : slot;
        player.equipment = player.equipment || {};

        // Get the currently equipped item in this slot (if any) to put back in inventory
        const currentlyEquippedItem = player.equipment[normalizedSlot];

        // Calculate the actual stats for the item when equipping using the imported function
        const calculatedItem = itemGenerator.calculateItemStats(inventoryItem);

        // Put the currently equipped item back into inventory if it exists
        if (currentlyEquippedItem) {
            const targetSlot = itemGenerator.normalizeCategory
                ? itemGenerator.normalizeCategory(normalizedSlot)
                : normalizedSlot;
            const restoredItem = utils.toInventoryItem(currentlyEquippedItem, targetSlot);
            if (restoredItem) {
                player.inventory.push(restoredItem);
            }
        }

        // Remove the new item from inventory
        player.inventory = player.inventory.filter(entry => entry !== inventoryItem);

        // Equip the new item
        player.equipment[normalizedSlot] = calculatedItem;

        characters.calcMiscStats(player);
        const oldMax = { ap: player.maxAp, hp: player.maxHp, mp: player.maxMp };
        player.maxAp = characters.calcMaxAp(player);
        player.ap = Math.min(player.maxAp, player.ap + (player.maxAp - oldMax.ap));
        player.maxHp = characters.calcMaxHp(player);
        player.hp = Math.min(player.maxHp, player.hp + (player.maxHp - oldMax.hp));
        player.maxMp = characters.calcMaxMp(player);
        player.mp = Math.min(player.maxMp, player.mp + (player.maxMp - oldMax.mp));
        console.log('[equipItem]', {
            slot: normalizedSlot,
            oldItem: currentlyEquippedItem ? (currentlyEquippedItem.displayName || currentlyEquippedItem.name || currentlyEquippedItem.id) : null,
            newItem: calculatedItem.displayName || calculatedItem.name || calculatedItem.id,
            oldMaxHp: oldMax.hp,
            newMaxHp: player.maxHp,
            oldMaxMp: oldMax.mp,
            newMaxMp: player.maxMp,
        });
        saveCharacter(player.name, player);
        // Send gear/inventory on the critical path so the client refreshes panels immediately.
        broadcastCriticalGearUpdate(partyId, party);
        socket.emit('eventLog', { message: `Equipped ${calculatedItem.displayName || calculatedItem.name || calculatedItem.id}.`, type: 'success' });
    }

    function handleSellItem(socket, data) {
        utils.trackSocketIoReceived('sellItem', data);
        const { partyId, itemId } = data || {};
        const party = parties.get(partyId);
        if (!party) return;
        const player = party.players.get(socket.id);
        if (!player) return;

        player.inventory = Array.isArray(player.inventory) ? player.inventory : [];
        const inventoryItem = player.inventory.find(entry =>
            entry && (entry.id === itemId || entry.baseItem === itemId || entry.name === itemId || entry.displayName === itemId)
        );

        if (!inventoryItem) {
            socket.emit('eventLog', { message: 'You do not own that item.', type: 'error' });
            return;
        }

        // Resolve item to get baseValue for pricing
        const resolvedItem = itemGenerator.resolveItem(
            inventoryItem.slot, inventoryItem.id, inventoryItem.level, inventoryItem.rarity
        );
        if (!resolvedItem || typeof resolvedItem.baseValue !== 'number') {
            socket.emit('eventLog', { message: 'Cannot determine value for this item.', type: 'error' });
            return;
        }

        const calculatedValue = itemGenerator.calculateItemPrice(resolvedItem.baseValue, resolvedItem.level, resolvedItem.rarity);
        const sellPrice = Math.max(1, Math.floor(calculatedValue * 0.75));

        // Remove from inventory
        player.inventory = player.inventory.filter(entry => entry !== inventoryItem);

        // Add the sold item back to the store so other players (or the same
        // player) can buy it again. It gets a fresh timestamp and a full-value
        // price, then is capped/sorted like the restock path.
        party.shopStock = Array.isArray(party.shopStock) ? party.shopStock : [];
        const returnedShopItem = makeShopItemFromInventory(inventoryItem);
        if (returnedShopItem) {
            party.shopStock.push(returnedShopItem);
            characters.sortAndCapShopStock(party);
        }

        // Add gold
        player.gold += sellPrice;

        saveCharacter(player.name, player);
        broadcastCriticalGearUpdate(partyId, party);

        const name = resolvedItem.displayName || resolvedItem.name || inventoryItem.id;
        socket.emit('eventLog', { message: `Sold ${name} for ${sellPrice}g.`, type: 'success' });
    }

    function handleUnequipItem(socket, data) {
        utils.trackSocketIoReceived('unequipItem', data);
        const { partyId, slot } = data || {};
        const party = parties.get(partyId);
        if (!party) return;
        const player = party.players.get(socket.id);
        if (!player) return;

        const normalizedSlot = slot === 'headgear' ? 'helmet' : slot === 'armor' ? 'armour' : slot;
        player.equipment = player.equipment || {};
        const unequippedItem = player.equipment[normalizedSlot];

        if (unequippedItem) {
            const inventoryItem = utils.toInventoryItem(unequippedItem, normalizedSlot);
            if (inventoryItem) {
                player.inventory = Array.isArray(player.inventory) ? player.inventory : [];
                player.inventory.push(inventoryItem);
                player.inventory = [...player.inventory];
            }
        }

        delete player.equipment[normalizedSlot];

        characters.calcMiscStats(player);
        const oldMax = { ap: player.maxAp, hp: player.maxHp, mp: player.maxMp };
        player.maxAp = characters.calcMaxAp(player);
        player.ap = Math.min(player.maxAp, player.ap + (player.maxAp - oldMax.ap));
        player.maxHp = characters.calcMaxHp(player);
        player.hp = Math.min(player.maxHp, player.hp + (player.maxHp - oldMax.hp));
        player.maxMp = characters.calcMaxMp(player);
        player.mp = Math.min(player.maxMp, player.mp + (player.maxMp - oldMax.mp));
        saveCharacter(player.name, player);
        broadcastCriticalGearUpdate(partyId, party);
        socket.emit('eventLog', { message: `Unequipped ${unequippedItem ? (unequippedItem.displayName || unequippedItem.name || unequippedItem.id) : 'nothing'}.`, type: 'success' });
    }

    function handleUseItem(socket, data) {
        utils.trackSocketIoReceived('useItem', data);
        const { partyId, itemId } = data || {};
        const party = parties.get(partyId);
        if (!party) return;
        const player = party.players.get(socket.id);
        if (!player) return;

        player.inventory = Array.isArray(player.inventory) ? player.inventory : [];
        const inventoryItem = player.inventory.find(entry => entry && (entry.id === itemId || entry.baseItem === itemId || entry.name === itemId || entry.displayName === itemId));
        if (!inventoryItem) {
            socket.emit('eventLog', { message: 'You do not own that item.', type: 'error' });
            return;
        }

        if (inventoryItem.type !== 'consumable') {
            socket.emit('eventLog', { message: 'That item is not consumable.', type: 'error' });
            return;
        }

        const effect = inventoryItem.effect;
        if (effect) {
            if (effect.type === 'heal') {
                player.hp = Math.min(player.maxHp, player.hp + (effect.amount || 0));
            } else if (effect.type === 'mana') {
                player.ap = Math.min(player.maxAp, player.ap + (effect.amount || 0));
            } else if (effect.type === 'stat') {
                player[effect.stat] = (player[effect.stat] || 0) + (effect.amount || 0);
            }
        }

        player.inventory = player.inventory.filter(entry => entry !== inventoryItem);
        saveCharacter(player.name, player);
        broadcastCriticalGearUpdate(partyId, party);
        socket.emit('eventLog', { message: `Used ${inventoryItem.displayName || inventoryItem.name || inventoryItem.id}.`, type: 'success' });
    }

    function handleLeaveParty(socket, partyId) {
        utils.trackSocketIoReceived('leaveParty', { partyId });
        const party = parties.get(partyId);
        if (party) {
            const player = party.players.get(socket.id);
            if (player) {
                saveCharacter(player.name, player);
            }
            party.players.delete(socket.id);
            socket.leave(partyId);
            // Only delete party if it becomes empty AND no combat is active (voluntary leaving)
            if (party.players.size === 0 && !party.combatActive) {
                parties.delete(partyId);
                if (actionIntervals.has(partyId)) clearInterval(actionIntervals.get(partyId));
                if (spawnTimers.has(partyId)) clearTimeout(spawnTimers.get(partyId));
                actionIntervals.delete(partyId);
                spawnTimers.delete(partyId);
            } else {
                // OPTIMIZATION: Send critical update for player leaving
                broadcastCriticalUpdate(partyId, party);
            }
        }
    }

    function handleDonate(socket, data) {
        utils.trackSocketIoReceived('donate', data);
        console.log("donate", data);
        const partyId = data.partyId;
        const party = parties.get(partyId);
        if (!party) {console.log("donate no party", partyId); return;}
        if (party.combatActive || party.floor !== 0) {
            utils.trackSocketIoSent('eventLog', { message: 'You can only donate in town!', type: 'error' });
            socket.emit('eventLog', { message: 'You can only donate in town!', type: 'error' });
            return;
        }
        const player = party.players.get(socket.id);
        if (!player) {
            console.log("Player not found in party for socket.id:", socket.id);
            return;
        }
        if(player.gold >= 50) {
            console.log("donate " + 50);
            player.gold -= 50;
            player.donated += 50;
            utils.trackSocketIoSent('eventLog', { message: 'Donated 50 gold! PIE increased.', type: 'success' });
            socket.emit('eventLog', { message: 'Donated 50 gold! PIE increased.', type: 'success' });
            characters.calcMiscStats(player);

            // OPTIMIZATION: Use targeted broadcast instead of full state
            broadcastPlayerUpdate(partyId, party, socket.id);
        } else {
            utils.trackSocketIoSent('eventLog', { message: 'Not enough gold to donate!', type: 'error' });
            socket.emit('eventLog', { message: 'Not enough gold to donate!', type: 'error' });
            console.log("donate n");
        }
    }

    function handleEscapeDungeon(socket, data) {
        utils.trackSocketIoReceived('escapeDungeon', data);
        const { partyId } = data;
        const party = parties.get(partyId);
        if (!party) {
            socket.emit('eventLog', { message: 'Party not found!', type: 'error' });
            return;
        }

        if (party.floor === 0) {
            socket.emit('eventLog', { message: 'Already in Town!', type: 'info' });
            return;
        }

        // Re-baseline deltas so updates made before the escape cannot overwrite
        // the freshly-synced Town state on the client.
        resetPartyDeltaBaseline(partyId);

        const oldDungeon = party.dungeon;

        // Clear any pending spawn timers
        if (spawnTimers.has(partyId)) {
            clearTimeout(spawnTimers.get(partyId));
            spawnTimers.delete(partyId);
        }

        // Stop combat intervals
        if (actionIntervals.has(partyId)) {
            clearInterval(actionIntervals.get(partyId));
            actionIntervals.delete(partyId);
        }
        party.combatActive = false;
        party.combatTurn = 0;
        party.enemies = [];

        // Suppress auto-embark so the party stays in Town after escaping
        party.autoEmbark = false;

        // Return to Town and reset progress
        party.floor = 0;
        party.dungeonFloors[oldDungeon] = 0;
        party.highestVisitedFloors[oldDungeon] = 0;

        // Restore party
        restorePartyToFull(partyId);
        Array.from(party.players.values()).forEach(p => {
            p.actionBar = 0;
            saveCharacter(p.name, p);
        });

        // Broadcast state change
        const dungeonChangePacket = {
            partyId,
            dungeon: oldDungeon,
            floor: 0,
            dungeonFloors: party.dungeonFloors,
            highestVisitedFloors: party.highestVisitedFloors,
            combatActive: false,
            enemies: [],
            autoEmbark: false,
            timestamp: Date.now()
        };
        seedEnemyFullSent(party);
        broadcastToParty(partyId, 'dungeonChange', dungeonChangePacket);
        broadcastToParty(partyId, 'eventLog', { message: '🏠 Escaped to Town! Dungeon progress reset.', type: 'info' });
        broadcastFullState(partyId, party);

        console.log(`[ESCAPE] Party ${partyId} escaped from ${oldDungeon} to Town`);
    }

    function handleEmbarkDungeon(socket, data) {
        utils.trackSocketIoReceived('embarkDungeon', data);
        const { partyId, dungeon } = data;
        const party = parties.get(partyId);
        if (!party) {
            socket.emit('eventLog', { message: 'Party not found!', type: 'error' });
            return;
        }

        resetPartyDeltaBaseline(partyId);
        embarkParty(partyId, party, dungeon);
    }

    function handleToggleAutoEmbark(socket, data) {
        utils.trackSocketIoReceived('toggleAutoEmbark', data);
        const { partyId, enabled } = data;
        const party = parties.get(partyId);
        if (!party) return;

        party.autoEmbark = !!enabled;

        // If enabling while already in Town, embark immediately on the current dungeon
        if (party.autoEmbark && party.floor === 0 && !party.combatActive) {
            embarkParty(partyId, party, party.dungeon || 'field');
        }

        const autoEmbarkPacket = {
            partyId,
            autoEmbark: party.autoEmbark,
            timestamp: Date.now()
        };
        broadcastToParty(partyId, 'gameDelta', autoEmbarkPacket);
    }

    function handleChangeDungeon(socket, data) {
        utils.trackSocketIoReceived('changeDungeon', data);
        const { partyId, dungeon } = data;
        const party = parties.get(partyId);
        if (!party) {
            socket.emit('eventLog', { message: 'Party not found!', type: 'error' });
            return;
        }

        resetPartyDeltaBaseline(partyId);

        // Check if dungeon exists
        if (!dungeons[dungeon]) {
            socket.emit('eventLog', { message: `Unknown dungeon: ${dungeon}`, type: 'error' });
            return;
        }

        // Check if already in this dungeon
        if (party.dungeon === dungeon) {
            socket.emit('eventLog', { message: `Already in ${dungeon}!`, type: 'info' });
            return;
        }

        // Check if dungeon is unlocked
        if (!characters.isDungeonUnlocked(party, dungeon)) {
            const dungeonOrder = ['field', 'forest', 'cave'];
            const idx = dungeonOrder.indexOf(dungeon);
            if (idx > 0) {
                const prevDungeon = dungeonOrder[idx - 1];
                socket.emit('eventLog', { message: `Reach floor 101 in ${prevDungeon} first!`, type: 'error' });
            } else {
                socket.emit('eventLog', { message: `Dungeon ${dungeon} is locked!`, type: 'error' });
            }
            return;
        }

        // Check if in combat
        if (party.combatActive) {
            socket.emit('eventLog', { message: 'Cannot change dungeons during combat!', type: 'error' });
            return;
        }

        // Change dungeon
        const oldDungeon = party.dungeon;
        party.dungeon = dungeon;

        // Initialize dungeonFloors and highestVisitedFloors for this dungeon if not exists
        if (!party.dungeonFloors) party.dungeonFloors = {};
        if (!party.highestVisitedFloors) party.highestVisitedFloors = {};

        // Start at floor 0 for each dungeon (progress is stored separately per dungeon)
        party.dungeonFloors[dungeon] = party.dungeonFloors[dungeon] || 0;
        const currentDungeonFloor = 0;
        party.floor = 0;

        // Update highest visited floor for this dungeon
        const currentHighest = party.highestVisitedFloors[dungeon] || 0;
        // Always update highestVisitedFloors when entering a dungeon to ensure buttons work
        if (currentDungeonFloor >= 1 && (!party.highestVisitedFloors[dungeon] || currentDungeonFloor > currentHighest)) {
            party.highestVisitedFloors[dungeon] = currentDungeonFloor;
        }

        // Clear enemies and combat state
        party.enemies = [];
        party.combatActive = false;
        party.combatTurn = 0;

        // Reset all player action bars
        Array.from(party.players.values()).forEach(p => {
            p.actionBar = 0;
            saveCharacter(p.name, p);
        });

        // Generate enemies if not in town
        if (party.floor >= 1) {
            generateEnemies(party);
            party.combatActive = true;
            startActionBarSystem(partyId, party);
        }

        // Broadcast dungeon change to all party members
        const dungeonChangePacket = {
            partyId,
            dungeon: party.dungeon,
            floor: party.floor,
            dungeonFloors: party.dungeonFloors,
            highestVisitedFloors: party.highestVisitedFloors,
            combatActive: party.combatActive,
            enemies: party.enemies,
            timestamp: Date.now()
        };

        seedEnemyFullSent(party);
        broadcastToParty(partyId, 'dungeonChange', dungeonChangePacket);

        // Also emit to event log
        const eventMsg = party.floor >= 1 ? `Entered ${dungeon}! ⚔️ Action Bars filling!` : `Entered ${dungeon}! 🏠 Safe in town!`;
        broadcastToParty(partyId, 'eventLog', { message: eventMsg, type: 'info' });

        console.log(`[DUNGEON] Party ${partyId} changed from ${oldDungeon} to ${dungeon}`);
    }

    function handleJoinParty(socket, data) {
        utils.trackSocketIoReceived('joinParty', data);
        console.log('[SERVER] Received joinParty:', data);
        const { partyId, name } = data;
        let party = parties.get(partyId);

        if (!party) {
            party = {
                partyId,
                players: new Map(),
                enemies: [],
                floor: 0,
                dungeon: 'field',
                dungeonFloors: { field: 1 },
                highestVisitedFloors: { field: 0 },
                completedDungeons: { field: false },
                combatActive: false,
                combatTurn: 0,
                maxPlayers: 24,
                shopStock: []
            };
            parties.set(partyId, party);

            characters.restockShopWithDungeonScaling(party, party.dungeon || 'field', characters.getDungeonData(party.dungeon || 'field'));
        }

        if (party.players.size < party.maxPlayers) {
            console.log('[SERVER] Loading character for name:', name);
            const savedData = loadCharacter(name);
            console.log('[SERVER] Loaded character data:', savedData ? 'exists' : 'null');

            let character = savedData || utils.createDefaultCharacter(name);
            character = characters.ensureSkillAndAbilityState(character);

            delete character.id;
            character.id = socket.id;

            const savedHp = character.hp;
            const savedMp = character.mp;
            const savedAp = character.ap;

            character.maxAp = characters.calcMaxAp(character);
            if (!savedData || savedAp === undefined) {
                character.ap = character.maxAp;
            }

            character.actionBar = character.actionBar || 0;
            character.maxActionBar = character.maxActionBar || 100;
            character.vit = character.vit || 5;

            normalizeCharacterStats(character);

            character.equipment = characters.normalizeEquipment(character.equipment || {});

            const resolvedEquipment = {};
            const equipmentObj = character.equipment || {};
            for (const slot of Object.keys(equipmentObj)) {
                const ref = equipmentObj[slot];
                if (ref && ref.id && ref.level && ref.rarity && !ref.baseItem) {
                    const targetSlot = itemGenerator.normalizeCategory
                        ? itemGenerator.normalizeCategory(slot)
                        : slot;
                    const resolved = itemGenerator.resolveItem
                        ? itemGenerator.resolveItem(targetSlot, ref.id, ref.level, ref.rarity)
                        : null;
                    if (resolved && resolved.baseItem) {
                        resolvedEquipment[slot] = { ...resolved, slot: targetSlot };
                    } else {
                        resolvedEquipment[slot] = ref;
                    }
                } else {
                    resolvedEquipment[slot] = ref;
                }
            }
            character.equipment = resolvedEquipment;

            character.maxHp = characters.calcMaxHp(character) || 60;
            character.maxMp = characters.calcMaxMp(character) || 40;

            if (savedData && typeof savedHp === 'number' && !isNaN(savedHp)) {
                character.hp = Math.max(0, Math.min(character.maxHp, savedHp));
            } else {
                character.hp = character.maxHp;
            }

            if (savedData && typeof savedMp === 'number' && !isNaN(savedMp)) {
                character.mp = Math.max(0, Math.min(character.maxMp, savedMp));
            } else {
                character.mp = character.maxMp;
            }

            if (savedData && typeof savedAp === 'number' && !isNaN(savedAp)) {
                character.ap = Math.max(0, Math.min(character.maxAp, savedAp));
            } else {
                character.ap = character.maxAp;
            }

            if (!savedData && party.floor === 0) {
                character.hp = character.maxHp;
            }

            party.players.set(socket.id, character);
            socket.join(partyId);
            console.log(`[SERVER] Player ${name} joined with socket.id: ${socket.id} to party ${partyId}`);
            console.log('[SERVER] Saving character for name:', name);
            saveCharacter(name, character);
            console.log('[SERVER] Character saved');

            const fullState = buildFullStatePacket(party, partyId);
            broadcastFullState(partyId, party);
            console.log('[SERVER] Emitting joinedParty to client');
            utils.trackSocketIoSent('joinedParty', { partyId, player: character, fullState });
            socket.emit('joinedParty', { partyId, player: character, fullState });
        } else {
            utils.trackSocketIoSent('partyFull', null);
            socket.emit('partyFull');
        }
    }

    function normalizeCharacterStats(character) {
        // Ensure minimum stat values to prevent 0/0 displays
        character.level = Math.max(1, character.level || 1);
        character.vit = Math.max(5, character.vit || 5);
        character.str = Math.max(5, character.str || 5);
        character.dex = Math.max(5, character.dex || 5);
        character.agi = Math.max(5, character.agi || 5);
        character.int = Math.max(5, character.int || 5);
        character.cnc = Math.max(5, character.cnc || 5);
        character.for = Math.max(1, character.for || 1);
        character.wis = Math.max(1, character.wis || 1);
        character.luk = Math.max(1, character.luk || 1);
        character.pie = Math.max(1, character.pie || 1);
    }

    function handleAllocatePoints(socket, data) {
        utils.trackSocketIoReceived('allocatePoints', data);
        console.log('[SERVER] Received allocatePoints:', data, 'socket.id:', socket.id);
        const { partyId, stat, points } = data;
        const party = parties.get(partyId);
        if (!party) {
            console.log('[SERVER] Party not found:', partyId);
            return;
        }
        const player = party.players.get(socket.id);
        console.log('[SERVER] Player found:', !!player, 'player name:', player ? player.name : 'none');
        if (!player || player.pointsToAllocate < points || points <= 0) {
            console.log('[SERVER] Invalid allocation: player exists?', !!player, 'pointsToAllocate:', player ? player.pointsToAllocate : 'N/A', 'requested:', points);
            return;
        }

        player[stat] += points;
        player.pointsToAllocate -= points;

        // 🩸 If vit or str increased, boost max HP and heal
        if (stat === 'vit' || stat === 'str') {
            const newMaxHp = characters.calcMaxHp(player);
            const hpDiff = newMaxHp - player.maxHp;
            player.maxHp = newMaxHp;
            player.hp = Math.min(player.maxHp, player.hp + hpDiff);
        }
        // 🩸 If int or cnc increased, boost max MP
        if (stat === 'int' || stat === 'cnc') {
            const newMaxMp = characters.calcMaxMp(player);
            const mpDiff = newMaxMp - player.maxMp;
            player.maxMp = newMaxMp;
            player.mp = Math.min(player.maxMp, player.mp + mpDiff);
        }

        // 🛡️ If vit, str, or for increased, boost max AP
        if (stat === 'vit' || stat === 'str' || stat === 'for') {
            const newMaxAp = characters.calcMaxAp(player);
            const apDiff = newMaxAp - player.maxAp;
            player.maxAp = newMaxAp;
            player.ap = Math.min(player.maxAp, player.ap + apDiff);
        }

        // Log the stat allocation to the event log
        utils.trackSocketIoSent('eventLog', { message: `Allocated ${points} points to ${stat}.`, type: 'info' });
        socket.emit('eventLog', { message: `Allocated ${points} points to ${stat}.`, type: 'info' });

        console.log('[SERVER] Saving character after allocatePoints for:', player.name);
        saveCharacter(player.name, player);
        console.log('[SERVER] Character saved after allocatePoints');

        // OPTIMIZATION: Use targeted broadcast instead of full state
        broadcastFullState(partyId, party);
    }

    function handleDisconnect(socket, reason) {
        clearInterval(socket.pingInterval);
        // Clean up performance tracking
        socketMap.delete(socket.id);

        // Clean up delta tracking for this socket
        playerLastState.delete(socket.id);

        // Handle party cleanup
        for (const [partyId, party] of parties.entries()) {
            if (party.players.has(socket.id)) {
                const player = party.players.get(socket.id);
                if (player) {
                    saveCharacter(player.name, player);
                }
                party.players.delete(socket.id);
                socket.leave(partyId);

                // Clean up WebRTC peer
                webrtcServer.removePeer(socket.id);

                if (party.players.size === 0 && !party.combatActive) {
                    parties.delete(partyId);
                    // Clean up all delta tracking for empty party
                    clearPartyDeltaState(partyId);
                    if (actionIntervals.has(partyId)) clearInterval(actionIntervals.get(partyId));
                    if (spawnTimers.has(partyId)) clearTimeout(spawnTimers.get(partyId));
                    actionIntervals.delete(partyId);
                    spawnTimers.delete(partyId);
                }
                break;
            }
        }
    }

    function handleLateDisconnect(socket) {
        utils.trackSocketIoReceived('disconnect');
        const party = Array.from(parties.values()).find(party => party.players.has(socket.id));
        if (!party) return;
        const player = party.players.get(socket.id);
        if (!player) return;

        party.players.delete(socket.id);
        broadcastPlayerUpdate(party.id, party, socket.id);
        socket.emit('eventLog', { message: 'Disconnected.', type: 'info' });
    }

// Event-driven single-player sync. Forces an immediate flush through the
// consolidated emitter (single gameDelta) so discrete-action changes (donate,
// assign ability slot, disconnect) land without waiting for the next periodic
// tick. Gear/inventory structural changes go through broadcastCriticalGearUpdate instead.
function broadcastPlayerUpdate(partyId, party, socketId) {
    const player = party.players.get(socketId);
    if (!player) return;
    // Event-driven single-player sync: bypass the 50ms gate and flush a gameDelta now.
    lastGameDelta.delete(partyId);
    emitPartyDeltas(partyId, party, Date.now());
}

// Helper function to generate combat summary
function generateCombatSummary(partyId, party, message) {
    let summary = '';
    let totalDamage = 0;
    let totalAttacks = 0;
    let totalHits = 0;
    let totalRollSum = 0;
    let totalHealed = 0;
    let totalCrits = 0;
    let playerSummaries = [];
    
    for (const [playerId, stats] of party.combatStats) {
        if (stats.attacks > 0) {
            const hitRate = (stats.hits / stats.attacks * 100).toFixed(1);
            const critRate = stats.hits > 0 ? (stats.crits / stats.hits * 100).toFixed(1) : '0';
            const avgDamage = stats.hits > 0 ? (stats.totalDamage / stats.hits).toFixed(1) : '0';
            const avgRoll = stats.hits > 0 ? (stats.rollSum / stats.hits).toFixed(1) : '0';
            const player = party.players.get(playerId);
            if (player) {
                playerSummaries.push({
                    name: player.name,
                    totalDamage: stats.totalDamage,
                    html: `<div class="player-summary">${player.name}: Total Damage ${stats.totalDamage.toFixed(1)}, Max Damage ${stats.maxDamage.toFixed(1)}, Total Healed ${stats.totalHealed.toFixed(1)}<br>Hit Rate ${hitRate}%, Crit Rate ${critRate}%, Avg Damage ${avgDamage}, Avg Roll ${avgRoll}</div>`
                });
            }
            totalDamage += stats.totalDamage;
            totalAttacks += stats.attacks;
            totalHits += stats.hits;
            totalRollSum += stats.rollSum;
            totalHealed += stats.totalHealed;
            totalCrits += stats.crits;
        }
    }
    
    playerSummaries.sort((a, b) => b.totalDamage - a.totalDamage);
    summary = playerSummaries.map(p => p.html).join('');
    
    if (totalAttacks > 0) {
        const overallHitRate = (totalHits / totalAttacks * 100).toFixed(1);
        const overallCritRate = totalHits > 0 ? (totalCrits / totalHits * 100).toFixed(1) : '0';
        const overallAvgDamage = totalHits > 0 ? (totalDamage / totalHits).toFixed(1) : '0';
        const overallAvgRoll = totalHits > 0 ? (totalRollSum / totalHits).toFixed(1) : '0';
        summary += `<div class="total-summary">Total: Damage ${totalDamage.toFixed(1)}, Healed ${totalHealed.toFixed(1)}<br> Hit Rate ${overallHitRate}%, Crit Rate ${overallCritRate}%, Avg Damage ${overallAvgDamage}, Avg Roll ${overallAvgRoll}</div>`;
    }
    
    // Emit combat end via the single combatEnd channel (WebRTC-preferred, Socket.IO fallback).
    broadcastToParty(partyId, 'combatEnd', {
        message,
        summary,
        combatActive: false
    });
    
    // Note: DoT effects are handled by the global DoT system (initDotSystem)
    // Removed redundant individual player DoT update logic
}

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { 
    cors: { origin: '*' },
    compression: true,
    perMessageDeflate: { threshold: 1024 }
});

app.use(express.static('public'));

// Merged ability definitions (auto-discovered per-skill JSON files).
app.get('/api/abilities', (req, res) => res.json(loadAbilities()));

// 60-second packet statistics logging
setInterval(() => {
    const webrtcStats = webrtcServer.packetTracker.getStats();
    
    const socketIoTotal = {
        sent: utils.socketIoPacketTracker.sent,
        received: utils.socketIoPacketTracker.received
    };
    const webrtcTotal = webrtcStats;
    
    const combinedSent = utils.socketIoPacketTracker.sent.total.count + webrtcStats.sent.total.count;
    const combinedSentBytes = utils.socketIoPacketTracker.sent.total.bytes + webrtcStats.sent.total.bytes;
    const combinedReceived = utils.socketIoPacketTracker.received.total.count + webrtcStats.received.total.count;
    const combinedReceivedBytes = utils.socketIoPacketTracker.received.total.bytes + webrtcStats.received.total.bytes;

    console.log('\n' + '='.repeat(70));
    console.log('=== PACKET STATISTICS (Last 60 seconds) =======================');
    console.log('='.repeat(70));
    
    console.log('\nSocket.IO:');
    console.log(utils.formatPacketStats('  ', socketIoTotal));
    
    console.log('\nWebRTC:');
    console.log(utils.formatPacketStats('  ', webrtcTotal));
    
    console.log('\n' + '-'.repeat(70));
    console.log('Combined Total:',
        `\n  Sent: ${combinedSent} packets, ${utils.formatBytes(combinedSentBytes)}`,
        `\n  Received: ${combinedReceived} packets, ${utils.formatBytes(combinedReceivedBytes)}`,
        `\n  Total: ${combinedSent + combinedReceived} packets, ${utils.formatBytes(combinedSentBytes + combinedReceivedBytes)}\n` + '='.repeat(70) + '\n');
    
    // Reset Socket.IO stats (WebRTC stats are reset externally if needed)
    utils.socketIoPacketTracker.sent = { total: { count: 0, bytes: 0 }, byType: {} };
    utils.socketIoPacketTracker.received = { total: { count: 0, bytes: 0 }, byType: {} };
    webrtcServer.packetTracker.reset();
}, 60000);

// Define parties and spawnTimers BEFORE WebRTC initialization (fixes ReferenceError at line 174)
const parties = new Map();
const spawnTimers = new Map();

// Initialize WebRTC server
const webrtcServer = new WebRTCServer();
webrtcServer.initialize(parties, io, webrtcServer);

// Set up WebRTC Socket.IO handlers (webrtc-offer, webrtc-signal, batchPreference)
webrtcServer.setupSocketIOHandlers(io);

// When a WebRTC data channel re-establishes (reconnect), push a fresh full state
// over the newly opened channel and re-baseline the server-side delta tracker so
// the client can restore its view cleanly after the interruption.
webrtcServer.on('webrtcStateRestore', (socketId) => {
    let targetPartyId = null;
    let targetParty = null;
    for (const [partyId, party] of parties.entries()) {
        if (party.players.has(socketId)) {
            targetPartyId = partyId;
            targetParty = party;
            break;
        }
    }
    if (!targetParty) {
        console.log(`[WebRTC Restore] No party found for reconnected socket ${socketId} - nothing to restore`);
        return;
    }

    // Re-baseline deltas so the freshly pushed full state becomes the new reference.
    webrtcServer.resetDeltaStateForSocket(socketId);
    const fullState = buildFullStatePacket(targetParty, targetPartyId);
    const sent = webrtcServer.sendMessage(socketId, 'partyUpdate', fullState);
    console.log(`[WebRTC Restore] Sent full state to reconnected socket ${socketId}: ${sent ? 'ok' : 'failed'}`);

    // Re-apply the delta baseline now that the client has the canonical state.
    webrtcServer.initializePlayerDeltaState(targetPartyId, targetParty, socketId);
});

// Helper function to broadcast to party via WebRTC (delegated to webrtcServer)
function broadcastToPartyWebRTC(partyId, type, data, excludeSocket = null, options = {}) {
    return webrtcServer.broadcastToPartyWebRTC(partyId, type, data, excludeSocket, options);
}

// Performance optimization: Client socket tracking
const socketMap = new Map(); // socketId -> socket object
// ═══════════════════════════════════════════════════════════════════
// DELTA COMPRESSION: Track previous state for efficient delta updates
// ═══════════════════════════════════════════════════════════════════

// Track last sent state per player (socketId -> { field: value })
const playerLastState = new Map(); // socketId -> { hp, ap, maxHp, maxAp, actionBar, level, ... }

// Track last sent state per enemy (enemyId -> { hp, maxHp, ap, actionBar })
const enemyLastState = new Map(); // enemyId -> { hp, maxHp, ap, actionBar }

// Track last sent party-level state
const partyLastState = new Map(); // partyId -> { floor, combatActive, combatTurn, highestVisitedFloors, dungeon, dungeonFloors, completedDungeons, autoEmbark }

// Track enemies that have already received a full snapshot on the gameDelta
// channel, so subsequent emits can ship partial (ENEMY_DELTA_FIELDS only) deltas.
// Cleared on embark / combatStart / dungeon rebaseline so full snapshots resume.
const enemyFullSent = new Set(); // enemyId

// Mark enemies as already full-synced after a channel other than gameDelta has
// shipped their complete object (dungeonChange / combatStart). Without this, the
// next gameDelta would emit a partial (no name) and the client would skip it.
function seedEnemyFullSent(party) {
    if (!party.enemies) return;
    for (const enemy of party.enemies) enemyFullSent.add(enemy.id);
}
// Fields tracked for per-player broadcast deltas (server-authoritative state).
const PLAYER_DELTA_FIELDS = ['hp', 'ap', 'maxHp', 'maxAp', 'level', 'xp', 'xpToNext', 'gold', 'mp', 'maxMp',
    'pointsToAllocate', 'abilityCooldowns', 'str', 'dex', 'agi', 'vit', 'int', 'cnc', 'wis', 'for', 'luk', 'pie',
    'actionBar', 'maxActionBar', 'equipment', 'inventory', 'skillsState'];

// Fields tracked for per-enemy broadcast deltas.
const ENEMY_DELTA_FIELDS = ['hp', 'maxHp', 'ap', 'maxAp', 'mp', 'maxMp'];

// Get delta for a single player - only return changed fields.
// consumeFields: list of field names this pass actually transmits. Only those
// fields are advanced in the baseline snapshot, so a pass that only sends HP/MP
// (or HP/AP) does not discard changes meant for another pass (e.g. skillsState).
// Pass null/undefined to compute the delta without advancing the baseline.
function getPlayerDelta(socketId, player, consumeFields = null) {
    const lastState = playerLastState.get(socketId) || {};
    const delta = extractDelta(lastState, player, PLAYER_DELTA_FIELDS);
    if (Object.keys(delta).length === 0) return null;
    // Only build the (relatively expensive) snapshot once we know a change exists.
    if (consumeFields) {
        const merged = { ...lastState };
        for (const f of consumeFields) merged[f] = player[f];
        playerLastState.set(socketId, merged);
    }
    return delta;
}

// Get delta for a single enemy - only return changed fields.
// Only advance the baseline when a real change is detected (BUG 3: was
// unconditionally setting enemyLastState even when delta was empty).
function getEnemyDelta(enemyId, enemy) {
    const lastState = enemyLastState.get(enemyId) || {};
    const delta = extractDelta(lastState, enemy, ENEMY_DELTA_FIELDS);
    const wasDead = lastState.hp !== undefined && lastState.hp <= 0;
    const isDead = enemy.hp <= 0;
    if (wasDead !== isDead) delta.isDead = isDead;
    if (Object.keys(delta).length === 0) return null;
    enemyLastState.set(enemyId, { ...enemy });
    return delta;
}

// Initialize delta state for a new player (send full state, then switch to deltas)
function initializePlayerDeltaState(partyId, party, socketId) {
    const player = party.players.get(socketId);
    if (player) playerLastState.set(socketId, buildSnapshot(player));
    if (party.enemies) {
        for (const enemy of party.enemies) {
            enemyLastState.set(enemy.id, { ...enemy });
        }
    }
    partyLastState.set(partyId, {
        floor: party.floor,
        combatActive: party.combatActive,
        combatTurn: party.combatTurn,
        highestVisitedFloors: party.highestVisitedFloors ? { ...party.highestVisitedFloors } : {}
    });
    webrtcServer.initializePlayerDeltaState(partyId, party, socketId);
}

// Clear delta tracking for a party (when party disbands)
function clearPartyDeltaState(partyId) {
    const party = parties.get(partyId);
    if (party) {
        for (const socketId of party.players.keys()) {
            playerLastState.delete(socketId);
        }
        // Delete this party's enemy delta snapshots. Enemy IDs come from
        // generateEnemies (no 'enemy_' prefix), so match by live enemy id.
        for (const enemy of party.enemies || []) {
            enemyLastState.delete(enemy.id);
        }
    }
    partyLastState.delete(partyId);
    webrtcServer.clearPartyDeltaState(partyId);
}

// Global function that can be used anywhere in the application
function startSpawnTimer(partyId, party) {
    if (party.floor < 1 || spawnTimers.has(partyId)) return;

    const timer = setTimeout(() => {
        if (!party.combatActive && (!party.enemies || party.enemies.length === 0)) {
            generateEnemies(party);
            party.combatActive = true;
            // Prefer WebRTC over TCP
            const combatPacket = { floor: party.floor, enemies: party.enemies };
            seedEnemyFullSent(party);
            broadcastToParty(partyId, 'combatStart', combatPacket);
            startActionBarSystem(partyId, party);
        }
        spawnTimers.delete(partyId);
    }, 1500);

    spawnTimers.set(partyId, timer);
}

// Single source of full restoration: fully heal every player in a party and persist.
function restorePartyToFull(partyId) {
    const party = parties.get(partyId);
    if (!party) return;
    Array.from(party.players.values()).forEach(p => {
        p.hp = p.maxHp;
        p.mp = p.maxMp;
        p.ap = p.maxAp;
        p.actionBar = 0;
        p.dots = [];
        p.hots = [];
        p.actionSlowEffects = [];
        saveCharacter(p.name, p);
    });
}

// Reset every player's action bar to 0 and persist (used on embark, floor
// change, teleport, escape, and dungeon change).
function resetPlayersActionBars(party) {
    Array.from(party.players.values()).forEach(p => {
        p.actionBar = 0;
        saveCharacter(p.name, p);
    });
}

// Module-local convenience readers for the frequently-recomputed live-combatant
// sets. Return fresh arrays each call (identity is not preserved), matching the
// inline `Array.from(...).filter(...)` they replace. No packet-shape change.
function livePlayers(party) {
    return Array.from(party.players.values()).filter(p => p.hp > 0);
}
function liveEnemies(party) {
    return (party.enemies || []).filter(e => e.hp > 0);
}

// Re-baseline the per-player/enemy delta state for a party to the current
// server state. Used on embark/escape/dungeon-change so changes made before
// the reset cannot be swallowed or overwrite the freshly-synced client state.
// Deltas are computed directly from state every tick, so re-baselining simply
// snapshots the current player/enemy/party state as the new comparison point.
function resetPartyDeltaBaseline(partyId) {
    const party = parties.get(partyId);
    if (!party) return;
    for (const [socketId, player] of party.players) {
        playerLastState.set(socketId, buildSnapshot(player));
    }
    if (party.enemies) {
        for (const enemy of party.enemies) {
            enemyLastState.set(enemy.id, { ...enemy });
        }
    }
    // Re-baselining resets comparison points; also clear the "full snapshot sent"
    // tracker so the freshly-synced enemies re-send full state on next gameDelta.
    enemyFullSent.clear();
}

// Cast a single already-selected ability for a player. Spends MP and sets the cooldown via
// skillEngine.applyAbilityCast, then applies healing/damage plus HoT/DoT/action-slow effects and awards XP.
// Casting no longer touches the action bar (that drives weapon attacks only).
function castAbilityForPlayer(combatant, partyId, party, ability) {
    if (!ability) return;
    const nextState = skillEngine.applyAbilityCast(combatant, ability, Date.now());
    if (!nextState) return;
    Object.assign(combatant, nextState);

    const alivePlayers = livePlayers(party);

    // Handle defense-up self-buff abilities (armor proficiencies) before all others.
    if (ability.defenseUpAmount && ability.defenseUpDuration) {
        skillEngine.applyDefenseUp(combatant, ability);
        combatant.skillsState = skillEngine.awardSkillXp(combatant.skillsState, ability.skillId, 3);
        broadcastCriticalUpdate(partyId, party, {
            actor: { ...combatant },
            targets: [],
            ability: ability,
            defenseUp: true
        });
        return;
    }

    // Handle healing abilities differently from offensive abilities
    if (ability.isHeal) {
        // For healing abilities, calculate the heal amount
        const healAmount = skillEngine.calculateHealAmount(ability, combatant);

        // Get targets for the healing ability
        const healTargets = skillEngine.getAbilityTargets(combatant, ability, [...alivePlayers]);

        // Apply healing to each target
        healTargets.forEach(target => {
            target.hp = Math.min(target.maxHp, target.hp + healAmount);

            // Apply HoT effect if specified in ability
            if (ability.hotHealPerTick && ability.hotDuration) {
                skillEngine.applyHot(combatant, target, ability, party, party.combatStats);
            }
        });

        // Award XP to healing skill when casting healing abilities
        // Determine if healing an ally (not enemy) for XP purposes
        const isHealingAlly = healTargets.some(t => !t.isEnemy && t !== combatant);
        combatant.skillsState = skillEngine.awardHealXp(combatant.skillsState, !isHealingAlly); // false = healing ally/non-enemy
    } else {
        // For offensive abilities, calculate damage and apply to targets
        const damageTargets = skillEngine.getAbilityTargets(combatant, ability, liveEnemies(party));

        // Calculate damage based on ability type
        let baseDamage = 1;

        if (ability.castUsesWeaponDamageModel) {
            // Use the same damage calculation as regular attacks
            const { mod, modD } = calculateAttackMods(combatant);
            const baseRoll = 50; // Base roll for abilities - adjust as needed
            baseDamage = calculateDamage(combatant, modD, baseRoll);

            const attributeMultiplier = skillEngine.calculateAttributeScaling(combatant, ability.attributeDamageScale);
            baseDamage *= attributeMultiplier;
        } else {
            // Use ability's own damage base
            baseDamage = ability.damageBase || 10; // Default damage if not specified
            if (combatant.isEnemy) baseDamage *= ENEMY_DAMAGE_MULTIPLIER;

            // Scale damage based on the associated skill level
            const skillLevel = skillEngine.getSkillLevel(combatant.skillsState, ability.skillId);
            baseDamage = baseDamage * (1 + (skillLevel - 1) * 0.05); // 5% more damage per skill level

            if (!ability.castUsesWeaponDamageModel) {
                const weapon = characters.getActiveWeapon(combatant);
                const resolvedWeapon = weapon?.id
                    ? itemGenerator.resolveItem('weapon', weapon.id, weapon.level || 1, weapon.rarity || 1)
                    : null;
                baseDamage += (resolvedWeapon?.spellPower || 0);
            }

            const attributeMultiplier = skillEngine.calculateAttributeScaling(combatant, ability.attributeDamageScale);
            baseDamage *= attributeMultiplier;
        }

        // Apply damage scaling for multiple targets
        const scaledDamage = skillEngine.calculateDamageScalingForMultipleTargets(
            baseDamage,
            damageTargets.length,
            ability.abilityType || 'damage',
            combatant
        );

        // Apply damage to each target
        damageTargets.forEach(target => {
            applyDamage(target, scaledDamage, partyId, party);

            // Apply DoT effect if specified in ability
            if (ability.dotDamagePerTick && ability.dotDuration) {
                skillEngine.applyDot(combatant, target, ability, party, party.combatStats);
            }

            // Apply action bar slow effect if specified in ability
            if (ability.actionBarSlowAmount) {
                skillEngine.applyActionSlowing(combatant, target, ability);
            }

            // Apply witchcraft debuff effects if specified in ability
            if (ability.weakenAmount && ability.weakenDuration) {
                skillEngine.applyWeaken(combatant, target, ability);
            }
            if (ability.vulnerabilityAmount && ability.vulnerabilityDuration) {
                skillEngine.applyVulnerability(combatant, target, ability);
            }
            if (ability.defenseDownAmount && ability.defenseDownDuration) {
                skillEngine.applyDefenseDown(combatant, target, ability);
            }

            // Update combat stats for the caster
            if (!combatant.isEnemy) {
                const stats = party.combatStats.get(combatant.id);
                if (stats) {
                    stats.hits++;
                    stats.totalDamage += scaledDamage;
                    stats.rollSum += 50; // Using 50 as base roll for abilities
                    stats.maxDamage = Math.max(stats.maxDamage, scaledDamage);
                }
            }
        });

        // Award XP to the associated skill - bonus for hitting multiple targets
        const xpPerTarget = 3;
        combatant.skillsState = skillEngine.awardSkillXp(combatant.skillsState, ability.skillId, xpPerTarget * damageTargets.length);
        
        // Check for enemy deaths and award party XP/gold, remove dead enemies
        if (damageTargets.some(t => t.isEnemy && t.hp <= 0)) {
            awardXP(partyId, party);
        }

        // Broadcast the ability event
        broadcastCriticalUpdate(partyId, party, {
            actor: { ...combatant },
            targets: damageTargets.map(t => ({ ...t, isEnemy: t.isEnemy || false })),
            ability: ability,
            damage: baseDamage,
            scaledDamage: scaledDamage,
            hit: true
        });
    }
}

// Start action bar system for combat
function startActionBarSystem(partyId, party) {
    if (actionIntervals.has(partyId)) { clearInterval(actionIntervals.get(partyId)); }
    if (spellCastIntervals.has(partyId)) { clearInterval(spellCastIntervals.get(partyId)); }
    party.combatStats = new Map();

    // Spell-cast timer: independent of the action bar. Every ~100ms each live player attempts
    // to cast their first available spell (cooldown + MP + weapon requirements still apply).
    const spellInterval = setInterval(() => {
        if (!party.combatActive) {
            clearInterval(spellInterval);
            spellCastIntervals.delete(partyId);
            return;
        }
        const alive = livePlayers(party);
        alive.forEach(player => {
            const ability = skillEngine.selectAbilityToCast(player, abilities, Date.now(), alive);
            if (ability) castAbilityForPlayer(player, partyId, party, ability);
        });
    }, 100);
    spellCastIntervals.set(partyId, spellInterval);

    const dotInterval = setInterval(() => {
        skillEngine.processDotTicks(party);
        skillEngine.processHotTicks(party);
    }, 160);
    const interval = setInterval(() => {
        if (!party.combatActive) {
            clearInterval(interval);
            actionIntervals.delete(partyId);
            return;
        }
        const livePlayersList = livePlayers(party);
        const liveEnemiesList = liveEnemies(party);
            if (livePlayersList.length === 0) {
                party.combatActive = false;
                clearInterval(interval);
                actionIntervals.delete(partyId);

                party.floor = 0;
                party.enemies = [];
                // Save alive players before clearing party
                const alivePlayers = Array.from(party.players.values()).filter(p => p.hp > 0);
                // Dead players have already left the party and had their gear dropped
                party.players.clear();
                alivePlayers.forEach(p => {
                    party.players.set(p.id, p);
                });

                if (party.players.size === 0) {
                    // Only delete party if everyone is actually dead
                    parties.delete(partyId);
                    if (spawnTimers.has(partyId)) {
                        clearTimeout(spawnTimers.get(partyId));
                        spawnTimers.delete(partyId);
                    }
                    generateCombatSummary(partyId, party, 'All players have fallen! Party disbanded.');
                } else {
                    // Some players survived - respawn timer for remaining players
                    startSpawnTimer(partyId, party);
                    // Prefer WebRTC for event log
                    const deathLogPacket = { 
                        message: 'Some players died, but the party continues!', 
                        type: 'info' 
                    };
                    broadcastToParty(partyId, 'eventLog', deathLogPacket);
                }
                return;
            }

            if (liveEnemiesList.length === 0) {
                party.combatActive = false;
                clearInterval(interval);
                clearInterval(dotInterval);
                actionIntervals.delete(partyId);

                // Re-baseline deltas so the just-ended combat cannot re-inject old
                // enemies or flip combatActive back on the client.
                resetPartyDeltaBaseline(partyId);

                // Generate combat summary using shared function
                generateCombatSummary(partyId, party, 'Victory! You can move now!');

                // Mark dungeon completion when the party defeats the boss on the last floor (per floorAmount)
                const dungeonDataForCompletion = party.dungeon ? characters.getDungeonData(party.dungeon) : null;
                const dungeonFloorMaxForCompletion = dungeonDataForCompletion?.floorAmount ?? 100;

                if (party.dungeon && party.dungeonFloors?.[party.dungeon] === dungeonFloorMaxForCompletion) {
                    if (!party.completedDungeons) party.completedDungeons = {};
                    if (party.completedDungeons[party.dungeon] !== true) {
                        party.completedDungeons[party.dungeon] = true;
                    }

                    console.log(`🏁 ${party.dungeon} completed!`)

                    // Broadcast the 🏁 completion line. These one-shot, critical
                    // messages must reach the client reliably, so emit on Socket.IO
                    // directly (TCP) AND over WebRTC without batching.
                    const completionPacket = { message: `🏁 ${party.dungeon} completed!`, type: 'success' };
                    io.to(partyId).emit('eventLog', completionPacket);
                    broadcastToParty(partyId, 'eventLog', completionPacket, { noBatch: true });

                    // Restock shop with items scaled to dungeon difficulty — runs on every boss clear
                    characters.restockShopWithDungeonScaling(party, party.dungeon, dungeonDataForCompletion);

                    // Reward every character with one scaled item or gold fallback for clearing the dungeon
                    const lootResults = characters.rewardPlayersOnDungeonClear(party, party.dungeon, dungeonDataForCompletion);
                    for (const result of lootResults) {
                        const awardPacket = { message: result.message, type: result.type === 'item' ? 'success' : 'info' };
                        io.to(partyId).emit('eventLog', awardPacket);
                        broadcastToParty(partyId, 'eventLog', awardPacket, { noBatch: true });
                    }

                    // Return to town immediately after boss defeat so UI reflects completion
                    party.floor = 0;
                    party.dungeonFloors[party.dungeon] = 0;
                    party.combatActive = false;
                    party.combatTurn = 0;
                    party.enemies = [];
                    restorePartyToFull(partyId);

                    broadcastFullState(partyId, party);

                    const returnPacket = { message: '🏠 Returned to Town!', type: 'info' };
                    io.to(partyId).emit('eventLog', returnPacket);
                    broadcastToParty(partyId, 'eventLog', returnPacket, { noBatch: true });

                    // 🔁 Auto-Embark: if enabled, immediately re-embark on the same dungeon
                    if (party.autoEmbark) {
                        embarkParty(partyId, party, party.dungeon || 'field');
                    }

                    return;
                }

                // 🆕 AUTO-PROGRESS: always advance to the next floor after a clear
                // Prefer WebRTC for event log
                const floorAdvancePacket = {
                    message: '✅ Auto-progressing to next floor...',
                    type: 'info'
                };
                broadcastToParty(partyId, 'eventLog', floorAdvancePacket);
                
                // Initialize dungeonFloors and highestVisitedFloors if not exists
                if (!party.dungeonFloors) party.dungeonFloors = {};
                if (!party.highestVisitedFloors) party.highestVisitedFloors = {};
                
                // Get current dungeon-relative floor
                const currentDungeonFloor = party.dungeonFloors[party.dungeon] || 1;
                
                // Calculate new dungeon-relative floor (max per dungeon)
                const dungeonDataForAutoProgress = characters.getDungeonData(party.dungeon);
                const dungeonFloorMaxForAutoProgress = dungeonDataForAutoProgress?.floorAmount ?? 100;
                const newDungeonFloor = Math.min(currentDungeonFloor + 1, dungeonFloorMaxForAutoProgress);
                party.dungeonFloors[party.dungeon] = newDungeonFloor;
                
                // Calculate absolute floor for display
                party.floor = newDungeonFloor;
                
                // Update highest visited floor for this dungeon
                const currentHighest = party.highestVisitedFloors[party.dungeon] || 0;
                if (newDungeonFloor > currentHighest) {
                    party.highestVisitedFloors[party.dungeon] = newDungeonFloor;
                }
                
                setTimeout(() => {
                    // Prefer WebRTC for nextFloor event
                    const nextFloorPacket = { partyId: party.partyId };
                    broadcastToParty(partyId, 'nextFloor', nextFloorPacket);
                }, 1000);

                Array.from(party.players.values()).forEach(p => saveCharacter(p.name, p));
                startSpawnTimer(partyId, party);
                return;
            }

        const agiFillRate = 4.8;
        const combatants = [...livePlayersList, ...liveEnemiesList];

        combatants.forEach(combatant => {
            if (combatant.hp > 0) {
                const weaponRef = combatant.equipment?.weapon;
                const resolvedWeapon = weaponRef?.id
                    ? itemGenerator.resolveItem('weapon', weaponRef.id, weaponRef.level || 1, weaponRef.rarity || 1)
                    : null;
                const weaponAspd = resolvedWeapon?.attackSpeed ?? 1.0;
                let fillAmount = (0.7 + agiFillRate * weaponAspd) * (1.1 + combatant.agi / 244 + weaponAspd / 20 + (combatant.equipment?.shoes?.defense || combatant.shoes || 3) / 122);
                combatant.actionBar = Math.min(combatant.maxActionBar, combatant.actionBar + fillAmount);
                
                // Process DoT, HoT, and action slow effects for this combatant
                if (combatant.dots && combatant.dots.length > 0) {
                    // Process individual DoT for this combatant
                    for (let i = combatant.dots.length - 1; i >= 0; i--) {
                        const dot = combatant.dots[i];
                        dot.tickCount++;
                        dot.duration--;
                        
                        // Apply damage (bypasses AP as specified)
                        // DoT on a player (combatant not an enemy) originates from an enemy -> reduce it
                        let damage = Math.max(1, Math.floor(dot.damagePerTick * (1 + dot.tickCount * 0.05)));
                        if (!combatant.isEnemy) damage = Math.max(1, Math.floor(damage * ENEMY_DAMAGE_MULTIPLIER));
                        // Prevent DoT from killing characters - leave at least 1 HP
                        combatant.hp = Math.max(1, combatant.hp - damage);
                        
                        // Find the source for credit attribution
                        let source = null;
                        if (!combatant.isEnemy) {
                            source = party.players.get(dot.sourceId);
                        } else {
                            // Find source among players
                            source = livePlayersList.find(p => p.id === dot.sourceId);
                        }
                        
                        // Track damage in combat stats
                        if (source && party.combatStats) {
                            const stats = party.combatStats.get(source.id);
                            if (stats) {
                                if (!stats.totalDotDamage) stats.totalDotDamage = 0;
                                stats.totalDotDamage += damage;
                            }
                        }
                        
                        // Remove DoT if duration is up
                        if (dot.duration <= 0) {
                            combatant.dots.splice(i, 1);
                        }
                    }
                }
                
                if (combatant.hots && combatant.hots.length > 0) {
                    // Process individual HoT for this combatant
                    for (let i = combatant.hots.length - 1; i >= 0; i--) {
                        const hot = combatant.hots[i];
                        hot.tickCount++;
                        hot.duration--;
                        
                        // Apply healing
                        const healAmount = Math.max(1, Math.floor(hot.healPerTick * (1 + hot.tickCount * 0.05)));
                        // Don't over-heal - respect max HP
                        combatant.hp = Math.min(combatant.maxHp, combatant.hp + healAmount);
                        
                        // Find the source for credit attribution
                        let source = null;
                        if (!combatant.isEnemy) {
                            source = party.players.get(hot.sourceId);
                        } else {
                            // Find source among players
                            source = livePlayersList.find(p => p.id === hot.sourceId);
                        }
                        
                        // Track healing in combat stats
                        if (source && party.combatStats) {
                            const stats = party.combatStats.get(source.id);
                            if (stats) {
                                if (!stats.totalHotHealing) stats.totalHotHealing = 0;
                                stats.totalHotHealing += healAmount;
                            }
                        }
                        
                        // Remove HoT if duration is up
                        if (hot.duration <= 0) {
                            combatant.hots.splice(i, 1);
                        }
                    }
                }
                
                if (combatant.actionBar >= combatant.maxActionBar) {
                    // Spell casting is handled by a separate ~100ms timer (see startActionBarSystem).
                    // The action bar now drives weapon attacks exclusively.
                    performActionBarAttack(combatant, partyId, party);
                    combatant.actionBar -= combatant.maxActionBar;
                }
            }
        });
    }, 50); // Every 50ms

    actionIntervals.set(partyId, interval);
}

// Helper functions for performActionBarAttack
function selectTarget(actor, livePlayers, liveEnemies) {
    if (actor.isEnemy) {
        const targetChoice = Math.round(Math.random() * 17);
        if (targetChoice < 15) {
            const maxPlayerHp = Math.max(...livePlayers.map(p => p.maxHp), 1);
            return livePlayers.sort((b, a) => {
                const scoreA = 0.5 * a.hp + 0.5 * (a.hp / a.maxHp) * maxPlayerHp;
                const scoreB = 0.5 * b.hp + 0.5 * (b.hp / b.maxHp) * maxPlayerHp;
                return scoreA - scoreB;
            })[0];
        }
        return livePlayers.sort((a, b) => Math.random() * a.hp - Math.random() * b.hp)[0];
    }
    return liveEnemies.sort((a, b) => a.hp - b.hp)[0];
}

function calculateAttackMods(actor) {
    const activeWeapon = characters.getActiveWeapon(actor);
    const weaponClass = characters.getActiveWeaponClass(actor);
    const effectiveWeapon = activeWeapon?.damage || activeWeapon?.level || 0;
    const mod = 2 + effectiveWeapon;
    const modD = 0.1 + effectiveWeapon * 0.7 + effectiveWeapon * (1.3 + Math.random() / 3);
    return { mod, modD, weaponClass };
}

function calculateRoll(actor, target, mod, party, partyId) {
    const luk = characters.getEffectiveAttribute(actor, 'luk');
    let roll = Math.floor(Math.random() * (80 + mod / 2 + luk * 2) + 1 + mod / 6 + luk * Math.random() * 0.3);
    roll = roll * (0.2 + Math.random() * 3);
    roll -= Math.floor(target.agi / 9 + target.agi * Math.random() * 1.4);
    roll = roll > 70 ? Math.round(Math.pow(roll, 0.9)) : Math.round(roll);
    return roll || 0;
}

function calculateDamage(actor, modD, roll) {
    const weaponClass = characters.getActiveWeaponClass(actor);
    const activeWeapon = characters.getActiveWeapon(actor);
    const resolvedWeapon = activeWeapon?.id
        ? itemGenerator.resolveItem('weapon', activeWeapon.id, activeWeapon.level || 1, activeWeapon.rarity || 1)
        : null;
    const effectiveDamage = resolvedWeapon?.damage || 3;
    const damMod = modD / 1.1 + effectiveDamage / 1.1;
    let damage = Math.random() * (0.5 + modD * 0.3) + damMod * 1.2 + modD * 1.2;
    const weaponData = weapons.find(w => w.id === activeWeapon?.id) || activeWeapon;
    damage *= characters.getAttributeDamageModifier(actor, weaponData);
    if (actor.isEnemy) damage *= ENEMY_DAMAGE_MULTIPLIER;
    return damage;
}

function updateCombatStats(actor, party, hit, crit, damage, roll) {
    if (actor.isEnemy) return;
    
    if (!party.combatStats.has(actor.id)) {
        party.combatStats.set(actor.id, { attacks: 0, hits: 0, totalDamage: 0, rollSum: 0, totalHealed: 0, crits: 0, maxDamage: 0 });
    }
    
    const stats = party.combatStats.get(actor.id);
    stats.attacks++;
    if (hit) {
        stats.hits++;
        stats.totalDamage += damage;
        stats.rollSum += roll;
        stats.maxDamage = Math.max(stats.maxDamage, damage);
        if (crit) stats.crits++;
    }
}

function handlePlayerDeath(partyId, party, player) {
    player.equipment = {};
    player.inventory = Array.isArray(player.inventory) ? player.inventory : [];
    
    // Recalculate derived stats without gear bonuses
    characters.calcMiscStats(player);
    player.maxHp = characters.calcMaxHp(player);
    player.maxMp = characters.calcMaxMp(player);
    player.maxAp = characters.calcMaxAp(player);
    
    // Restore minimal HP so the saved character isn't permanently dead on rejoin
    player.hp = Math.max(1, Math.floor(player.maxHp * 0.1));
    player.mp = player.maxMp;
    player.ap = player.maxAp;
    player.actionBar = 0;
    
    // Save character state after permanent gear loss
    saveCharacter(player.name, player);
    
    // Remove from current party
    party.players.delete(player.id);
    
    // Disconnect the socket
    io.sockets.sockets.get(player.id)?.disconnect();
}

function applyDamage(target, damage, partyId, party) {
    // Vulnerability debuff: target takes increased incoming damage
    const vulnerability = skillEngine.sumDebuffAmount(target.vulnerabilityEffects, 2.0);
    if (vulnerability > 0) {
        damage = damage * (1 + vulnerability);
    }

    // Correct AP absorption logic: AP absorbs its full value before HP takes damage
    const apDamage = Math.min(damage * 0.5, target.ap);
    target.ap -= apDamage;
    const remainingDamage = damage - apDamage;
    
    if (remainingDamage > 0) {
        target.hp -= remainingDamage;
    }
    
    // The consolidated emitter sends HP/MP/AP immediately on the critical
    // cadence, so no separate queue call is needed here.
    
    if (target.hp <= 0 && !target.isEnemy) {
        handlePlayerDeath(partyId, party, target);
        const deathMsg = `${target.name} has fallen and lost their gear! 💥`;
        // Send death event as critical update - prefer WebRTC
        const deathPacket = { 
            type: 'death', 
            playerId: target.id,
            playerName: target.name, 
            message: deathMsg 
        };
        broadcastToParty(partyId, 'combatEvent', deathPacket);
        // Also send event log via WebRTC
        broadcastToParty(partyId, 'eventLog', { message: deathMsg, type: 'death' });
    }
}

// Perform action bar attack
function performActionBarAttack(actor, partyId, party) {
    const target = selectTarget(actor, livePlayers(party), liveEnemies(party));
    if (!target) return;

    const { mod, modD } = calculateAttackMods(actor);
    let roll = calculateRoll(actor, target, mod, party, partyId);
    const hit = roll > 0, crit = roll > 99;
    
    updateCombatStats(actor, party, hit, crit, 0, roll);

    let damage = 1;
    if (hit) {
        roll += Math.round(0.5 * actor.luk + Math.random() * actor.luk * 1.2);
        damage = calculateDamage(actor, modD, roll);

        // Weaken debuff: the attacker's outgoing damage is reduced
        const weaken = skillEngine.sumDebuffAmount(actor.weakenEffects, 0.9);
        if (weaken > 0) {
            damage = damage * (1 - weaken);
        }

        const rawDamage = damage; // pre-mitigation damage

        // Defense-Down debuff: the target's damage mitigation is reduced
        const defenseDown = skillEngine.sumDebuffAmount(target.defenseDownEffects, 0.9);
        const mitigationTerm = (0.2 * Math.random() * (target.equipment?.helmet?.defense || target.helmet || 1) + 0.3 * Math.random() * (target.equipment?.armour?.defense || target.armour || 0) + 0.1 * Math.random() * (target.equipment?.shoes?.defense || target.shoes || 0) + 0.003 * Math.random() * target.vit + 0.001 * Math.random() * target.for) / 6;
        const defenseUp = skillEngine.sumDebuffAmount(target.defenseUpEffects, 0.5);
        const effectiveMitigation = (defenseDown > 0 ? mitigationTerm * (1 - defenseDown) : mitigationTerm) + defenseUp;
        const cappedMitigation = Math.min(effectiveMitigation, rawDamage * 0.85);
        damage = Math.max(0, Math.round(damage - cappedMitigation));
        const mitigated = Math.max(0, rawDamage - damage + 1);
        updateCombatStats(actor, party, true, crit, damage, roll);
        applyDamage(target, damage, partyId, party);

        const weaponSkillId = skillEngine.getWeaponSkillId(characters.getActiveWeapon(actor));
        if (!actor.isEnemy && actor.skillsState) {
            actor.skillsState = skillEngine.awardSkillXp(actor.skillsState, weaponSkillId, Math.max(1, Math.round(damage / 24)));
        }
        
        // Award armor proficiency XP to the player being hit, based on damage mitigated,
        // split across the proficiencies of their worn armor pieces (by piece count).
        if (!target.isEnemy && target.skillsState && mitigated > 0) {
            target.skillsState = skillEngine.awardArmorProficiencyXp(target.skillsState, mitigated * 5, target);
        }
    }

    if (target.isEnemy && target.hp <= 0) awardXP(partyId, party);
    
    broadcastCriticalUpdate(partyId, party, {
        actor: { ...actor },
        target: { ...target, isEnemy: target.isEnemy || false },
        hit,
        crit,
        damage,
        roll
    });
}

// Award XP to players
function awardXP(partyId, party) {
    const deadEnemies = party.enemies.filter(e => e.hp <= 0);
    party.enemies = party.enemies.filter(e => e.hp > 0);

    const livePlayers = Array.from(party.players.values()).filter(p => p.hp > 0);
    let leveledUpPlayers = [];
    
    deadEnemies.forEach(enemy => {
        if (livePlayers.length > 0) {
            const xpShare = enemy.xpValue / livePlayers.length;
            livePlayers.forEach(player => {
                player.xp += xpShare;

                let goldShare = (enemy.gold + xpShare / 128);
                player.gold += (0.002 + goldShare) + Math.random() * (goldShare + player.luk) / 333;
                // Prevent infinite loop if xpToNext is 0 or invalid
                if (player.xpToNext <= 0) player.xpToNext = 128;
                while (player.xp >= player.xpToNext) {
                    player.xp -= player.xpToNext;
                    player.level++;
                    player.xpToNext = Math.floor((player.xpToNext + 8) * 1.08);
                    player.pointsToAllocate += Math.floor(3);

                    // 🩸 Level-up HP gain scales with vitality
                    const newMaxHp = characters.calcMaxHp(player);
                    const hpDiff = newMaxHp - player.maxHp;
                    player.maxHp = newMaxHp;
                    player.hp = Math.min(player.maxHp, player.hp + hpDiff);

                    const newMaxMp = characters.calcMaxMp(player);
                    const mpDiff = newMaxMp - player.maxMp;
                    player.maxMp = newMaxMp;
                    player.mp = Math.min(player.maxMp, player.mp + mpDiff);

                    // Recalculate max AP on level up
                    const newMaxAp = characters.calcMaxAp(player);
                    const apDiff = newMaxAp - player.maxAp;
                    player.maxAp = newMaxAp;
                    player.ap = Math.min(player.maxAp, player.ap + apDiff);

                    // Track leveled up players for critical update
                    leveledUpPlayers.push({
                        id: player.id,
                        name: player.name,
                        level: player.level,
                        hp: player.hp,
                        maxHp: player.maxHp,
                        maxMp: player.maxMp,
                        maxAp: player.maxAp
                    });
                    
                    // Send level up event via WebRTC preferred
                    const levelUpPacket = {
                        message: player.name + ' advanced to level ' + player.level + '!',
                        type: 'success'
                    };
                    broadcastToParty(partyId, 'eventLog', levelUpPacket);
                }
                characters.calcMiscStats(player);
                saveCharacter(player.name, player);
            });
        }
    });
    
    // OPTIMIZATION: Send targeted critical update for leveled up players instead of full state
    if (leveledUpPlayers.length > 0) {
        broadcastCriticalUpdate(partyId, party, {
            actor: null,
            target: null,
            leveledUp: leveledUpPlayers
        });
    }
    
    // Prefer WebRTC for full state after XP award
    broadcastFullState(partyId, party);
}

const actionIntervals = new Map();
const spellCastIntervals = new Map();

// Debug function: Poll server stats every 30 seconds
setInterval(() => {
    console.log('=== Server Stats ===');
    console.log(`Total connected clients: ${io.sockets.sockets.size}`);
    console.log(`Total parties: ${parties.size}`);
    const mem = process.memoryUsage();
    console.log(`Memory: RSS ${Math.round(mem.rss / 1024 / 1024)}MB, Heap Used ${Math.round(mem.heapUsed / 1024 / 1024)}MB, Heap Total ${Math.round(mem.heapTotal / 1024 / 1024)}MB`);
    console.log(`Uptime: ${Math.round(process.uptime())} seconds`);
    console.log(`Active action intervals: ${actionIntervals.size}`);
    console.log(`Active spawn timers: ${spawnTimers.size}`);
    for (const [partyId, party] of parties) {
        const room = io.sockets.adapter.rooms.get(partyId);
        const connectedSockets = room ? room.size : 0;
        console.log(`Party ${partyId}: ${party.players.size} players, ${connectedSockets} connected, Floor ${party.floor}, Combat: ${party.combatActive}`);
        if (room) {
            const socketList = Array.from(room).map(id => {
                const sock = io.sockets.sockets.get(id);
                return `${id}(${sock ? sock.ping : 'unknown'}ms)`;
            }).join(', ');
            console.log(`  Connected sockets: ${socketList}`);
        }
    }
    console.log('===================');
}, 8000);

// Periodic shop sweep: every 5 minutes, drop any shop item older than
// characters.SHOP_ITEM_MAX_AGE_MS. Items without a timestamp (legacy/pre-feature stock)
// are kept for backward compatibility.
setInterval(() => {
    const now = Date.now();
    let partiesScanned = 0;
    let itemsRemoved = 0;

    for (const [partyId, party] of parties) {
        if (!party || !Array.isArray(party.shopStock) || party.shopStock.length === 0) continue;
        const before = party.shopStock.length;
        const kept = party.shopStock.filter(item => {
            if (item.timestamp === undefined) return true; // don't expire legacy items
            return (now - item.timestamp) < characters.SHOP_ITEM_MAX_AGE_MS;
        });
        if (kept.length !== before) {
            itemsRemoved += before - kept.length;
            party.shopStock = kept;
            broadcastCriticalGearUpdate(partyId, party);
        }
        partiesScanned++;
    }

    if (itemsRemoved > 0 || partiesScanned > 0) {
        console.log(`[Shop Sweep] Scanned ${partiesScanned} parties, removed ${itemsRemoved} expired items.`);
    }
}, 5 * 60 * 1000);

// ═══════════════════════════════════════════════════════════════════
// UNIFIED REGENERATION SYSTEM - Consolidates HP/MP/AP regen + Saint system
// ═══════════════════════════════════════════════════════════════════
function startRegenSystem() {
    setInterval(() => {
        for (const [partyId, party] of parties) {
            const inCombat = party.combatActive, live = livePlayers(party);
            if (live.length === 0) continue;
            
            if (party.floor === 0) live.forEach(p => p.ap = Math.min(p.maxAp, p.ap + 5));
            
            live.forEach(p => {
                // HP Regen (effective attributes include equipment bonuses)
                let hpRegen = (inCombat ? 0.11 : 0.17) + characters.getEffectiveAttribute(p, 'vit') / 288 + characters.getEffectiveAttribute(p, 'str') / 344 + characters.getEffectiveAttribute(p, 'for') / 377 + characters.getEffectiveAttribute(p, 'pie') / 533;
                p.hp = Math.min(p.maxHp, p.hp + hpRegen * (inCombat ? 2.2 : 3.6));

                // MP Regen (effective attributes include equipment bonuses)
                let mpRegen = (inCombat ? 0.07 : 0.17) + characters.getEffectiveAttribute(p, 'int') / 422 + characters.getEffectiveAttribute(p, 'cnc') / 311 + characters.getEffectiveAttribute(p, 'wis') / 377 + characters.getEffectiveAttribute(p, 'pie') / 422;
                p.mp = Math.min(p.maxMp, p.mp + mpRegen * (inCombat ? 0.9 : 1.8));
                
                // HP/MP changes are emitted by the consolidated delta broadcaster
                // on the critical cadence (≤200ms), so no extra queueing here.
            });
        }
    }, 100);
}

function startBroadcastSystem() {
    const interval = setInterval(() => {
        const now = Date.now();
        const isCombat = (party) => party.combatActive;
        const isTown = (party) => party.floor === 0;

        for (const [partyId, party] of parties.entries()) {
            // No live players in this party: nothing to broadcast.
            let hasLive = false;
            for (const p of party.players.values()) {
                if (p.hp > 0) { hasLive = true; break; }
            }
            if (!hasLive) continue;

            // Single consolidated emitter: computes each player's delta once and
            // emits a single coalesced gameDelta on the 50ms cadence below (the
            // sole state channel). emitPartyDeltas also self-gates at 50ms so a
            // faster caller would still coalesce; at 50ms it fires every tick.
            emitPartyDeltas(partyId, party, now);

            // Update max action bar during combat (derived from live player count).
            if (isCombat(party)) {
                const live = livePlayers(party);
                for (const p of live) p.maxActionBar = 105 + live.length;
            }

            // Persist character data less frequently (~2.5s). At the 50ms cadence
            // this probability yields ~2.5s between saves (0.02 * 50ms = 1s avg,
            // ~2.5s expected for the loop to land true per player).
            if (Math.random() < 0.02) {
                for (const p of party.players.values()) if (p.hp > 0) saveCharacter(p.name, p);
            }
        }
    }, 70); // Coalescing cadence: produce a gameDelta every ~70ms
    return interval;
}


// ═══════════════════════════════════════════════════════════════════
// SINGLE CONSOLIDATED DELTA EMITTER
// Computes ONE delta per player/enemy and emits a single combined `gameDelta`
// event (replacing the old critical/standard/background/hpMp split). The full
// PLAYER_DELTA_FIELDS union is transmitted per changed player so nothing is
// dropped between passes, and the shared baseline is advanced exactly once.
// Enemy deltas are computed here too and carried on the same gameDelta.
// `combatEvent` (per-hit actor/target flash) remains a distinct channel.
// ═════════════════════════════════════════════════════════════════
const lastGameDelta = new Map(); // partyId -> last coalesced emit timestamp (50ms gate)

function emitPartyDeltas(partyId, party, now) {
    const GAME_DELTA_INTERVAL = 60;
    const last = lastGameDelta.get(partyId) || 0;
    if (now - last < GAME_DELTA_INTERVAL) return;
    lastGameDelta.set(partyId, now);

    const delta = { partyId, timestamp: now, playerUpdates: {}, enemyUpdates: {} };

    // Party-level fields: only include a field when it differs from the last
    // sent value. Advances the baseline per field so unchanged fields are not
    // re-shipped every tick (the three map fields are large and change rarely).
    const PARTY_DELTA_FIELDS = ['combatActive', 'combatTurn', 'floor', 'dungeon',
        'dungeonFloors', 'highestVisitedFloors', 'completedDungeons', 'autoEmbark'];
    const partyPrev = partyLastState.get(partyId) || {};
    const partyNext = {};
    let partyDirty = false;
    for (const f of PARTY_DELTA_FIELDS) {
        const cur = party[f] !== undefined ? party[f] : (f === 'dungeonFloors' || f === 'highestVisitedFloors' || f === 'completedDungeons' ? {} : undefined);
        const prev = partyPrev[f] !== undefined ? partyPrev[f] : (f === 'dungeonFloors' || f === 'highestVisitedFloors' || f === 'completedDungeons' ? {} : undefined);
        partyNext[f] = cur;
        if (utils.deepEqual(cur, prev)) continue;
        delta[f] = cur;
        partyDirty = true;
    }

    // Per-player: snapshot the union of all changed PLAYER_DELTA_FIELDS.
    for (const [socketId, player] of party.players) {
        const playerDelta = getPlayerDelta(socketId, player, PLAYER_DELTA_FIELDS);
        if (!playerDelta) continue;
        delta.playerUpdates[socketId] = {
            id: socketId, name: player.name, isDead: player.hp <= 0, ...playerDelta
        };
    }

    // Enemy deltas: full snapshot only the first time an enemy is seen on this
    // channel, partial (changed ENEMY_DELTA_FIELDS + id + isDead) thereafter.
    if (party.enemies?.length) {
        for (const enemy of party.enemies) {
            const enemyDelta = getEnemyDelta(enemy.id, enemy);
            if (!enemyDelta) continue;
            if (enemyFullSent.has(enemy.id)) {
                delta.enemyUpdates[enemy.id] = { id: enemy.id, isDead: enemy.hp <= 0, ...enemyDelta };
            } else {
                delta.enemyUpdates[enemy.id] = { ...enemy, id: enemy.id, isDead: enemy.hp <= 0 };
                enemyFullSent.add(enemy.id);
            }
        }
    }

    // Skip the entire packet when nothing changed for any player/enemy/party field.
    if (!partyDirty && Object.keys(delta.playerUpdates).length === 0 && Object.keys(delta.enemyUpdates).length === 0) {
        return;
    }

    // Advance the party-level baseline for every field we tracked.
    partyLastState.set(partyId, partyNext);

    broadcastToParty(partyId, 'gameDelta', delta);
}

// ⚑ Embark Dungeon helper (starts at relative floor 1 and only runs floor-by-floor)
// Returns true if the party embarked, false otherwise.
function embarkParty(partyId, party, dungeon) {
    // Only embark from town and not in combat
    if (party.combatActive || party.floor !== 0) {
        broadcastToParty(partyId, 'eventLog', { message: 'You can only embark from Town (floor 0).', type: 'error' });
        return false;
    }

    // Check if dungeon exists
    if (!dungeons[dungeon]) {
        broadcastToParty(partyId, 'eventLog', { message: `Unknown dungeon: ${dungeon}`, type: 'error' });
        return false;
    }

    // Check if dungeon is unlocked
    if (!characters.isDungeonUnlocked(party, dungeon)) {
        broadcastToParty(partyId, 'eventLog', { message: `Dungeon ${dungeon} is locked until you complete the previous dungeon.`, type: 'error' });
        return false;
    }

    // Switch dungeon
    party.dungeon = dungeon;

    if (!party.dungeonFloors) party.dungeonFloors = {};
    if (!party.highestVisitedFloors) party.highestVisitedFloors = {};
    if (!party.completedDungeons) party.completedDungeons = {};

    // Start at relative floor 1
    party.dungeonFloors[dungeon] = 1;
    party.floor = 1;

    // Update highest visited
    const currentHighest = party.highestVisitedFloors[dungeon] || 0;
    if (!party.highestVisitedFloors[dungeon] || 1 > currentHighest) {
        party.highestVisitedFloors[dungeon] = 1;
    }

    // Reset enemies/combat
    party.enemies = [];
    party.combatActive = false;
    party.combatTurn = 0;
    // Reset player action bars
    Array.from(party.players.values()).forEach(p => {
        p.actionBar = 0;
        saveCharacter(p.name, p);
    });

    generateEnemies(party);
    party.combatActive = true;
    startActionBarSystem(partyId, party);

    const embarkPacket = {
        partyId,
        dungeon: party.dungeon,
        floor: party.floor,
        dungeonFloors: party.dungeonFloors,
        highestVisitedFloors: party.highestVisitedFloors,
        completedDungeons: party.completedDungeons,
        combatActive: party.combatActive,
        enemies: party.enemies,
        timestamp: Date.now()
    };

    seedEnemyFullSent(party);
    broadcastToParty(partyId, 'dungeonChange', embarkPacket);
    broadcastToParty(partyId, 'eventLog', { message: `🚀 Embarked on ${dungeon} (Floor 1)!`, type: 'success' });
    return true;
}

// ═══════════════════════════════════════════════════════════════════
// CONNECTION HANDLER - Centralized socket connection management
// ═══════════════════════════════════════════════════════════════════
io.on('connection', (socket) => {
    console.log(`[CONNECTION] New socket connected: ${socket.id} from ${socket.handshake.address}`);
    
    // Performance optimization: Track socket
    socketMap.set(socket.id, socket);
    
    // Ping measurement - send pings every 2 seconds for faster initial measurement
    socket.ping = 0;
    socket.pingInterval = setInterval(() => {
        utils.trackSocketIoSent('ping', Date.now());
        socket.emit('ping', Date.now());
    }, 2000);
    socket.on('pong', (timestamp) => {
        utils.trackSocketIoReceived('pong', { timestamp });
        socket.ping = Date.now() - timestamp;
        // Send server-measured ping to client for display
        utils.trackSocketIoSent('pingUpdate', socket.ping);
        socket.emit('pingUpdate', socket.ping);
    });
    socket.on('disconnect', (reason) => handleDisconnect(socket, reason));

    // Note: WebRTC signaling handlers (webrtc-offer, webrtc-signal, batchPreference)
    // are now handled by webrtcServer.setupSocketIOHandlers(io) called at initialization

    socket.on('joinParty', (data) => handleJoinParty(socket, data));
    
    socket.on('allocatePoints', (data) => handleAllocatePoints(socket, data));
    
    // 🏃 Escape Dungeon handler (return to Town after combat, reset progress)
    socket.on('escapeDungeon', (data) => handleEscapeDungeon(socket, data));

    // ⚑ Embark Dungeon handler (starts at relative floor 1 and only runs floor-by-floor)
socket.on('embarkDungeon', (data) => handleEmbarkDungeon(socket, data));

    // 🔁 Toggle Auto-Embark (re-embark on the same dungeon automatically when returning to Town)
    socket.on('toggleAutoEmbark', (data) => handleToggleAutoEmbark(socket, data));

// 🎲 Change Dungeon handler
socket.on('changeDungeon', (data) => handleChangeDungeon(socket, data));

    socket.on('leaveParty', (partyId) => handleLeaveParty(socket, partyId));
    socket.on('equipItem', (data) => handleEquipItem(socket, data));

    socket.on('assignAbilitySlot', (data) => {
        utils.trackSocketIoReceived('assignAbilitySlot', data);
        const { partyId, slotIndex, abilityId } = data || {};
        const party = parties.get(partyId);
        if (!party) return;
        const player = party.players.get(socket.id);
        if (!player) return;

        const slot = Number(slotIndex);
        if (!Number.isInteger(slot) || slot < 0 || slot >= 8) {
            socket.emit('eventLog', { message: 'Invalid ability slot.', type: 'error' });
            return;
        }

        if (abilityId && !abilities.some(ability => ability.id === abilityId)) {
            socket.emit('eventLog', { message: 'Unknown ability.', type: 'error' });
            return;
        }

        // Validate skill requirements for the ability
        if (abilityId) {
            const ability = abilities.find(a => a.id === abilityId);
            if (ability && ability.unlockSkillLevelMin) {
                const requiredSkillLevel = ability.unlockSkillLevelMin;
                const skillId = ability.skillId;
                
                // Calculate the player's skill level for this skill
                const playerSkillXp = (player.skillsState?.[skillId]?.xp || 0);
                const playerSkillLevel = utils.calcSkillLv(playerSkillXp);
                
                if (playerSkillLevel < requiredSkillLevel) {
                    socket.emit('eventLog', { 
                        message: `Cannot assign ${ability.name}: Requires level ${requiredSkillLevel} ${skillId.replace('skill_', '').replace('_', ' ')}`, 
                        type: 'error' 
                    });
                    return;
                }
            }
        }

        player.abilitySlots = Array.isArray(player.abilitySlots) ? player.abilitySlots : [];
        const nextSlots = Array.from({ length: 8 }, (_, index) => player.abilitySlots[index] || null);
        if (abilityId) {
            const dupIndex = nextSlots.findIndex((id, i) => i !== slot && id === abilityId);
            if (dupIndex !== -1) nextSlots[dupIndex] = null;
        }

        nextSlots[slot] = abilityId;
        player.abilitySlots = nextSlots;
        saveCharacter(player.name, player);
        broadcastPlayerUpdate(partyId, party, socket.id);
        socket.emit('eventLog', { message: `Assigned ${abilityId || 'nothing'} to slot ${slot + 1}.`, type: 'success' });
    });

    socket.on('unequipItem', (data) => handleUnequipItem(socket, data));

    socket.on('useItem', (data) => handleUseItem(socket, data));

    socket.on('sellItem', (data) => handleSellItem(socket, data));

    socket.on('disconnect', () => handleLateDisconnect(socket));

    // Register shop purchase handlers
    socket.on('buyRandomGear', (partyId) => handleGearPurchase(socket, 'randomGear', partyId));
    socket.on('buyArmour', (partyId) => handleGearPurchase(socket, 'armour', partyId));
    socket.on('buyWeapon', (partyId) => handleGearPurchase(socket, 'weapon', partyId));
    socket.on('buyWeaponMelee', (partyId) => handleGearPurchase(socket, 'weaponMelee', partyId));
    socket.on('buyWeaponRanged', (partyId) => handleGearPurchase(socket, 'weaponRanged', partyId));
    socket.on('buyWeaponMagic', (partyId) => handleGearPurchase(socket, 'weaponMagic', partyId));
    socket.on('buyShoes', (partyId) => handleGearPurchase(socket, 'shoes', partyId));
    socket.on('buyHelmet', (partyId) => handleGearPurchase(socket, 'helmet', partyId));
    
    // Handle purchases from shop stock
    socket.on('buyShopItem', (data) => {
        if (data && data.partyId && data.index !== undefined) {
            handleGearPurchase(socket, `shop_${data.index}`, data.partyId);
        }
    });

    socket.on('donate', (data) => handleDonate(socket, data));
});

// 🩸 Start global regeneration and broadcast system
const regenIntervalId = startRegenSystem();
const broadcastIntervalId = startBroadcastSystem();

// Initialize DoT system
function initDotSystem() {
    const EFFECT_FIELDS = ['dots', 'hots', 'actionSlowEffects', 'weakenEffects', 'vulnerabilityEffects', 'defenseDownEffects', 'defenseUpEffects'];
    const hasActiveEffects = (party) => {
        const combatants = [...party.players.values(), ...(party.enemies || [])];
        return combatants.some(c => EFFECT_FIELDS.some(f => Array.isArray(c[f]) && c[f].length > 0));
    };
    // Process DoTs every 1000ms for all parties (reduced from 160ms for less bandwidth)
    const dotInterval = setInterval(() => {
        for (const [partyId, party] of parties.entries()) {
            // The process* calls are no-op-safe on empty effect arrays, so only
            // gate the broadcast: skip the delta flush when no combatant has any
            // active DoT/HoT/debuff/buff effect this tick.
            const active = hasActiveEffects(party);

            // Process DoT ticks
            skillEngine.processDotTicks(party);
            
            skillEngine.processHotTicks(party);
            
            // Process action slow effects using the new function from skillEngine
            skillEngine.processActionSlowEffects(party);

            // Process witchcraft debuff effects using the new functions from skillEngine
            skillEngine.processWeakenEffects(party);
            skillEngine.processVulnerabilityEffects(party);
            skillEngine.processDefenseDownEffects(party);
            skillEngine.processDefenseUpEffects(party);

            // OPTIMIZATION: only flush a critical delta update when effects were
            // active (or just expired) this tick, instead of every party every second.
            if (active) {
                broadcastCriticalUpdate(partyId, party);
            }
        }
    }, 1000);
    return dotInterval;
}

// Start DoT system
const dotIntervalId = initDotSystem();

server.listen(25561, () => {
    console.log('🩸 AGI Action Bar RPG with VIT Regeneration on port 25561');
});