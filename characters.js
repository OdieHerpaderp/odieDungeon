// Character Management Module

import { saveCharacter } from './database.js';
import { getRandomEnemy, getRandomEnemyName, generateEnemies } from './enemies.js';
import {
  getDefaultSkillsState,
  getWeaponSkillId,
  awardSkillXp,
  getEquippedItem,
  getEquippedWeaponClass,
  selectAbilityToCast,
  applyAbilityCast,
  calculateHealAmount,
  awardHealXp,
  calculateDamageScalingForMultipleTargets,
  getAbilityTargets,
  getSkillLevel,
} from './public/skills/skillEngine.js';
import { loadAbilities } from './loadAbilities.js';
import * as itemGenerator from './public/gear/itemGenerator.js';
import {
  DEFAULT_CHARACTER_STATS,
  createDefaultCharacter,
  compactEquipment,
  toCompactRef,
  toInventoryItem,
  safeArray,
  normalizeCharacterStats,
  getEffectiveAttribute,
  getEquipmentBonus,
  getMappedEquipmentBonuses,
} from './utils.js';
import dungeons from './public/dungeons.json' with { type: 'json' };

export { getEffectiveAttribute, getAttributeDamageModifier } from './utils.js';

// Maximum number of items a shop can hold. Shared so the sell-to-shop path can
// apply the same cap/re-sort as the dungeon restock path.
export const MAX_SHOP_ITEMS = 255;

// Ratio applied to item sell price when selling back to the shop (0.5 = 50% of buy price).
export const SHOP_SELL_RATIO = 0.5;

// How long a shop item stays on the shelf before the expiry sweep removes it.
export const SHOP_ITEM_MAX_AGE_MS = 30 * 60 * 1000;

// Sort the shop stock by price (most expensive first) so the priciest items
// appear at the top, then cap to MAX_SHOP_ITEMS (keeping the highest-priced).
export function sortAndCapShopStock(party) {
  if (!party || !safeArray(party.shopStock).length) return;
  party.shopStock.sort((a, b) => (b.price || 0) - (a.price || 0));
  if (party.shopStock.length > MAX_SHOP_ITEMS) {
    party.shopStock = party.shopStock.slice(0, MAX_SHOP_ITEMS);
  }
}

// Function to restock the shop with items scaled to dungeon difficulty
export function restockShopWithDungeonScaling(party, dungeon, dungeonData) {
  if (!party) return;

  // Keep existing stock and add to it instead of clearing it out
  party.shopStock = party.shopStock || [];

  // Generate 2-4 items for every category so each restock always covers all
  // gear types (weapon, chest, headgear, shoes).
  const categoryPool = ['weapon', 'chest', 'headgear', 'shoes', 'offHand'];

  for (const category of categoryPool) {
    const count = 3 + Math.floor(Math.random() * 2); // 2-4 items
    for (let i = 0; i < count; i++) {
      // Pass a single-category pool so the generator's random pick always
      // resolves to this category.
      const item = itemGenerator.generateScaledItem(dungeonData, [category]);
      // Timestamp so the periodic expiry sweep can drop items older than
      // SHOP_ITEM_MAX_AGE_MS.
      item.timestamp = Date.now();
      party.shopStock.push(item);
    }
  }

  // Sort the shop stock by price (most expensive first) so the priciest items appear at the top
  sortAndCapShopStock(party);

  const dungeonDifficulty =
    (dungeonData?.floorBase ?? 1) + (dungeonData?.floorMult ?? 1) * (dungeonData?.floorAmount ?? 100);

  console.log(
    `Restocked shop (now ${party.shopStock.length} items) after completing ${dungeon} (difficulty: ${dungeonDifficulty})`,
  );
}

// Give every character in the party one randomized item when the dungeon boss is
// defeated. Items use the same dungeon scaling as the shop restock that happens
// at the same time, and are added directly to each player's inventory (and saved).
export function rewardPlayersOnDungeonClear(party, dungeon, dungeonData) {
  if (!party || !party.players || party.players.size === 0) return [];

  const floorBase = dungeonData?.floorBase ?? 1;
  const floorMult = dungeonData?.floorMult ?? 1;
  const floorAmount = dungeonData?.floorAmount ?? 100;
  const dungeonDifficulty = Math.round(floorBase + floorMult * floorAmount);

  const categoryPool = ['weapon', 'chest', 'headgear', 'shoes', 'offHand'];
  const results = [];

  for (const player of party.players.values()) {
    const name = player.name || 'a hero';

    if (Math.random() < 0.3) {
      const item = itemGenerator.generateScaledItem(dungeonData, categoryPool);
      player.inventory = safeArray(player.inventory);
      player.inventory.push(toInventoryItem(item, item.slot));
      player.inventory = [...player.inventory];
      if (player.name) saveCharacter(player.name, player);

      const displayName = item.displayName || item.name || item.id || 'gear';
      const rarityText = item.rarity ? ` (${item.rarity}★)` : '';
      results.push({
        name,
        type: 'item',
        message: `\ud83c\udf81 ${name} found ${displayName}${rarityText}!`,
        detail: `${displayName}${rarityText}`,
      });
    } else {
      let dungeonReward = Math.round(Math.pow(6 + dungeonDifficulty / 1.5, 0.8));
      player.gold = (player.gold || 0) + dungeonReward;
      if (player.name) saveCharacter(player.name, player);
      results.push({
        name,
        type: 'gold',
        message: `\ud83d\udcb0 ${name} found ${dungeonReward} gold!`,
        detail: `${dungeonReward} gold`,
      });
    }
  }

  return results;
}

