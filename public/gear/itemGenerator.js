(function (root, factory) {
  var generator = factory();

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = generator;
  }

   if (root) {
     root.itemGenerator = generator;
     root.generateScaledItem = generator.generateScaledItem;
     root.generateRandomItem = generator.generateRandomItem;
     root.calculateItemStat = generator.calculateItemStat; // Export the calculation function
     root.calculateItemStats = generator.calculateItemStats; // Export the calculation function
     root.calculateItemPrice = generator.calculateItemPrice; // Export the pricing function
     root.calculateItemTier = generator.calculateItemTier; // Export the tier calculation function
     root.resolveItem = generator.resolveItem;
     root.findBaseItem = generator.findBaseItem;
   }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
   var defaultCatalog = {
      weapon: [],
      headgear: [],
      armor: [],
      // Populated from feetWear*.json (Node) or via updateCatalogs (browser)
      shoes: []
    };

   // Map equipment slot names to their catalog category
   var SLOT_CATEGORY = {
     weapon: 'weapon',
     armour: 'armor',
     armor: 'armor',
     helmet: 'headgear',
     headgear: 'headgear',
     shoes: 'shoes'
   };

    // Check if we're in a browser environment and load the JSON files accordingly
    if (typeof module !== 'undefined' && module.exports) {
      // Node.js environment
      var weaponMelee = require('./weaponMelee.json');
      var weaponRanged = require('./weaponRanged.json');
      var weaponMagic = require('./weaponMagic.json');
      var headgearLight = require('./headgearLight.json');
      var headgearMedium = require('./headgearMedium.json');
      var headgearHeavy = require('./headgearHeavy.json');
      var armorLight = require('./armorLight.json');
      var armorMedium = require('./armorMedium.json');
      var armorHeavy = require('./armorHeavy.json');
      var feetWearLight = require('./feetWearLight.json');
      var feetWearMedium = require('./feetWearMedium.json');
      var feetWearHeavy = require('./feetWearHeavy.json');
      defaultCatalog.weapon = [...weaponMelee, ...weaponRanged, ...weaponMagic];
      defaultCatalog.headgear = [...headgearLight, ...headgearMedium, ...headgearHeavy];
      defaultCatalog.armor = [...armorLight, ...armorMedium, ...armorHeavy];
      defaultCatalog.shoes = [...feetWearLight, ...feetWearMedium, ...feetWearHeavy];
    } else {
      // Browser environment - we'll load the data asynchronously later
      // Initialize with empty arrays and provide a function to update the catalogs
    }

  function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function randomFloat(min, max) {
    return Math.random() * (max - min) + min;
  }

  function pickRandom(items) {
    if (!items || !items.length) {
      return null;
    }

    return items[randomInt(0, items.length - 1)];
  }

  function normalizeCategory(category) {
    if (!category) {
      return pickRandom(Object.keys(defaultCatalog));
    }

    var normalized = String(category).toLowerCase();
    var aliases = {
      weapons: 'weapon',
      weapon: 'weapon',
      headgear: 'headgear',
      helmet: 'headgear',
      armor: 'armor',
      armors: 'armor'
    };

    return aliases[normalized] || normalized;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  // Calculate individual stat based on base value, level, and rarity.
  // All values are always rounded to two decimals.
   function calculateItemStat(baseValue, level, rarity) {
    if (typeof baseValue !== 'number') {
      return baseValue; // Return as-is if not a number
    }

    var levelMultiplier = 0.7 + level / 21;
    var rarityMultiplier = 0.6 + rarity / 10;
    var calculatedValue =
      Math.round(baseValue * levelMultiplier * rarityMultiplier * 100) / 100;
    return calculatedValue; // Ensure minimum value of 0.01 for defensive stats
  }

   function calculateItemTier(item) {
     if (!item) return null;
     var level = Number.isFinite(item.level) ? item.level : 1;
     var rarity = Number.isFinite(item.rarity) ? item.rarity : 1;
     return (calculateItemStat(39.5, level, rarity) - 18.3) / 2.3;
   }

   // Calculate the item's gold price (buy/sell base) using the POW formula.
  // No flooring or sell multiplier is applied here — call sites handle those.
  function calculateItemPrice(baseValue, level, rarity) {
    if (typeof baseValue !== 'number') {
      return baseValue; // Return as-is if not a number
    }
    const levelMult = Math.pow(0.9 + level * 0.9, 1.2);
    const rarityMult = Math.pow(0.9 + rarity * 1.5, 1.4);
    return Math.round(Math.pow((baseValue * (0.9 + levelMult / 11) * (0.9 + rarityMult / 8)) * 1.9, 1.3)) / 10;
  }

  // Calculate bonuses based on base bonuses, level, and rarity
  function calculateBonuses(baseBonuses, level, rarity) {
    var calculatedBonuses = {};
    if (!baseBonuses) {
      return calculatedBonuses;
    }

    Object.keys(baseBonuses).forEach(function (stat) {
      var baseValue = baseBonuses[stat];
      calculatedBonuses[stat] = calculateItemStat(baseValue, level, rarity);
    });

    return calculatedBonuses;
  }

  function generateRandomItem(category, options, catalog) {
    var normalizedCategory = normalizeCategory(category);
    var itemCatalog = catalog && catalog[normalizedCategory]
      ? catalog[normalizedCategory]
      : defaultCatalog[normalizedCategory];

    if (!itemCatalog || !itemCatalog.length) {
      throw new Error('No items available for category: ' + normalizedCategory);
    }

    var baseItem = pickRandom(itemCatalog);
    var level = options && Number.isFinite(options.level)
      ? clamp(options.level, 1, 99)
      : randomInt(1, 30);
    var rarity = options && Number.isFinite(options.rarity)
      ? clamp(options.rarity, 1, 6)
      : randomFloat(1, 6);
    var levelMultiplier = 1 + level / 100;
    var rarityMultiplier = 1 + rarity / 100;
    var item = {
      id: baseItem.id + '-' + Math.random().toString(36).slice(2, 8),
      slot: normalizedCategory,
      name: baseItem.id,
      displayName: baseItem.name,
      level: level,
      rarity: Number(rarity.toFixed(2)),
      baseItem: baseItem.id, // Keep reference to the base item
      type: baseItem.type,
      // Store base values instead of calculated ones
      baseBonuses: baseItem.bonuses,
      baseDamage: baseItem.damage,
      baseSpellPower: baseItem.spellPower,
      baseAttackSpeed: baseItem.attackSpeed,
      baseDefense: baseItem.defense,
      baseMagicResist: baseItem.magicResist,
      baseDamageModifiers: baseItem.damageModifiers,
      baseValue: baseItem.value,
      baseRange: baseItem.range,
      description: baseItem.description
    };

    // Note: Actual stats will be calculated dynamically when needed
    // This reduces storage redundancy and ensures consistency
    
    return item;
  }

   // Find a base item definition from the catalog by equipment slot + id
   function findBaseItem(slot, id) {
     var cat = SLOT_CATEGORY[slot] || normalizeCategory(slot);
     var list = defaultCatalog[cat];
     if (!list || !list.length) return null;
     return list.find(function (i) { return i.id === id; }) || null;
   }

   // Function to calculate all stats for an item dynamically
   function calculateItemStats(item) {
    if (!item || !item.baseItem) {
      return item;
    }
    
    // Get the base item definition from the catalog
    var baseItem = null;
    var category = item.slot;
    
    if (defaultCatalog[category]) {
      baseItem = defaultCatalog[category].find(i => i.id === item.baseItem);
    }
    
    if (!baseItem) {
      return item; // Return as-is if base item not found
    }
    
    // Create a copy of the item with calculated stats
    var calculatedItem = Object.assign({}, item);
    
    // Calculate all stats based on base values
    if (typeof item.baseDamage === 'number') {
      calculatedItem.damage = calculateItemStat(item.baseDamage, item.level, item.rarity);
    }

    if (typeof item.baseSpellPower === 'number') {
      calculatedItem.spellPower = calculateItemStat(item.baseSpellPower, item.level, item.rarity);
    }

    if (typeof item.baseAttackSpeed === 'number') {
      calculatedItem.attackSpeed = item.baseAttackSpeed;
    }

     if (typeof item.baseDefense === 'number') {
       calculatedItem.defense = calculateItemStat(item.baseDefense, item.level, item.rarity);
     }

     if (typeof item.baseMagicResist === 'number') {
       calculatedItem.magicResist = calculateItemStat(item.baseMagicResist, item.level, item.rarity);
     }

      if (typeof item.baseValue === 'number') {
        calculatedItem.value = calculateItemPrice(item.baseValue, item.level, item.rarity);
      }
    
    if (typeof item.baseRange === 'number') {
      calculatedItem.range = item.baseRange; // Range typically doesn't scale with level/rarity
    }
    
     if (item.baseBonuses) {
       calculatedItem.bonuses = calculateBonuses(item.baseBonuses, item.level, item.rarity);
     }

     var damageModifiers = (baseItem && baseItem.damageModifiers)
       || item.baseDamageModifiers
       || item.damageModifiers;
     if (damageModifiers) {
       calculatedItem.damageModifiers = damageModifiers;
     }

      return calculatedItem;
   }

   // Generate a single randomized item scaled to a dungeon's difficulty.
   // Shares the exact same scaling math as the shop restock so boss rewards and
   // shop stock feel consistent for a given dungeon clear.
   function generateScaledItem(dungeonData, categoryPool) {
     var floorBase = dungeonData && dungeonData.floorBase || 1;
     var floorMult = dungeonData && dungeonData.floorMult || 0.1;
     var floorAmount = dungeonData && dungeonData.floorAmount || 3;
     var dungeonDifficulty = floorBase + floorMult * floorAmount;

     var baseLevel = Math.max(0.1, 0.5 + dungeonDifficulty / 2);

     var category = categoryPool[Math.floor(Math.random() * categoryPool.length)];

     var itemLevel = 0.4 + Math.pow(0.3 + (baseLevel / 1.5 + floorAmount / 13) + Math.random() * (baseLevel * 3.2 + 3), 0.9) / 1.8;
  
     var itemRarity = 0.6 + Math.pow(0.9 + Math.random() * (baseLevel * 2.2 + 7), 0.65) / 2.5;
      itemRarity = Number(itemRarity.toFixed(1));
     console.log(`Generating item for dungeon difficulty ${dungeonDifficulty.toFixed(2)}: level ${itemLevel.toFixed(2)}, rarity ${itemRarity}, category ${category}`);

     var generatedItem = generateRandomItem(category, {
       level: Math.round(itemLevel),
       rarity: itemRarity
     });

       var calculatedValue = calculateItemPrice(
         generatedItem.baseValue,
         generatedItem.level,
         generatedItem.rarity
       );
       generatedItem.price = Math.max(10, Number.isFinite(calculatedValue) ? calculatedValue : 10);

     return generatedItem;
   }

    // Function to update catalogs with data loaded from JSON files (for browser)
    function updateCatalogs(weaponMelee, weaponRanged, weaponMagic, headgear, armors, shoes) {
      if (weaponMelee) defaultCatalog.weapon = [...(weaponMelee || []), ...(weaponRanged || []), ...(weaponMagic || [])];
      if (headgear) defaultCatalog.headgear = headgear;
      if (armors) defaultCatalog.armor = armors;
      if (shoes) defaultCatalog.shoes = shoes;
    }

   // Resolve a compact equipment reference ({ id, level, rarity }) into a
   // fully calculated item by looking the base definition up in the catalog.
   // Returns null if the base item cannot be found.
   function resolveItem(slot, id, level, rarity) {
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
       description: base.description,
        baseDamage: base.damage,
        baseAttackSpeed: base.attackSpeed,
        baseSpellPower: base.spellPower,
         baseDefense: base.defense,
        baseMagicResist: base.magicResist,
        baseDamageModifiers: base.damageModifiers,
        baseValue: base.value,
       baseRange: base.range,
       baseBonuses: base.bonuses
     };

     return calculateItemStats(ref);
   }

     return {
       defaultCatalog: defaultCatalog,
       generateRandomItem: generateRandomItem,
       calculateItemStat: calculateItemStat,
       calculateItemPrice: calculateItemPrice,
       calculateItemStats: calculateItemStats,
       calculateItemTier: calculateItemTier,
       generateScaledItem: generateScaledItem,
       updateCatalogs: updateCatalogs,
       findBaseItem: findBaseItem,
       resolveItem: resolveItem,
       normalizeCategory: normalizeCategory
     };
}));