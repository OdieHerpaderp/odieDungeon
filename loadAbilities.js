// Node-only loader for ability definitions.
// Abilities are split into one JSON file per skillId (skill_*.json) under
// public/abilities/. This module auto-discovers those files, parses each as a
// JSON array, and concatenates them into a single flat array. Adding or
// removing a skill's abilities is done by editing that skill's file only.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ABILITIES_DIR = path.join(__dirname, "public", "abilities");
const ABILITY_FILE_GLOB = /^skill_.*\.json$/;

let cache = null;

export async function loadAbilities() {
  if (cache) return cache;

  let merged = [];
  try {
    const files = await fs.promises.readdir(ABILITIES_DIR);
    for (const file of files.sort()) {
      if (!ABILITY_FILE_GLOB.test(file)) continue;
      const filePath = path.join(ABILITIES_DIR, file);
      let parsed;
      try {
        const raw = await fs.promises.readFile(filePath, "utf8");
        parsed = JSON.parse(raw);
      } catch (err) {
        throw new Error(`Failed to parse ability file ${file}: ${err.message}`);
      }
      if (!Array.isArray(parsed)) {
        throw new Error(`Ability file ${file} must contain a JSON array`);
      }
      merged = merged.concat(parsed);
    }
  } catch (err) {
    if (err.code === "ENOENT") {
      throw new Error(`Abilities directory not found: ${ABILITIES_DIR}`);
    }
    throw err;
  }

  cache = merged;
  return merged;
}

export function getAbilityById(id) {
  return (cache || []).find((a) => a.id === id) || null;
}

// Clear the memoized result (e.g. for hot reload after editing files).
export function clearAbilitiesCache() {
  cache = null;
}
