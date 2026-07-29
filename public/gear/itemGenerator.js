// itemGenerator - ESM for server; also works as <script type="module"> for browser (skips Node import() branch)
// Browser fills catalogs via updateCatalogs() after fetching JSON from Express static files.

import meleeBlunt from './WeaponMelee/blunt.json' with { type: 'json' };
import meleeLongBlade from './WeaponMelee/longBlade.json' with { type: 'json' };
import meleeShortBlade from './WeaponMelee/shortBlade.json' with { type: 'json' };
import meleePolearms from './WeaponMelee/polearms.json' with { type: 'json' };
import meleePugilism from './WeaponMelee/pugilism.json' with { type: 'json' };
import rangedSlings from './WeaponRanged/slings.json' with { type: 'json' };
import rangedBow from './WeaponRanged/bow.json' with { type: 'json' };
import rangedThrown from './WeaponRanged/thrown.json' with { type: 'json' };
import magicRunes from './WeaponMagic/runes.json' with { type: 'json' };
import magicRods from './WeaponMagic/rods.json' with { type: 'json' };
import magicStaves from './WeaponMagic/staves.json' with { type: 'json' };
import headgearLight from './headGear/light.json' with { type: 'json' };
import headgearMedium from './headGear/medium.json' with { type: 'json' };
import headgearHeavy from './headGear/heavy.json' with { type: 'json' };
import armorLight from './armor/light.json' with { type: 'json' };
import armorMedium from './armor/medium.json' with { type: 'json' };
import armorHeavy from './armor/heavy.json' with { type: 'json' };
import feetWearLight from './feetWear/light.json' with { type: 'json' };
import feetWearMedium from './feetWear/medium.json' with { type: 'json' };
import feetWearHeavy from './feetWear/heavy.json' with { type: 'json' };
import offHand from './offHand/offHand.json' with { type: 'json' };

export const SLOT_CATEGORY = {
  weapon: 'weapon',
  armour: 'armor',
  armor: 'armor',
  helmet: 'headgear',
  headgear: 'headgear',
  shoes: 'shoes',
  offHand: 'offHand',
  shield: 'offHand',
  book: 'offHand',
};

const weapons = [
  ...meleeBlunt,
  ...meleeLongBlade,
  ...meleeShortBlade,
  ...meleePolearms,
  ...meleePugilism,
  ...rangedSlings,
  ...rangedBow,
  ...rangedThrown,
  ...magicRunes,
  ...magicRods,
  ...magicStaves,
];

let defaultCatalog = {
  weapon: weapons,
  weaponMelee: [...meleeBlunt, ...meleeLongBlade, ...meleeShortBlade, ...meleePolearms, ...meleePugilism],
  weaponRanged: [...rangedSlings, ...rangedBow, ...rangedThrown],
  weaponMagic: [...magicRunes, ...magicRods, ...magicStaves],
  headgear: [...headgearLight, ...headgearMedium, ...headgearHeavy],
  armor: [...armorLight, ...armorMedium, ...armorHeavy],
  shoes: [...feetWearLight, ...feetWearMedium, ...feetWearHeavy],
  offHand: [...offHand],
};

export function getCatalog() {
  return defaultCatalog;
}

