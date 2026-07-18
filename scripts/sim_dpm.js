#!/usr/bin/env node

const path = require('path');
const {
  ventureGroups,
  ventureEffects,
  calcVentureLv,
  applyVentureStatModifications,
  applyVentureActionBarModifications,
  executeVentureEffects,
  handleVentureOnHit,
  handleVentureOnCrit,
  bobStatPriorities,
  processDotTicks,
} = require(path.join(__dirname, '..', 'public', 'ventures.js'));

// Build venture map for requirement lookups
const ventureMap = {};
for (const g of ventureGroups) {
  for (const v of g.ventures) {
    ventureMap[v.key] = v;
  }
}

// Calculate total required venture levels recursively, taking max level for duplicates
function getTotalRequiredLevels(key) {
  const venture = ventureMap[key];
  if (!venture || !venture.req || venture.req === '') return 0;
  
  const maxLevels = new Map(); // venture => max level required
  
  function collectReqs(reqs) {
    for (const req of reqs) {
      const current = maxLevels.get(req.venture) || 0;
      maxLevels.set(req.venture, Math.max(current, req.level));
      
      // recurse on prerequisites
      const subVenture = ventureMap[req.venture];
      if (subVenture && subVenture.req && subVenture.req !== '') {
        collectReqs(subVenture.req);
      }
    }
  }
  
  collectReqs(venture.req);
  
  let total = 0;
  for (const level of maxLevels.values()) {
    total += level;
  }
  return total;
}

const TICK_MS = 50;
const MAX_ACTION_BAR = 106; // 105 + 1 player
const SIM_TIMES_S = [5, 6, 7, 8, 9, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28];

function getAllVentureKeys() {
  const keys = [];
  for (const g of ventureGroups) {
    for (const v of g.ventures) keys.push(v.key);
  }
  return keys;
}

function baseFill(agi, shoesDef) {
  return 5.2 * (1.2 + agi / 244 + shoesDef / 122);
}

function makeActor(currentVenture) {
  const fullVentureKeys = getAllVentureKeys();
  const ventures = {};
  for (const k of fullVentureKeys) ventures[k] = (k === currentVenture) ? 4444 : 2222; // xp baseline, triple for current venture

  // Set MP based on venture type (matching app.js mechanics)
  let maxMp, initialMp;
  switch(currentVenture) {
    case 'gunslinger':
    case 'hexSlinger':
      maxMp = 6;  // 6-shot magazine
      initialMp = 6; // Start with full magazine
      break;
    case 'soldier':
      maxMp = 20; // 20 MP pool (larger than gunslinger/hexslinger)
      initialMp = 20; // Start with full MP
      break;
    default:
      maxMp = 150; // Default for other classes
      initialMp = 90; // Default initial MP
  }

  // Calculate stats based on venture priorities
  const baseStat = 14;
  const priorities = bobStatPriorities[currentVenture] || ['str', 'dex', 'agi', 'vit', 'int', 'cnc']; // fallback
  const stats = {
    str: baseStat, dex: baseStat, agi: baseStat, vit: baseStat,
    int: baseStat, cnc: baseStat, wis: baseStat, luk: baseStat, for: baseStat, pie: baseStat
  };
  priorities.forEach((stat, index) => {
    const bonus = (8 - index) * 3;
    stats[stat] += bonus;
  });

  return {
    id: 'att',
    name: 'Sim',
    isEnemy: false,
    level: 8,
    // core stats
    str: stats.str, dex: stats.dex, agi: stats.agi, vit: stats.vit,
    int: stats.int, cnc: stats.cnc, wis: stats.wis * 1.2, luk: stats.luk * 1.2, for: stats.for * 1.2, pie: stats.pie * 1.2,
    // gear
    equipment: {
      weapon: { id: 'sword', damage: 7, level: 7, type: 'melee' },
      armour: { id: 'leatherArmor', defense: 6, level: 6, type: 'light' },
      helmet: { id: 'strawHat', defense: 6, level: 6, type: 'light' },
      shoes: { id: 'travelBoots', defense: 6, level: 6, type: 'light' }
    },
    // resources
    gold: 700,
    mp: initialMp,
    maxMp: maxMp,
    ap: 0,
    maxAp: 0,
    // venture
    currentVenture,
    ventures,
    // combat state
    actionBar: 0,
    maxActionBar: MAX_ACTION_BAR,
    hp: 260,
    maxHp: 360,
  };
}

