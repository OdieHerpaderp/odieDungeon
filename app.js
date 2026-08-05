// odieDungeon
import assert from 'node:assert';
import express from 'express';
import http from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { Server } from 'socket.io';
import * as utils from './utils.js';
import { saveCharacter, loadCharacter } from './database.js';
import * as characters from './characters.js';
import { WebRTCServer } from './appWebRTC.js';
import { DeltaTracker } from './utilities/deltaTracker.js';
import { generateEnemies } from './enemies.js';
import * as skillEngine from './public/skills/skillEngine.js';
import { loadAbilities } from './loadAbilities.js';
import * as itemGenerator from './public/gear/itemGenerator.js';
import { createCombatEngine } from './combatEngine.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import dungeons from './public/dungeons.json' with { type: 'json' };

let abilities = [];

export { app };
export { server };

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
  'gameDelta',
  'combatEvent',
  'eventLog',
  'dungeonChange',
  'combatStart',
  'combatEnd',
  'nextFloor',
  'autoEmbark',
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
  packet.shopSellRatio = characters.SHOP_SELL_RATIO;
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
    if (targetInfo.actor)
      packet.actor = {
        id: targetInfo.actor.id,
        name: targetInfo.actor.name,
        hp: targetInfo.actor.hp,
        maxHp: targetInfo.actor.maxHp,
        ap: targetInfo.actor.ap,
        maxAp: targetInfo.actor.maxAp,
        actionBar: targetInfo.actor.actionBar,
        isDead: targetInfo.actor.hp <= 0,
      };
    if (targetInfo.target)
      packet.target = {
        id: targetInfo.target.id,
        name: targetInfo.target.name,
        isEnemy: targetInfo.target.isEnemy || false,
        hp: targetInfo.target.hp,
        maxHp: targetInfo.target.maxHp,
        ap: targetInfo.target.ap,
        maxAp: targetInfo.target.maxAp,
        isDead: targetInfo.target.hp <= 0,
      };
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
      id: socketId,
      name: player.name,
      hp: player.hp,
      maxHp: player.maxHp,
      ap: player.ap,
      maxAp: player.maxAp,
      mp: player.mp,
      maxMp: player.maxMp,
      isDead: player.hp <= 0,
      gold: player.gold,
      inventory: player.inventory,
      equipment: player.equipment,
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
    inventoryItem.rarity,
  );
  if (!resolved || typeof resolved.baseValue !== 'number') return null;

  // List at full value (same formula as the dungeon restock), min 10g.
  resolved.price = Math.max(10, itemGenerator.calculateItemPrice(resolved.baseValue, resolved.level, resolved.rarity));
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
    const categoryPool = ['weapon', 'chest', 'headgear', 'shoes'];
    const category = categoryPool[Math.floor(Math.random() * categoryPool.length)];
    const level = Math.max(1, Math.min(99, (player.level || 1) + Math.floor(Math.random() * 5) - 2));
    const rarity = 1 + Math.floor(Math.random() * 6);
    item = itemGenerator.generateRandomItem(category, { level, rarity });
    slot =
      category === 'weapon' ? 'weapon' : category === 'chest' ? 'chest' : category === 'shoes' ? 'shoes' : 'helmet';
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
    const itemPool = catalog[gearType] || [];
    item = itemPool[0];
    slot =
      gearType === 'weapon' || gearType === 'weaponMelee' || gearType === 'weaponRanged' || gearType === 'weaponMagic'
        ? 'weapon'
        : gearType === 'chest'
          ? 'chest'
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
  player.inventory = utils.safeArray(player.inventory);

  // If this is a shop stock item, remove it from the stock
  if (itemIndex !== -1) {
    party.shopStock.splice(itemIndex, 1);
  }

  const inventoryItem = utils.toInventoryItem(item, slot);
  player.inventory.push(inventoryItem);

  // Force a new array reference to ensure change detection by the delta system
  player.inventory = [...player.inventory];

  void saveCharacter(player.name, player);

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

  if (!itemId) {
    handleUnequipItem(socket, { partyId, slot });
    return;
  }

  player.inventory = utils.safeArray(player.inventory);
  const inventoryItem = utils.findInventoryItem(player.inventory, itemId);
  if (!inventoryItem) {
    socket.emit('eventLog', { message: 'You do not own that item.', type: 'error' });
    return;
  }

  const normalizedSlot = slot === 'headgear' ? 'helmet' : slot === 'chest' ? 'chest' : slot === 'shield' || slot === 'book' ? 'offHand' : slot;
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
  player.inventory = player.inventory.filter((entry) => entry !== inventoryItem);

  // Equip the new item
  player.equipment[normalizedSlot] = calculatedItem;

  // Two-handed weapon rules: equipping one auto-unequips offHand.
  if (normalizedSlot === 'weapon' && calculatedItem.twoHanded) {
    if (player.equipment.offHand) {
      const restored = utils.toInventoryItem(player.equipment.offHand, 'offHand');
      if (restored) player.inventory.push(restored);
      delete player.equipment.offHand;
    }
  }
  // Equipping anything in offHand while a two-handed weapon is armed -> refuse.
  if (normalizedSlot === 'offHand' && player.equipment.weapon?.twoHanded) {
    // Put the attempted off-hand item back in inventory before refusing.
    const restored = utils.toInventoryItem(calculatedItem, 'offHand');
    if (restored) player.inventory.push(restored);
    socket.emit('eventLog', { message: 'Cannot equip off-hand while wielding a two-handed weapon.', type: 'error' });
    return;
  }

  characters.calcMiscStats(player);
  characters.logGearBonuses(player, 'equipItem');

  const oldMax = { hp: player.maxHp, mp: player.maxMp };
  utils.recalcDerivedMaxAndClampCurrents(player);

  console.log('[equipItem]', {
    slot: normalizedSlot,
    oldItem: currentlyEquippedItem
      ? currentlyEquippedItem.displayName || currentlyEquippedItem.name || currentlyEquippedItem.id
      : null,
    newItem: calculatedItem.displayName || calculatedItem.name || calculatedItem.id,
    oldMaxHp: oldMax.hp,
    newMaxHp: player.maxHp,
    oldMaxMp: oldMax.mp,
    newMaxMp: player.maxMp,
  });
  void saveCharacter(player.name, player);
  // Send gear/inventory on the critical path so the client refreshes panels immediately.
  broadcastCriticalGearUpdate(partyId, party);
  socket.emit('eventLog', {
    message: `Equipped ${calculatedItem.displayName || calculatedItem.name || calculatedItem.id}.`,
    type: 'success',
  });
}

