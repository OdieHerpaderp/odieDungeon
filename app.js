// odieDungeon
// Global tuning: multiplier applied to all damage dealt BY enemies (1.0 = unchanged, 0.5 = -50%)
const ENEMY_DAMAGE_MULTIPLIER = 0.8;
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
const armors = require('./public/gear/armors.json');
const headgear = require('./public/gear/headgear.json');
const feetWear = require('./public/gear/feetWear.json');
const itemGenerator = require('./public/gear/itemGenerator');

function assert(condition, message) {
    if (!condition) throw new Error(`[ASSERT] ${message}`);
}

// Load dungeons configuration
const dungeons = require('./public/dungeons.json');

// ═══════════════════════════════════════════════════════════════════
// UNIFIED BROADCAST SYSTEM - Consolidates 6 broadcast functions into 2
// ═══════════════════════════════════════════════════════════════════
function buildUpdatePacket(party, partyId, updateType) {
    const packet = { partyId, timestamp: Date.now() };
    const livePlayers = Array.from(party.players.values()).filter(p => p.hp > 0);
    
    switch (updateType) {
        case 'critical':
            packet.playerUpdates = {};
            for (const [socketId, player] of party.players) {
                const delta = getPlayerDelta(socketId, player, CRITICAL_DELTA_FIELDS);
                if (delta && (delta.hp !== undefined || delta.ap !== undefined)) {
                    packet.playerUpdates[socketId] = {
                        hp: player.hp, maxHp: player.maxHp,
                        ap: player.ap, maxAp: player.maxAp, isDead: player.hp <= 0
                    };
                }
            }
            if (party.enemies?.length) {
                packet.enemyUpdates = {};
                for (const enemy of party.enemies) {
                    const delta = getEnemyDelta(enemy.id, enemy);
                    if (delta?.hp !== undefined || delta?.ap !== undefined) {
                        packet.enemyUpdates[enemy.id] = { id: enemy.id, name: enemy.name, hp: enemy.hp, maxHp: enemy.maxHp, ap: enemy.ap, maxAp: enemy.maxAp, isDead: enemy.hp <= 0 };
                    }
                }
            }
            break;
            
        case 'standard':
            packet.playerUpdates = {};
            for (const [socketId, player] of party.players) {
                const delta = getPlayerDelta(socketId, player, STANDARD_DELTA_FIELDS);
                if (delta && (delta.actionBar !== undefined || delta.level !== undefined || delta.skillsState !== undefined)) {
                    packet.playerUpdates[socketId] = { id: socketId, name: player.name, actionBar: player.actionBar, maxActionBar: player.maxActionBar, level: player.level, hp: player.hp, maxHp: player.maxHp, isDead: player.hp <= 0, skillsState: player.skillsState };
                }
            }
            if (party.enemies?.length) {
                packet.enemyUpdates = {};
                for (const enemy of party.enemies) {
                    const delta = getEnemyDelta(enemy.id, enemy);
                    if (delta && Object.keys(delta).length > 0) {
                        packet.enemyUpdates[enemy.id] = { id: enemy.id, name: enemy.name, hp: enemy.hp, maxHp: enemy.maxHp, ap: enemy.ap, maxAp: enemy.maxAp, actionBar: enemy.actionBar, maxActionBar: enemy.maxActionBar, isDead: enemy.hp <= 0 };
                    }
                }
            }
            packet.combatActive = party.combatActive;
            packet.combatTurn = party.combatTurn;
            break;
            
        case 'background':
            packet.playerUpdates = {};
            const bgFields = ['xp', 'gold', 'str', 'dex', 'agi', 'vit', 'int', 'cnc', 'wis', 'for', 'luk', 'pie', 'pointsToAllocate', 'abilitySlots', 'abilityCooldowns', 'equipment', 'inventory'];
            for (const [socketId, player] of party.players) {
                const delta = getPlayerDelta(socketId, player, BACKGROUND_DELTA_FIELDS);
                if (delta) {
                    const bgDelta = {};
                    for (const f of bgFields) if (delta[f] !== undefined) bgDelta[f] = delta[f];
                    if (Object.keys(bgDelta).length > 0) {
                        bgDelta.id = socketId; bgDelta.name = player.name;
                        packet.playerUpdates[socketId] = bgDelta;
                    }
                }
            }
            packet.floor = party.floor;
            packet.dungeonFloors = party.dungeonFloors || {};
            packet.highestVisitedFloors = party.highestVisitedFloors || {};
            break;
            
        case 'full':
            // 🆕 Full state - use socket.id from Map key for all players
            packet.players = Array.from(party.players.values()).map(player => {
                // Ensure each player uses the Map key as their ID, not the potentially stale player.id
                const socketId = Array.from(party.players.entries()).find(([_, p]) => p === player)?.[0];
                return { ...player, id: socketId || player.id };
            });
            packet.enemies = party.enemies || [];
            packet.floor = party.floor;
            packet.dungeon = party.dungeon || 'field';
            packet.dungeonFloors = party.dungeonFloors || {};
            packet.highestVisitedFloors = party.highestVisitedFloors || {};
            packet.completedDungeons = party.completedDungeons || {};
            packet.combatActive = party.combatActive || false;
            packet.combatTurn = party.combatTurn || 0;
            packet.autoEmbark = party.autoEmbark || false;
            packet.shopStock = party.shopStock || []; // Include shop stock in the full state
            packet._fullState = true;
            break;
    }
    return packet;
}

