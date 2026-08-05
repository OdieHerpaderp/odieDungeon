// itemGenerator - ESM for server; also works as <script type="module"> for browser (skips Node import() branch)
// Browser fills catalogs via updateCatalogs() after fetching JSON from Express static files.

import * as melee from './WeaponMelee/index.js';
import * as ranged from './WeaponRanged/index.js';
import * as magic from './WeaponMagic/index.js';
import * as headgear from './headGear/index.js';
import * as chest from './chest/index.js';
import * as feetWear from './feetWear/index.js';
import * as offHand from './offHand/index.js';

export const SLOT_CATEGORY = {
  weapon: 'weapon',
  chest: 'chest',
  helmet: 'headgear',
  headgear: 'headgear',
  shoes: 'shoes',
  offHand: 'offHand',
  shield: 'offHand',
  book: 'offHand',
};

let defaultCatalog = {
  weapon: Object.values(melee).flat().concat(Object.values(ranged).flat(), Object.values(magic).flat()),
  weaponMelee: Object.values(melee).flat(),
  weaponRanged: Object.values(ranged).flat(),
  weaponMagic: Object.values(magic).flat(),
  headgear: Object.values(headgear).flat(),
  chest: Object.values(chest).flat(),
  shoes: Object.values(feetWear).flat(),
  offHand: Object.values(offHand).flat(),
};

export function getCatalog() {
  return defaultCatalog;
}

function randomFloat(min, max) {
  return Math.random() * (max - min) + min;
}