function handleSellItem(socket, data) {
  utils.trackSocketIoReceived('sellItem', data);
  const { partyId, itemId } = data || {};
  const party = parties.get(partyId);
  if (!party) return;
  const player = party.players.get(socket.id);
  if (!player) return;

  player.inventory = utils.safeArray(player.inventory);
  const inventoryItem = utils.findInventoryItem(player.inventory, itemId);

  if (!inventoryItem) {
    socket.emit('eventLog', { message: 'You do not own that item.', type: 'error' });
    return;
  }

  // Resolve item to get baseValue for pricing
  const resolvedItem = itemGenerator.resolveItem(
    inventoryItem.slot,
    inventoryItem.id,
    inventoryItem.level,
    inventoryItem.rarity,
  );
  if (!resolvedItem || typeof resolvedItem.baseValue !== 'number') {
    socket.emit('eventLog', { message: 'Cannot determine value for this item.', type: 'error' });
    return;
  }

  const calculatedValue = itemGenerator.calculateItemPrice(
    resolvedItem.baseValue,
    resolvedItem.level,
    resolvedItem.rarity,
  );
  const sellPrice = Math.max(1, Math.floor(calculatedValue * characters.SHOP_SELL_RATIO));

  // Remove from inventory
  player.inventory = player.inventory.filter((entry) => entry !== inventoryItem);

  // Add the sold item back to the store so other players (or the same
  // player) can buy it again. It gets a fresh timestamp and a full-value
  // price, then is capped/sorted like the restock path.
  party.shopStock = utils.safeArray(party.shopStock);
  const returnedShopItem = makeShopItemFromInventory(inventoryItem);
  if (returnedShopItem) {
    party.shopStock.push(returnedShopItem);
    characters.sortAndCapShopStock(party);
  }

  // Add gold
  player.gold += sellPrice;

  void saveCharacter(player.name, player);
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

  const normalizedSlot = slot === 'headgear' ? 'helmet' : slot === 'chest' ? 'chest' : slot === 'shield' || slot === 'book' ? 'offHand' : slot;
  player.equipment = player.equipment || {};
  const unequippedItem = player.equipment[normalizedSlot];

  if (unequippedItem) {
    const inventoryItem = utils.toInventoryItem(unequippedItem, normalizedSlot);
    if (inventoryItem) {
      player.inventory = utils.safeArray(player.inventory);
      player.inventory.push(inventoryItem);
      player.inventory = [...player.inventory];
    }
  }

  delete player.equipment[normalizedSlot];

  characters.calcMiscStats(player);
  characters.logGearBonuses(player, 'unequipItem');

  utils.recalcDerivedMaxAndClampCurrents(player);
  void saveCharacter(player.name, player);
  broadcastCriticalGearUpdate(partyId, party);
  socket.emit('eventLog', {
    message: `Unequipped ${unequippedItem ? unequippedItem.displayName || unequippedItem.name || unequippedItem.id : 'nothing'}.`,
    type: 'success',
  });
}

