# How to Create a New Gear Item

This guide explains how to add a new item to the game. It covers the file structure, required fields, the item processing pipeline, and common pitfalls.

---

## 1. Understand the file structure

All gear JSON files live under `public/gear/` in a slot-based folder structure:

```
public/gear/
  WeaponMelee/       # blunt.json, longBlade.json, shortBlade.json, polearms.json, pugilism.json
  WeaponRanged/      # slings.json, bow.json, thrown.json
  WeaponMagic/       # runes.json, rods.json, staves.json
  armor/             # light.json, medium.json, heavy.json
  headGear/          # light.json, medium.json, heavy.json
  feetWear/          # light.json, medium.json, heavy.json
  offHand/           # offHand.json
  itemGenerator.js   # Central catalog builder — imports all JSON files
```

Each JSON file is an array of item objects.

---

## 2. Required item fields

Every item in a gear JSON file must include these fields:

```json
{
  "id": "uniqueId",
  "name": "Display Name",
  "type": "melee|ranged|magic",
  "subType": "blunt|longBlade|shortBlade|polearms|pugilism|slings|bow|thrown|runes|rods|staves",
  "damage": 10,
  "spellPower": 0,
  "attackSpeed": 1.2,
  "bonuses": { "STR": 5, "DEX": 3 },
  "damageModifiers": { "STR": 1.0 },
  "range": 1,
  "value": 25,
  "description": "A brief description of the item."
}
```

### Field reference

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | Yes | Unique identifier used to reference the item in abilities, inventory, and equipment. Must match exactly in `findBaseItem()` lookups. |
| `name` | string | Yes | Display name shown to the player. |
| `type` | string | Yes | One of `melee`, `ranged`, or `magic`. Determines which ability categories can use this weapon. |
| `subType` | string | Yes | The weapon subtype (e.g. `blunt`, `longBlade`, `bow`). Must match `requiredWeaponSubTypes` in abilities for the weapon to be usable with those abilities. |
| `damage` | number | Yes | Base physical damage. Used in `calculateItemStats()` and `calculateItemPrice()`. |
| `spellPower` | number | Yes | Base spell power. Set to `0` for non-magic weapons. |
| `attackSpeed` | number | Yes | Attacks per second. Affects DPS calculation and ability timing. |
| `bonuses` | object | Yes | Stat bonuses applied to the player when equipped. Keys are stat names (STR, DEX, AGI, VIT, INT, CNC, etc.), values are numbers. |
| `damageModifiers` | object | Yes | Multipliers applied to damage based on the player's stats. Keys are stat names, values are multipliers (e.g. `1.0` = full scaling, `0.5` = half scaling). |
| `range` | number | Yes | Weapon range. Currently an unused mechanic — set to `1` for all items. |
| `value` | number | Yes | Base gold value. Used by `calcGearPrices.mjs` for price normalization and by `calculateItemPrice()` for shop pricing. |
| `description` | string | Yes | Flavor text shown to the player. |

### Optional fields

| Field | Type | Description |
|---|---|---|
| `twoHanded` | boolean | If `true`, the weapon occupies both hands and cannot use an offhand. Also grants access to `skill_twoHanded.json` abilities. |

---

## 3. Add the item to the correct JSON file

Items are grouped by subtype. To add a new long blade, edit `public/gear/WeaponMelee/longBlade.json`:

```bash
# Read the current file
cat public/gear/WeaponMelee/longBlade.json

# Add your new item to the array, then write it back
```

The JSON file must remain a valid JSON array. Each item in the array is a separate weapon that can be randomly selected when generating loot or shop stock.

---

## 4. The item processing pipeline

When a player equips or purchases an item, it goes through this pipeline:

### Step 1: `itemGenerator.generateRandomItem()` — Loot/shop generation

Called when generating shop stock or random dungeon loot. Picks a random base item from the catalog, then applies level and rarity scaling.

- **Input:** category (e.g. `'weapon'`), options (level, rarity), optional catalog override
- **Output:** A full item object with computed `damage`, `spellPower`, `attackSpeed`, `bonuses`, `damageModifiers`, `baseValue`, `baseRange` — all derived from the base item in the JSON
- **Key:** The output item's `id` is `baseItem.id + '-' + randomSuffix` (e.g. `longSword-a3f8k2`). The `baseItem` field stores the original `baseItem.id` (e.g. `longSword`) for lookup purposes.

### Step 2: `utils.toInventoryItem()` — Convert to inventory format

Called when adding an item to a player's inventory or equipment.

- **Input:** The generated item object + slot name
- **Output:** A compact inventory entry with `id`, `level`, `rarity`, `slot`, `baseItem`, `baseDamage`, `baseSpellPower`, `baseAttackSpeed`, `baseDefense`, `baseMagicResist`, `baseDamageModifiers`, `baseValue`, `baseRange`, `baseBonuses`, `type`, `subType`, `twoHanded`, `description`
- **Key:** This strips out computed stats (like `damage` after level scaling) and stores only base values. The computed stats are recalculated on equip.

### Step 3: `itemGenerator.calculateItemStats()` — Compute final stats

Called when equipping an item or resolving an item for display.

- **Input:** The inventory item (with base values)
- **Output:** The item with computed `damage`, `spellPower`, `attackSpeed`, `defense`, `magicResist`, `value`, `bonuses` — all scaled by `level` and `rarity`
- **Formula:** `calculateItemStat(baseValue, level, rarity)` = `baseValue * (0.7 + level/16) * (0.6 + rarity/7)`

### Step 4: `itemGenerator.resolveItem()` — Full resolution