function pickRandom(items, weightFn) {
  if (!items || !items.length) return null;
  if (!weightFn) {
    return items[Math.floor(Math.random() * items.length)];
  }
  const weights = items.map((i) => weightFn(i) || 0);
  let total = 0;
  for (let i = 0; i < weights.length; i++) total += weights[i];
  if (total === 0) return items[0];
  let r = Math.random() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

export function normalizeCategory(category) {
  if (!category) return pickRandom(Object.keys(defaultCatalog));
  const normalized = String(category).toLowerCase();
  const aliases = {
    headgear: 'headgear',
    helmet: 'headgear',
    armor: 'chest',
    armors: 'chest',
    shield: 'offHand',
    book: 'offHand',
    offhand: 'offHand',
  };
  return aliases[normalized] || normalized;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function calculateItemStat(baseValue, level, rarity) {
  if (typeof baseValue !== 'number') return baseValue;
  const levelMultiplier = 0.6 + level / 13;
  const rarityMultiplier = 0.6 + rarity / 8;
  return Math.round(baseValue * levelMultiplier * rarityMultiplier * 100) / 100;
}

export function calculateItemTier(item) {
  if (!item) return null;
  const level = Number.isFinite(item.level) ? item.level : 1;
  const rarity = Number.isFinite(item.rarity) ? item.rarity : 1;
  return (calculateItemStat(51.1, level, rarity) - 22.1) / 3;
}

export function calculateItemPrice(baseValue, level, rarity) {
  if (typeof baseValue !== 'number') return baseValue;
  const levelMult = Math.pow(0.8 + level * 0.9, 1.2);
  const rarityMult = Math.pow(0.8 + rarity * 1.6, 1.3);
  return Math.round(Math.pow(baseValue * (0.9 + levelMult / 11) * (0.9 + rarityMult / 7) * 1.8, 1.25)) / 10;
}

function calculateBonuses(baseBonuses, level, rarity) {
  const calculatedBonuses = {};
  if (!baseBonuses) return calculatedBonuses;
  Object.keys(baseBonuses).forEach((stat) => {
    calculatedBonuses[stat] = calculateItemStat(baseBonuses[stat], level, rarity);
  });
  return calculatedBonuses;
}

export function generateRandomItem(category, options, catalog, baseItemId) {
  const normalizedCategory = normalizeCategory(category);
  const itemCatalog =
    catalog && catalog[normalizedCategory] ? catalog[normalizedCategory] : defaultCatalog[normalizedCategory];
  if (!itemCatalog || !itemCatalog.length) throw new Error(`No items available for category: ${normalizedCategory}`);

  let baseItem;
  if (baseItemId !== undefined) {
    baseItem = itemCatalog.find((i) => i.id === baseItemId);
    if (!baseItem) throw new Error(`Base item not found: ${baseItemId}`);
  } else {
    baseItem = pickRandom(itemCatalog);
  }
  const level = options && Number.isFinite(options.level) ? clamp(options.level, 1, 255) : Math.floor(Math.random() * 30) + 1;
  const rarity = options && Number.isFinite(options.rarity) ? clamp(options.rarity, 1, 7) : randomFloat(1, 6);

  return {
    id: `${baseItem.id}-${Math.random().toString(36).slice(2, 8)}`,
    slot: normalizedCategory,
    name: baseItem.id,
    displayName: baseItem.name,
    level,
    rarity: Number(rarity.toFixed(2)),
    baseItem: baseItem.id,
    type: baseItem.type,
    subType: baseItem.subType,
    twoHanded: baseItem.twoHanded,
    baseBonuses: baseItem.bonuses,
    baseDamage: baseItem.damage,
    baseSpellPower: baseItem.spellPower,
    baseAttackSpeed: baseItem.attackSpeed,
    baseDefense: baseItem.defense,
    baseMagicResist: baseItem.magicResist,
    baseDamageModifiers: baseItem.damageModifiers,
    baseValue: baseItem.value,
    baseRange: baseItem.range,
    description: baseItem.description,
  };
}

export function findBaseItem(slot, id) {
  const cat = SLOT_CATEGORY[slot] || normalizeCategory(slot);
  const list = defaultCatalog[cat];
  if (!list || !list.length) return null;
  return (
    list.find((i) => i.id === id) || null
  );
}

export function calculateItemStats(item) {
  if (!item || !item.baseItem) return item;
  let baseItem = null;
  const category = item.slot;
  if (defaultCatalog[category]) {
    baseItem = defaultCatalog[category].find((i) => i.id === item.baseItem);
  }
  if (!baseItem) return item;

  const calculatedItem = Object.assign({}, item);
  const baseDamage = item.baseDamage != null ? item.baseDamage : baseItem.damage;
  const baseSpellPower = item.baseSpellPower != null ? item.baseSpellPower : baseItem.spellPower;
  const baseAttackSpeed = item.baseAttackSpeed != null ? item.baseAttackSpeed : baseItem.attackSpeed;
  const baseDefense = item.baseDefense != null ? item.baseDefense : baseItem.defense;
  const baseMagicResist = item.baseMagicResist != null ? item.baseMagicResist : baseItem.magicResist;
  const baseValue = item.baseValue != null ? item.baseValue : baseItem.value;
  const baseRange = item.baseRange != null ? item.baseRange : baseItem.range;
  const baseBonuses = item.baseBonuses != null ? item.baseBonuses : baseItem.bonuses;

  if (typeof baseDamage === 'number')
    calculatedItem.damage = 1 + calculateItemStat(3 + baseDamage, item.level, item.rarity);
  if (typeof baseSpellPower === 'number')
    calculatedItem.spellPower = calculateItemStat(baseSpellPower, item.level, item.rarity);
  if (typeof baseAttackSpeed === 'number') calculatedItem.attackSpeed = baseAttackSpeed;
  if (typeof baseDefense === 'number')
    calculatedItem.defense = calculateItemStat(baseDefense, item.level, item.rarity);
  if (typeof baseMagicResist === 'number')
    calculatedItem.magicResist = calculateItemStat(baseMagicResist, item.level, item.rarity);
  if (typeof baseValue === 'number')
    calculatedItem.value = calculateItemPrice(baseValue, item.level, item.rarity);
  if (typeof baseRange === 'number') calculatedItem.range = baseRange;
  if (baseBonuses) calculatedItem.bonuses = calculateBonuses(baseBonuses, item.level, item.rarity);

  const damageModifiers = item.baseDamageModifiers || item.damageModifiers || baseItem.damageModifiers;
  if (damageModifiers) calculatedItem.damageModifiers = damageModifiers;

  return calculatedItem;
}

export function generateScaledItem(dungeonData, categoryPool) {
  const floorBase = (dungeonData && dungeonData.floorBase) || 1;
  const floorMult = (dungeonData && dungeonData.floorMult) || 0.1;
  const floorAmount = (dungeonData && dungeonData.floorAmount) || 3;
  const dungeonDifficulty = floorBase + floorMult * floorAmount;
  const baseLevel = Math.max(0.1, 0.5 + dungeonDifficulty / 2);
  const category = categoryPool[Math.floor(Math.random() * categoryPool.length)];
  const itemCatalog = defaultCatalog[category];
  const baseItem = pickRandom(itemCatalog, (i) => 1 / (i.value + 1));
  let itemLevel = 0.2 + Math.pow(0.2 + (baseLevel / 1.6 + floorAmount / 13) + Math.random() * (baseLevel * 3.6 + 6), 0.88) / 1.9;
  let itemRarity = 0.2 + Math.pow(0.6 + Math.random() * (baseLevel * 2.2 + 11), 0.46) / 2;
  itemRarity = Number(itemRarity.toFixed(1));
  const avgValue = itemCatalog.reduce((s, i) => s + (i.value || 1), 0) / itemCatalog.length;
  const bias = Math.sqrt((avgValue + 1) / (baseItem.value + 1));
  itemLevel /= bias;
  itemRarity /= bias;
  itemLevel = Math.max(1, Math.min(99, Math.round(itemLevel)));
  itemRarity = Math.max(1, Math.min(7, Number(itemRarity.toFixed(1))));
  const generatedItem = generateRandomItem(category, { level: itemLevel, rarity: itemRarity }, itemCatalog, baseItem.id);
  const calculatedValue = calculateItemPrice(generatedItem.baseValue, generatedItem.level, generatedItem.rarity);
  generatedItem.price = Math.max(10, Number.isFinite(calculatedValue) ? calculatedValue : 10);
  return generatedItem;
}

export function updateCatalogs(catalog) {
  if (!catalog) return;
  defaultCatalog = Object.assign({}, defaultCatalog, catalog);
}

export function resolveItem(slot, id, level, rarity) {
  const base = findBaseItem(slot, id);
  if (!base) return null;
  const cat = SLOT_CATEGORY[slot] || normalizeCategory(slot);
  const ref = {
    id,
    baseItem: id,
    slot: cat,
    name: base.id,
    displayName: base.name,
    level,
    rarity,
    type: base.type,
    subType: base.subType,
    twoHanded: base.twoHanded,
    description: base.description,
    baseDamage: base.damage,
    baseAttackSpeed: base.attackSpeed,
    baseSpellPower: base.spellPower,
    baseDefense: base.defense,
    baseMagicResist: base.magicResist,
    baseDamageModifiers: base.damageModifiers,
    baseValue: base.value,
    baseRange: base.range,
    baseBonuses: base.bonuses,
  };
  return calculateItemStats(ref);
}