function broadcastToParty(partyId, eventType, packet) {
    const sent = broadcastToPartyWebRTC(partyId, eventType, packet);
    if (sent === 0) {
        utils.trackSocketIoSent(eventType, packet);
        io.to(partyId).emit(eventType, packet);
    }
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
    
    broadcastToParty(partyId, 'criticalUpdate', buildUpdatePacket(party, partyId, 'critical'));
}

// Send shop stock + every player's inventory/equipment (+ recomputed stats) over the
// critical path (WebRTC-preferred, Socket.IO fallback). Unthrottled, so gear/shop changes
// reach clients immediately instead of waiting on the 2s background update or a full re-sync.
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
    broadcastToParty(partyId, 'criticalUpdate', packet);
}

function broadcastStandardUpdate(partyId, party) {
    broadcastToParty(partyId, 'standardUpdate', buildUpdatePacket(party, partyId, 'standard'));
}

function broadcastBackgroundUpdate(partyId, party) {
    const now = Date.now();
    const lastTime = lastBackgroundBroadcast.get(partyId) || 0;
    if (now - lastTime < 2000) return;
    lastBackgroundBroadcast.set(partyId, now);
    broadcastToParty(partyId, 'backgroundUpdate', buildUpdatePacket(party, partyId, 'background'));
}

