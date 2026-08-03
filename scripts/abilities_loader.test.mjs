import assert from "node:assert";
import fs from "fs";
import path from "path";
import { loadAbilities, getAbilityById, clearAbilitiesCache } from "../loadAbilities.js";

clearAbilitiesCache();
const abilities = await loadAbilities();

assert.strictEqual(abilities.length, 60, `expected 60 abilities, got ${abilities.length}`);
assert.ok(
  abilities.every((a) => a.id && a.skillId),
  "every ability must have an id and skillId"
);

const ids = new Set(abilities.map((a) => a.id));
assert.strictEqual(ids.size, abilities.length, "every ability id must be unique");

const skillFiles = fs.readdirSync(path.join(import.meta.dirname, "..", "public", "abilities")).filter((f) => /^skill_.*\.json$/.test(f));
assert.strictEqual(skillFiles.length, 17, `expected 17 skill_*.json files, got ${skillFiles.length}`);

const armorAbilities = abilities.filter((a) => a.skillId && a.skillId.startsWith("skill_armor_"));
assert.ok(armorAbilities.length >= 3, "expected at least 3 armor abilities");

assert.strictEqual(getAbilityById("fireball")?.skillId, "skill_spellcasting");
assert.strictEqual(getAbilityById("does_not_exist"), null);

console.log("abilities loader checks passed");
