import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { calcSkillLv, calcXpForLevel, calcXpForNextLevel, getEffectiveAttribute, attributeScaling } from '../../utils.js';
import * as itemGenerator from '../gear/itemGenerator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const weapons = itemGenerator.getCatalog().weapon;

// Load skill definitions from skills.json file
const skillDefinitionsRaw = JSON.parse(fs.readFileSync(path.join(__dirname, 'skills.json'), 'utf8'));

// Add xpCurve function to each skill definition for backward compatibility
const skillDefinitions = skillDefinitionsRaw.map((skill) => ({
  ...skill,
  xpCurve: skill.xpCurve || ((level) => 20 + level * 10), // Default curve if not specified in JSON
}));

export function getDefaultSkillsState() {
  return Object.fromEntries(skillDefinitions.map((skill) => [skill.id, { xp: 0 }]));
}

export function getSkillDefinition(skillId) {
  return skillDefinitions.find((skill) => skill.id === skillId) || null;
}

export function getSkillLevel(skillsState, skillId) {
  const xp = skillsState?.[skillId]?.xp || 0;
  return Math.floor(calcSkillLv(xp));
}

export function getSkillXp(skillsState, skillId) {
  return skillsState?.[skillId]?.xp || 0;
}

// Equipped weapons are persisted as compact refs ({ id, level, rarity }) that omit
// weaponClass/type, so resolve the full weapon definition by id when a compact ref is passed.
function resolveFullWeapon(weapon) {
  if (!weapon || !weapon.id) return weapon;
  return weapons.find((w) => w.id === weapon.id) || weapon;
}

// Map a melee weapon `subType` to its proficiency skill id. Derived from the
// subTypes declared in public/gear/WeaponMelee/ so each melee subtype is its own skill.
const MELEE_SUBTYPE_TO_SKILL = {
  blunt: 'skill_melee_blunt',
  longblade: 'skill_melee_longBlade',
  shortblade: 'skill_melee_shortBlade',
  polearms: 'skill_melee_polearms',
  pugilism: 'skill_melee_pugilism',
};

export function getWeaponSkillId(weapon) {
  if (!weapon) return 'skill_melee_blunt';
  if (weapon.defaultSkillIdOnHit) return weapon.defaultSkillIdOnHit;
  const resolved = resolveFullWeapon(weapon);
  const weaponClass = (resolved?.weaponClass || resolved?.type || '').toLowerCase();
  if (weaponClass === 'ranged') {
    const subType = (resolved?.subType || '').toLowerCase();
    if (subType === 'thrown') return 'skill_thrown';
    // slings, bows, or any other ranged subType → archery
    return 'skill_archery';
  }
  if (weaponClass === 'magic') return 'skill_magic';
  if (weaponClass === 'melee') {
    const subType = (resolved?.subType || '').toLowerCase();
    return MELEE_SUBTYPE_TO_SKILL[subType] || 'skill_melee_blunt';
  }
  return 'skill_melee_blunt';
}

export function awardSkillXp(skillsState, skillId, xpAmount) {
  if (!skillsState || !skillId) return skillsState;
  const nextState = { ...(skillsState || {}) };
  const state = { ...(nextState[skillId] || { xp: 0 }) };
  state.xp = (state.xp || 0) + xpAmount;
  nextState[skillId] = state;
  return nextState;
}

// Map an armor `type` to its proficiency skill id.
const ARMOR_TYPE_TO_SKILL = {
  light: 'skill_armor_light',
  medium: 'skill_armor_medium',
  heavy: 'skill_armor_heavy',
};

// Resolve the armor `type` (light/medium/heavy) for an equipped piece, handling both
// full resolved items (which carry `.type`) and compact refs ({ id, level, rarity }).
function getArmorPieceType(slot, piece) {
  if (!piece) return null;
  if (piece.type) return String(piece.type).toLowerCase();
  if (piece.id && itemGenerator && typeof itemGenerator.resolveItem === 'function') {
    const resolved = itemGenerator.resolveItem(slot, piece.id, piece.level, piece.rarity);
    if (resolved && resolved.type) return String(resolved.type).toLowerCase();
  }
  return null;
}

