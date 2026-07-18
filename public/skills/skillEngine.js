const fs = require('fs');
const path = require('path');
const weaponMelee = require(path.join(__dirname, '..', 'gear', 'weaponMelee.json'));
const weaponRanged = require(path.join(__dirname, '..', 'gear', 'weaponRanged.json'));
const weaponMagic = require(path.join(__dirname, '..', 'gear', 'weaponMagic.json'));
const weapons = [...weaponMelee, ...weaponRanged, ...weaponMagic];
const itemGenerator = require(path.join(__dirname, '..', 'gear', 'itemGenerator'));
const { calcSkillLv, calcXpForLevel, calcXpForNextLevel } = require(path.join(__dirname, '..', '..', 'utils.js'));

// Load skill definitions from skills.json file
const skillDefinitionsRaw = JSON.parse(fs.readFileSync(path.join(__dirname, 'skills.json'), 'utf8'));

// Add xpCurve function to each skill definition for backward compatibility
const skillDefinitions = skillDefinitionsRaw.map(skill => ({
  ...skill,
  xpCurve: skill.xpCurve || ((level) => 20 + level * 10) // Default curve if not specified in JSON
}));

// characters.js requires this module at load time, so require it lazily here to
// avoid a circular dependency. By the time these helpers run, characters.js is fully loaded.
let _charactersModule = null;
function getCharactersModule() {
  if (!_charactersModule) _charactersModule = require(path.join(__dirname, '..', '..', 'characters.js'));
  return _charactersModule;
}
function getDefaultSkillsState() {
  return Object.fromEntries(skillDefinitions.map(skill => [skill.id, { xp: 0 }]));
}

function getSkillDefinition(skillId) {
  return skillDefinitions.find(skill => skill.id === skillId) || null;
}

function getSkillLevel(skillsState, skillId) {
  const xp = skillsState?.[skillId]?.xp || 0;
  return Math.max(1, Math.floor(calcSkillLv(xp)));
}

function getSkillXp(skillsState, skillId) {
  return skillsState?.[skillId]?.xp || 0;
}

// Equipped weapons are persisted as compact refs ({ id, level, rarity }) that omit
// weaponClass/type, so resolve the full weapon definition by id when a compact ref is passed.
function resolveFullWeapon(weapon) {
  if (!weapon || !weapon.id) return weapon;
  return weapons.find(w => w.id === weapon.id) || weapon;
}

// Map a melee weapon `subType` to its proficiency skill id. Derived from the
// subTypes declared in public/gear/weaponMelee.json so each melee subtype is its own skill.
const MELEE_SUBTYPE_TO_SKILL = {
  blunt: 'skill_melee_blunt',
  longblade: 'skill_melee_longBlade',
  shortblade: 'skill_melee_shortBlade',
  polearms: 'skill_melee_polearms',
  pugilism: 'skill_melee_pugilism'
};

function getWeaponSkillId(weapon) {
  if (!weapon) return 'skill_melee_blunt';
  if (weapon.defaultSkillIdOnHit) return weapon.defaultSkillIdOnHit;
  const resolved = resolveFullWeapon(weapon);
  const weaponClass = (resolved?.weaponClass || resolved?.type || '').toLowerCase();
  if (weaponClass === 'ranged') return 'skill_ranged';
  if (weaponClass === 'magic') return 'skill_magic';
  if (weaponClass === 'melee') {
    const subType = (resolved?.subType || '').toLowerCase();
    return MELEE_SUBTYPE_TO_SKILL[subType] || 'skill_melee_blunt';
  }
  return 'skill_melee_blunt';
}