export function getWeapons() {
  return weapons;
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function randomFloat(min, max) {
  return Math.random() * (max - min) + min;
}

function pickRandom(items) {
  if (!items || !items.length) return null;
  return items[randomInt(0, items.length - 1)];
}

export function normalizeCategory(category) {
  if (!category) return pickRandom(Object.keys(defaultCatalog));
  var normalized = String(category).toLowerCase();
  var aliases = {
    weapons: 'weapon',
    weapon: 'weapon',
    headgear: 'headgear',
    helmet: 'headgear',
    armor: 'armor',
    armors: 'armor',
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
  var levelMultiplier = 0.7 + level / 16;
  var rarityMultiplier = 0.6 + rarity / 7;
  return Math.round(baseValue * levelMultiplier * rarityMultiplier * 100) / 100;
}

export function calculateItemTier(item) {
  if (!item) return null;
  var level = Number.isFinite(item.level) ? item.level : 1;
  var rarity = Number.isFinite(item.rarity) ? item.rarity : 1;
  return (calculateItemStat(43.7, level, rarity) - 21.8) / 3.1;
}

export function calculateItemPrice(baseValue, level, rarity) {
  if (typeof baseValue !== 'number') return baseValue;
  const levelMult = Math.pow(0.65 + level * 0.9, 1.2);
  const rarityMult = Math.pow(0.65 + rarity * 1.5, 1.4);
  return Math.round(Math.pow(baseValue * (0.75 + levelMult / 11) * (0.75 + rarityMult / 8) * 1.9, 1.4)) / 10;
}

function calculateBonuses(baseBonuses, level, rarity) {
  var calculatedBonuses = {};
  if (!baseBonuses) return calculatedBonuses;
  Object.keys(baseBonuses).forEach(function (stat) {
    calculatedBonuses[stat] = calculateItemStat(baseBonuses[stat], level, rarity);
  });
  return calculatedBonuses;
}

export function generateRandomItem(category, options, catalog) {
  var normalizedCategory = normalizeCategory(category);
  var itemCatalog =
    catalog && catalog[normalizedCategory] ? catalog[normalizedCategory] : defaultCatalog[normalizedCategory];
  if (!itemCatalog || !itemCatalog.length) throw new Error('No items available for category: ' + normalizedCategory);

  var baseItem = pickRandom(itemCatalog);
  var level = options && Number.isFinite(options.level) ? clamp(options.level, 1, 99) : randomInt(1, 30);
  var rarity = options && Number.isFinite(options.rarity) ? clamp(options.rarity, 1, 6) : randomFloat(1, 6);

  return {
    id: baseItem.id + '-' + Math.random().toString(36).slice(2, 8),
    slot: normalizedCategory,
    name: baseItem.id,
    displayName: baseItem.name,
    level: level,
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
  var cat = SLOT_CATEGORY[slot] || normalizeCategory(slot);
  var list = defaultCatalog[cat];
  if (!list || !list.length) return null;
  return (
    list.find(function (i) {
      return i.id === id;
    }) || null
  );
}

export function calculateItemStats(item) {
  if (!item || !item.baseItem) return item;
  var baseItem = null;
  var category = item.slot;
  if (defaultCatalog[category]) {
    baseItem = defaultCatalog[category].find((i) => i.id === item.baseItem);
  }
  if (!baseItem) return item;

  var calculatedItem = Object.assign({}, item);
  var baseDamage = item.baseDamage != null ? item.baseDamage : baseItem.damage;
  var baseSpellPower = item.baseSpellPower != null ? item.baseSpellPower : baseItem.spellPower;
  var baseAttackSpeed = item.baseAttackSpeed != null ? item.baseAttackSpeed : baseItem.attackSpeed;
  var baseDefense = item.baseDefense != null ? item.baseDefense : baseItem.defense;
  var baseMagicResist = item.baseMagicResist != null ? item.baseMagicResist : baseItem.magicResist;
  var baseValue = item.baseValue != null ? item.baseValue : baseItem.value;
  var baseRange = item.baseRange != null ? item.baseRange : baseItem.range;
  var baseBonuses = item.baseBonuses != null ? item.baseBonuses : baseItem.bonuses;

  if (typeof baseDamage === 'number')
    calculatedItem.damage = calculateItemStat(baseDamage, item.level, item.rarity);
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

  var damageModifiers = item.baseDamageModifiers || item.damageModifiers || baseItem.damageModifiers;
  if (damageModifiers) calculatedItem.damageModifiers = damageModifiers;

  return calculatedItem;
}

export function generateScaledItem(dungeonData, categoryPool) {
  var floorBase = (dungeonData && dungeonData.floorBase) || 1;
  var floorMult = (dungeonData && dungeonData.floorMult) || 0.1;
  var floorAmount = (dungeonData && dungeonData.floorAmount) || 3;
  var dungeonDifficulty = floorBase + floorMult * floorAmount;
  var baseLevel = Math.max(0.1, 0.5 + dungeonDifficulty / 2);
  var category = categoryPool[Math.floor(Math.random() * categoryPool.length)];
  var itemLevel =
    0.2 + Math.pow(0.2 + (baseLevel / 1.2 + floorAmount / 13) + Math.random() * (baseLevel * 3.8 + 1), 0.9) / 1.9;
  var itemRarity = 0.4 + Math.pow(0.7 + Math.random() * (baseLevel * 2.6 + 7), 0.65) / 2.3;
  itemRarity = Number(itemRarity.toFixed(1));
  var logMsg = `Generating item for dungeon difficulty ${dungeonDifficulty.toFixed(2)}: level ${itemLevel.toFixed(2)}, rarity ${itemRarity}, category ${category}`;
  console.log(logMsg);

  var generatedItem = generateRandomItem(category, { level: Math.round(itemLevel), rarity: itemRarity });
  var calculatedValue = calculateItemPrice(generatedItem.baseValue, generatedItem.level, generatedItem.rarity);
  generatedItem.price = Math.max(10, Number.isFinite(calculatedValue) ? calculatedValue : 10);
  return generatedItem;
}

export function updateCatalogs(catalog) {
  if (!catalog) return;
  defaultCatalog = Object.assign({}, defaultCatalog, catalog);
}

export function resolveItem(slot, id, level, rarity) {
  var base = findBaseItem(slot, id);
  if (!base) return null;
  var cat = SLOT_CATEGORY[slot] || normalizeCategory(slot);
  var ref = {
    id: id,
    baseItem: id,
    slot: cat,
    name: base.id,
    displayName: base.name,
    level: level,
    rarity: rarity,
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