function makeDamagedAlly() {
  return {
    id: 'ally',
    name: 'Damaged Ally',
    isEnemy: false,
    level: 1,
    // core stats
    str: 20, dex: 20, agi: 20, vit: 20,
    int: 20, cnc: 20, wis: 20, luk: 20, for: 20, pie: 20,
    // gear
    equipment: {
      weapon: { id: 'sword', damage: 3, level: 3, type: 'melee' },
      armour: { id: 'leatherArmor', defense: 3, level: 3, type: 'light' },
      helmet: { id: 'strawHat', defense: 3, level: 3, type: 'light' },
      shoes: { id: 'travelBoots', defense: 3, level: 3, type: 'light' }
    },
    // resources
    gold: 700,
    mp: 20,
    maxMp: 20,
    ap: 0,
    maxAp: 0,
    // venture
    currentVenture: 'novice',
    ventures: { novice: 10 },
    // combat state
    actionBar: 0,
    maxActionBar: 100,
    hp: 130,  // Damaged - only 50% HP
    maxHp: 400,
    dots: [],
    hots: [] // Initialize HoT system
  };
}

function makeTarget() {
  return {
    id: 'tgt',
    isEnemy: true,
    name: 'Dummy',
    level: 1,
    hp: 80000,
    maxHp: 120000,
    equipment: {
      weapon: { id: 'newspaper', damage: 0, level: 1, type: 'melee' },
      armour: { id: 'leatherArmor', defense: 0, level: 1, type: 'light' },
      helmet: { id: 'strawHat', defense: 0, level: 1, type: 'light' },
      shoes: { id: 'travelBoots', defense: 0, level: 1, type: 'light' }
    },
    vit: 0,
    for: 0,
    agi: 35,
    ap: 0,
    maxAp: 0,
    gold: 700,
    actionBar: 0,
    maxActionBar: 100,
    ventures: {},
    currentVenture: 'novice',
    dots: []
  };
}

