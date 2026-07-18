const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { loadAbilities, getAbilityById, clearAbilitiesCache } = require('../loadAbilities');

clearAbilitiesCache();
const abilities = loadAbilities();

assert.strictEqual(abilities.length, 42, `expected 42 abilities, got ${abilities.length}`);
assert.ok(abilities.every(a => a.id && a.skillId), 'every ability must have an id and skillId');

const ids = new Set(abilities.map(a => a.id));
assert.strictEqual(ids.size, abilities.length, 'every ability id must be unique');

const skillFiles = fs.readdirSync(path.join(__dirname, '..', 'public', 'abilities'))
  .filter(f => /^skill_.*\.json$/.test(f));
assert.strictEqual(skillFiles.length, 13, `expected 13 skill_*.json files, got ${skillFiles.length}`);

const armorAbilities = abilities.filter(a => a.skillId && a.skillId.startsWith('skill_armor_'));
assert.ok(armorAbilities.length >= 3, 'expected at least 3 armor abilities');
assert.ok(armorAbilities.every(a => a.defenseUpAmount && a.defenseUpDuration), 'every armor ability must be a defenseUp self-buff');

assert.strictEqual(getAbilityById('fireball')?.skillId, 'skill_spellcasting');
assert.strictEqual(getAbilityById('does_not_exist'), null);

console.log('abilities loader checks passed');
