// Character Management Module

const {
  saveCharacter,
  loadCharacter,
} = require("./database.js");
const {
  getRandomEnemy,
  getRandomEnemyName,
  generateEnemies,
} = require("./enemies.js");
const {
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
  applyDot,
  applyHot: skillEngineApplyHot,
  applyActionSlowing,
  processDotTicks: skillEngineProcessDotTicks,
  processHotTicks: skillEngineProcessHotTicks,
  processActionSlowEffects,
} = require("./public/skills/skillEngine");
const { loadAbilities } = require("./loadAbilities");
const abilities = loadAbilities();
const itemGenerator = require("./public/gear/itemGenerator");
const { DEFAULT_CHARACTER_STATS, createDefaultCharacter, compactEquipment, toCompactRef, toInventoryItem } = require("./utils.js");

// Load dungeons configuration
const dungeons = require("./public/dungeons.json");

// Maximum number of items a shop can hold. Shared so the sell-to-shop path can
// apply the same cap/re-sort as the dungeon restock path.
const MAX_SHOP_ITEMS = 120;

// How long a shop item stays on the shelf before the expiry sweep removes it.
const SHOP_ITEM_MAX_AGE_MS = 30 * 60 * 1000;

// Sort the shop stock by price (most expensive first) so the priciest items
// appear at the top, then cap to MAX_SHOP_ITEMS (keeping the highest-priced).
function sortAndCapShopStock(party) {
  if (!party || !Array.isArray(party.shopStock)) return;
  party.shopStock.sort((a, b) => (b.price || 0) - (a.price || 0));
  if (party.shopStock.length > MAX_SHOP_ITEMS) {
    party.shopStock = party.shopStock.slice(0, MAX_SHOP_ITEMS);
  }
}