function performAttack(attacker, target, party, combatStats) {
  // Build base modifiers from app.js
  const stats = { mod: 0, modD: 0, useMelee: '✊' };
  applyVentureStatModifications(attacker, stats);
  
  const effectiveWeapon = attacker.equipment?.weapon?.damage || attacker.equipment?.weapon?.level || 0;
  let mod = 2 + effectiveWeapon + (attacker.wis || 0) / 4;
  let modD = 1 + effectiveWeapon * 1.1 + (mod / 2 + effectiveWeapon) * (0.5 + Math.random() / 3) / 1.8;
  
  // Re-apply venture mods on the new base
  stats.mod = mod;
  stats.modD = modD;
  applyVentureStatModifications(attacker, stats);
  mod = stats.mod;
  modD = stats.modD;

  // roll from app.js
  let roll = Math.floor(Math.random() * (80 + mod / 2 + (attacker.luk || 0) * 2) + 1 + mod / 6 + (attacker.luk || 0) * Math.random() * 0.3);
  roll = roll * (0.2 + Math.random() * 3);

  // Use venture ability (pre-roll modifiers etc.)
  executeVentureEffects(attacker, target, party, combatStats);

  roll -= Math.floor((target.agi || 0) / 9 + (target.agi || 0) * Math.random() * 1.4);
  if (roll > 70) roll = Math.round(Math.pow(roll, 0.9)); else roll = Math.round(roll);
  if (!Number.isFinite(roll)) roll = 0;

  const hit = roll > 0;
  const crit = roll > 99;
  let damage = 0;

  if (hit) {
    roll += Math.round(0.5 * (attacker.luk || 0) + Math.random() * (attacker.luk || 0) * 1.2);

    const damMod = Math.random() * (0.3 + modD * 0.3) + modD * 1.6 + effectiveWeapon * 1.2;
    damage = modD + Math.random() * (0.3 + modD * 0.3 + damMod * 0.3) + damMod * 1.2;

    if (crit) {
      roll += Math.round(Math.random() * (attacker.luk || 0));
      const thiefComponent = calcVentureLv(((attacker.ventures['thief'] || 0) + 2));
      const gamblerComponent = calcVentureLv(((attacker.ventures['gambler'] || 0) + 2));
      const rangerComponent = calcVentureLv(((attacker.ventures['ranger'] || 0) + 2));
      damage *= 1.1 + (roll - 80 + thiefComponent / 133 + gamblerComponent / 99 + rangerComponent / 111 + (attacker.luk || 0) / 128) / 222;
      handleVentureOnCrit(attacker, target, roll, damage, party, combatStats);
    }

    // Armor/VIT/FOR mitigation from app.js
    damage -= (0.05 * Math.random() * (target.equipment?.armour?.defense || target.armour || 0) + 0.02 * Math.random() * (target.vit || 0) + 0.004 * Math.random() * (target.for || 0));
    damage = Math.round(damage);
    if (damage < 0) damage = 0;

    // AP absorption from app.js
    if ((target.ap || 0) > 0) {
      const apDamage = Math.min(damage * 0.75, target.ap);
      target.ap = Math.max(0, target.ap - apDamage);
      damage -= apDamage; // The remaining damage is dealt to HP
    }

    if (damage > 0) {
      target.hp = Math.max(0, target.hp - damage);
    }

    try {
      handleVentureOnHit(attacker, target, roll, damage, party, combatStats);
    } catch (e) {
      console.error(`Error in handleVentureOnHit for ${attacker.currentVenture}:`, e.message);
    }
  }

  return { hit, crit, damage: Math.max(0, Math.round(damage)) };
}

function simulateVenture(key, totalTimeS) {
  const actor = makeActor(key);
  const targets = [makeTarget(), makeTarget(), makeTarget(), makeTarget(), makeTarget(), makeTarget(), makeTarget(), makeTarget()]; // 8 enemies
  const ally = makeDamagedAlly();
  const party = {
    floor: 1,
    enemies: targets,
    players: new Map([['att', actor], ['ally', ally]]),
    combatStats: new Map([['att', { attacks: 0, hits: 0, totalDamage: 0, rollSum: 0, totalHealed: 0, crits: 0 }]])
  };
  const combatStats = party.combatStats;

  let totalDamage = 0;
  let ticks = Math.floor((totalTimeS * 1000) / TICK_MS);

  for (let i = 0; i < ticks; i++) {
    // MP regen (from app.js, in-combat)
    let mpRegen = (0.11) + (actor.int || 0) / 422 + (actor.cnc || 0) / 311 + (actor.wis || 0) / 377 + (actor.pie || 0) / 422;
    
    // Apply venture-specific MP regeneration mechanics
    if (actor.currentVenture === 'gunslinger' || actor.currentVenture === 'hexSlinger' || actor.currentVenture === 'soldier') {
      // Gunslinger and HexSlinger only regenerate when magazine is empty (reload mechanic)
    } else {
      // Standard MP regen for non-gun classes
      actor.mp = Math.min(actor.maxMp, actor.mp + mpRegen * 0.4);
    }

    // Process damage over time (DoT) effects
    // Store HP values before processing DoTs
    const enemyHpsBefore = party.enemies.map(e => e.hp);
    processDotTicks(party);
    // Calculate DoT damage this tick
    let dotDamageThisTick = 0;
    for (let j = 0; j < party.enemies.length; j++) {
      dotDamageThisTick += Math.max(0, enemyHpsBefore[j] - party.enemies[j].hp);
    }
    totalDamage += dotDamageThisTick;
    
    // Track DoT damage in combat stats
    const st = combatStats.get('att');
    if (!st.totalDotDamage) st.totalDotDamage = 0;
    st.totalDotDamage += dotDamageThisTick;

    // Fill action bar
    let fill = baseFill(actor.agi || 0, actor.equipment?.shoes?.defense || actor.shoes || 0);
    fill = applyVentureActionBarModifications(actor, fill);

    actor.actionBar += fill;

    // Attempt attack
    if (actor.actionBar >= actor.maxActionBar) {
      let canAttack = true;

      // Handle ammo-based classes (gunslinger, hexslinger, soldier)
      if (actor.currentVenture === 'gunslinger' || actor.currentVenture === 'hexSlinger' || actor.currentVenture === 'soldier') {
        if (actor.mp <= 0) {
          if (actor.currentVenture === 'soldier') {
            // Soldier doesn't reload - just can't attack when out of MP
            canAttack = false;
          } else {
            // Gunslinger and HexSlinger reload on empty (server behavior)
            actor.mp = actor.maxMp; // Reload to full magazine
            canAttack = false;
          }
        } else {
          // Consume 1 MP per shot for all gun classes
          actor.mp -= 1;
        }
      }

      if (canAttack) {
        // Choose target: lowest HP enemy
        const liveEnemies = targets.filter(e => e.hp > 0);
        if (liveEnemies.length === 0) break; // No enemies left
        const target = liveEnemies.sort((a, b) => a.hp - b.hp)[0];
        const res = performAttack(actor, target, party, combatStats);
        const st = combatStats.get('att');
        st.attacks++;
        if (res.hit) {
          st.hits++;
          if (res.crit) st.crits++;
          st.totalDamage += res.damage;
          totalDamage += res.damage;
        }
      }
      actor.actionBar -= actor.maxActionBar;
    }
  }

  const dps = totalDamage / totalTimeS;
  return { key, totalDamage, dps };
}

