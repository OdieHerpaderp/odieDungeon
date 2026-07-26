import { deepEqual } from "../utils.js";

export const PLAYER_FIELDS = [
  "hp",
  "ap",
  "maxHp",
  "maxAp",
  "level",
  "xp",
  "xpToNext",
  "gold",
  "mp",
  "maxMp",
  "pointsToAllocate",
  "abilityCooldowns",
  "str",
  "dex",
  "agi",
  "vit",
  "int",
  "cnc",
  "wis",
  "for",
  "luk",
  "pie",
  "equipment",
  "inventory",
  "armor",
  "weapon",
  "actionBar",
  "maxActionBar",
  "currentVenture",
  "effects",
];

export const ENEMY_FIELDS = ["hp", "maxHp", "ap", "maxAp", "mp", "maxMp", "actionBar", "maxActionBar", "isDead"];

export function buildSnapshot(entity) {
  const snapshot = { ...entity };
  if (entity.abilityCooldowns) snapshot.abilityCooldowns = { ...entity.abilityCooldowns };
  if (entity.equipment) snapshot.equipment = { ...entity.equipment };
  if (Array.isArray(entity.inventory)) snapshot.inventory = [...entity.inventory];
  if (entity.skillsState) snapshot.skillsState = { ...entity.skillsState };
  return snapshot;
}

export function extractDelta(lastState, current, fields) {
  const delta = {};
  for (const f of fields) {
    if (current[f] !== undefined && !deepEqual(current[f], lastState[f])) {
      delta[f] = current[f];
    }
  }
  return delta;
}