function broadcastFullState(partyId, party) {
    broadcastToParty(partyId, 'partyUpdate', buildUpdatePacket(party, partyId, 'full'));
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

        // List at full value (same formula as the dungeon restock), min 20g.
        resolved.price = Math.max(
            20,
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
            cost = Math.max(20, Number.isFinite(calculatedValue) ? calculatedValue : 20);
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

            // Send a full state packet so the client can refresh its UI. The
            // previous implementation used `broadcastPlayerUpdate`, but that
            // only contains delta fields and missed the new equipment/inventory
            // references. A full sync guarantees the client sees the change.
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
        broadcastToParty(partyId, 'dungeonChange', dungeonChangePacket);
        broadcastToParty(partyId, 'eventLog', { message: '🏠 Escaped to Town! Dungeon progress reset.', type: 'info' });
        broadcastFullState(partyId, party);
        queueStateUpdate(partyId, ['players', 'enemies', 'floor', 'combatActive']);

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
        broadcastToParty(partyId, 'standardUpdate', autoEmbarkPacket);
    }

    function handleChangeDungeon(socket, data) {
        utils.trackSocketIoReceived('changeDungeon', data);
        const { partyId, dungeon } = data;
        const party = parties.get(partyId);
        if (!party) {
            socket.emit('eventLog', { message: 'Party not found!', type: 'error' });
            return;
        }

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

            const fullState = buildUpdatePacket(party, partyId, 'full');
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

        characters.calcMaxHp(player); characters.calcMaxMp(player);
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

function broadcastPlayerUpdate(partyId, party, socketId) {
    const player = party.players.get(socketId);
    if (!player) return;
    const delta = getPlayerDelta(socketId, player, PLAYER_DELTA_FIELDS);
    if (!delta || Object.keys(delta).length === 0) return;
    
    // Determine update type based on what changed
    const bgFields = ['gold', 'xp', 'str', 'dex', 'agi', 'vit', 'int', 'cnc', 'wis', 'for', 'luk', 'pie', 
                      'pointsToAllocate', 'skillsState', 'abilitySlots', 'abilityCooldowns', 'equipment', 'inventory'];
    
    // Check for any background fields changed
    const bgDelta = {};
    let hasBgChanges = false;
    
    for (const f of bgFields) {
        if (delta[f] !== undefined) {
            bgDelta[f] = delta[f];
            hasBgChanges = true;
        }
    }
    
    // Gear Change Check: If inventory or equipment explicitly changed, force a full state sync 
    // to ensure the client receives the structural change correctly.
    const hasMajorGearChange = delta.inventory !== undefined || delta.equipment !== undefined;
    
    // Critical Update Check: Always send critical update if HP/AP changed, regardless of other changes.
    const hasCritChange = delta.maxHp !== undefined || delta.maxAp !== undefined || delta.hp !== undefined || delta.ap !== undefined;
    
    // Always send background update when skills or equipment changes
    if (hasBgChanges) {
        if (!hasCritChange && !hasMajorGearChange) {
            // If only minor background changes occurred, proceed with standard 'backgroundUpdate'.
            const bgPacket = { 
                partyId, 
                playerUpdates: { [socketId]: { id: socketId, name: player.name, ...bgDelta } }, 
                timestamp: Date.now() 
            };
            broadcastToParty(partyId, 'backgroundUpdate', bgPacket);
        } else {
            // If critical fields changed OR major gear/inventory changes, send full state update for reliability.
            const fullStatePacket = buildUpdatePacket(party, partyId, 'full');
            
            // Prefer WebRTC over TCP
            broadcastToParty(partyId, 'partyUpdate', fullStatePacket);
        }
        
        // Also send critical update if HP/AP changed, regardless of gear changes.
        if (hasCritChange) {
            const critPacket = { 
                partyId, 
                playerUpdates: { [socketId]: { id: socketId, name: player.name, hp: player.hp, maxHp: player.maxHp, ap: player.ap, maxAp: player.maxAp } }, 
                timestamp: Date.now() 
            };
            broadcastToParty(partyId, 'criticalUpdate', critPacket);
        }
    } else if (hasCritChange || hasMajorGearChange) {
        // Standard update for action bar, level, etc. - prefer WebRTC/Full State when critical fields changed.
         const fullStatePacket = buildUpdatePacket(party, partyId, 'full');
        
        // Prefer WebRTC over TCP
        broadcastToParty(partyId, 'partyUpdate', fullStatePacket);
    } else {
        // Standard update for action bar, level, etc. - prefer WebRTC (Default if nothing special happened)
        const stdPacket = { 
            partyId, 
            playerUpdates: { [socketId]: { id: socketId, name: player.name, level: player.level, currentVenture: player.currentVenture, hp: player.hp, maxHp: player.maxHp } }, 
            timestamp: Date.now() 
        };
        broadcastToParty(partyId, 'standardUpdate', stdPacket);
    }
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
    
    // Update DoT effects display
    const livePlayers = Array.from(party.players.values()).filter(p => p.hp > 0);
    const liveEnemies = party.enemies.filter(e => e.hp > 0);
    
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
    const webrtcStats = webrtcServer.getPacketStats();
    
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
    webrtcServer.resetPacketStats();
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
    const fullState = buildUpdatePacket(targetParty, targetPartyId, 'full');
    const sent = webrtcServer.sendMessage(socketId, 'partyUpdate', fullState);
    console.log(`[WebRTC Restore] Sent full state to reconnected socket ${socketId}: ${sent ? 'ok' : 'failed'}`);

    // Re-apply the delta baseline now that the client has the canonical state.
    webrtcServer.initializePlayerDeltaState(targetPartyId, targetParty, socketId);
});

// Helper function to broadcast to party via WebRTC (delegated to webrtcServer)
function broadcastToPartyWebRTC(partyId, type, data, excludeSocket = null) {
    return webrtcServer.broadcastToPartyWebRTC(partyId, type, data, excludeSocket);
}

// Performance optimization: Client socket tracking
const socketMap = new Map(); // socketId -> socket object
const lastBackgroundBroadcast = new Map(); // partyId -> timestamp

// ═══════════════════════════════════════════════════════════════════
// DELTA COMPRESSION: Track previous state for efficient delta updates
// ═══════════════════════════════════════════════════════════════════

// Track last sent state per player (socketId -> { field: value })
const playerLastState = new Map(); // socketId -> { hp, ap, maxHp, maxAp, actionBar, level, ... }

// Track last sent state per enemy (enemyId -> { hp, maxHp, ap, actionBar })
const enemyLastState = new Map(); // enemyId -> { hp, maxHp, ap, actionBar }

// Track last sent party-level state
const partyLastState = new Map(); // partyId -> { floor, combatActive, combatTurn, highestVisitedFloors }

// ═══════════════════════════════════════════════════════════════════
// IMMEDIATE HP/MP UPDATE SYSTEM - Send updates instantly when values change
// ═══════════════════════════════════════════════════════════════════

// Track pending HP/MP changes for batching (partyId -> { socketId -> { hp, mp, ap } })
const pendingHPMpUpdates = new Map(); // partyId -> Map(socketId -> { hp, mp, ap, timestamp })

// Timer for flushing pending HP/MP updates
let hpMpFlushTimer = null;
const HP_MP_FLUSH_INTERVAL = 150; // Flush every 150ms (optimized from 125ms)

// Flush pending HP/MP updates to clients - optimized with delta detection
function flushPendingHPMpUpdates() {
    const now = Date.now();
    
    for (const [partyId, playerUpdates] of pendingHPMpUpdates) {
        if (playerUpdates.size === 0) continue;
        
        const party = parties.get(partyId);
        if (!party) continue;
        
        // Build minimal update packet with only changed values using delta detection
        const updatePacket = { partyId, timestamp: now };
        const updates = {};
        let hasActualChanges = false;
        
        for (const [socketId, changes] of playerUpdates) {
            const player = party.players.get(socketId);
            if (!player) continue;
            
            // Only HP/MP/AP are transmitted by this path, so only those fields are
            // consumed from the baseline. This leaves other pending changes (notably
            // skillsState) intact for the periodic standard-priority broadcaster.
            const delta = getPlayerDelta(socketId, player, HPMP_FLUSH_DELTA_FIELDS);
            if (!delta || Object.keys(delta).length === 0) continue;
            
            hasActualChanges = true;
            updates[socketId] = {
                id: socketId,
                name: player.name,
                hp: player.hp,
                maxHp: player.maxHp,
                mp: player.mp,
                maxMp: player.maxMp,
                ap: player.ap,
                maxAp: player.maxAp,
                isDead: player.hp <= 0
            };
        }
        
        // Only send if there are actual changes
        if (hasActualChanges && Object.keys(updates).length > 0) {
            updatePacket.playerUpdates = updates;
            
            // Prefer WebRTC over TCP
            broadcastToParty(partyId, 'hpMpUpdate', updatePacket);
        }
        
        playerUpdates.clear();
    }
}

// Queue an HP/MP update to be sent (batched with other changes)
function queueHPMpUpdate(partyId, socketId) {
    if (!pendingHPMpUpdates.has(partyId)) {
        pendingHPMpUpdates.set(partyId, new Map());
    }
    
    const playerUpdates = pendingHPMpUpdates.get(partyId);
    playerUpdates.set(socketId, { queued: true, timestamp: Date.now() });
    
    // Start flush timer if not already running
    if (!hpMpFlushTimer) {
        hpMpFlushTimer = setInterval(flushPendingHPMpUpdates, HP_MP_FLUSH_INTERVAL);
    }
}

// Fields tracked for per-player broadcast deltas (server-authoritative state).
const PLAYER_DELTA_FIELDS = ['hp', 'ap', 'maxHp', 'maxAp', 'level', 'xp', 'xpToNext', 'gold', 'mp', 'maxMp',
    'pointsToAllocate', 'abilityCooldowns', 'str', 'dex', 'agi', 'vit', 'int', 'cnc', 'wis', 'for', 'luk', 'pie',
    'actionBar', 'maxActionBar', 'equipment', 'inventory', 'skillsState'];

// Fields each broadcast path transmits (and therefore "consumes" from the delta
// baseline). Restricting consumption to the transmitted fields prevents one pass
// (e.g. the HP/MP flush, or the critical HP pass) from discarding changes destined
// for another pass (e.g. skillsState, which only the standard pass sends). Without
// this, a hit that also tweaks HP/MP would permanently swallow the skill-XP delta.
const CRITICAL_DELTA_FIELDS = ['hp', 'ap', 'maxHp', 'maxAp'];
const STANDARD_DELTA_FIELDS = ['actionBar', 'maxActionBar', 'level', 'skillsState'];
const BACKGROUND_DELTA_FIELDS = ['xp', 'xpToNext', 'gold', 'mp', 'maxMp', 'pointsToAllocate',
    'str', 'dex', 'agi', 'vit', 'int', 'cnc', 'wis', 'for', 'luk', 'pie',
    'abilitySlots', 'abilityCooldowns', 'equipment', 'inventory'];
const HPMP_FLUSH_DELTA_FIELDS = ['hp', 'maxHp', 'mp', 'maxMp', 'ap', 'maxAp'];

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
    if (consumeFields) {
        const full = buildSnapshot(player);
        const merged = { ...lastState };
        for (const f of consumeFields) merged[f] = full[f];
        playerLastState.set(socketId, merged);
    }
    return delta;
}