// Compact equipment references: only id + scaling factors are persisted.
// All other stats are calculated from the gear catalogs (e.g. WeaponMelee/blunt.json).
const EQUIPMENT_SLOTS = ['weapon', 'chest', 'helmet', 'shoes', 'offHand'];

export function getDefaultEquipment() {
  return compactEquipment({
    weapon: { id: 'newspaper', level: 1, rarity: 1 },
    chest: { id: 'rags', level: 1, rarity: 1 },
    helmet: { id: 'strawHat', level: 1, rarity: 1 },
    shoes: { id: 'sandals', level: 1, rarity: 1 },
  });
}

export function normalizeEquipment(equipment) {
  if (!equipment || typeof equipment !== 'object') return getDefaultEquipment();
  const refs = {};
  for (const slot of EQUIPMENT_SLOTS) {
    const ref = toCompactRef(equipment[slot], slot);
    if (ref) {
      refs[slot] = ref;
    } else if (slot === 'offHand') {
      refs[slot] = undefined;
    } else {
      refs[slot] = {
        id: slot === 'chest' ? 'rags' : slot === 'helmet' ? 'strawHat' : slot === 'shoes' ? 'sandals' : 'newspaper',
        level: 1,
        rarity: 1,
      };
    }
  }
  return compactEquipment(refs);
}

export function ensureSkillAndAbilityState(character) {
  const defaults = getDefaultSkillsState();
  character.skillsState = character.skillsState || {};
  // Merge in any skills defined in skills.json that an existing save lacks
  // (e.g. newly added skills like Spellcasting), preserving saved XP.
  character.skillsState = { ...defaults, ...character.skillsState };
  character.abilityCooldowns = character.abilityCooldowns || {};
  const existingSlots = safeArray(character.abilitySlots);
  const normalizedSlots = Array.from({ length: 8 }, (_, index) => existingSlots[index] || null);
  character.abilitySlots = normalizedSlots
    .filter(Boolean)
    .concat(Array.from({ length: 8 - normalizedSlots.filter(Boolean).length }, () => null));
  character.equipment = normalizeEquipment(character.equipment || {});
  character.inventory = safeArray(character.inventory)
    .map((item) => toInventoryItem(item, item && item.slot))
    .filter(Boolean);
  return character;
}

export function logGearBonuses(player, changeType = 'calculated') {
  const mapped = getMappedEquipmentBonuses(player);
  const bonusList = [
    { stat: 'STR', val: mapped.str || 0 },
    { stat: 'DEX', val: mapped.dex || 0 },
    { stat: 'AGI', val: mapped.agi || 0 },
    { stat: 'VIT', val: mapped.vit || 0 },
    { stat: 'INT', val: mapped.int || 0 },
    { stat: 'CNC', val: mapped.cnc || 0 },
    { stat: 'HP', val: mapped.hp || 0 },
    { stat: 'MP', val: mapped.mp || 0 },
  ];

  const withSign = bonusList.map((b) => `${b.stat}: ${b.val >= 0 ? '+' : ''}${b.val}`).join(', ');
  console.log(`[${changeType}] ${player?.name || 'Unknown'} gear bonuses: [${withSign}]`);
}

export function getActiveWeapon(player) {
  return getEquippedItem(player, 'weapon') || getDefaultEquipment().weapon;
}

export function getActiveWeaponClass(player) {
  return getEquippedWeaponClass(getActiveWeapon(player));
}

// Helper function to get dungeon data
export function getDungeonData(dungeonKey) {
  return dungeons[dungeonKey] || null;
}

// Ordered progression chain. Follows the real dungeon list so clearing one
// dungeon unlocks the next (field -> backyard -> meadow -> farm -> orchard ...).
const DUNGEON_PROGRESSION = Object.keys(dungeons);