// Award armor proficiency XP based on the damage the player mitigated. The XP is split
// across the proficiencies of the player's worn armor pieces, weighted by piece count
// (each piece contributes equally; pieces of the same type pool into one proficiency).
export function awardArmorProficiencyXp(skillsState, mitigatedAmount, player) {
  if (!skillsState || !player || !(mitigatedAmount > 0)) return skillsState;

  const SLOTS = ['chest', 'helmet', 'shoes', 'offHand'];
  const equipment = player.equipment || {};
  const typeCounts = {};
  let total = 0;

  // Empty/missing slots are safely skipped: getArmorPieceType returns null
  // for undefined pieces, and the guard below skips any type not in the map.
  for (const slot of SLOTS) {
    const type = getArmorPieceType(slot, equipment[slot]);
    if (type && ARMOR_TYPE_TO_SKILL[type]) {
      typeCounts[type] = (typeCounts[type] || 0) + 1;
      total += 1;
    }
  }

  if (total === 0) return skillsState;

  let nextState = skillsState;
  for (const [type, count] of Object.entries(typeCounts)) {
    const share = Math.round((mitigatedAmount * count) / total);
    if (share > 0) {
      nextState = awardSkillXp(nextState, ARMOR_TYPE_TO_SKILL[type], share);
    }
  }
  return nextState;
}

// Helper: fetch a stat bonus from an equipped item
function getStatBonusFromItem(item, stat) {
  return item?.bonuses?.[stat] ?? 0;
}

export function getEquippedItem(player, slot) {
  if (!player) return null;
  const equipment = player.equipment || {};
  return equipment[slot] || null;
}

export function getEquippedWeaponClass(weapon) {
  const resolved = resolveFullWeapon(weapon);
  return (resolved?.weaponClass || resolved?.type || '').toLowerCase();
}

export function getEquippedWeaponSubType(weapon) {
  const resolved = resolveFullWeapon(weapon);
  return (resolved?.subType || '').toLowerCase() || null;
}

export function getAbilityUnlockState(ability, player) {
  if (!ability) return false;
  const ownSkillLevel = getSkillLevel(player?.skillsState || {}, ability.skillId);
  return ownSkillLevel >= (ability.unlockSkillLevelMin ?? 1);
}

export function selectAbilityToCast(player, abilities, now, liveTargets) {
  if (!player || !Array.isArray(abilities) || abilities.length === 0) return null;
  const slots = player.abilitySlots || [];
  const slotIds = slots.filter(Boolean);
  const available = abilities.filter((ability) => {
    if (!ability || !slotIds.includes(ability.id)) return false;
    if (!getAbilityUnlockState(ability, player)) return false;
    const cooldownReady = !player.abilityCooldowns?.[ability.id] || now >= player.abilityCooldowns[ability.id];
    if (!cooldownReady) return false;
    if ((player.mp || 0) < (ability.mpCostBase || 0)) return false;
    if (ability.isHeal && Array.isArray(liveTargets)) {
      const needsHealing = liveTargets.some((t) => !t.isEnemy && t.hp > 0 && t.hp < 0.75 * (t.maxHp || 1));
      if (!needsHealing) return false;
    }
    const weapon = getEquippedItem(player, 'weapon');
    const weaponClass = getEquippedWeaponClass(weapon);
    if (ability.allowedWeaponClasses && ability.allowedWeaponClasses.length > 0) {
      if (ability.requiresWeaponEquipped && !weapon) return false;
      if (weaponClass && !ability.allowedWeaponClasses.includes(weaponClass)) return false;
    }
    if (ability.requiredWeaponSubTypes && ability.requiredWeaponSubTypes.length > 0) {
      if (ability.requiresWeaponEquipped && !weapon) return false;
      const subType = getEquippedWeaponSubType(weapon);
      const required = ability.requiredWeaponSubTypes.map((s) => String(s).toLowerCase());
      if (subType && !required.includes(subType)) return false;
    }
    if (ability.requiresTwoHandedWeapon) {
      const resolved = resolveFullWeapon(getEquippedItem(player, 'weapon'));
      if (!resolved?.twoHanded) return false;
    }
    return true;
  });
  return available[0] || null;
}

