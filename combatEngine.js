import * as characters from './characters.js';
import * as skillEngine from './public/skills/skillEngine.js';
import * as buffEngine from './public/skills/buffEngine.js';
import * as itemGenerator from './public/gear/itemGenerator.js';
import * as utils from './utils.js';

const ENEMY_DAMAGE_MULTIPLIER = 0.7;

export function createCombatEngine({
  broadcastCriticalUpdate,
  broadcastToParty,
  broadcastFullState,
  saveCharacter,
  getSocket,
  parties,
  actionIntervals,
  spellCastIntervals,
  spawnTimers,
  startSpawnTimer,
  embarkParty,
  resetPartyDeltaBaseline,
  _seedEnemyFullSent,
  io,
  getAbilities,
}) {
  function livePlayers(party) {
    return Array.from(party.players.values()).filter((p) => p.hp > 0);
  }
  function liveEnemies(party) {
    return (party.enemies || []).filter((e) => e.hp > 0);
  }
  function selectTarget(actor, livePlayersList, liveEnemiesList) {
    if (actor.isEnemy) {
      const targetChoice = Math.round(Math.random() * 17);
      if (targetChoice < 15) {
        const maxPlayerHp = Math.max(...livePlayersList.map((p) => p.maxHp), 1);
        return livePlayersList.sort((b, a) => {
          const scoreA = 0.5 * a.hp + 0.5 * (a.hp / a.maxHp) * maxPlayerHp;
          const scoreB = 0.5 * b.hp + 0.5 * (b.hp / b.maxHp) * maxPlayerHp;
          return scoreA - scoreB;
        })[0];
      }
      return livePlayersList.sort((a, b) => Math.random() * a.hp - Math.random() * b.hp)[0];
    }
    return liveEnemiesList.sort((a, b) => a.hp - b.hp)[0];
  }
  function calculateAccuracyMod(actor) {
    const activeWeapon = characters.getActiveWeapon(actor);
    const weaponClass = characters.getActiveWeaponClass(actor);

    let accuracyMod = 2;
    const classWeights = {
      melee: { primary: 'dex', secondary: 'agi', pWeight: 0.8, sWeight: 0.2 },
      ranged: { primary: 'dex', secondary: 'cnc', pWeight: 0.8, sWeight: 0.2 },
      magic: { primary: 'cnc', secondary: 'dex', pWeight: 0.8, sWeight: 0.2 },
    };
    const weights = classWeights[weaponClass] || classWeights.melee;
    const primary = characters.getEffectiveAttribute(actor, weights.primary);
    const secondary = characters.getEffectiveAttribute(actor, weights.secondary);
    accuracyMod += primary * weights.pWeight + secondary * weights.sWeight;

    return accuracyMod;
  }

  function calcWeaponBasicDamage(actor) {
    const weaponRef = characters.getActiveWeapon(actor);
    const resolvedWeapon = weaponRef?.id
      ? itemGenerator.resolveItem('weapon', weaponRef.id, weaponRef.level || 1, weaponRef.rarity || 1)
      : null;
    const scaledWeaponDamage = resolvedWeapon?.damage ?? 0;
    const attrBonus = characters.getAttributeDamageModifier(actor, resolvedWeapon);
    const weaponProfLevel = skillEngine.getSkillLevel(actor.skillsState, skillEngine.getWeaponSkillId(weaponRef));
    const twoHandedLevel = weaponRef?.twoHanded
      ? skillEngine.getSkillLevel(actor.skillsState, 'skill_twoHanded')
      : 0;
    const result = (scaledWeaponDamage + attrBonus) * (80 + weaponProfLevel + twoHandedLevel) / 50;
    if (actor.isEnemy) return result * ENEMY_DAMAGE_MULTIPLIER;
    return result;
  }

  function calculateRoll(actor, target, accuracyMod) {
    const luk = characters.getEffectiveAttribute(actor, 'luk');
    let roll = Math.floor(
      Math.random() * (80 + accuracyMod / 2 + luk * 2) + 1 + accuracyMod / 6 + luk * Math.random() * 0.3,
    );
    roll = roll * (0.2 + Math.random() * 3);
    roll -= Math.floor(target.agi / 9 + target.agi * Math.random() * 1.4);
    roll = roll > 70 ? Math.round(Math.pow(roll, 0.9)) : Math.round(roll);
    return roll || 0;
  }

  function updateCombatStats(actor, party, hit, crit, damage, roll) {
    if (actor.isEnemy) return;

    if (!party.combatStats.has(actor.id)) {
      party.combatStats.set(actor.id, utils.createEmptyCombatStats());
    }

    const stats = party.combatStats.get(actor.id);
    stats.attacks++;
    if (hit) {
      stats.hits++;
      stats.totalDamage += damage;
      stats.rollSum += roll;
      stats.maxDamage = Math.max(stats.maxDamage, damage);
      if (crit) stats.crits++;
    }
  }

  function updateIncomingCombatStats(target, party, rawDamage, mitigated) {
    if (target.isEnemy) return;
    if (!party.combatStats.has(target.id)) {
      party.combatStats.set(target.id, utils.createEmptyCombatStats());
    }
    const stats = party.combatStats.get(target.id);
    stats.totalDamageTaken += rawDamage;
    stats.totalMitigated += mitigated;
    stats.maxDamageTaken = Math.max(stats.maxDamageTaken, rawDamage);
  }

  function handlePlayerDeath(partyId, party, player) {
    player.equipment = {};
    player.inventory = utils.safeArray(player.inventory);

    characters.calcMiscStats(player);
    utils.recalcDerivedMaxAndClampCurrents(player);

    player.hp = Math.max(1, Math.floor(player.maxHp * 0.1));
    player.actionBar = 0;

    void saveCharacter(player.name, player);

    party.players.delete(player.id);

    getSocket(player.id)?.disconnect();
  }

  function applyDamage(target, damage, partyId, party) {
    const vulnerability = buffEngine.sumEffectAmount(target.effects, 'vulnerability', 2.0);
    if (vulnerability > 0) {
      damage = damage * (1 + vulnerability);
    }

    const apDamage = Math.min(damage * 0.5, target.ap);
    target.ap -= apDamage;
    const remainingDamage = damage - apDamage;

    if (remainingDamage > 0) {
      target.hp -= remainingDamage;
    }

    if (target.hp <= 0 && !target.isEnemy) {
      handlePlayerDeath(partyId, party, target);
      const deathMsg = `${target.name} has fallen and lost their gear! 💥`;
      const deathPacket = {
        type: 'death',
        playerId: target.id,
        playerName: target.name,
        message: deathMsg,
      };
      broadcastToParty(partyId, 'combatEvent', deathPacket);
      broadcastToParty(partyId, 'eventLog', { message: deathMsg, type: 'death' });
    }
  }

  function resolveAttackHit(actor, target, accuracyMod, party, partyId) {
    let roll = calculateRoll(actor, target, accuracyMod);
    const hit = roll > 0;
    const crit = roll > 99;

    if (!hit) {
      broadcastCriticalUpdate(partyId, party, {
        actor: { ...actor },
        target: { ...target, isEnemy: target.isEnemy || false },
        hit: false,
        crit: false,
        damage: 0,
        roll,
      });
      return { hit, crit, damage: 0, roll };
    }

    roll += Math.round(0.5 * actor.luk + Math.random() * actor.luk * 1.2);
    let damage = calcWeaponBasicDamage(actor);

    const weaken = buffEngine.sumEffectAmount(actor.effects, 'weaken', 0.9);
    if (weaken > 0) damage = damage * (1 - weaken);
    const rawDamage = damage;

    const offHandDef = target.equipment?.offHand?.defense || target.offHand || 0;
    const defenseDown = buffEngine.sumEffectAmount(target.effects, 'defenseDown', 0.9);
    const mitigationTerm =
      (0.65 * (1.8 + Math.random()) * (target.equipment?.helmet?.defense || target.helmet || 1) +
        0.65 * (1.8 + Math.random()) * (target.equipment?.chest?.defense || target.chest || 1) +
        0.65 * (1.8 + Math.random()) * (target.equipment?.shoes?.defense || target.shoes || 1) +
        0.65 * (1.8 + Math.random()) * offHandDef +
        0.06 * (1.8 + Math.random()) * target.vit) / 5;
    const defenseUp = buffEngine.sumEffectAmount(target.effects, 'defenseUp', 0.5);
    const effectiveMitigation = (defenseDown > 0 ? mitigationTerm * (1 - defenseDown) : mitigationTerm) + defenseUp;
    const cappedMitigation = Math.min(effectiveMitigation, rawDamage * 0.95);
    damage = Math.max(0, Math.round(damage - cappedMitigation / 3) / 0.999 + mitigationTerm / 120);
    const mitigated = Math.max(0, rawDamage - damage + 0.1);

    updateCombatStats(actor, party, true, crit, damage, roll);
    applyDamage(target, damage, partyId, party);
    if (!target.isEnemy) {
      updateIncomingCombatStats(target, party, rawDamage, mitigated);
    }

    const weaponSkillId = skillEngine.getWeaponSkillId(characters.getActiveWeapon(actor));
    if (!actor.isEnemy && actor.skillsState) {
      const xpAmount = Math.max(1, damage / 32);
      if (actor.equipment.weapon?.twoHanded) {
        actor.skillsState = skillEngine.awardSkillXp(
          actor.skillsState,
          weaponSkillId,
          xpAmount / 1.5,
        );
        actor.skillsState = skillEngine.awardSkillXp(
          actor.skillsState,
          'skill_twoHanded',
          xpAmount / 1.5,
        );
      } else {
        actor.skillsState = skillEngine.awardSkillXp(
          actor.skillsState,
          weaponSkillId,
          xpAmount,
        );
      }
    }

    if (!target.isEnemy && target.skillsState && mitigated > 0) {
      target.skillsState = skillEngine.awardArmorProficiencyXp(target.skillsState, mitigated / 3, target);
    }

    broadcastCriticalUpdate(partyId, party, {
      actor: { ...actor },
      target: { ...target, isEnemy: target.isEnemy || false },
      hit,
      crit,
      damage,
      roll,
    });

    return { hit, crit, damage, roll };
  }

  function performActionBarAttack(actor, partyId, party) {
    const target = selectTarget(actor, livePlayers(party), liveEnemies(party));
    if (!target) return;

    const accuracyMod = calculateAccuracyMod(actor);
    const result = resolveAttackHit(actor, target, accuracyMod, party, partyId);

    if (target.isEnemy && target.hp <= 0) awardXP(partyId, party);

    if (result.hit && actor.equipment.weapon?.twoHanded && Math.random() < 0.5) {
      const liveEnemiesList = liveEnemies(party).filter((e) => e.hp > 0 && e !== target);
      if (liveEnemiesList.length) {
        const extraTarget = liveEnemiesList[Math.floor(Math.random() * liveEnemiesList.length)];
        resolveAttackHit(actor, extraTarget, accuracyMod, party, partyId);
      }
    }
  }

  function castAbilityForPlayer(combatant, partyId, party, ability) {
    if (!ability) return;
    const nextState = skillEngine.applyAbilityCast(combatant, ability, Date.now());
    if (!nextState) return;
    Object.assign(combatant, nextState);

    const alivePlayers = livePlayers(party);

    if (ability.effects?.some((e) => e.type === 'defenseUp')) {
      buffEngine.applyEffect(combatant, combatant, ability);
      combatant.skillsState = skillEngine.awardSkillXp(combatant.skillsState, ability.skillId, 3);
      broadcastCriticalUpdate(partyId, party, {
        actor: { ...combatant },
        targets: [],
        ability: ability,
        defenseUp: true,
      });
      return;
    }

    if (ability.isHeal) {
      const healAmount = skillEngine.calculateHealAmount(ability, combatant);
      const healTargets = skillEngine.getAbilityTargets(combatant, ability, [...alivePlayers]);

      let totalHealed = 0;
      healTargets.forEach((target) => {
        const before = target.hp;
        target.hp = Math.min(target.maxHp, target.hp + healAmount);
        totalHealed += target.hp - before;

        if (ability.effects?.some((e) => e.type === 'HPup')) {
          buffEngine.applyEffect(combatant, target, ability);
        }
      });

      combatant.skillsState = skillEngine.awardHealXp(combatant.skillsState, totalHealed, ability.skillId);

      const casterStats = party.combatStats.get(combatant.id);
      if (casterStats) casterStats.totalHealed += totalHealed;
    } else {
      const damageTargets = skillEngine.getAbilityTargets(combatant, ability, liveEnemies(party));

      const skillLevel = skillEngine.getSkillLevel(combatant.skillsState, ability.skillId);
      let baseDamage;

      const weapon = characters.getActiveWeapon(combatant);
      const resolvedWeapon = weapon?.id
        ? itemGenerator.resolveItem('weapon', weapon.id, weapon.level || 1, weapon.rarity || 1)
        : null;
      const effSpellPower = resolvedWeapon?.spellPower || 0;
      if (ability.castUsesWeaponDamageModel) {
        const weaponBasic = calcWeaponBasicDamage(combatant);
        const attrBonus = skillEngine.calculateAttributeScaling(combatant, ability.attributeDamageScale);
        baseDamage = (ability.damageBase + attrBonus + weaponBasic + effSpellPower) * (80 + skillLevel + effSpellPower) / 50;
      } else {
        const attrBonus = skillEngine.calculateAttributeScaling(combatant, ability.attributeDamageScale);
        baseDamage = (ability.damageBase + attrBonus + effSpellPower) * (80 + skillLevel + effSpellPower) / 50;
      }
      if (combatant.isEnemy) baseDamage *= ENEMY_DAMAGE_MULTIPLIER;
      const scaledDamage = skillEngine.calculateDamageScalingForMultipleTargets(baseDamage, damageTargets.length);

      damageTargets.forEach((target) => {
        applyDamage(target, scaledDamage, partyId, party);

        if (!target.isEnemy) {
          updateIncomingCombatStats(target, party, scaledDamage, 0);
        }

        if (ability.effects?.some((e) => e.type === 'HPdown')) {
          buffEngine.applyEffect(combatant, target, ability);
        }

        if (ability.effects?.some((e) => e.type === 'actionSlow')) {
          buffEngine.applyEffect(combatant, target, ability);
        }

        if (ability.effects?.some((e) => e.type === 'weaken')) {
          buffEngine.applyEffect(combatant, target, ability);
        }
        if (ability.effects?.some((e) => e.type === 'vulnerability')) {
          buffEngine.applyEffect(combatant, target, ability);
        }
        if (ability.effects?.some((e) => e.type === 'defenseDown')) {
          buffEngine.applyEffect(combatant, target, ability);
        }

        if (!combatant.isEnemy) {
          const stats = party.combatStats.get(combatant.id);
          if (stats) {
            stats.hits++;
            stats.totalDamage += scaledDamage;
            stats.rollSum += 50;
            stats.maxDamage = Math.max(stats.maxDamage, scaledDamage);
          }
        }
      });

      const xpPerTarget = 3;
      combatant.skillsState = skillEngine.awardSkillXp(
        combatant.skillsState,
        ability.skillId,
        xpPerTarget * damageTargets.length,
      );

      if (damageTargets.some((t) => t.isEnemy && t.hp <= 0)) {
        awardXP(partyId, party);
      }

      broadcastCriticalUpdate(partyId, party, {
        actor: { ...combatant },
        targets: damageTargets.map((t) => ({ ...t, isEnemy: t.isEnemy || false })),
        ability: ability,
        damage: baseDamage,
        scaledDamage: scaledDamage,
        hit: true,
      });
    }
  }

  function awardXP(partyId, party) {
    const deadEnemies = party.enemies.filter((e) => e.hp <= 0);
    party.enemies = party.enemies.filter((e) => e.hp > 0);

    const livePlayers = Array.from(party.players.values()).filter((p) => p.hp > 0);
    const leveledUpPlayers = [];

    deadEnemies.forEach((enemy) => {
      if (livePlayers.length > 0) {
          const xpShare = enemy.xpValue / livePlayers.length;
          livePlayers.forEach((player) => {
            player.xp += xpShare;

            const goldShare = enemy.gold / (0.2 + livePlayers.length / 0.8);
          player.gold += goldShare;
          if (player.xpToNext <= 0) player.xpToNext = 128;
          while (player.xp >= player.xpToNext) {
            player.xp -= player.xpToNext;
            player.level++;
            player.xpToNext = Math.floor((player.xpToNext + 8) * 1.08);
            player.pointsToAllocate += Math.floor(3);
            player.str++; player.dex++; player.agi++; player.vit++; player.int++; player.cnc++;

            const newMaxHp = characters.calcMaxHp(player);
            const hpDiff = newMaxHp - player.maxHp;
            player.maxHp = newMaxHp;
            player.hp = Math.min(player.maxHp, player.hp + hpDiff);

            const newMaxMp = characters.calcMaxMp(player);
            const mpDiff = newMaxMp - player.maxMp;
            player.maxMp = newMaxMp;
            player.mp = Math.min(player.maxMp, player.mp + mpDiff);

            const newMaxAp = characters.calcMaxAp(player);
            const apDiff = newMaxAp - player.maxAp;
            player.maxAp = newMaxAp;
            player.ap = Math.min(player.maxAp, player.ap + apDiff);

            leveledUpPlayers.push({
              id: player.id,
              name: player.name,
              level: player.level,
              hp: player.hp,
              maxHp: player.maxHp,
              maxMp: player.maxMp,
              maxAp: player.maxAp,
            });

            const levelUpPacket = {
              message: `${player.name} advanced to level ${player.level}!`,
              type: 'success',
            };
            broadcastToParty(partyId, 'eventLog', levelUpPacket);
          }
          characters.calcMiscStats(player);
          void saveCharacter(player.name, player);
        });
      }
    });

    if (leveledUpPlayers.length > 0) {
      broadcastCriticalUpdate(partyId, party, {
        actor: null,
        target: null,
        leveledUp: leveledUpPlayers,
      });
    }

    broadcastFullState(partyId, party);
  }

  function generateCombatSummary(partyId, party, message) {
    let totalDamage = 0;
    let totalAttacks = 0;
    let totalHits = 0;
    let totalRollSum = 0;
    let totalHealed = 0;
    let totalCrits = 0;
    let totalMaxDamage = 0;
    let totalDamageTaken = 0;
    let totalMitigated = 0;
    const playerEntries = [];

    const durationSeconds = Math.max(1, (Date.now() - party.combatStartMs) / 1000);

    for (const [playerId, stats] of party.combatStats) {
      if (stats.attacks > 0) {
        const hitRate = ((stats.hits / stats.attacks) * 100).toFixed(1);
        const critRate = stats.hits > 0 ? ((stats.crits / stats.hits) * 100).toFixed(1) : '0';
        const avgDamage = stats.hits > 0 ? (stats.totalDamage / stats.hits).toFixed(1) : '0';
        const avgRoll = stats.hits > 0 ? (stats.rollSum / stats.hits).toFixed(1) : '0';
        const effectiveHealed = stats.totalHealed + (stats.totalHotHealing || 0);
        const dps = stats.hits > 0 ? (stats.totalDamage / durationSeconds) : 0;
        const hps = effectiveHealed / durationSeconds;
        const player = party.players.get(playerId);
        if (player) {
          playerEntries.push({
            name: player.name,
            totalDamage: stats.totalDamage,
            maxDamage: stats.maxDamage,
            totalHealed: effectiveHealed,
            hits: stats.hits,
            attacks: stats.attacks,
            crits: stats.crits,
            hitRate,
            critRate,
            avgDamage,
            avgRoll,
            durationSeconds,
            dps,
            hps,
            totalDamageTaken: stats.totalDamageTaken || 0,
            totalMitigated: stats.totalMitigated || 0,
            maxDamageTaken: stats.maxDamageTaken || 0,
          });
        }
        totalDamage += stats.totalDamage;
        totalMaxDamage += stats.maxDamage;
        totalAttacks += stats.attacks;
        totalHits += stats.hits;
        totalRollSum += stats.rollSum;
        totalHealed += effectiveHealed;
        totalCrits += stats.crits;
        totalDamageTaken += stats.totalDamageTaken || 0;
        totalMitigated += stats.totalMitigated || 0;
      }
    }

    playerEntries.sort((a, b) => (b.totalDamage + b.totalHealed) - (a.totalDamage + a.totalHealed));

    const overallHitRate = totalAttacks > 0 ? ((totalHits / totalAttacks) * 100).toFixed(1) : '0';
    const overallCritRate = totalHits > 0 ? ((totalCrits / totalHits) * 100).toFixed(1) : '0';
    const overallAvgDamage = totalHits > 0 ? (totalDamage / totalHits).toFixed(1) : '0';
    const overallAvgRoll = totalHits > 0 ? (totalRollSum / totalHits).toFixed(1) : '0';
    const overallDps = totalDamage / durationSeconds;
    const overallHps = totalHealed / durationSeconds;

    const summary = {
      players: playerEntries,
      totals: {
        totalDamage,
        totalMaxDamage,
        totalHealed,
        totalAttacks,
        totalHits,
        totalCrits,
        overallHitRate,
        overallCritRate,
        overallAvgDamage,
        overallAvgRoll,
        overallDurationSeconds: durationSeconds,
        overallDps,
        overallHps,
        totalDamageTaken,
        totalMitigated,
      },
    };

    broadcastToParty(partyId, 'combatEnd', {
      message,
      summary,
      combatActive: false,
    });
  }

  function restorePartyToFull(partyId) {
    const party = parties.get(partyId);
    if (!party) return;
    Array.from(party.players.values()).forEach((p) => {
      p.hp = p.maxHp;
      p.mp = p.maxMp;
      p.ap = p.maxAp;
      p.actionBar = 0;
      buffEngine.clearEffects(p);
      void saveCharacter(p.name, p);
    });
  }

  function startActionBarSystem(partyId, party) {
    if (actionIntervals.has(partyId)) {
      clearInterval(actionIntervals.get(partyId));
    }
    if (spellCastIntervals.has(partyId)) {
      clearInterval(spellCastIntervals.get(partyId));
    }
    party.combatStats = new Map();
    party.combatStartMs = Date.now();

    const spellInterval = setInterval(() => {
      if (!party.combatActive) {
        clearInterval(spellInterval);
        spellCastIntervals.delete(partyId);
        return;
      }
      const alive = livePlayers(party);
      alive.forEach((player) => {
        const ability = skillEngine.selectAbilityToCast(player, getAbilities(), Date.now(), alive);
        if (ability) castAbilityForPlayer(player, partyId, party, ability);
      });
    }, 200);
    spellCastIntervals.set(partyId, spellInterval);

    const interval = setInterval(() => {
      if (!party.combatActive) {
        clearInterval(interval);
        actionIntervals.delete(partyId);
        return;
      }
      const livePlayersList = livePlayers(party);
      const liveEnemiesList = liveEnemies(party);
      if (livePlayersList.length === 0) {
        party.combatActive = false;
        clearInterval(interval);
        actionIntervals.delete(partyId);

        party.floor = 0;
        party.enemies = [];
        const alivePlayers = Array.from(party.players.values()).filter((p) => p.hp > 0);
        party.players.clear();
        alivePlayers.forEach((p) => {
          party.players.set(p.id, p);
        });

        if (party.players.size === 0) {
          parties.delete(partyId);
          if (spawnTimers.has(partyId)) {
            clearTimeout(spawnTimers.get(partyId));
            spawnTimers.delete(partyId);
          }
          generateCombatSummary(partyId, party, 'All players have fallen! Party disbanded.');
        } else {
          startSpawnTimer(partyId, party);
          const deathLogPacket = {
            message: 'Some players died, but the party continues!',
            type: 'info',
          };
          broadcastToParty(partyId, 'eventLog', deathLogPacket);
        }
        return;
      }

      if (liveEnemiesList.length === 0) {
        party.combatActive = false;
        clearInterval(interval);
        actionIntervals.delete(partyId);

        resetPartyDeltaBaseline(partyId);

        const dungeonDataForCompletion = party.dungeon ? characters.getDungeonData(party.dungeon) : null;
        const dungeonFloorMaxForCompletion = dungeonDataForCompletion?.floorAmount ?? 100;

        generateCombatSummary(partyId, party, 'Victory! You can move now!');
        console.log(`[DEBUG-VICTORY] party=${partyId} dungeon=${party.dungeon} floor=${party.floor} dungeonFloor=${party.dungeonFloors?.[party.dungeon]} maxFloor=${dungeonFloorMaxForCompletion} enemies=${(party.enemies || []).length} live=${liveEnemiesList.length} enemyHps=${(party.enemies || []).map((e) => `${e.name}:${e.hp}`).join(', ')}`);

        party.enemies = [];

        if (party.dungeon && party.dungeonFloors?.[party.dungeon] === dungeonFloorMaxForCompletion) {
          if (!party.completedDungeons) party.completedDungeons = {};
          if (party.completedDungeons[party.dungeon] !== true) {
            party.completedDungeons[party.dungeon] = true;
          }

          console.log(`🏁 ${party.dungeon} completed!`);

          const completionPacket = { message: `🏁 ${party.dungeon} completed!`, type: 'success' };
          io.to(partyId).emit('eventLog', completionPacket);
          broadcastToParty(partyId, 'eventLog', completionPacket, { noBatch: true });

          characters.restockShopWithDungeonScaling(party, party.dungeon, dungeonDataForCompletion);

          const lootResults = characters.rewardPlayersOnDungeonClear(party, party.dungeon, dungeonDataForCompletion);
          for (const result of lootResults) {
            const awardPacket = { message: result.message, type: result.type === 'item' ? 'success' : 'info' };
            io.to(partyId).emit('eventLog', awardPacket);
            broadcastToParty(partyId, 'eventLog', awardPacket, { noBatch: true });
          }

          party.floor = 0;
          party.dungeonFloors[party.dungeon] = 0;
          party.combatActive = false;
          party.combatTurn = 0;
          party.enemies = [];
          restorePartyToFull(partyId);

          broadcastFullState(partyId, party);

          const returnPacket = { message: '🏠 Returned to Town!', type: 'info' };
          io.to(partyId).emit('eventLog', returnPacket);
          broadcastToParty(partyId, 'eventLog', returnPacket, { noBatch: true });

          if (party.autoEmbark) {
            embarkParty(partyId, party, party.dungeon || 'field');
          }

          return;
        }

        const floorAdvancePacket = {
          message: '✅ Auto-progressing to next floor...',
          type: 'info',
        };
        broadcastToParty(partyId, 'eventLog', floorAdvancePacket);

        if (!party.dungeonFloors) party.dungeonFloors = {};
        if (!party.highestVisitedFloors) party.highestVisitedFloors = {};

        const currentDungeonFloor = party.dungeonFloors[party.dungeon] || 1;

        const dungeonDataForAutoProgress = characters.getDungeonData(party.dungeon);
        const dungeonFloorMaxForAutoProgress = dungeonDataForAutoProgress?.floorAmount ?? 100;
        const newDungeonFloor = Math.min(currentDungeonFloor + 1, dungeonFloorMaxForAutoProgress);
        console.log(`[DEBUG-AUTOPROGRESS] party=${partyId} dungeon=${party.dungeon} oldFloor=${currentDungeonFloor} newFloor=${newDungeonFloor} maxFloor=${dungeonFloorMaxForAutoProgress} enemiesBefore=${(party.enemies || []).length} liveBefore=${liveEnemies(party).length}`);

        party.dungeonFloors[party.dungeon] = newDungeonFloor;

        party.floor = newDungeonFloor;

        const currentHighest = party.highestVisitedFloors[party.dungeon] || 0;
        if (newDungeonFloor > currentHighest) {
          party.highestVisitedFloors[party.dungeon] = newDungeonFloor;
        }

        setTimeout(() => {
          const nextFloorPacket = { partyId: party.partyId };
          party._autoProgressTimestamp = Date.now();
          broadcastToParty(partyId, 'nextFloor', nextFloorPacket);
        }, 1000);

        Array.from(party.players.values()).forEach((p) => void saveCharacter(p.name, p));
        startSpawnTimer(partyId, party);
        return;
      }

      const agiFillRate = 4.8;
      const combatants = [...livePlayersList, ...liveEnemiesList];

      combatants.forEach((combatant) => {
        if (combatant.hp > 0) {
          const weaponRef = combatant.equipment?.weapon;
          const resolvedWeapon = weaponRef?.id
            ? itemGenerator.resolveItem('weapon', weaponRef.id, weaponRef.level || 1, weaponRef.rarity || 1)
            : null;
          const weaponAspd = resolvedWeapon?.attackSpeed ?? 1.0;
          const fillAmount =
            (0.7 + agiFillRate * weaponAspd) *
            (1.1 +
              combatant.agi / 244 +
              weaponAspd / 20 +
              (combatant.equipment?.shoes?.defense || combatant.shoes || 3) / 122);
          combatant.actionBar = Math.min(combatant.maxActionBar, combatant.actionBar + fillAmount);

          if (combatant.actionBar >= combatant.maxActionBar) {
            performActionBarAttack(combatant, partyId, party);
            combatant.actionBar -= combatant.maxActionBar;
          }
        }
      });
    }, 50);

    actionIntervals.set(partyId, interval);
  }

  function startRegenSystem() {
    setInterval(() => {
      for (const [_partyId, party] of parties) {
        const inCombat = party.combatActive,
          live = livePlayers(party);
        if (live.length === 0) continue;

        if (party.floor === 0) live.forEach((p) => (p.ap = Math.min(p.maxAp, p.ap + 5)));

        live.forEach((p) => {
          const hpRegen =
            (inCombat ? 0.11 : 0.19) +
            characters.getEffectiveAttribute(p, 'vit') / 366 +
            characters.getEffectiveAttribute(p, 'str') / 477;
          p.hp = Math.min(p.maxHp, p.hp + hpRegen * (inCombat ? 1.9 : 3.5));

          const mpRegen =
            (inCombat ? 0.24 : 0.28) +
            characters.getEffectiveAttribute(p, 'int') / 422 +
            characters.getEffectiveAttribute(p, 'cnc') / 533;
          p.mp = Math.min(p.maxMp, p.mp + mpRegen * (inCombat ? 2.4 : 3.4));

          const apRegen =
            (inCombat ? 0.01 : 0.26) +
            characters.getEffectiveAttribute(p, 'int') / 422 +
            characters.getEffectiveAttribute(p, 'cnc') / 333;
          p.ap = Math.min(p.maxAp, p.ap + apRegen * (inCombat ? 0.01 : 2.3));
        });
      }
    }, 100);
  }

  function initDotSystem() {
    const EFFECT_FIELDS = ['effects'];
    const hasActiveEffects = (party) => {
      const combatants = [...party.players.values(), ...(party.enemies || [])];
      return combatants.some((c) => EFFECT_FIELDS.some((f) => Array.isArray(c[f]) && c[f].length > 0));
    };
    const dotInterval = setInterval(() => {
      for (const [_partyId, party] of parties.entries()) {
        const active = hasActiveEffects(party);
        buffEngine.processEffects(party);
        if (active) {
          broadcastCriticalUpdate(_partyId, party);
        }
      }
    }, 1000);
    return dotInterval;
  }

  return {
    livePlayers,
    liveEnemies,
    selectTarget,
    calculateAccuracyMod,
    calculateRoll,
    updateCombatStats,
    updateIncomingCombatStats,
    handlePlayerDeath,
    applyDamage,
    resolveAttackHit,
    performActionBarAttack,
    castAbilityForPlayer,
    awardXP,
    generateCombatSummary,
    restorePartyToFull,
    startActionBarSystem,
    startRegenSystem,
    initDotSystem,
  };
}
