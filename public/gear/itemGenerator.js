// itemGenerator - ESM for server; also works as <script type="module"> for browser (skips Node import() branch)
// Browser fills catalogs via updateCatalogs() after fetching JSON from Express static files.

export const SLOT_CATEGORY = {
  weapon: 'weapon',
  armour: 'armor',
  armor: 'armor',
  helmet: 'headgear',
  headgear: 'headgear',
  shoes: 'shoes'
};

let defaultCatalog = {
  weapon: [],
  headgear: [],
  armor: [],
  shoes: []
};

export function getCatalog() { return defaultCatalog; }

// Server-side: load JSON catalogs synchronously via dynamic import().
// This block uses await which is valid as top-level-await in ESM modules.
// On the browser (<script type="module">), the same top-level await works but
// import('fs') throws — we guard with process check so it never runs client-side.
(async () => {
  if (typeof process !== 'undefined' && process.versions && process.versions.node) {
    try {
      const fs = await import('fs');
      const path = await import('path');
      const { fileURLToPath } = await import('url');
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = path.dirname(__filename);
      const require = (await import('module')).createRequire(import.meta.url);

      defaultCatalog.weapon = [
        ...require(path.join(__dirname, './weaponMelee.json')),
        ...require(path.join(__dirname, './weaponRanged.json')),
        ...require(path.join(__dirname, './weaponMagic.json'))
      ];
      defaultCatalog.headgear = [
        ...require(path.join(__dirname, './headgearLight.json')),
        ...require(path.join(__dirname, './headgearMedium.json')),
        ...require(path.join(__dirname, './headgearHeavy.json'))
      ];
      defaultCatalog.armor = [
        ...require(path.join(__dirname, './armorLight.json')),
        ...require(path.join(__dirname, './armorMedium.json')),
        ...require(path.join(__dirname, './armorHeavy.json'))
      ];
      defaultCatalog.shoes = [
        ...require(path.join(__dirname, './feetWearLight.json')),
        ...require(path.join(__dirname, './feetWearMedium.json')),
        ...require(path.join(__dirname, './feetWearHeavy.json'))
      ];
    } catch(e) {
      // If loading fails in server context, proceed with empty catalogs
      // (will be populated by index.js fetch + updateCatalogs if needed)
    }
  }
})();

function randomInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function randomFloat(min, max) { return Math.random() * (max - min) + min; }

function pickRandom(items) {
  if (!items || !items.length) return null;
  return items[randomInt(0, items.length - 1)];
}

export function normalizeCategory(category) {
  if (!category) return pickRandom(Object.keys(defaultCatalog));
  var normalized = String(category).toLowerCase();
  var aliases = {
    weapons: 'weapon', weapon: 'weapon',
    headgear: 'headgear', helmet: 'headgear',
    armor: 'armor', armors: 'armor'
  };
  return aliases[normalized] || normalized;
}

function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }

export function calculateItemStat(baseValue, level, rarity) {
  if (typeof baseValue !== 'number') return baseValue;
  var levelMultiplier = 0.7 + level / 21;
  var rarityMultiplier = 0.6 + rarity / 10;
  return Math.round(baseValue * levelMultiplier * rarityMultiplier * 100) / 100;
}

export function calculateItemTier(item) {
  if (!item) return null;
  var level = Number.isFinite(item.level) ? item.level : 1;
  var rarity = Number.isFinite(item.rarity) ? item.rarity : 1;
  return (calculateItemStat(39.5, level, rarity) - 18.7) / 1.9;
}

export function calculateItemPrice(baseValue, level, rarity) {
  if (typeof baseValue !== 'number') return baseValue;
  const levelMult = Math.pow(0.9 + level * 0.9, 1.2);
  const rarityMult = Math.pow(0.9 + rarity * 1.5, 1.4);
  return Math.round(Math.pow(baseValue * (0.9 + levelMult / 11) * (0.9 + rarityMult / 8) * 2.1, 1.4)) / 10;
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
  var itemCatalog = catalog && catalog[normalizedCategory] ? catalog[normalizedCategory] : defaultCatalog[normalizedCategory];
  if (!itemCatalog || !itemCatalog.length) throw new Error("No items available for category: " + normalizedCategory);

  var baseItem = pickRandom(itemCatalog);
  var level = options && Number.isFinite(options.level) ? clamp(options.level, 1, 99) : randomInt(1, 30);
  var rarity = options && Number.isFinite(options.rarity) ? clamp(options.rarity, 1, 6) : randomFloat(1, 6);

  return {
    id: baseItem.id + '-' + Math.random().toString(36).slice(2, 8),
    slot: normalizedCategory, name: baseItem.id, displayName: baseItem.name,
    level: level, rarity: Number(rarity.toFixed(2)),
    baseItem: baseItem.id, type: baseItem.type,
    baseBonuses: baseItem.bonuses, baseDamage: baseItem.damage,
    baseSpellPower: baseItem.spellPower, baseAttackSpeed: baseItem.attackSpeed,
    baseDefense: baseItem.defense, baseMagicResist: baseItem.magicResist,
    baseDamageModifiers: baseItem.damageModifiers, baseValue: baseItem.value,
    baseRange: baseItem.range, description: baseItem.description
  };
}

