// Test script for Heal Over Time (HoT) system
// Uses buffEngine.js where the unified effects system is implemented.
const assert = require('assert');
const buffEngine = require('../public/skills/buffEngine');

console.log('Testing Heal Over Time (HoT) System');
console.log('=' .repeat(50));

// Create a healer agent with enough healing XP for level 1 skill scaling
const medic = {
  id: 'medic1',
  name: 'Test Medic',
  skillsState: { skill_healing: { xp: 200 } },
  isEnemy: false,
  effects: []
};

const ally = {
  id: 'ally1',
  name: 'Injured Ally',
  hp: 30,
  maxHp: 100,
  effects: [],
  isEnemy: false
};

const enemy = {
  id: 'enemy1',
  name: 'Test Enemy',
  hp: 80,
  maxHp: 100,
  isEnemy: true,
  effects: []
};

const party = {
  players: new Map([
    ['medic1', medic],
    ['ally1', ally]
  ]),
  enemies: [enemy],
  combatStats: new Map()
};

party.combatStats.set('medic1', {
  totalDamage: 0,
  totalHealed: 0,
  hotsApplied: 0,
  totalHotHealing: 0
});

console.log('Initial state:');
console.log(`Medic HP: ${medic.hp}/${medic.maxHp}`);
console.log(`Ally HP: ${ally.hp}/${ally.maxHp}`);
console.log(`Ally effects: ${ally.effects.length}`);

// Test applying a HoT to the ally via buffEngine.applyEffect
console.log('\nTesting applyEffect with HoT to wounded ally...');
const hotAbility = {
  id: 'test_hot_ability',
  name: 'Test HoT Ability',
  skillId: 'skill_healing',
  effects: [{ type: 'hot', healPerTick: 3, duration: 3 }]
};

buffEngine.applyEffect(medic, ally, hotAbility);
console.log(`Hot applied: ${ally.effects.some(e => e.type === 'hot')}`);
console.log(`Ally effects after apply: ${ally.effects.length}`);
const hotEffect = ally.effects.find(e => e.type === 'hot');
if (hotEffect) {
  console.log(`HoT details: ${hotEffect.healPerTick} heal/tick, ${hotEffect.duration} ticks`);
}

assert.strictEqual(ally.effects.some(e => e.type === 'hot'), true, 'HoT should be applied');
assert.ok(ally.effects.length >= 1, 'ally should have at least 1 effect after applyEffect');

// Test HoT tick processing
console.log('\nTesting HoT tick processing...');
console.log(`Ally HP before ticks: ${ally.hp}/${ally.maxHp}`);

for (let i = 0; i < 5; i++) {
  buffEngine.processEffects(party);
  console.log(`After tick ${i+1}: Ally HP = ${ally.hp}/${ally.maxHp}, effects remaining: ${ally.effects.length}`);
}

assert.ok(ally.hp > 30, 'ally HP should have increased from HoT ticks');

// Check combat stats
const medicStats = party.combatStats.get('medic1');
console.log('\nCombat stats:');
console.log(`Total HoT healing: ${medicStats.totalHotHealing || 0}`);

assert.ok(medicStats.totalHotHealing > 0, 'combatStats should record HoT healing amount');

console.log('\nHoT system test completed successfully!');