function awardSkillXp(skillsState, skillId, xpAmount) {
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
  heavy: 'skill_armor_heavy'
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
function awardArmorProficiencyXp(skillsState, mitigatedAmount, player) {
  if (!skillsState || !player || !(mitigatedAmount > 0)) return skillsState;

  const SLOTS = ['armour', 'helmet', 'shoes'];
  const equipment = player.equipment || {};
  const typeCounts = {};
  let total = 0;

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
  return (item?.bonuses?.[stat] ?? 0);
}

function getEquippedItem(player, slot) {
  if (!player) return null;
  const equipment = player.equipment || {};
  return equipment[slot] || null;
}

function getEquippedWeaponClass(weapon) {
  const resolved = resolveFullWeapon(weapon);
  return (resolved?.weaponClass || resolved?.type || '').toLowerCase();
}

function getEquippedWeaponSubType(weapon) {
  const resolved = resolveFullWeapon(weapon);
  return (resolved?.subType || '').toLowerCase() || null;
}

function getAbilityUnlockState(ability, player) {
  if (!ability) return false;
  const ownSkillLevel = getSkillLevel(player?.skillsState || {}, ability.skillId);
  return ownSkillLevel >= (ability.unlockSkillLevelMin || 1);
}

function selectAbilityToCast(player, abilities, now, liveTargets) {
  if (!player || !Array.isArray(abilities) || abilities.length === 0) return null;
  const slots = player.abilitySlots || [];
  const slotIds = slots.filter(Boolean);
  const available = abilities.filter(ability => {
    if (!ability || !slotIds.includes(ability.id)) return false;
    if (!getAbilityUnlockState(ability, player)) return false;
    const cooldownReady = !player.abilityCooldowns?.[ability.id] || now >= player.abilityCooldowns[ability.id];
    if (!cooldownReady) return false;
    if ((player.mp || 0) < (ability.mpCostBase || 0)) return false;
    if (ability.isHeal && Array.isArray(liveTargets)) {
      const needsHealing = liveTargets.some(t => !t.isEnemy && t.hp > 0 && t.hp < 0.75 * (t.maxHp || 1));
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
      const required = ability.requiredWeaponSubTypes.map(s => String(s).toLowerCase());
      if (subType && !required.includes(subType)) return false;
    }
    return true;
  });
  return available[0] || null;
}

function applyAbilityCast(player, ability, now) {
  if (!player || !ability) return null;
  const next = { ...(player || {}) };
  next.mp = Math.max(0, (next.mp || 0) - (ability.mpCostBase || 0));
  next.abilityCooldowns = { ...(next.abilityCooldowns || {}) };
  next.abilityCooldowns[ability.id] = now + (ability.cooldownMsBase || 1000);
  return next;
}

function calculateAttributeScaling(player, attributeDamageScale) {
  if (!attributeDamageScale || typeof attributeDamageScale !== 'object') return 1;
  const { getEffectiveAttribute } = getCharactersModule();
  let sum = 0;
  for (const [stat, weight] of Object.entries(attributeDamageScale)) {
    if (typeof weight !== 'number') continue;
    sum += getEffectiveAttribute(player, stat) * weight;
  }
  return 1 + sum * 0.01;
}

// New function to calculate healing based on skill level
function calculateHealAmount(ability, player) {
  if (!ability || !player) return 0;

  let healAmount = ability.healAmount || 0;
  const skillLevel = getSkillLevel(player.skillsState, ability.skillId) || 1;
  const skillMultiplier = 1 + skillLevel * 0.01;

  if (!ability.castUsesWeaponDamageModel) {
    const weapon = getEquippedItem(player, 'weapon');
    const resolvedWeapon = weapon?.id
      ? itemGenerator.resolveItem('weapon', weapon.id, weapon.level || 1, weapon.rarity || 1)
      : null;
    healAmount += (resolvedWeapon?.spellPower || 0);
  }

  const attributeMultiplier = calculateAttributeScaling(player, ability.attributeDamageScale);

  return Math.floor(healAmount * skillMultiplier * attributeMultiplier);
}

// New function to award XP for healing actions
function awardHealXp(skillsState, targetWasEnemy = false) {
  // Award healing skill XP when healing others (especially allies)
  const healingXp = targetWasEnemy ? 2 : 5; // More XP for healing allies vs enemies
  return awardSkillXp(skillsState, 'skill_healing', healingXp);
}

// New function to calculate damage scaling for multi-target attacks
function calculateDamageScalingForMultipleTargets(baseDamage, numTargets, abilityType = 'damage', player) {
  if (numTargets <= 1) return baseDamage;
  const weapon = getEquippedItem(player, 'weapon');
  const fullWeapon = weapon?.id ? weapons.find(w => w.id === weapon.id) : null;
  const damageModifiers = fullWeapon?.damageModifiers || {};
  const entries = Object.entries(damageModifiers);
  if (entries.length === 0) return baseDamage;
  
  let sum = 0;
  const { getEffectiveAttribute } = getCharactersModule();
  for (const [stat, weight] of entries) {
    if (typeof weight !== 'number') continue;
    // Use effective attribute (base stat + equipment bonuses from every slot)
    sum += getEffectiveAttribute(player, stat) * weight;
  }
  
  const attributeMultiplier = 1 + sum * 0.03;
  const scaled = baseDamage * attributeMultiplier;
  
  switch(abilityType) {
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
function getAbilityTargets(caster, ability, liveTargets) {
  if (!caster || !ability || !liveTargets || liveTargets.length === 0) {
    return [];
  }

  // Determine if this is a healing ability targeting allies or a damage ability targeting enemies
  const isHealAbility = ability.isHeal === true;

  // Filter targets based on whether this is healing (allies) or damaging (enemies)
  let filteredTargets;
  if (isHealAbility) {
    // For healing abilities, target living party members (including possibly self)
    filteredTargets = liveTargets.filter(t => !t.isEnemy && t.hp > 0);
  } else {
    // For damage abilities, target living enemies
    filteredTargets = liveTargets.filter(t => t.isEnemy && t.hp > 0);
  }

  // Sort targets by priority
  if (isHealAbility) {
    // For healing, prioritize targets with lower HP percentage
    filteredTargets.sort((a, b) => (a.hp / a.maxHp) - (b.hp / b.maxHp));
  } else {
    // For damage, sort randomly or by distance (for now, random)
    filteredTargets.sort(() => Math.random() - 0.5);
  }

  // Limit to maxTargets specified in ability
  const maxTargets = ability.maxTargets || 1;
  return filteredTargets.slice(0, maxTargets);
}

// New function to apply damage over time (DoT) effects
function applyDot(caster, target, ability, party, combatStats) {
  if (!ability.dotDamagePerTick && !ability.dotDuration) return false;

  if (!target.dots) target.dots = [];

  // Check if target already has 9 DoTs
  if (target.dots.length >= 9) {
    // Remove the oldest DoT if at max capacity
    target.dots.shift();
  }

  // Calculate DoT damage based on skill level
  const skillLevel = getSkillLevel(caster.skillsState, ability.skillId) || 1;
  const skillMultiplier = 1 + (skillLevel - 1) * 0.05; // 5% more per skill level
  const attributeMultiplier = calculateAttributeScaling(caster, ability.attributeDamageScale);
  const damagePerTick = Math.floor((ability.dotDamagePerTick || 0) * skillMultiplier * attributeMultiplier);
  const duration = ability.dotDuration || 3;

  // Add new DoT
  const dot = {
    damagePerTick: damagePerTick,
    duration: duration,
    sourceId: caster.id,
    sourceName: caster.name,
    tickCount: 0,
    abilityId: ability.id,
    abilityName: ability.name
  };

  target.dots.push(dot);

  // Track DoT application in combat stats
  if (combatStats && !caster.isEnemy) {
    const stats = combatStats.get(caster.id);
    if (stats) {
      if (!stats.dotsApplied) stats.dotsApplied = 0;
      stats.dotsApplied++;
    }
  }

  return true;
}

// New function to apply heal over time (HoT) effects
function applyHot(caster, target, ability, party, combatStats) {
  if (!ability.hotHealPerTick && !ability.hotDuration) return false;

  if (!target.hots) target.hots = [];

  // Check if target already has 9 HoTs
  if (target.hots.length >= 9) {
    // Remove the oldest HoT if at max capacity
    target.hots.shift();
  }

  // Calculate HoT healing based on skill level
  const skillLevel = getSkillLevel(caster.skillsState, ability.skillId) || 1;
  const skillMultiplier = 1 + (skillLevel - 1) * 0.05; // 5% more per skill level
  const attributeMultiplier = calculateAttributeScaling(caster, ability.attributeDamageScale);
  const healPerTick = Math.floor((ability.hotHealPerTick || 0) * skillMultiplier * attributeMultiplier);
  const duration = ability.hotDuration || 3;

  // Add new HoT
  const hot = {
    healPerTick: healPerTick,
    duration: duration,
    sourceId: caster.id,
    sourceName: caster.name,
    tickCount: 0,
    abilityId: ability.id,
    abilityName: ability.name
  };

  target.hots.push(hot);

  // Track HoT application in combat stats
  if (combatStats && !caster.isEnemy) {
    const stats = combatStats.get(caster.id);
    if (stats) {
      if (!stats.hotsApplied) stats.hotsApplied = 0;
      stats.hotsApplied++;
    }
  }

  return true;
}

// New function to apply action bar slowing effects
function applyActionSlowing(caster, target, ability) {
  if (!ability.actionBarSlowAmount && !ability.actionBarSlowDuration) return false;

  // Reduce the target's action bar by the specified amount
  const slowAmount = ability.actionBarSlowAmount || 0;
  target.actionBar = Math.max(0, target.actionBar - slowAmount);

  // Optionally track slow duration if needed for UI
  if (ability.actionBarSlowDuration && !target.actionSlowEffects) {
    target.actionSlowEffects = [];
  }

  if (ability.actionBarSlowDuration && target.actionSlowEffects) {
    const slowEffect = {
      duration: ability.actionBarSlowDuration,
      amount: slowAmount,
      sourceId: caster.id,
      sourceName: caster.name,
      abilityId: ability.id
    };

    // Add to existing slow effects or create new array
    target.actionSlowEffects.push(slowEffect);
  }

  return true;
}

// New function to apply a "weaken" debuff (reduces the target's outgoing damage).
function applyWeaken(caster, target, ability) {
  if (!ability.weakenAmount && !ability.weakenDuration) return false;
  if (!target.weakenEffects) target.weakenEffects = [];
  if (target.weakenEffects.length >= 9) target.weakenEffects.shift();

  const weakenEffect = {
    amount: ability.weakenAmount || 0,
    duration: ability.weakenDuration || 3,
    sourceId: caster.id,
    sourceName: caster.name,
    abilityId: ability.id,
    abilityName: ability.name
  };
  target.weakenEffects.push(weakenEffect);
  return true;
}

// New function to apply a "vulnerability" debuff (target takes increased incoming damage).
function applyVulnerability(caster, target, ability) {
  if (!ability.vulnerabilityAmount && !ability.vulnerabilityDuration) return false;
  if (!target.vulnerabilityEffects) target.vulnerabilityEffects = [];
  if (target.vulnerabilityEffects.length >= 9) target.vulnerabilityEffects.shift();

  const vulnerabilityEffect = {
    amount: ability.vulnerabilityAmount || 0,
    duration: ability.vulnerabilityDuration || 3,
    sourceId: caster.id,
    sourceName: caster.name,
    abilityId: ability.id,
    abilityName: ability.name
  };
  target.vulnerabilityEffects.push(vulnerabilityEffect);
  return true;
}

// New function to apply a "defense down" debuff (reduces the target's damage mitigation).
function applyDefenseDown(caster, target, ability) {
  if (!ability.defenseDownAmount && !ability.defenseDownDuration) return false;
  if (!target.defenseDownEffects) target.defenseDownEffects = [];
  if (target.defenseDownEffects.length >= 9) target.defenseDownEffects.shift();

  const defenseDownEffect = {
    amount: ability.defenseDownAmount || 0,
    duration: ability.defenseDownDuration || 3,
    sourceId: caster.id,
    sourceName: caster.name,
    abilityId: ability.id,
    abilityName: ability.name
  };
  target.defenseDownEffects.push(defenseDownEffect);
  return true;
}

// New function to apply a "defense up" self-buff (increases the caster's own damage mitigation).
function applyDefenseUp(caster, ability) {
  if (!ability.defenseUpAmount && !ability.defenseUpDuration) return false;
  if (!caster.defenseUpEffects) caster.defenseUpEffects = [];
  if (caster.defenseUpEffects.length >= 9) caster.defenseUpEffects.shift();

  const defenseUpEffect = {
    amount: ability.defenseUpAmount || 0,
    duration: ability.defenseUpDuration || 3,
    sourceId: caster.id,
    sourceName: caster.name,
    abilityId: ability.id,
    abilityName: ability.name
  };
  caster.defenseUpEffects.push(defenseUpEffect);
  return true;
}

// New function to process DoT ticks (this would typically be called in the main game loop)
function processDotTicks(party) {
  const livePlayers = Array.from(party.players.values()).filter(p => p.hp > 0);
  const liveEnemies = party.enemies.filter(e => e.hp > 0);

  [...livePlayers, ...liveEnemies].forEach(target => {
    if (!target.dots) target.dots = [];
    if (target.dots.length === 0) return;

    // Process each DoT
    for (let i = target.dots.length - 1; i >= 0; i--) {
      const dot = target.dots[i];
      dot.tickCount++;
      dot.duration--;

      // Apply damage (bypasses AP as specified)
      const damage = Math.max(1, Math.floor(dot.damagePerTick * (1 + dot.tickCount * 0.05)));
      // Prevent DoT from killing characters - leave at least 1 HP
      target.hp = Math.max(1, target.hp - damage);

      // Find the source for credit attribution
      let source = null;
      if (!target.isEnemy) {
        source = party.players.get(dot.sourceId);
      } else {
        // Find source among players
        source = livePlayers.find(p => p.id === dot.sourceId);
      }

      // Track damage in combat stats
      if (source && party.combatStats) {
        const stats = party.combatStats.get(source.id);
        if (stats) {
          if (!stats.totalDotDamage) stats.totalDotDamage = 0;
          stats.totalDotDamage += damage;
        }
      }

      // Remove DoT if duration is up
      if (dot.duration <= 0) {
        target.dots.splice(i, 1);
      }
    }
  });
}

// New function to process HoT ticks (this would typically be called in the main game loop)
function processHotTicks(party) {
  const livePlayers = Array.from(party.players.values()).filter(p => p.hp > 0);
  const liveEnemies = party.enemies.filter(e => e.hp > 0);

  [...livePlayers, ...liveEnemies].forEach(target => {
    if (!target.hots) target.hots = [];
    if (target.hots.length === 0) return;

    // Process each HoT
    for (let i = target.hots.length - 1; i >= 0; i--) {
      const hot = target.hots[i];
      hot.tickCount++;
      hot.duration--;

      // Apply healing
      const healAmount = Math.max(1, Math.floor(hot.healPerTick * (1 + hot.tickCount * 0.05)));
      // Don't over-heal - respect max HP
      target.hp = Math.min(target.maxHp, target.hp + healAmount);

      // Find the source for credit attribution
      let source = null;
      if (!target.isEnemy) {
        source = party.players.get(hot.sourceId);
      } else {
        // Find source among players
        source = livePlayers.find(p => p.id === hot.sourceId);
      }

      // Track healing in combat stats
      if (source && party.combatStats) {
        const stats = party.combatStats.get(source.id);
        if (stats) {
          if (!stats.totalHotHealing) stats.totalHotHealing = 0;
          stats.totalHotHealing += healAmount;
        }
      }

      // Remove HoT if duration is up
      if (hot.duration <= 0) {
        target.hots.splice(i, 1);
      }
    }
  });
}

// New function to process action bar slow effects
function processActionSlowEffects(party) {
  const livePlayers = Array.from(party.players.values()).filter(p => p.hp > 0);
  const liveEnemies = party.enemies.filter(e => e.hp > 0);

  [...livePlayers, ...liveEnemies].forEach(target => {
    if (!target.actionSlowEffects) target.actionSlowEffects = [];
    if (target.actionSlowEffects.length === 0) return;

    // Process each slow effect
    for (let i = target.actionSlowEffects.length - 1; i >= 0; i--) {
      const slowEffect = target.actionSlowEffects[i];
      slowEffect.duration--;

      // Remove slow effect if duration is up
      if (slowEffect.duration <= 0) {
        target.actionSlowEffects.splice(i, 1);
      }
    }
  });
}

// New function to process weaken debuff effects (decrement durations, expire at 0)
function processWeakenEffects(party) {
  const livePlayers = Array.from(party.players.values()).filter(p => p.hp > 0);
  const liveEnemies = party.enemies.filter(e => e.hp > 0);

  [...livePlayers, ...liveEnemies].forEach(target => {
    if (!target.weakenEffects) target.weakenEffects = [];
    if (target.weakenEffects.length === 0) return;

    for (let i = target.weakenEffects.length - 1; i >= 0; i--) {
      const effect = target.weakenEffects[i];
      effect.duration--;
      if (effect.duration <= 0) {
        target.weakenEffects.splice(i, 1);
      }
    }
  });
}

// New function to process vulnerability debuff effects
function processVulnerabilityEffects(party) {
  const livePlayers = Array.from(party.players.values()).filter(p => p.hp > 0);
  const liveEnemies = party.enemies.filter(e => e.hp > 0);

  [...livePlayers, ...liveEnemies].forEach(target => {
    if (!target.vulnerabilityEffects) target.vulnerabilityEffects = [];
    if (target.vulnerabilityEffects.length === 0) return;

    for (let i = target.vulnerabilityEffects.length - 1; i >= 0; i--) {
      const effect = target.vulnerabilityEffects[i];
      effect.duration--;
      if (effect.duration <= 0) {
        target.vulnerabilityEffects.splice(i, 1);
      }
    }
  });
}

// New function to process defense-down debuff effects
function processDefenseDownEffects(party) {
  const livePlayers = Array.from(party.players.values()).filter(p => p.hp > 0);
  const liveEnemies = party.enemies.filter(e => e.hp > 0);

  [...livePlayers, ...liveEnemies].forEach(target => {
    if (!target.defenseDownEffects) target.defenseDownEffects = [];
    if (target.defenseDownEffects.length === 0) return;

    for (let i = target.defenseDownEffects.length - 1; i >= 0; i--) {
      const effect = target.defenseDownEffects[i];
      effect.duration--;
      if (effect.duration <= 0) {
        target.defenseDownEffects.splice(i, 1);
      }
    }
  });
}

// New function to process defense-up self-buff effects
function processDefenseUpEffects(party) {
  const livePlayers = Array.from(party.players.values()).filter(p => p.hp > 0);
  const liveEnemies = party.enemies.filter(e => e.hp > 0);

  [...livePlayers, ...liveEnemies].forEach(target => {
    if (!target.defenseUpEffects) target.defenseUpEffects = [];
    if (target.defenseUpEffects.length === 0) return;

    for (let i = target.defenseUpEffects.length - 1; i >= 0; i--) {
      const effect = target.defenseUpEffects[i];
      effect.duration--;
      if (effect.duration <= 0) {
        target.defenseUpEffects.splice(i, 1);
      }
    }
  });
}

// Sum helper: total magnitude of an active debuff effect array (capped to avoid degeneracy)
function sumDebuffAmount(effectsArray, cap) {
  if (!Array.isArray(effectsArray) || effectsArray.length === 0) return 0;
  const sum = effectsArray.reduce((acc, e) => acc + (e.amount || 0), 0);
  return cap != null ? Math.min(sum, cap) : sum;
}

module.exports = {
  // Skill system initialization and definitions
  skillDefinitions,
  getDefaultSkillsState,
  getSkillDefinition,

  // Skill-related utilities
  getSkillLevel,
  getSkillXp,
  getWeaponSkillId,
  awardSkillXp,
  awardArmorProficiencyXp,

  // Equipment-related functions
  getEquippedItem,
  getEquippedWeaponClass,

  // Ability-related functions
  getAbilityUnlockState,
  selectAbilityToCast,
  applyAbilityCast,

  // Healing and multi-target combat functions
  calculateAttributeScaling,
  calculateHealAmount,
  awardHealXp,
  calculateDamageScalingForMultipleTargets,
  getAbilityTargets,

  // Status effect application functions
  applyDot,
  applyHot,
  applyActionSlowing,
  applyWeaken,
  applyVulnerability,
  applyDefenseDown,
  applyDefenseUp,

  // Periodic effect processing functions
  processDotTicks,
  processHotTicks,
  processActionSlowEffects,
  processWeakenEffects,
  processVulnerabilityEffects,
  processDefenseDownEffects,
  processDefenseUpEffects,
  sumDebuffAmount,

  // Skill curve helpers
  calcSkillLv,
  calcXpForLevel,
  calcXpForNextLevel
};