// Helper function to check if a dungeon is unlocked for a party
export function isDungeonUnlocked(party, dungeonKey) {
  // Field is always unlocked (first dungeon)
  if (dungeonKey === 'field') return true;

  const dungeonOrder = DUNGEON_PROGRESSION;
  const dungeonIndex = dungeonOrder.indexOf(dungeonKey);

  // If dungeon not found or is first (field), return true
  if (dungeonIndex <= 0) return true;

  // Gate on completion of previous dungeon.
  const prevDungeonKey = dungeonOrder[dungeonIndex - 1];

  // Back-compat: if completedDungeons doesn't exist, fall back to highestVisitedFloors >= 100
  const completedMap = party.completedDungeons || {};
  const completedExplicit = completedMap[prevDungeonKey] === true;

  const highestVisited = party.highestVisitedFloors?.[prevDungeonKey] || 0;
  const completedByLegacy = highestVisited >= 100;

  return completedExplicit || completedByLegacy;
}

// Helper function to get unlocked dungeons for a party
export function getUnlockedDungeons(party) {
  const dungeonOrder = DUNGEON_PROGRESSION;
  const unlocked = [];

  for (const dungeonKey of dungeonOrder) {
    if (isDungeonUnlocked(party, dungeonKey)) {
      unlocked.push(dungeonKey);
    } else {
      break; // Stop at first locked dungeon
    }
  }

  return unlocked;
}

// Helper function to determine weapon type from useMelee emoji

export function getStartingInventory() {
  return [
    { id: 'pebble', level: 1, rarity: 1, slot: 'weapon' },
    { id: 'magicRune', level: 1, rarity: 1, slot: 'weapon' },
  ];
}

// Character creation and management functions
export function createCharacter(name) {
  let character = createDefaultCharacter(name);
  character = ensureSkillAndAbilityState(character);
  character.inventory.push(...getStartingInventory());

  // Initialize equipment
  character.equipment = normalizeEquipment(character.equipment || {});

  // Calculate initial stats
  character.maxHp = calcMaxHp(character);
  character.maxMp = calcMaxMp(character);
  character.maxAp = calcMaxAp(character);

  // Set current values to max initially
  character.hp = character.maxHp;
  character.mp = character.maxMp;
  character.ap = character.maxAp;

  return character;
}

export function calcMiscStats(player) {
  player.wis =
    (getEffectiveAttribute(player, 'int') / 1.9 +
      getEffectiveAttribute(player, 'cnc') / 1.7 +
      player.level / 2.3) *
    0.48 +
    getEquipmentBonus(player, 'wis');
  player.for =
    (player.level / 77 + 0.2 + getEffectiveAttribute(player, 'vit') / 1.4 + getEffectiveAttribute(player, 'str') / 2.2) *
    0.42 +
    getEquipmentBonus(player, 'for');
  player.luk = (player.level / 16 + 0.2) * 0.36 + getEquipmentBonus(player, 'luk');
  player.pie = (5 + player.donated / 48 - player.gold / 128000) * 0.38 + getEquipmentBonus(player, 'pie');
}

export function calcMaxHp(player) {
  calcMiscStats(player);

  const vitEff = getEffectiveAttribute(player, 'vit');
  const strEff = getEffectiveAttribute(player, 'str');
  let baseHP =
    190 +
    player.level * 7 +
    vitEff * 8 +
    strEff * 2 +
    player.for * 0.5 +
    player.wis * 0.1;
  baseHP +=
    ((player.level / 9 + 45) * (0.8 + vitEff / 1.8 + strEff / 9 + player.for / 11)) /
    17;
  baseHP += getEquipmentBonus(player, 'hp');

  return Math.round(baseHP);
}

export function calcMaxMp(player) {
  calcMiscStats(player);

  const intEff = getEffectiveAttribute(player, 'int');
  const cncEff = getEffectiveAttribute(player, 'cnc');
  let output =
    24 +
    (player.level * 0.6 + intEff * 1.4 + cncEff * 0.6 + player.wis * 0.1 + getEquipmentBonus(player, 'mp'));
  return Math.round(Math.pow(output * 1.3, 0.96));
}

export function calcMaxAp(player) {
  const apBonus = getEquipmentBonus(player, 'ap');
  const vitEff = getEffectiveAttribute(player, 'vit');
  const intEff = getEffectiveAttribute(player, 'int');
  const cncEff = getEffectiveAttribute(player, 'cnc');
  const levelBonus = Math.floor(player.level);
  const statBonus = (vitEff + intEff + cncEff) / 3;
  const hpBonus = player.maxHp * 0.008;

  return Math.floor((apBonus + levelBonus + statBonus + hpBonus) * 1.25);
}

// Export all character-related functions
export function calculateItemSellValue(slot, id, level, rarity) {
  const resolved = itemGenerator.resolveItem(slot, id, level, rarity);
  if (!resolved || typeof resolved.baseValue !== 'number') return 0;
  const calculatedValue = itemGenerator.calculateItemPrice(resolved.baseValue, level, rarity);
  return Math.floor(calculatedValue * SHOP_SELL_RATIO);
}