export function findBaseItem(slot, id) {
  var cat = SLOT_CATEGORY[slot] || normalizeCategory(slot);
  var list = defaultCatalog[cat];
  if (!list || !list.length) return null;
  return list.find(function (i) { return i.id === id; }) || null;
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
  if (typeof item.baseDamage === 'number') calculatedItem.damage = calculateItemStat(item.baseDamage, item.level, item.rarity);
  if (typeof item.baseSpellPower === 'number') calculatedItem.spellPower = calculateItemStat(item.baseSpellPower, item.level, item.rarity);
  if (typeof item.baseAttackSpeed === 'number') calculatedItem.attackSpeed = item.baseAttackSpeed;
  if (typeof item.baseDefense === 'number') calculatedItem.defense = calculateItemStat(item.baseDefense, item.level, item.rarity);
  if (typeof item.baseMagicResist === 'number') calculatedItem.magicResist = calculateItemStat(item.baseMagicResist, item.level, item.rarity);
  if (typeof item.baseValue === 'number') calculatedItem.value = calculateItemPrice(item.baseValue, item.level, item.rarity);
  if (typeof item.baseRange === 'number') calculatedItem.range = item.baseRange;
  if (item.baseBonuses) calculatedItem.bonuses = calculateBonuses(item.baseBonuses, item.level, item.rarity);

  var damageModifiers = (baseItem && baseItem.damageModifiers) || item.baseDamageModifiers || item.damageModifiers;
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
  var itemLevel = 0.4 + Math.pow(0.3 + (baseLevel / 1.2 + floorAmount / 13) + Math.random() * (baseLevel * 3.8 + 3), 0.9) / 1.8;
  var itemRarity = 0.6 + Math.pow(0.9 + Math.random() * (baseLevel * 2.3 + 7), 0.65) / 2.5;
  itemRarity = Number(itemRarity.toFixed(1));
  console.log(`Generating item for dungeon difficulty ${dungeonDifficulty.toFixed(2)}: level ${itemLevel.toFixed(2)}, rarity ${itemRarity}, category ${category}`);

  var generatedItem = generateRandomItem(category, { level: Math.round(itemLevel), rarity: itemRarity });
  var calculatedValue = calculateItemPrice(generatedItem.baseValue, generatedItem.level, generatedItem.rarity);
  generatedItem.price = Math.max(10, Number.isFinite(calculatedValue) ? calculatedValue : 10);
  return generatedItem;
}

export function updateCatalogs(weaponMelee, weaponRanged, weaponMagic, headgear, armors, shoes) {
  defaultCatalog.weapon = [...(weaponMelee||[]), ...(weaponRanged||[]), ...(weaponMagic||[])];
  defaultCatalog.headgear = headgear || [];
  defaultCatalog.armor = armors || [];
  defaultCatalog.shoes = shoes || [];
}

export function resolveItem(slot, id, level, rarity) {
  var base = findBaseItem(slot, id);
  if (!base) return null;
  var cat = SLOT_CATEGORY[slot] || normalizeCategory(slot);
  var ref = {
    id: id, baseItem: id, slot: cat, name: base.id, displayName: base.name,
    level: level, rarity: rarity, type: base.type, description: base.description,
    baseDamage: base.damage, baseAttackSpeed: base.attackSpeed, baseSpellPower: base.spellPower,
    baseDefense: base.defense, baseMagicResist: base.magicResist,
    baseDamageModifiers: base.damageModifiers, baseValue: base.value,
    baseRange: base.range, baseBonuses: base.bonuses
  };
  return calculateItemStats(ref);
}