function handleUseItem(socket, data) {
  utils.trackSocketIoReceived('useItem', data);
  const { partyId, itemId } = data || {};
  const party = parties.get(partyId);
  if (!party) return;
  const player = party.players.get(socket.id);
  if (!player) return;

  player.inventory = utils.safeArray(player.inventory);
  const inventoryItem = utils.findInventoryItem(player.inventory, itemId);
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

  player.inventory = player.inventory.filter((entry) => entry !== inventoryItem);
  void saveCharacter(player.name, player);
  broadcastCriticalGearUpdate(partyId, party);
  socket.emit('eventLog', {
    message: `Used ${inventoryItem.displayName || inventoryItem.name || inventoryItem.id}.`,
    type: 'success',
  });
}

function handleLeaveParty(socket, partyId) {
  utils.trackSocketIoReceived('leaveParty', { partyId });
  const party = parties.get(partyId);
  if (party) {
    const player = party.players.get(socket.id);
    if (player) {
      void saveCharacter(player.name, player);
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
  combat.restorePartyToFull(partyId);
  Array.from(party.players.values()).forEach((p) => {
    p.actionBar = 0;
    void saveCharacter(p.name, p);
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
    timestamp: Date.now(),
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
    timestamp: Date.now(),
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
    const dungeonOrder = Object.keys(dungeons);
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
  Array.from(party.players.values()).forEach((p) => {
    p.actionBar = 0;
    void saveCharacter(p.name, p);
  });

  // Generate enemies if not in town
  if (party.floor >= 1) {
    generateEnemies(party);
    party.combatActive = true;
    combat.startActionBarSystem(partyId, party);
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
    timestamp: Date.now(),
  };

  seedEnemyFullSent(party);
  broadcastToParty(partyId, 'dungeonChange', dungeonChangePacket);

  // Also emit to event log
  const eventMsg =
    party.floor >= 1 ? `Entered ${dungeon}! ⚔️ Action Bars filling!` : `Entered ${dungeon}! 🏠 Safe in town!`;
  broadcastToParty(partyId, 'eventLog', { message: eventMsg, type: 'info' });

  console.log(`[DUNGEON] Party ${partyId} changed from ${oldDungeon} to ${dungeon}`);
}

async function handleJoinParty(socket, data) {
  utils.trackSocketIoReceived('joinParty', data);
  console.log('[SERVER] Received joinParty', data);
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
      shopStock: [],
    };
    parties.set(partyId, party);

    const dungeon = party.dungeon || 'field';
    const dungeonData = characters.getDungeonData(dungeon);
    for (let i = 0; i < 5; i++) {
      characters.restockShopWithDungeonScaling(party, dungeon, dungeonData);
    }
  }

  if (party.players.size < party.maxPlayers) {
    console.log('[SERVER] Loading character for name', name);
    const savedData = await loadCharacter(name);
    console.log('[SERVER] Loaded character data', savedData ? 'exists' : 'null');

    let character = savedData || utils.createDefaultCharacter(name);
    character = characters.ensureSkillAndAbilityState(character);

    if (!savedData) {
      character.inventory.push(...characters.getStartingInventory());
    }

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

    utils.normalizeCharacterStats(character);

    character.equipment = characters.normalizeEquipment(character.equipment || {});

    const resolvedEquipment = {};
    const equipmentObj = character.equipment || {};
    for (const slot of Object.keys(equipmentObj)) {
      const ref = equipmentObj[slot];
      if (ref && ref.id && ref.level && ref.rarity && !ref.baseItem) {
        const targetSlot = itemGenerator.normalizeCategory ? itemGenerator.normalizeCategory(slot) : slot;
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
    void saveCharacter(name, character);

    const fullState = buildFullStatePacket(party, partyId);
    broadcastFullState(partyId, party);
    utils.trackSocketIoSent('joinedParty', { partyId, player: character, fullState });
    socket.emit('joinedParty', { partyId, player: character, fullState });
  } else {
    utils.trackSocketIoSent('partyFull', null);
    socket.emit('partyFull');
  }
}

function handleAllocatePoints(socket, data) {
  utils.trackSocketIoReceived('allocatePoints', data);
  console.log('[SERVER] Received allocatePoints', data, 'socket.id:', socket.id);
  const { partyId, stat, points } = data;
  const party = parties.get(partyId);
  if (!party) {
    console.log('[SERVER] Party not found', partyId);
    return;
  }
  const player = party.players.get(socket.id);
  console.log('[SERVER] Player found', !!player, 'player name:', player ? player.name : 'none');
  if (!player || player.pointsToAllocate < points || points <= 0) {
    console.log(
      '[SERVER] Invalid allocation: player exists?',
      !!player,
      'pointsToAllocate:',
      player ? player.pointsToAllocate : 'N/A',
      'requested:',
      points,
    );
    return;
  }

  player[stat] += points;
  player.pointsToAllocate -= points;

  // 🩸 vit/str → max HP (+heal to new cap) plus max AP
  if (stat === 'vit' || stat === 'str') {
    utils.recalcDerivedMaxAndClampCurrents(player);
  }

  // 🩸 int/cnc → max MP only (HP/AP already covered or unchanged)
  if (stat === 'int' || stat === 'cnc') {
    const oldMaxMp = player.maxMp;
    player.maxMp = characters.calcMaxMp(player);
    player.mp = Math.min(player.maxMp, player.mp + (player.maxMp - oldMaxMp));
  }

  // 🛡️ for (when not already handled by vit/str branch above)
  if (stat === 'for') {
    const oldMaxAp = player.maxAp;
    player.maxAp = characters.calcMaxAp(player);
    player.ap = Math.min(player.maxAp, player.ap + (player.maxAp - oldMaxAp));
  }

  // Log the stat allocation to the event log
  utils.trackSocketIoSent('eventLog', { message: `Allocated ${points} points to ${stat}.`, type: 'info' });
  socket.emit('eventLog', { message: `Allocated ${points} points to ${stat}.`, type: 'info' });

  void saveCharacter(player.name, player);

  // OPTIMIZATION: Use targeted broadcast instead of full state
  broadcastFullState(partyId, party);
}

function handleDisconnect(socket, _reason) {
  clearInterval(socket.pingInterval);
  // Clean up performance tracking
  socketMap.delete(socket.id);

  // Clean up delta tracking for this socket
  deltaTracker.deletePlayer(socket.id);

  // Handle party cleanup
  for (const [partyId, party] of parties.entries()) {
    if (party.players.has(socket.id)) {
      const player = party.players.get(socket.id);
      if (player) {
        void saveCharacter(player.name, player);
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
  const party = Array.from(parties.values()).find((party) => party.players.has(socket.id));
  if (!party) return;
  const player = party.players.get(socket.id);
  if (!player) return;

  party.players.delete(socket.id);
  broadcastPlayerUpdate(party.id, party, socket.id);
  socket.emit('eventLog', { message: 'Disconnected.', type: 'info' });
}

// Event-driven single-player sync. Forces an immediate flush through the
// consolidated emitter (single gameDelta) so discrete-action changes (escape,
// assign ability slot, disconnect) land without waiting for the next periodic
// tick. Gear/inventory structural changes go through broadcastCriticalGearUpdate instead.
function broadcastPlayerUpdate(partyId, party, socketId) {
  const player = party.players.get(socketId);
  if (!player) return;
  // Event-driven single-player sync: bypass the 50ms gate and flush a gameDelta now.
  lastGameDelta.delete(partyId);
  emitPartyDeltas(partyId, party, Date.now());
}


const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  compression: true,
  perMessageDeflate: { threshold: 1024 },
});

app.use('/vendor/socket.io-client', express.static(join(__dirname, 'node_modules', 'socket.io-client', 'dist')));
app.use(express.static('public'));

// Merged ability definitions (auto-discovered per-skill JSON files).
app.get('/api/abilities', async (req, res) => res.json(abilities.length ? abilities : await loadAbilities()));

// 60-second packet statistics logging
setInterval(() => {
  const webrtcStats = webrtcServer.packetTracker;

  const combinedSent = utils.socketIoPacketTracker.sent.total.count + webrtcStats.sent.total.count;
  const combinedSentBytes = utils.socketIoPacketTracker.sent.total.bytes + webrtcStats.sent.total.bytes;
  const combinedReceived = utils.socketIoPacketTracker.received.total.count + webrtcStats.received.total.count;
  const combinedReceivedBytes = utils.socketIoPacketTracker.received.total.bytes + webrtcStats.received.total.bytes;

  console.log('[Packet Stats]', { socketIoSent: utils.socketIoPacketTracker.sent, socketIoReceived: utils.socketIoPacketTracker.received, webrtcSent: webrtcStats.sent, webrtcReceived: webrtcStats.received, combinedSentPackets: combinedSent, combinedSentBytes: combinedSentBytes, combinedReceivedPackets: combinedReceived, combinedReceivedBytes: combinedReceivedBytes });

  // Reset Socket.IO stats (WebRTC stats are reset externally if needed)
  utils.socketIoPacketTracker.reset();
  webrtcServer.packetTracker.reset();
}, 60000);

// Define parties and spawnTimers BEFORE WebRTC initialization (fixes ReferenceError at line 174)
const parties = new Map();
const spawnTimers = new Map();
const actionIntervals = new Map();
const spellCastIntervals = new Map();

// Initialize WebRTC server
const webrtcServer = new WebRTCServer();
webrtcServer.initialize(parties, io, webrtcServer);

const combat = createCombatEngine({
  broadcastCriticalUpdate,
  broadcastToParty,
  broadcastFullState,
  saveCharacter,
  getSocket: (id) => io.sockets.sockets.get(id),
  parties,
  actionIntervals,
  spellCastIntervals,
  spawnTimers,
  startSpawnTimer,
  embarkParty,
  resetPartyDeltaBaseline,
  seedEnemyFullSent,
  io,
  getAbilities: () => abilities,
});

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
  deltaTracker.resetBaseline(targetPartyId, targetParty);
  const fullState = buildFullStatePacket(targetParty, targetPartyId);
  const sent = webrtcServer.sendMessage(socketId, 'partyUpdate', fullState);
    console.log(`[WebRTC Restore] Sent full state to reconnected socket ${socketId}: ${sent ? 'ok' : 'failed'}`);

  // Re-apply the delta baseline now that the client has the canonical state.
  deltaTracker.resetBaseline(targetPartyId, targetParty);
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
const deltaTracker = new DeltaTracker();

// Mark enemies as already full-synced after a channel other than gameDelta has
// shipped their complete object (dungeonChange / combatStart). Without this, the
// next gameDelta would emit a partial (no name) and the client would skip it.
function seedEnemyFullSent(party) {
  deltaTracker.seedEnemyFullSent(party);
}

// Clear delta tracking for a party (when party disbands)
function clearPartyDeltaState(partyId) {
  const party = parties.get(partyId);
  deltaTracker.clearParty(partyId, party);
}

// Global function that can be used anywhere in the application
function startSpawnTimer(partyId, party) {
  if (party.floor < 1 || spawnTimers.has(partyId)) return;

  const autoProgressTimestamp = party._autoProgressTimestamp;
  delete party._autoProgressTimestamp;

  const timer = setTimeout(() => {
    const elapsed = autoProgressTimestamp ? Date.now() - autoProgressTimestamp : null;
    const live = (party.enemies || []).filter((e) => e.hp > 0);
    const reason = !party.combatActive ? (live.length > 0 ? 'enemies-remain' : 'ok') : 'combat-active';

    if (reason !== 'ok') {
      console.log(`[DEBUG-SKIP-SPAWN-TIMER] party=${partyId} reason=${reason} elapsedMs=${elapsed} combatActive=${party.combatActive} enemies=${(party.enemies || []).length} live=${live.length} enemyHps=${(party.enemies || []).map((e) => `${e.name}:${e.hp}`).join(', ')}`);
      return;
    }
    if (!party.combatActive && (!party.enemies || combat.liveEnemies(party).length === 0)) {
      generateEnemies(party);
      party.combatActive = true;
      // Prefer WebRTC over TCP
      const combatPacket = { floor: party.floor, enemies: party.enemies };
      seedEnemyFullSent(party);
      broadcastToParty(partyId, 'combatStart', combatPacket);
      combat.startActionBarSystem(partyId, party);
    }
    spawnTimers.delete(partyId);
  }, 1500);

  spawnTimers.set(partyId, timer);
}




// Re-baseline the per-player/enemy delta state for a party to the current
// server state. Used on embark/escape/dungeon-change so changes made before
// the reset cannot be swallowed or overwrite the freshly-synced client state.
// Deltas are computed directly from state every tick, so re-baselining simply
// snapshots the current player/enemy/party state as the new comparison point.
function resetPartyDeltaBaseline(partyId) {
  const party = parties.get(partyId);
  if (!party) return;
  deltaTracker.resetBaseline(partyId, party);
}














// Debug function: Poll server stats every 30 seconds// Debug function: Poll server stats every 30 seconds
setInterval(() => {
  const mem = process.memoryUsage();
  console.log('[Server Stats]', { connectedClients: io.sockets.sockets.size, totalParties: parties.size, memory: { rss: Math.round(mem.rss / 1024 / 1024), heapUsed: Math.round(mem.heapUsed / 1024 / 1024), heapTotal: Math.round(mem.heapTotal / 1024 / 1024) }, uptime: Math.round(process.uptime()), actionIntervals: actionIntervals.size, spawnTimers: spawnTimers.size, parties: Array.from(parties.values()).map((p) => ({ partyId: p.partyId, players: p.players.size, floor: p.floor, combatActive: p.combatActive })) });
}, 8000);

// Periodic shop sweep: every 5 minutes, drop any shop item older than
// characters.SHOP_ITEM_MAX_AGE_MS. Items without a timestamp (legacy/pre-feature stock)
// are kept for backward compatibility.
setInterval(
  () => {
    const now = Date.now();
    let partiesScanned = 0;
    let itemsRemoved = 0;

    for (const [partyId, party] of parties) {
       if (!party || !utils.safeArray(party.shopStock).length) continue;
      const before = party.shopStock.length;
      const kept = party.shopStock.filter((item) => {
        if (item.timestamp === undefined) return true; // don't expire legacy items
        return now - item.timestamp < characters.SHOP_ITEM_MAX_AGE_MS;
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
  },
  5 * 60 * 1000,
);

function startBroadcastSystem() {
  const interval = setInterval(() => {
    const now = Date.now();
    const isCombat = (party) => party.combatActive;

    for (const [partyId, party] of parties.entries()) {
      // No live players in this party: nothing to broadcast.
      let hasLive = false;
      for (const p of party.players.values()) {
        if (p.hp > 0) {
          hasLive = true;
          break;
        }
      }
      if (!hasLive) continue;

      // Single consolidated emitter: computes each player's delta once and
      // emits a single coalesced gameDelta on the 50ms cadence below (the
      // sole state channel). emitPartyDeltas also self-gates at 50ms so a
      // faster caller would still coalesce; at 50ms it fires every tick.
      emitPartyDeltas(partyId, party, now);

      // Update max action bar during combat (derived from live player count).
      if (isCombat(party)) {
        const live = combat.livePlayers(party);
        for (const p of live) p.maxActionBar = 105 + live.length;
      }

      // Persist character data less frequently (~2.5s). At the 50ms cadence
      // this probability yields ~2.5s between saves (0.02 * 50ms = 1s avg,
      // ~2.5s expected for the loop to land true per player).
      if (Math.random() < 0.02) {
        for (const p of party.players.values()) if (p.hp > 0) void saveCharacter(p.name, p);
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
  const { delta: partyDelta, partyNext, partyDirty } = deltaTracker.getPartyDelta(partyId, party);
  for (const f of Object.keys(partyDelta)) delta[f] = partyDelta[f];

  // Per-player: snapshot the union of all changed PLAYER_DELTA_FIELDS.
  for (const [socketId, player] of party.players) {
    const entry = deltaTracker.collectPlayerUpdate(socketId, player);
    if (!entry) continue;
    delta.playerUpdates[socketId] = entry;
  }

  // Enemy deltas: full snapshot only the first time an enemy is seen on this
  // channel, partial (changed ENEMY_DELTA_FIELDS + id + isDead) thereafter.
  if (party.enemies?.length) {
    for (const enemy of party.enemies) {
      const entry = deltaTracker.collectEnemyUpdate(enemy.id, enemy);
      if (!entry) continue;
      delta.enemyUpdates[enemy.id] = entry;
    }
  }

  // Skip the entire packet when nothing changed for any player/enemy/party field.
  if (!partyDirty && Object.keys(delta.playerUpdates).length === 0 && Object.keys(delta.enemyUpdates).length === 0) {
    return;
  }

  // Advance the party-level baseline for every field we tracked.
  deltaTracker.commitPartyBaseline(partyId, partyNext);

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
    broadcastToParty(partyId, 'eventLog', {
      message: `Dungeon ${dungeon} is locked until you complete the previous dungeon.`,
      type: 'error',
    });
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
  Array.from(party.players.values()).forEach((p) => {
    p.actionBar = 0;
    void saveCharacter(p.name, p);
  });

  generateEnemies(party);
  party.combatActive = true;
  combat.startActionBarSystem(partyId, party);

  const embarkPacket = {
    partyId,
    dungeon: party.dungeon,
    floor: party.floor,
    dungeonFloors: party.dungeonFloors,
    highestVisitedFloors: party.highestVisitedFloors,
    completedDungeons: party.completedDungeons,
    combatActive: party.combatActive,
    enemies: party.enemies,
    timestamp: Date.now(),
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

    if (abilityId && !abilities.some((ability) => ability.id === abilityId)) {
      socket.emit('eventLog', { message: 'Unknown ability.', type: 'error' });
      return;
    }

    // Validate skill requirements for the ability
    if (abilityId) {
      const ability = abilities.find((a) => a.id === abilityId);
      if (ability && ability.unlockSkillLevelMin) {
        const requiredSkillLevel = ability.unlockSkillLevelMin;
        const skillId = ability.skillId;

        // Calculate the player's skill level for this skill
        const playerSkillXp = player.skillsState?.[skillId]?.xp || 0;
        const playerSkillLevel = utils.calcSkillLv(playerSkillXp);

        if (playerSkillLevel < requiredSkillLevel) {
          socket.emit('eventLog', {
            message: `Cannot assign ${ability.name}: Requires level ${requiredSkillLevel} ${skillId.replace('skill_', '').replace('_', ' ')}`,
            type: 'error',
          });
          return;
        }
      }
    }

    player.abilitySlots = utils.safeArray(player.abilitySlots);
    const nextSlots = Array.from({ length: 8 }, (_, index) => player.abilitySlots[index] || null);
    if (abilityId) {
      const dupIndex = nextSlots.findIndex((id, i) => i !== slot && id === abilityId);
      if (dupIndex !== -1) nextSlots[dupIndex] = null;
    }

    nextSlots[slot] = abilityId;
    player.abilitySlots = nextSlots;
    void saveCharacter(player.name, player);
    broadcastPlayerUpdate(partyId, party, socket.id);
    socket.emit('eventLog', { message: `Assigned ${abilityId || 'nothing'} to slot ${slot + 1}.`, type: 'success' });
  });

  socket.on('unequipItem', (data) => handleUnequipItem(socket, data));
  socket.on('useItem', (data) => handleUseItem(socket, data));
  socket.on('sellItem', (data) => handleSellItem(socket, data));
  socket.on('disconnect', () => handleLateDisconnect(socket));

  // Register shop purchase handlers
  socket.on('buyRandomGear', (partyId) => handleGearPurchase(socket, 'randomGear', partyId));
  socket.on('buyChest', (partyId) => handleGearPurchase(socket, 'chest', partyId));
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
});

combat.startRegenSystem();
startBroadcastSystem();

// Start DoT system
combat.initDotSystem();

server.listen(25561, async () => {
  try {
    abilities = await loadAbilities();
    skillEngine.initSkillEngine(abilities);
    console.log(`[INIT] Loaded ${abilities.length} abilities and initialized skill engine`);
  } catch (err) {
    console.error('[INIT] Failed to initialize abilities/skill engine:', err);
  }
  console.log('AGI Action Bar RPG with VIT Regeneration on port 25561');
});