// Function to restock the shop with items scaled to dungeon difficulty
function restockShopWithDungeonScaling(party, dungeon, dungeonData) {
  if (!party) return;

  // Keep existing stock and add to it instead of clearing it out
  party.shopStock = party.shopStock || [];

  // Generate 2-4 items for every category so each restock always covers all
  // gear types (weapon, armor, headgear, shoes).
  const categoryPool = ["weapon", "armor", "headgear", "shoes"];

  for (const category of categoryPool) {
    const count = 2 + Math.floor(Math.random() * 2); // 2-4 items
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

  const dungeonDifficulty = (dungeonData?.floorBase ?? 1) + (dungeonData?.floorMult ?? 1) * (dungeonData?.floorAmount ?? 100);

  console.log(
    `Restocked shop (now ${party.shopStock.length} items) after completing ${dungeon} (difficulty: ${dungeonDifficulty})`,
  );
}

// Give every character in the party one randomized item when the dungeon boss is
// defeated. Items use the same dungeon scaling as the shop restock that happens
// at the same time, and are added directly to each player's inventory (and saved).
function rewardPlayersOnDungeonClear(party, dungeon, dungeonData) {
  if (!party || !party.players || party.players.size === 0) return [];

  const floorBase = dungeonData?.floorBase ?? 1;
  const floorMult = dungeonData?.floorMult ?? 1;
  const floorAmount = dungeonData?.floorAmount ?? 100;
  const dungeonDifficulty = Math.round(floorBase + floorMult * floorAmount);

  const categoryPool = ["weapon", "armor", "headgear", "shoes"];
  const results = [];

  for (const player of party.players.values()) {
    const name = player.name || 'a hero';

    if (Math.random() < 0.3) {
    const item = itemGenerator.generateScaledItem(dungeonData, categoryPool);
      player.inventory = Array.isArray(player.inventory) ? player.inventory : [];
      player.inventory.push(toInventoryItem(item, item.slot));
      player.inventory = [...player.inventory];
      if (player.name) saveCharacter(player.name, player);

      const displayName = item.displayName || item.name || item.id || 'gear';
      const rarityText = item.rarity ? ` (${item.rarity}★)` : '';
      results.push({ name, type: 'item', message: `🎁 ${name} found ${displayName}${rarityText}!`, detail: `${displayName}${rarityText}` });
    } else {
      let dungeonReward = Math.round(Math.pow(3 + dungeonDifficulty, 0.5));
      player.gold = (player.gold || 0) + dungeonReward;
      if (player.name) saveCharacter(player.name, player);
      results.push({ name, type: 'gold', message: `💰 ${name} found ${dungeonReward} gold!`, detail: `${dungeonReward} gold` });
    }
  }

  return results;
}

// Compact equipment references: only id + scaling factors are persisted.
// All other stats are calculated from the gear catalogs (e.g. weaponMelee.json).
const EQUIPMENT_SLOTS = ["weapon", "armour", "helmet", "shoes"];

function getDefaultEquipment() {
  return compactEquipment({
    weapon: { id: "newspaper", level: 1, rarity: 1 },
    armour: { id: "rags", level: 1, rarity: 1 },
    helmet: { id: "strawHat", level: 1, rarity: 1 },
    shoes: { id: "sandals", level: 1, rarity: 1 },
  });
}

function normalizeEquipment(equipment) {
  if (!equipment || typeof equipment !== "object") return getDefaultEquipment();
  const refs = {};
  for (const slot of EQUIPMENT_SLOTS) {
    const ref = toCompactRef(equipment[slot], slot);
    refs[slot] = ref || { id: slot === "armour" ? "rags" : slot === "helmet" ? "strawHat" : slot === "shoes" ? "sandals" : "newspaper", level: 1, rarity: 1 };
  }
  return compactEquipment(refs);
}

function ensureSkillAndAbilityState(character) {
  const defaults = getDefaultSkillsState();
  character.skillsState = character.skillsState || {};
  // Merge in any skills defined in skills.json that an existing save lacks
  // (e.g. newly added skills like Spellcasting), preserving saved XP.
  character.skillsState = { ...defaults, ...character.skillsState };
  character.abilityCooldowns = character.abilityCooldowns || {};
  const slotCount = 8;
  const normalizedSlots = Array.from({ length: slotCount }, (_, index) => {
    const existing = Array.isArray(character.abilitySlots)
      ? character.abilitySlots[index]
      : null;
    if (existing) return existing;
    return null; // Always return null for empty slots, don't auto-assign abilities
  });
  character.abilitySlots = normalizedSlots
    .filter(Boolean)
    .concat(
      Array.from(
        { length: slotCount - normalizedSlots.filter(Boolean).length },
        () => null,
      ),
    );
  character.equipment = normalizeEquipment(character.equipment || {});
  character.inventory = (Array.isArray(character.inventory)
    ? character.inventory
    : []).map(item => toInventoryItem(item, item && item.slot)).filter(Boolean);
  return character;
}

function getEquipmentBonus(player, statName) {
  if (!statName) return 0;
  const mapped = getMappedEquipmentBonuses(player);
  return mapped[statName.toLowerCase()] || 0;
}

function logGearBonuses(player, changeType = 'calculated') {
  const mapped = getMappedEquipmentBonuses(player);
  const bonusList = [
    { stat: 'STR', val: mapped.str || 0 },
    { stat: 'DEX', val: mapped.dex || 0 },
    { stat: 'AGI', val: mapped.agi || 0 },
    { stat: 'VIT', val: mapped.vit || 0 },
    { stat: 'INT', val: mapped.int || 0 },
    { stat: 'CNC', val: mapped.cnc || 0 },
    { stat: 'HP',  val: mapped.hp || 0 },
    { stat: 'MP',  val: mapped.mp || 0 }
  ];
  
  const withSign = bonusList.map(b => `${b.stat}: ${b.val >= 0 ? '+' : ''}${b.val}`).join(', ');
  console.log(`[${changeType}] ${player?.name || 'Unknown'} gear bonuses: [${withSign}]`);
}

// Compact equipment refs persist only { id, level, rarity } and carry no bonuses
// of their own, so resolve each ref against its gear catalog to obtain the
// level/rarity-scaled bonus object before summing.
function resolveEquippedItemBonuses(slot, item) {
  if (!item || typeof item !== "object" || !item.id) return {};
  if (item.bonuses) return item.bonuses;
  if (item.baseBonuses) return item.baseBonuses;
  if (!itemGenerator || typeof itemGenerator.resolveItem !== "function") return {};
  const resolved = itemGenerator.resolveItem(slot, item.id, item.level, item.rarity);
  return (resolved && resolved.bonuses) || {};
}

// Return equipment bonuses with lowercase stat keys (e.g., STR -> str, HP -> hp)
function getMappedEquipmentBonuses(player) {
  const equipment = player?.equipment || {};
  const out = {};
  for (const [slot, item] of Object.entries(equipment)) {
    if (!item || typeof item !== "object") continue;
    const bonuses = resolveEquippedItemBonuses(slot, item);
    for (const [k, v] of Object.entries(bonuses || {})) {
      if (typeof v !== "number") continue;
      const key = String(k).toLowerCase();
      out[key] = (out[key] || 0) + v;
    }
  }
  return out;
}

function getActiveWeapon(player) {
  return getEquippedItem(player, "weapon") || getDefaultEquipment().weapon;
}

function getActiveWeaponClass(player) {
  return getEquippedWeaponClass(getActiveWeapon(player));
}

// Helper function to get dungeon data
function getDungeonData(dungeonKey) {
  return dungeons[dungeonKey] || null;
}

// Ordered progression chain. Follows the real dungeon list so clearing one
// dungeon unlocks the next (field -> backyard -> meadow -> farm -> orchard ...).
const DUNGEON_PROGRESSION = Object.keys(dungeons);

// Helper function to check if a dungeon is unlocked for a party
function isDungeonUnlocked(party, dungeonKey) {
  // Field is always unlocked (first dungeon)
  if (dungeonKey === "field") return true;

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
function getUnlockedDungeons(party) {
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

// Character creation and management functions
function createCharacter(name) {
  let character = createDefaultCharacter(name);
  character = ensureSkillAndAbilityState(character);

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

function calcMiscStats(player) {
  // Calculate derived stats from equipment and core stats
  const equip = getMappedEquipmentBonuses(player);

  const intEff = (player.int || 0) + (equip.int || 0);
  const cncEff = (player.cnc || 0) + (equip.cnc || 0);
  player.wis =
    (intEff / 1.9 + cncEff / 1.7 + player.level / 2.3) * 0.48 +
    (equip.wis || 0);

  const vitEff = (player.vit || 0) + (equip.vit || 0);
  const strEff = (player.str || 0) + (equip.str || 0);
  player.for =
    (player.level / 77 + 0.2 + vitEff / 1.4 + strEff / 2.2) * 0.42 +
    (equip.for || 0);

  player.luk = (player.level / 16 + 0.2) * 0.36 + (equip.luk || 0);
  player.pie =
    (5 + player.donated / 48 - player.gold / 128000) * 0.38 +
    (equip.pie || 0);

}

function calcMaxHp(player) {
  calcMiscStats(player);

  // Get base HP from core stats
  let baseHP = 170 + player.level * 7 + (player.vit + getEquipmentBonus(player, 'vit')) * 7 + (player.str + getEquipmentBonus(player, 'str')) * 3 + player.for * 0.5 + player.wis * 0.1;
  baseHP += ((player.level / 9 + 35) * (0.8 + (player.vit + getEquipmentBonus(player, 'vit')) / 2 + (player.str + getEquipmentBonus(player, 'str')) / 9 + player.for / 11)) / 17;
  // Add HP equipment bonuses from every slot (weapon/armour/helmet/shoes)
  baseHP += getEquipmentBonus(player, 'hp');

  return Math.round(baseHP);
}

function calcMaxMp(player) {
  calcMiscStats(player);

  let output =
    24 +
    (player.level * 0.6 +
      (player.int + getEquipmentBonus(player, 'int')) * 1.4 +
      (player.cnc + getEquipmentBonus(player, 'cnc')) * 0.6 +
      player.wis * 0.6 +
      getEquipmentBonus(player, 'mp'));
  return Math.round(Math.pow(output * 1.3, 0.96));
}

function calcMaxAp(player) {
  const armourDef = player?.equipment?.armour?.defense || 3;
  const helmetDef = player?.equipment?.helmet?.defense || 3;
  const shoesDef = player?.equipment?.shoes?.defense || 3;

  const gearBonus = Math.floor(
    armourDef * 3 + helmetDef * 5 + shoesDef * 1,
  );

  // Reduced non-gear contributions (minor source)
  const levelBonus = Math.floor(player.level);
  const statBonus = Math.floor((player.vit + player.str + player.for) / 9);

  // HP contribution (minimal)
  const hpBonus = Math.floor(player.maxHp * 0.006); // Reduced from 0.15

  return Math.floor(
    (gearBonus +
      levelBonus +
      statBonus +
      hpBonus) *
      0.6,
  );
}

function getEffectiveAttribute(player, statName) {
  if (!statName) return 0;
  const statKey = String(statName).toLowerCase();
  const base = Number.isFinite(player[statKey]) ? player[statKey] : 0;
  const bonus = getEquipmentBonus(player, statKey) || 0;
  return base + bonus;
}

function getAttributeDamageModifier(player, weapon) {
  if (!weapon || typeof weapon !== "object") return 1;
  const modifiers = weapon.damageModifiers;
  if (!modifiers || typeof modifiers !== "object") return 1;
  const entries = Object.entries(modifiers);
  if (entries.length === 0) return 1;

  let sum = 0;
  for (const [stat, weight] of entries) {
    if (typeof weight !== "number") continue;
    sum += getEffectiveAttribute(player, stat) * weight;
  }
  return 1 + sum * 0.03;
}

// Export all character-related functions
function calculateItemSellValue(slot, id, level, rarity) {
  const resolved = itemGenerator.resolveItem(slot, id, level, rarity);
  if (!resolved || typeof resolved.baseValue !== "number") return 0;
  const calculatedValue = itemGenerator.calculateItemPrice(resolved.baseValue, level, rarity);
  return Math.floor(calculatedValue * 0.75);
}

module.exports = {
  createCharacter,
  getDefaultEquipment,
  normalizeEquipment,
  ensureSkillAndAbilityState,
  getEquipmentBonus,
  getActiveWeapon,
  getActiveWeaponClass,
  getDungeonData,
  isDungeonUnlocked,
  getUnlockedDungeons,
  getMappedEquipmentBonuses,
  logGearBonuses,

  calcMiscStats,
  calcMaxHp,
  calcMaxMp,
  calcMaxAp,
  restockShopWithDungeonScaling,
  rewardPlayersOnDungeonClear,
  getEffectiveAttribute,
  getAttributeDamageModifier,

  calculateItemSellValue,

  MAX_SHOP_ITEMS,
  SHOP_ITEM_MAX_AGE_MS,
  sortAndCapShopStock,
};
