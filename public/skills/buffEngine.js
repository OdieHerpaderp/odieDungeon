const fs = require('fs');
const path = require('path');
const weaponMelee = require(path.join(__dirname, '..', 'gear', 'weaponMelee.json'));
const weaponRanged = require(path.join(__dirname, '..', 'gear', 'weaponRanged.json'));
const weaponMagic = require(path.join(__dirname, '..', 'gear', 'weaponMagic.json'));
const weapons = [...weaponMelee, ...weaponRanged, ...weaponMagic];
const itemGenerator = require(path.join(__dirname, '..', 'gear', 'itemGenerator'));
const { calcSkillLv, calcXpForLevel, calcXpForNextLevel } = require(path.join(__dirname, '..', '..', 'utils.js'));

let _charactersModule = null;
function getCharactersModule() {
  if (!_charactersModule) _charactersModule = require(path.join(__dirname, '..', '..', 'characters.js'));
  return _charactersModule;
}

function getSkillLevel(skillsState, skillId) {
  const xp = skillsState?.[skillId]?.xp || 0;
  return Math.floor(calcSkillLv(xp));
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

const MAX_EFFECT_STACKS = 9;

const EFFECT_HANDLERS = {
  dot: {
    maxStack: 9,
    apply(caster, target, ability) {
      const skillLevel = getSkillLevel(caster.skillsState, ability.skillId);
      const skillMultiplier = 1 + (skillLevel - 1) * 0.05;
      const attributeMultiplier = calculateAttributeScaling(caster, ability.attributeDamageScale);
      const damagePerTick = Math.floor((ability.damagePerTick || ability.dotDamagePerTick || 0) * skillMultiplier * attributeMultiplier);
      const duration = ability.duration || ability.dotDuration || 3;
      return {
        type: 'dot',
        amount: damagePerTick,
        duration: duration,
        sourceId: caster.id,
        sourceName: caster.name,
        abilityId: ability.id,
        abilityName: ability.name,
        tickCount: 0,
        damagePerTick: damagePerTick
      };
    },
    tick(effect, target, party) {
      const damage = Math.max(1, Math.floor(effect.amount * (1 + effect.tickCount * 0.05)));
      target.hp = Math.max(1, target.hp - damage);
      let source = null;
      if (!target.isEnemy) {
        source = party.players.get(effect.sourceId);
      } else {
        source = party.players.values().find(p => p.id === effect.sourceId);
      }
      if (source && party.combatStats) {
        const stats = party.combatStats.get(source.id);
        if (stats) {
          if (!stats.totalDotDamage) stats.totalDotDamage = 0;
          stats.totalDotDamage += damage;
        }
      }
    }
  },

  hot: {
    maxStack: 9,
    apply(caster, target, ability) {
      const skillLevel = getSkillLevel(caster.skillsState, ability.skillId);
      const skillMultiplier = 1 + (skillLevel - 1) * 0.05;
      const attributeMultiplier = calculateAttributeScaling(caster, ability.attributeDamageScale);
      const healPerTick = Math.floor((ability.healPerTick || ability.hotHealPerTick || 0) * skillMultiplier * attributeMultiplier);
      const duration = ability.duration || ability.hotDuration || 3;
      if (caster.combatStats) {
        const stats = caster.combatStats.get(caster.id);
        if (stats) {
          if (!stats.hotsApplied) stats.hotsApplied = 0;
          stats.hotsApplied++;
        }
      }
      return {
        type: 'hot',
        amount: healPerTick,
        duration: duration,
        sourceId: caster.id,
        sourceName: caster.name,
        abilityId: ability.id,
        abilityName: ability.name,
        tickCount: 0,
        healPerTick: healPerTick
      };
    },
    tick(effect, target, party) {
      const healAmount = Math.max(1, Math.floor(effect.amount * (1 + effect.tickCount * 0.05)));
      target.hp = Math.min(target.maxHp, target.hp + healAmount);
      let source = null;
      if (!target.isEnemy) {
        source = party.players.get(effect.sourceId);
      } else {
        source = party.players.values().find(p => p.id === effect.sourceId);
      }
      if (source && party.combatStats) {
        const stats = party.combatStats.get(source.id);
        if (stats) {
          if (!stats.totalHotHealing) stats.totalHotHealing = 0;
          stats.totalHotHealing += healAmount;
        }
      }
    }
  },

  weaken: {
    maxStack: 9,
    apply(caster, target, ability) {
      return {
        type: 'weaken',
        amount: ability.amount || ability.weakenAmount || 0,
        duration: ability.duration || ability.weakenDuration || 3,
        sourceId: caster.id,
        sourceName: caster.name,
        abilityId: ability.id,
        abilityName: ability.name,
        tickCount: 0
      };
    },
    tick() {}
  },

  vulnerability: {
    maxStack: 9,
    apply(caster, target, ability) {
      return {
        type: 'vulnerability',
        amount: ability.amount || ability.vulnerabilityAmount || 0,
        duration: ability.duration || ability.vulnerabilityDuration || 3,
        sourceId: caster.id,
        sourceName: caster.name,
        abilityId: ability.id,
        abilityName: ability.name,
        tickCount: 0
      };
    },
    tick() {}
  },

  defenseDown: {
    maxStack: 9,
    apply(caster, target, ability) {
      return {
        type: 'defenseDown',
        amount: ability.amount || ability.defenseDownAmount || 0,
        duration: ability.duration || ability.defenseDownDuration || 3,
        sourceId: caster.id,
        sourceName: caster.name,
        abilityId: ability.id,
        abilityName: ability.name,
        tickCount: 0
      };
    },
    tick() {}
  },

  defenseUp: {
    maxStack: 9,
    apply(caster, target, ability) {
      return {
        type: 'defenseUp',
        amount: ability.amount || ability.defenseUpAmount || 0,
        duration: ability.duration || ability.defenseUpDuration || 3,
        sourceId: caster.id,
        sourceName: caster.name,
        abilityId: ability.id,
        abilityName: ability.name,
        tickCount: 0
      };
    },
    tick() {}
  },

  actionSlow: {
    maxStack: 9,
    apply(caster, target, ability) {
      const slowAmount = ability.amount || ability.actionBarSlowAmount || 0;
      target.actionBar = Math.max(0, target.actionBar - slowAmount);
      return {
        type: 'actionSlow',
        amount: slowAmount,
        duration: ability.duration || ability.actionBarSlowDuration || 0,
        sourceId: caster.id,
        sourceName: caster.name,
        abilityId: ability.id,
        abilityName: ability.name,
        tickCount: 0
      };
    },
    tick() {}
  }
};

function applyEffect(caster, target, ability) {
  if (!ability || !target) return false;
  if (!target.effects) target.effects = [];

  let effectEntries = [];

  if (Array.isArray(ability.effects)) {
    for (const entry of ability.effects) {
      const handler = EFFECT_HANDLERS[entry.type];
      if (!handler) continue;
      const mergedAbility = { ...ability, ...entry };
      const effect = handler.apply(caster, target, mergedAbility);
      if (effect) {
        target.effects.push(effect);
      }
    }
    return true;
  }

  for (const [type, handler] of Object.entries(EFFECT_HANDLERS)) {
    const oldFieldMap = {
      dot: ['dotDamagePerTick', 'dotDuration'],
      hot: ['hotHealPerTick', 'hotDuration'],
      weaken: ['weakenAmount', 'weakenDuration'],
      vulnerability: ['vulnerabilityAmount', 'vulnerabilityDuration'],
      defenseDown: ['defenseDownAmount', 'defenseDownDuration'],
      defenseUp: ['defenseUpAmount', 'defenseUpDuration'],
      actionSlow: ['actionBarSlowAmount', 'actionBarSlowDuration']
    };
    const fields = oldFieldMap[type];
    if (fields && ability[fields[0]] && ability[fields[1]]) {
      const effect = handler.apply(caster, target, ability);
      if (effect) {
        target.effects.push(effect);
      }
    }
  }

  return true;
}

function processEffects(party) {
  const livePlayers = Array.from(party.players.values()).filter(p => p.hp > 0);
  const liveEnemies = (party.enemies || []).filter(e => e.hp > 0);
  const allCombatants = [...livePlayers, ...liveEnemies];

  for (const target of allCombatants) {
    if (!target.effects || target.effects.length === 0) continue;

    for (let i = target.effects.length - 1; i >= 0; i--) {
      const effect = target.effects[i];
      const handler = EFFECT_HANDLERS[effect.type];
      if (!handler) {
        target.effects.splice(i, 1);
        continue;
      }

      effect.tickCount++;
      effect.duration--;

      if (effect.type === 'dot' || effect.type === 'hot') {
        handler.tick(effect, target, party);
      }

      if (effect.duration <= 0) {
        target.effects.splice(i, 1);
      }
    }
  }
}

function sumEffectAmount(effects, type, cap) {
  if (!Array.isArray(effects) || effects.length === 0) return 0;
  const sum = effects
    .filter(e => e.type === type)
    .reduce((acc, e) => acc + (e.amount || 0), 0);
  return cap != null ? Math.min(sum, cap) : sum;
}

function clearEffects(entity) {
  if (entity) entity.effects = [];
}

module.exports = {
  applyEffect,
  processEffects,
  sumEffectAmount,
  clearEffects,
  EFFECT_HANDLERS,
  MAX_EFFECT_STACKS
};