// Test script for Heal Over Time (HoT) system
const { ventureEffects, defaultCharacterValues, applyHot, processHotTicks } = require('../public/ventures.js');

console.log('Testing Heal Over Time (HoT) System');
console.log('=' .repeat(50));

// Create test characters
const medic = {
  id: 'medic1',
  name: 'Test Medic',
  currentVenture: 'medic',
  ventures: { medic: 1000, acolyte: 500, cleric: 300 },
  int: 25,
  wis: 20,
  cnc: 18,
  hp: 100,
  maxHp: 100,
  mp: 50,
  maxMp: 50,
  isEnemy: false
};

const ally = {
  id: 'ally1',
  name: 'Injured Ally',
  hp: 30,
  maxHp: 100,
  hots: [],
  isEnemy: false
};

const enemy = {
  id: 'enemy1',
  name: 'Test Enemy',
  hp: 80,
  maxHp: 100,
  isEnemy: true
};

// Create test party
const party = {
  players: new Map([
    ['medic1', medic],
    ['ally1', ally]
  ]),
  enemies: [enemy],
  combatStats: new Map()
};

// Initialize combat stats
party.combatStats.set('medic1', {
  totalDamage: 0,
  totalHealed: 0,
  hotsApplied: 0,
  totalHotHealing: 0
});

console.log('Initial state:');
console.log(`Medic HP: ${medic.hp}/${medic.maxHp}`);
console.log(`Ally HP: ${ally.hp}/${ally.maxHp}`);
console.log(`Ally HoTs: ${ally.hots.length}`);

// Test medic onHit effect
console.log('\nTesting medic onHit effect...');
const medicEffect = ventureEffects.medic;
if (medicEffect && medicEffect.onHit) {
  medicEffect.onHit(medic, enemy, 85, 15, party, party.combatStats);
  
  console.log(`After onHit - Ally HoTs: ${ally.hots.length}`);
  if (ally.hots.length > 0) {
    const hot = ally.hots[0];
    console.log(`HoT details: ${hot.healPerTick} heal/tick, ${hot.duration} ticks`);
  }
}

// Test HoT processing
console.log('\nTesting HoT tick processing...');
console.log(`Ally HP before ticks: ${ally.hp}/${ally.maxHp}`);

// Process multiple ticks
for (let i = 0; i < 5; i++) {
  processHotTicks(party);
  console.log(`After tick ${i+1}: Ally HP = ${ally.hp}/${ally.maxHp}, HoTs remaining: ${ally.hots.length}`);
}

// Check combat stats
const medicStats = party.combatStats.get('medic1');
console.log('\nCombat stats:');
console.log(`HoTs applied: ${medicStats.hotsApplied || 0}`);
console.log(`Total HoT healing: ${medicStats.totalHotHealing || 0}`);

console.log('\nHoT system test completed successfully!');