export function applyAbilityCast(player, ability, now) {
  if (!player || !ability) return null;
  const next = { ...(player || {}) };
  next.mp = Math.max(0, (next.mp || 0) - (ability.mpCostBase || 0));
  next.abilityCooldowns = { ...(next.abilityCooldowns || {}) };
  next.abilityCooldowns[ability.id] = now + (ability.cooldownMsBase || 1000);
  return next;
}

export const calculateAttributeScaling = attributeScaling;

// New function to calculate healing based on skill level
export function calculateHealAmount(ability, player) {
  if (!ability || !player) return 0;

  let healAmount = ability.healAmount || 0;
  const skillLevel = getSkillLevel(player.skillsState, ability.skillId);
  const skillMultiplier = 1 + skillLevel * 0.01;

  if (!ability.castUsesWeaponDamageModel) {
    const weapon = getEquippedItem(player, 'weapon');
    const resolvedWeapon = weapon?.id
      ? itemGenerator.resolveItem('weapon', weapon.id, weapon.level || 1, weapon.rarity || 1)
      : null;
    healAmount += resolvedWeapon?.spellPower || 0;
  }

  const attributeMultiplier = calculateAttributeScaling(player, ability.attributeDamageScale);

  return Math.floor(healAmount * skillMultiplier * attributeMultiplier);
}

// New function to award XP for healing actions
export function awardHealXp(skillsState, amountHealed, skillId) {
  const healingXp = 3 + amountHealed / 4;
  return awardSkillXp(skillsState, skillId, healingXp);
}

// New function to calculate damage scaling for multi-target attacks
export function calculateDamageScalingForMultipleTargets(baseDamage, numTargets, abilityType = 'damage', player) {
  if (numTargets <= 1) return baseDamage;
  const weapon = getEquippedItem(player, 'weapon');
  const fullWeapon = weapon?.id ? weapons.find((w) => w.id === weapon.id) : null;
  const damageModifiers = fullWeapon?.damageModifiers || {};
  const entries = Object.entries(damageModifiers);
  if (entries.length === 0) return baseDamage;

  let sum = 0;
  for (const [stat, weight] of entries) {
    if (typeof weight !== 'number') continue;
    sum += getEffectiveAttribute(player, stat) * weight;
  }

  const attributeMultiplier = 1 + sum * 0.03;
  const scaled = baseDamage * attributeMultiplier;

  switch (abilityType) {
    case 'aoe':
      return scaled * Math.pow(0.85, numTargets - 1);
    case 'cone':
      return scaled * Math.pow(0.9, numTargets - 1);
    case 'damage':
    default:
      return scaled * Math.pow(0.75, numTargets - 1);
  }
}

// New function to get targets for an ability based on its properties
export function getAbilityTargets(caster, ability, liveTargets) {
  if (!caster || !ability || !liveTargets || liveTargets.length === 0) {
    return [];
  }

  const isHealAbility = ability.isHeal === true;

  let filteredTargets;
  if (isHealAbility) {
    filteredTargets = liveTargets.filter((t) => !t.isEnemy && t.hp > 0);
  } else {
    filteredTargets = liveTargets.filter((t) => t.isEnemy && t.hp > 0);
  }

  if (isHealAbility) {
    filteredTargets.sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp);
  } else {
    filteredTargets.sort(() => Math.random() - 0.5);
  }

  const maxTargets = chooseTargetCount(ability);
  return filteredTargets.slice(0, maxTargets);
}

export function chooseTargetCount(ability) {
  const targetDef = ability.targets;
  if (!Array.isArray(targetDef) || targetDef.length < 2) return ability.maxTargets || 1;
  const min = targetDef[0];
  const max = targetDef[1];
  if (!Number.isFinite(min) || !Number.isFinite(max)) return ability.maxTargets || 1;
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  const count = hi - lo + 1;
  return lo + Math.floor(Math.random() * count);
}

export { calcSkillLv, calcXpForLevel, calcXpForNextLevel };