// Get delta for a single enemy - only return changed fields
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
    }
    for (const [key] of enemyLastState) {
        if (key.startsWith('enemy_')) {
            enemyLastState.delete(key);
        }
    }
    partyLastState.delete(partyId);
    lastBackgroundBroadcast.delete(partyId);
    webrtcServer.clearPartyDeltaState(partyId);
}

// Priority-based update system
const priorityQueues = new Map(); // partyId -> { critical, standard, background }

// Field priority classification using regex patterns for efficient matching
// Format: [regexPattern, priorityString]
const FIELD_PRIORITIES = [
    // Critical fields (HP/AP) - most frequent, fastest updates
    [/^players\.(hp|ap|maxHp|maxAp)$/, 'critical'],
    // Standard fields (combat-relevant) - action bars, combat state, skill progression
    [/^players\.(actionBar|maxActionBar|level|skillsState)$/, 'standard'],
    [/^(enemies|combatActive|combatTurn)$/, 'standard'],
    // Background fields (non-critical) - stats, gear, gold, XP
    [/^players\.(gold|xp)$/, 'background'],
    [/^players\.(str|dex|agi|vit|int|cnc|wis|for|luk|pie)$/, 'background'],
    [/^(floor|highestVisitedFloors)$/, 'background']
];

// Initialize priority queues for a party
function initializePriorityQueues(partyId) {
    if (!priorityQueues.has(partyId)) {
        priorityQueues.set(partyId, {
            critical: { lastBroadcast: 0, data: {}, fields: new Set() },
            standard: { lastBroadcast: 0, data: {}, fields: new Set() },
            background: { lastBroadcast: 0, data: {}, fields: new Set() }
        });
    }
    return priorityQueues.get(partyId);
}

function categorizeFieldChanges(partyId, changedFields) {
    const queues = initializePriorityQueues(partyId);
    const categorized = { critical: new Set(), standard: new Set(), background: new Set() };

    for (const field of changedFields) {
        let priority = 'background';
        for (const [pattern, fieldPriority] of FIELD_PRIORITIES) {
            if (pattern.test(field)) { priority = fieldPriority; break; }
        }
        categorized[priority].add(field);
    }
    return categorized;
}