Called when resolving a compact equipment ref (e.g. `{ id: 'longSword', level: 5, rarity: 3 }`) to a full computed item. Combines `findBaseItem()` + `calculateItemStats()`.

---

## 5. How the catalog is built

`public/gear/itemGenerator.js` imports all JSON files and builds `defaultCatalog`:

```js
// Imports (21 total)
import meleeBlunt from './WeaponMelee/blunt.json' with { type: 'json' };
import meleeLongBlade from './WeaponMelee/longBlade.json' with { type: 'json' };
// ... (all 21 imports)

// Catalog structure
let defaultCatalog = {
  weapon: [...allWeapons],           // Aggregated flat array
  weaponMelee: [...meleeBlunt, ...meleeLongBlade, ...],  // Per-subtype
  weaponRanged: [...rangedSlings, ...rangedBow, ...],
  weaponMagic: [...magicRunes, ...magicRods, ...magicStaves],
  headgear: [...headgearLight, ...headgearMedium, ...headgearHeavy],
  armor: [...armorLight, ...armorMedium, ...armorHeavy],
  shoes: [...feetWearLight, ...feetWearMedium, ...feetWearHeavy],
  offHand: [...offHand],
};
```

**To add a new item:** You only need to edit the appropriate JSON file. The catalog is rebuilt from the JSON imports at module load time. No code changes are needed in `itemGenerator.js` unless you're adding a new slot category.

---

## 6. How abilities reference weapon subtypes

Abilities in `public/abilities/` use `requiredWeaponSubTypes` to restrict which weapons can use them:

```json
{
  "id": "longblade_quick_slash",
  "requiredWeaponSubTypes": ["longBlade"],
  "allowedWeaponClasses": ["melee"],
  "requiresWeaponEquipped": true
}
```

**To make an ability usable with a new weapon:** Add the weapon's `subType` to the ability's `requiredWeaponSubTypes` array.

**To create a new ability for a subtype:** Add a new entry to the appropriate ability JSON file (e.g. `skill_melee_longBlade.json`).

---

## 7. Two-handed weapons

Two-handed weapons have `twoHanded: true` in their JSON. This means:

- They **cannot** equip an offhand
- They gain access to abilities in `skill_twoHanded.json` (Wide Arc, Shattering Slam, Whirlwind Spin, Earthquake)
- They have a **50% chance to hit an additional target** with every weapon attack (passive proc)
- They are excluded from offhand stat bonuses (STR, AGI, VIT, INT, etc.)

Currently two-handed weapons exist in:
- `WeaponMelee/longBlade.json` — greatSword
- `WeaponMelee/blunt.json` — ironMaul
- `WeaponMelee/polearms.json` — halberd

---

## 8. Price calculation

`calcGearPrices.mjs` reads all gear JSON files and computes normalized prices using a scoring system:

- **Defensive items** (armor, headgear, feetWear, offHand): scored by `defense + magicResist + bonusWeight`
- **Weapon items**: scored by `effectiveDamage + effectiveSpellPower/8 + attackSpeed*0.8 + bonusWeight`
- Scores are normalized across all items of the same `kind` (defensive or weapon)
- The `value` field in each JSON item is overwritten with the normalized score

**To add a new item:** Run `node --experimental-vm-modules scripts/calcGearPrices.mjs update` after adding the item to recalculate all prices.

---

## 9. Shop restock and starting inventory

- **Shop restock:** `characters.restockShopWithDungeonScaling()` calls `itemGenerator.generateScaledItem()` for categories `['weapon', 'armor', 'headgear', 'shoes', 'offHand']`. Any item in the catalog can appear in the shop.
- **Starting inventory:** `characters.getStartingInventory()` returns `[{ id: 'pebble', ... }, { id: 'magicRune', ... }]`. To add a new starting item, edit this function in `characters.js`.
- **Default equipment:** `characters.getDefaultEquipment()` sets starter gear (`newspaper`, `rags`, `strawHat`, `sandals`). To change starter gear, edit this function in `characters.js`.

---

## 10. Common pitfalls

1. **Duplicate `id` values.** Every item must have a unique `id`. If two items share an `id`, `findBaseItem()` will return the first match, and the second item is unreachable.

2. **Mismatched `subType`.** The `subType` field must exactly match the `requiredWeaponSubTypes` in abilities. A typo like `"longblade"` vs `"longBlade"` will make the weapon unusable with any proficiency ability.

3. **Missing `type` field.** Abilities filter by `allowedWeaponClasses` (`melee`, `ranged`, `magic`). The item's `type` must match the ability's `allowedWeaponClasses`.

4. **Two-handed + offhand.** A two-handed weapon cannot equip an offhand. If you set `twoHanded: true` but the player has an offhand equipped, the offhand will be unequipped when the two-handed weapon is equipped (handled in `handleEquipItem`).

5. **Forgetting to run `calcGearPrices.mjs update`.** New items will have their original `value` from the JSON file until prices are recalculated. Shop stock uses `calculateItemPrice()` which scales from `baseValue`, so the `value` field affects shop pricing.

6. **Adding a new slot category.** If you add a new slot (e.g. `neck`), you must also update `SLOT_CATEGORY` in `itemGenerator.js`, `normalizeCategory()`, and `EQUIPMENT_SLOTS` in `characters.js`.

7. **Browser compatibility.** All gear JSON files are imported with `{ type: 'json' }` in `itemGenerator.js`. The browser loads these via Express static file serving (`express.static('public')`). New subdirectories are automatically served — no route changes needed.