function main() {
  const keys = getAllVentureKeys();
  const results = [];
  for (const k of keys) {
    try {
      const dpsList = SIM_TIMES_S.map(t => simulateVenture(k, t).dps);
      const best = Math.max(...dpsList);
      const average = dpsList.reduce((a, b) => a + b, 0) / dpsList.length;
      results.push({ key: k, best, average, reqLvls: getTotalRequiredLevels(k) });
    } catch (e) {
      results.push({ key: k, error: e && e.message ? e.message : String(e) });
    }
  }
  const ok = results.filter(r => !r.error).sort((a, b) => b.average - a.average);

  // Calculate average and median best DPS
  const bestValues = ok.map(r => r.best);

  // Calculate average best
  const avgBest = bestValues.reduce((sum, val) => sum + val, 0) / bestValues.length;

  // Calculate median best
  const sortedBest = [...bestValues].sort((a, b) => a - b);

  const medianBest = sortedBest.length % 2 === 0
    ? (sortedBest[sortedBest.length / 2 - 1] + sortedBest[sortedBest.length / 2]) / 2
    : sortedBest[Math.floor(sortedBest.length / 2)];

  console.log('Venture DPS (sorted by average DPS desc):');
  ok.forEach((r, index) => console.log(`${(index + 1).toString().padStart(2)}. ${r.key.padEnd(14)}  avgDPS=${r.average.toFixed(2)}  bestDPS=${r.best.toFixed(2)}  reqLvls=${r.reqLvls}`));

  console.log('\n--- Statistics ---');
  console.log(`Average best DPS=${avgBest.toFixed(2)}`);
  console.log(`Median best DPS=${medianBest.toFixed(2)}`);

  const failed = results.filter(r => r.error);
  if (failed.length) {
    console.log('\nErrors:');
    failed.forEach(r => console.log(`${r.key}: ${r.error}`));
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  simulateVenture,
  getAllVentureKeys,
  makeActor,
  makeTarget,
  performAttack,
  baseFill,
  SIM_TIMES_S,
  TICK_MS,
  MAX_ACTION_BAR
};