// Categorize changed fields into priority queues for throttled broadcast.
// The actual packet is rebuilt from deltas in processPriorityUpdates.
function queueStateUpdate(partyId, changedFields) {
    const queues = initializePriorityQueues(partyId);
    const categorized = categorizeFieldChanges(partyId, changedFields);
    for (const [priority, fields] of Object.entries(categorized)) {
        if (fields.size > 0) queues[priority].fields.add(...fields);
    }
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

// Clear enemies and end combat for a party (used across floor/teleport handlers).
function resetPartyCombat(party) {
    resetPartyCombat(party);
}

// Cast a single already-selected ability for a player. Spends MP and sets the cooldown via
// skillEngine.applyAbilityCast, then applies healing/damage plus HoT/DoT/action-slow effects and awards XP.
// Casting no longer touches the action bar (that drives weapon attacks only).
function castAbilityForPlayer(combatant, partyId, party, ability) {
    if (!ability) return;
    const nextState = skillEngine.applyAbilityCast(combatant, ability, Date.now());
    if (!nextState) return;
    Object.assign(combatant, nextState);

    const livePlayers = Array.from(party.players.values()).filter(p => p.hp > 0);

    // Handle defense-up self-buff abilities (armor proficiencies) before all others.
    if (ability.defenseUpAmount && ability.defenseUpDuration) {
        skillEngine.applyDefenseUp(combatant, ability);
        combatant.skillsState = skillEngine.awardSkillXp(combatant.skillsState, ability.skillId, 3);
        queueStateUpdate(partyId, ['players.skillsState']);
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
        const healTargets = skillEngine.getAbilityTargets(combatant, ability, [...livePlayers]);

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
        queueStateUpdate(partyId, ['players.skillsState']);
    } else {
        // For offensive abilities, calculate damage and apply to targets
        const liveEnemies = party.enemies.filter(e => e.hp > 0);
        const damageTargets = skillEngine.getAbilityTargets(combatant, ability, liveEnemies);

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
        queueStateUpdate(partyId, ['players.skillsState']);
        
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
        const livePlayers = Array.from(party.players.values()).filter(p => p.hp > 0);
        livePlayers.forEach(player => {
            const ability = skillEngine.selectAbilityToCast(player, abilities, Date.now(), livePlayers);
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
        const livePlayers = Array.from(party.players.values()).filter(p => p.hp > 0);
        const liveEnemies = party.enemies.filter(e => e.hp > 0);
            if (livePlayers.length === 0) {
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
                    // Use optimized queue for state update
                    queueStateUpdate(partyId, ['players', 'enemies', 'floor', 'combatActive']);
                    // Prefer WebRTC for event log
                    const deathLogPacket = { 
                        message: 'Some players died, but the party continues!', 
                        type: 'info' 
                    };
                    broadcastToParty(partyId, 'eventLog', deathLogPacket);
                }
                return;
            }

            if (liveEnemies.length === 0) {
                party.combatActive = false;
                clearInterval(interval);
                clearInterval(dotInterval);
                actionIntervals.delete(partyId);
                
                // Generate combat summary using shared function
                generateCombatSummary(partyId, party, 'Victory! You can move now!');

                // Mark dungeon completion when the party defeats the boss on the last floor (per floorAmount)
                const dungeonDataForCompletion = party.dungeon ? characters.getDungeonData(party.dungeon) : null;
                const dungeonFloorMaxForCompletion = dungeonDataForCompletion?.floorAmount ?? 100;

                if (party.dungeon && party.dungeonFloors?.[party.dungeon] === dungeonFloorMaxForCompletion) {
                    if (!party.completedDungeons) party.completedDungeons = {};
                    if (party.completedDungeons[party.dungeon] !== true) {
                        party.completedDungeons[party.dungeon] = true;
                        broadcastToParty(partyId, 'eventLog', { message: `🏁 ${party.dungeon} completed!`, type: 'success' });
                    }

                    // Restock shop with items scaled to dungeon difficulty
                    characters.restockShopWithDungeonScaling(party, party.dungeon, dungeonDataForCompletion);

                    // Reward every character with one scaled item or gold fallback for clearing the dungeon
                    const lootResults = characters.rewardPlayersOnDungeonClear(party, party.dungeon, dungeonDataForCompletion);
                    for (const result of lootResults) {
                        broadcastToParty(partyId, 'eventLog', { message: result.message, type: result.type === 'item' ? 'success' : 'info' });
                    }

                    // Return to town immediately after boss defeat so UI reflects completion
                    party.floor = 0;
                    party.dungeonFloors[party.dungeon] = 0;
                    party.combatActive = false;
                    party.combatTurn = 0;
                    party.enemies = [];
                    restorePartyToFull(partyId);

                    queueStateUpdate(partyId, ['players', 'enemies', 'floor', 'combatActive']);
                    broadcastFullState(partyId, party);

                    broadcastToParty(partyId, 'eventLog', { message: '🏠 Returned to Town!', type: 'info' });

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
                // Use optimized queue for state update
                queueStateUpdate(partyId, ['players', 'enemies', 'floor', 'combatActive']);
                return;
            }

        const agiFillRate = 4.8;
        const combatants = [...livePlayers, ...liveEnemies];

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
                            source = livePlayers.find(p => p.id === dot.sourceId);
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
                            source = livePlayers.find(p => p.id === hot.sourceId);
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
        if (targetChoice < 15) return livePlayers.sort((b, a) => a.hp - b.hp)[0];
        return livePlayers.sort((a, b) => Math.random() * a.hp - Math.random() * b.hp)[0];
    }
    return liveEnemies.sort((a, b) => a.hp - b.hp)[0];
}

function calculateAttackMods(actor) {
    const stats = { mod: 0, modD: 0, useMelee: '✊' };
    const activeWeapon = characters.getActiveWeapon(actor);
    const weaponClass = characters.getActiveWeaponClass(actor);
    const effectiveWeapon = activeWeapon?.damage || activeWeapon?.level || 0;
    const mod = 2 + effectiveWeapon;
    const modD = 0.1 + effectiveWeapon * 0.7 + effectiveWeapon * (1.3 + Math.random() / 3);
    //stats.modD += characters.getEquipmentBonus(actor, 'HP') * 0.001;
    return { ...stats, mod, modD, useMelee: stats.useMelee, weaponClass };
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
    
    // Queue immediate HP/MP update for the damaged target
    if (!target.isEnemy) {
        queueHPMpUpdate(partyId, target.id);
    }
    
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
        broadcastToParty(partyId, 'criticalUpdate', deathPacket);
        // Also send event log via WebRTC
        broadcastToParty(partyId, 'eventLog', { message: deathMsg, type: 'death' });
    }
}

function updatePartyState(target, party) {
    if (target.isEnemy) {
        const idx = party.enemies.findIndex(e => e.id === target.id);
        if (idx !== -1) party.enemies[idx] = { ...target };
    } else if (target.hp > 0) {
        party.players.set(target.id, { ...target });
    }
}

// Perform action bar attack
function performActionBarAttack(actor, partyId, party) {
    const livePlayers = Array.from(party.players.values()).filter(p => p.hp > 0);
    const liveEnemies = party.enemies.filter(e => e.hp > 0);
    const target = selectTarget(actor, livePlayers, liveEnemies);
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
            queueStateUpdate(partyId, ['players.skillsState']);
        }
        
        // Award armor proficiency XP to the player being hit, based on damage mitigated,
        // split across the proficiencies of their worn armor pieces (by piece count).
        if (!target.isEnemy && target.skillsState && mitigated > 0) {
            target.skillsState = skillEngine.awardArmorProficiencyXp(target.skillsState, mitigated * 5, target);
            queueStateUpdate(partyId, ['players.skillsState']);
        }
    }

    updatePartyState(target, party);
    
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
    const fullStatePacket = buildUpdatePacket(party, partyId, 'full');
    broadcastToParty(partyId, 'partyUpdate', fullStatePacket);
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
const lastSentRegen = new Map(); // socketId -> { hp, mp }
function startRegenSystem() {
    setInterval(() => {
        for (const [partyId, party] of parties) {
            const inCombat = party.combatActive, live = Array.from(party.players.values()).filter(p => p.hp > 0);
            if (live.length === 0) continue;
            
            if (party.floor === 0) live.forEach(p => p.ap = Math.min(p.maxAp, p.ap + 5));
            
            live.forEach(p => {
                // HP Regen (effective attributes include equipment bonuses)
                let hpRegen = (inCombat ? 0.08 : 0.13) + characters.getEffectiveAttribute(p, 'vit') / 288 + characters.getEffectiveAttribute(p, 'str') / 344 + characters.getEffectiveAttribute(p, 'for') / 377 + characters.getEffectiveAttribute(p, 'pie') / 533 + (p.equipment?.shoes?.defense || 3) / 333;
                p.hp = Math.min(p.maxHp, p.hp + hpRegen * (inCombat ? 1.5 : 3.1));

                // MP Regen (effective attributes include equipment bonuses)
                let mpRegen = (inCombat ? 0.05 : 0.17) + characters.getEffectiveAttribute(p, 'int') / 422 + characters.getEffectiveAttribute(p, 'cnc') / 311 + characters.getEffectiveAttribute(p, 'wis') / 377 + characters.getEffectiveAttribute(p, 'pie') / 422 + (p.equipment?.shoes?.defense || 3) / 333;
                p.mp = Math.min(p.maxMp, p.mp + mpRegen * (inCombat ? 0.8 : 1.7));
                
                // Queue update if HP/MP changed by 1+
                const last = lastSentRegen.get(p.id);
                if (!last || Math.abs(p.hp - last.hp) >= 1 || Math.abs(p.mp - last.mp) >= 1) {
                    lastSentRegen.set(p.id, { hp: p.hp, mp: p.mp });
                    queueHPMpUpdate(partyId, p.id);
                }
            });
        }
    }, 100);
}

function startBroadcastSystem() {
    const interval = setInterval(() => {
        const now = Date.now();
        
        for (const [partyId, party] of parties.entries()) {
            // Get live players for this party
            const livePlayers = Array.from(party.players.values()).filter(p => p.hp > 0);
            
            if (livePlayers.length === 0) continue;
            
            // Get priority queues for this party
            const queues = priorityQueues.get(partyId);
            if (!queues) continue;
            
            // Calculate dynamic intervals based on party state
            const isCombat = party.combatActive;
            const isTown = party.floor === 0;
            
            // Longer intervals for background updates (5 seconds in town, 2 seconds in combat)
            const backgroundInterval = isTown ? 600 : 800;
            const standardInterval = isCombat ? 400 : 600;
            
            // Process priority updates with adaptive intervals
            processPriorityUpdates(partyId, party, queues, 'critical', now, isCombat ? 150 : 200);
            processPriorityUpdates(partyId, party, queues, 'standard', now, standardInterval);
            processPriorityUpdates(partyId, party, queues, 'background', now, backgroundInterval);
            
            // Update max action bar during combat
            if (isCombat) {
                livePlayers.forEach(player => {
                    player.maxActionBar = 105 + livePlayers.length;
                });
            }
            
            // Save character data less frequently (every ~5th broadcast = ~2.5 seconds)
            if (Math.random() < 0.2) {
                livePlayers.forEach(p => saveCharacter(p.name, p));
            }
        }
    }, 500); // Check every 500ms (reduced from 100ms - 5x less frequent)
    return interval;
}

// Process updates for a specific priority level - prefer WebRTC over TCP, with reduced frequency
function processPriorityUpdates(partyId, party, queues, priority, now, updateInterval) {
    const queue = queues[priority];
    if (!queue || queue.fields.size === 0) return;
    
    // Apply throttling
    if (now - queue.lastBroadcast < updateInterval) return;
    
    // Build minimal update packet based on priority
    let updatePacket = { partyId, timestamp: now };
    
    if (priority === 'critical') {
        // Only HP/AP changes
        const playerUpdates = {};
        for (const [socketId, player] of party.players) {
            const delta = getPlayerDelta(socketId, player, CRITICAL_DELTA_FIELDS);
            if (delta && (delta.hp !== undefined || delta.ap !== undefined)) {
                playerUpdates[socketId] = {
                    hp: player.hp,
                    maxHp: player.maxHp,
                    ap: player.ap,
                    maxAp: player.maxAp,
                    isDead: player.hp <= 0
                };
            }
        }
        if (Object.keys(playerUpdates).length === 0) {
            queue.fields.clear();
            return;
        }
        updatePacket.playerUpdates = playerUpdates;
        
        broadcastToParty(partyId, 'criticalUpdate', updatePacket);
    } else if (priority === 'standard') {
        // Action bars, combat status, skill progression
        const playerUpdates = {};
        for (const [socketId, player] of party.players) {
            const delta = getPlayerDelta(socketId, player, STANDARD_DELTA_FIELDS);
            if (delta && (delta.actionBar !== undefined || delta.level !== undefined || delta.skillsState !== undefined)) {
                playerUpdates[socketId] = {
                    id: socketId,
                    name: player.name,
                    actionBar: player.actionBar,
                    isDead: player.hp <= 0,
                    skillsState: player.skillsState
                };
            }
        }
        updatePacket.playerUpdates = playerUpdates;
        updatePacket.combatActive = party.combatActive;
        updatePacket.combatTurn = party.combatTurn;
        
        broadcastToParty(partyId, 'standardUpdate', updatePacket);
    } else {
        // Background: stats, gear, gold, XP (only send if there are actual changes)
        const playerUpdates = {};
        for (const [socketId, player] of party.players) {
            const delta = getPlayerDelta(socketId, player, BACKGROUND_DELTA_FIELDS);
            if (delta) {
                    const bgFields = ['xp', 'gold', 'str', 'dex', 'agi', 'vit', 'int', 'cnc', 'wis', 'for', 'luk', 'pie',
                                      'abilitySlots', 'abilityCooldowns', 'equipment', 'inventory'];
                const hasBgChanges = bgFields.some(f => delta[f] !== undefined);
                if (hasBgChanges) {
                    playerUpdates[socketId] = { id: socketId, name: player.name };
                    bgFields.forEach(f => {
                        if (delta[f] !== undefined) playerUpdates[socketId][f] = delta[f];
                    });
                }
            }
        }
        if (Object.keys(playerUpdates).length === 0) {
            queue.fields.clear();
            return;
        }
        updatePacket.playerUpdates = playerUpdates;
        updatePacket.floor = party.floor;
        
        broadcastToParty(partyId, 'backgroundUpdate', updatePacket);
    }
    
    queue.lastBroadcast = now;
    queue.fields.clear();
    queue.data = {};
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
    
    // ═══════════════════════════════════════════════════════════════════
    // UNIFIED MOVEMENT HANDLERS - Consolidates moveFloor and nextFloor
    // ═══════════════════════════════════════════════════════════════════
    const handleFloorMove = (partyId, direction) => {
        const party = parties.get(partyId);
        if (!party) return;
        
        // Initialize dungeonFloors and highestVisitedFloors if not exists
        if (!party.dungeonFloors) party.dungeonFloors = {};
        if (!party.highestVisitedFloors) party.highestVisitedFloors = {};
        
        // Get current dungeon-relative floor
        const currentDungeonFloor = party.dungeonFloors[party.dungeon] || 0;
        const dungeonData = characters.getDungeonData(party.dungeon);
        
        [spawnTimers, actionIntervals].forEach(m => m.has(partyId) && (m.get(partyId).constructor.name === 'Timeout' ? clearTimeout(m.get(partyId)) : clearInterval(m.get(partyId)), m.delete(partyId)));
        const liveEnemies = (party.enemies || []).filter(e => e.hp > 0);
        if (party.combatActive || liveEnemies.length > 0) {
            broadcastToParty(partyId, 'movementBlocked', { message: `${liveEnemies.length} enemies alive!` });
            return;
        }
        
        // Calculate new dungeon-relative floor (1-100 per dungeon)
        let newDungeonFloor = currentDungeonFloor;
        if (direction === 'up') {
            const dungeonDataForMove = characters.getDungeonData(party.dungeon);
            const dungeonFloorMaxForMove = dungeonDataForMove?.floorAmount ?? 100;
            newDungeonFloor = Math.min(currentDungeonFloor + 1, dungeonFloorMaxForMove);
        } else {
            // Going down - if at floor 1, go to town (floor 0)
            if (currentDungeonFloor <= 1) {
                // Going to town
                party.dungeonFloors[party.dungeon] = 0;  // Keep dungeon floor at 1
                party.floor = 0;
                
                // Clear enemies and combat state
                resetPartyCombat(party);
                resetPlayersActionBars(party);
                
                // Broadcast update
                broadcastToParty(partyId, 'standardUpdate', { 
                    partyId, 
                    floor: party.floor, 
                    dungeonFloors: party.dungeonFloors,
                    highestVisitedFloors: party.highestVisitedFloors,
                    combatActive: party.combatActive, 
                    enemies: party.enemies, 
                    timestamp: Date.now() 
                });
                broadcastToParty(partyId, 'eventLog', { message: '🏠 Safe in town!', type: 'info' });
                return;
            } else {
                newDungeonFloor = Math.max(currentDungeonFloor - 1, 1);
            }
        }
        
        // Update dungeon-relative floor
        party.dungeonFloors[party.dungeon] = newDungeonFloor;
        
        // Calculate absolute floor for display
        party.floor = newDungeonFloor;
        
        // Initialize highestVisitedFloors for this dungeon if not exists
        if (!party.highestVisitedFloors) party.highestVisitedFloors = {};
        
        // Update highest visited floor
        const currentHighest = party.highestVisitedFloors[party.dungeon] || 0;
        // Always update highestVisitedFloors when entering a new floor to ensure buttons work
        if (newDungeonFloor >= 1 && (!party.highestVisitedFloors[party.dungeon] || newDungeonFloor > currentHighest)) {
            party.highestVisitedFloors[party.dungeon] = newDungeonFloor;
        }
        
        resetPartyCombat(party);
        resetPlayersActionBars(party);
        if (party.floor >= 1) { generateEnemies(party); party.combatActive = true; startActionBarSystem(partyId, party); }
        broadcastToParty(partyId, 'standardUpdate', { 
            partyId, 
            floor: party.floor,
            dungeonFloors: party.dungeonFloors,
            highestVisitedFloors: party.highestVisitedFloors,
            combatActive: party.combatActive, 
            enemies: party.enemies, 
            timestamp: Date.now() 
        });
        broadcastToParty(partyId, 'eventLog', { message: party.floor >= 1 ? '⚔️ Action Bars filling!' : '🏠 Safe in town!', type: 'info' });
    };
    // Manual floor movement disabled in favor of Embark flow (floor-by-floor via nextFloor after victory)
    // socket.on('moveFloor', data => handleFloorMove(data.partyId, data.direction));
    // socket.on('nextFloor', data => handleFloorMove(data.partyId, 'up'));

    // ═══════════════════════════════════════════════════════════════════
    // UNIFIED TELEPORT HANDLERS - Consolidates teleportToTown and teleportToFloor
    // ═══════════════════════════════════════════════════════════════════
    const handleTeleport = (partyId, targetFloor) => {
        const party = parties.get(partyId);
        if (!party || (targetFloor !== 0 && (party.floor !== 0 || targetFloor < 1 || targetFloor > 300))) {
            socket.emit('eventLog', { message: !party ? 'Party not found!' : 'Invalid teleport!', type: 'error' });
            return;
        }
        [spawnTimers, actionIntervals].forEach(m => m.has(partyId) && (m.get(partyId).constructor.name === 'Timeout' ? clearTimeout(m.get(partyId)) : clearInterval(m.get(partyId)), m.delete(partyId)));
        if (targetFloor === 0) {
            // Reset dungeon floor to 1 when going to town for consistency
            if (!party.dungeonFloors) party.dungeonFloors = {};
            party.dungeonFloors[party.dungeon] = 0;  // Keep dungeon floor at 1
            party.floor = 0;
            
            Object.assign(party, { floor: 0, enemies: [], combatActive: false, combatTurn: 0 });
            restorePartyToFull(partyId);
            broadcastToParty(partyId, 'eventLog', { message: '🏠 Teleported to Town!', type: 'info' });
        } else {
            Object.assign(party, { floor: targetFloor, enemies: [], combatActive: false, combatTurn: 0 });
            if (!party.dungeonFloors) party.dungeonFloors = {};
            if (!party.highestVisitedFloors) party.highestVisitedFloors = {};
            party.dungeonFloors[party.dungeon] = targetFloor;  // Keep dungeon floor at targetFloor
            // Update highest visited floor if target is higher
            const currentHighest = party.highestVisitedFloors[party.dungeon] || 0;
            // Always update highestVisitedFloors when teleporting to ensure buttons work
            if (targetFloor >= 1 && (!party.highestVisitedFloors[party.dungeon] || targetFloor > currentHighest)) {
                party.highestVisitedFloors[party.dungeon] = targetFloor;
            }
            resetPlayersActionBars(party);
            generateEnemies(party); party.combatActive = true; startActionBarSystem(partyId, party);
            broadcastToParty(partyId, 'eventLog', { message: `📍 Teleported to Floor ${targetFloor}!`, type: 'info' });
        }
        broadcastFullState(partyId, party);
    };
    // Manual teleport disabled in favor of Embark flow
    // socket.on('teleportToTown', data => handleTeleport(data.partyId, 0));
    // socket.on('teleportToFloor', data => handleTeleport(data.partyId, data.floor));

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
    // Process DoTs every 1000ms for all parties (reduced from 160ms for less bandwidth)
    const dotInterval = setInterval(() => {
        for (const [partyId, party] of parties.entries()) {
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

            // OPTIMIZATION: Send critical update only if HP/AP changed, not full state
            broadcastCriticalUpdate(partyId, party);
        }
    }, 1000);
    return dotInterval;
}

// Start DoT system
const dotIntervalId = initDotSystem();

server.listen(25561, () => {
    console.log('🩸 AGI Action Bar RPG with VIT Regeneration on port 25561');
});