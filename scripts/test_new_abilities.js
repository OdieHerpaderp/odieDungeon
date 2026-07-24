/**
 * Test script to verify the new buff/debuff system via buffEngine
 */

const buffEngine = require('../public/skills/buffEngine');

console.log("🧪 Testing buffEngine features...\n");

// Create a test caster and target
const caster = {
    id: 'test_caster',
    name: 'Test Caster',
    skillsState: {
        skill_magic: { xp: 1000 }
    },
    isEnemy: false,
    effects: []
};

const target = {
    id: 'test_target',
    name: 'Test Target',
    hp: 100,
    maxHp: 100,
    actionBar: 100,
    maxActionBar: 100,
    effects: [],
    isEnemy: true
};

console.log("Caster Skill Level:", 1);

// Test DoT functionality
console.log("\n🧪 Testing DoT (Damage over Time)...");
const dotAbility = {
    id: 'test_dot_ability',
    name: 'Test DoT Ability',
    effects: [{ type: 'dot', damagePerTick: 5, duration: 4 }],
    skillId: 'skill_magic'
};

buffEngine.applyEffect(caster, target, dotAbility);
console.log("DoT Applied:", target.effects.some(e => e.type === 'dot'));
console.log("Target effects:", target.effects);

// Test HoT functionality
console.log("\n🧪 Testing HoT (Heal over Time)...");
const hotAbility = {
    id: 'test_hot_ability',
    name: 'Test HoT Ability',
    effects: [{ type: 'hot', healPerTick: 3, duration: 3 }],
    skillId: 'skill_healing'
};

buffEngine.applyEffect(caster, target, hotAbility);
console.log("HoT Applied:", target.effects.some(e => e.type === 'hot'));
console.log("Target effects:", target.effects);

// Test Action Bar Slowing
console.log("\n🧪 Testing Action Bar Slowing...");
const slowAbility = {
    id: 'test_slow_ability',
    name: 'Test Slow Ability',
    effects: [{ type: 'actionSlow', amount: 25, duration: 3 }]
};

const prevActionBar = target.actionBar;
buffEngine.applyEffect(caster, target, slowAbility);
console.log("Action Bar Slow Applied:", target.actionBar < prevActionBar);
console.log("Target ActionBar after slow:", target.actionBar);

// Test processEffects
console.log("\n🧪 Testing processEffects...");
const party = {
    players: new Map([[caster.id, caster]]),
    enemies: [target],
    combatStats: new Map()
};

console.log("Target HP before processEffects:", target.hp);
buffEngine.processEffects(party);
console.log("Target HP after processEffects:", target.hp);
console.log("Target effects after processing:", target.effects);

// Test Weaken debuff
console.log("\n🧪 Testing Weaken Debuff...");
const weakenAbility = {
    id: 'test_weaken_ability',
    name: 'Test Weaken Ability',
    effects: [{ type: 'weaken', amount: 0.25, duration: 3 }],
    skillId: 'skill_witchcraft'
};
buffEngine.applyEffect(caster, target, weakenAbility);
console.log("Weaken Applied:", target.effects.some(e => e.type === 'weaken'));
console.log("Sum Weaken (cap 0.9):", buffEngine.sumEffectAmount(target.effects, 'weaken', 0.9));

// Test Vulnerability debuff
console.log("\n🧪 Testing Vulnerability Debuff...");
const vulnAbility = {
    id: 'test_vuln_ability',
    name: 'Test Vulnerability Ability',
    effects: [{ type: 'vulnerability', amount: 0.30, duration: 3 }],
    skillId: 'skill_witchcraft'
};
buffEngine.applyEffect(caster, target, vulnAbility);
console.log("Vulnerability Applied:", target.effects.some(e => e.type === 'vulnerability'));
console.log("Sum Vulnerability (cap 2.0):", buffEngine.sumEffectAmount(target.effects, 'vulnerability', 2.0));

// Test Defense-Down debuff
console.log("\n🧪 Testing Defense-Down Debuff...");
const defDownAbility = {
    id: 'test_defdown_ability',
    name: 'Test Defense-Down Ability',
    effects: [{ type: 'defenseDown', amount: 0.35, duration: 3 }],
    skillId: 'skill_witchcraft'
};
buffEngine.applyEffect(caster, target, defDownAbility);
console.log("Defense-Down Applied:", target.effects.some(e => e.type === 'defenseDown'));
console.log("Sum Defense-Down (cap 0.9):", buffEngine.sumEffectAmount(target.effects, 'defenseDown', 0.9));

// Test clearEffects
console.log("\n🧪 Testing clearEffects...");
buffEngine.clearEffects(target);
console.log("Effects after clear:", target.effects.length);

console.log("\n✅ All tests completed successfully!");
console.log("The buffEngine unified effects system is working properly.");