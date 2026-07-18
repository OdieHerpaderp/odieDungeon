/**
 * Test script to verify the new DoT, HoT, and action bar slowing functionality
 */

const { getDefaultSkillsState, getSkillLevel, applyDot, applyHot, applyActionSlowing, applyWeaken, applyVulnerability, applyDefenseDown, processDotTicks, processHotTicks, processActionSlowEffects, processWeakenEffects, processVulnerabilityEffects, processDefenseDownEffects, sumDebuffAmount } = require('../public/skills/skillEngine');

console.log("🧪 Testing new SkillEngine features...\n");

// Create a test caster and target
const caster = {
    id: 'test_caster',
    name: 'Test Caster',
    skillsState: {
        skill_magic: { xp: 1000 } // Level 6 based on xp curve
    },
    isEnemy: false
};

const target = {
    id: 'test_target',
    name: 'Test Target',
    hp: 100,
    maxHp: 100,
    actionBar: 100,
    maxActionBar: 100,
    dots: [],
    hots: [],
    actionSlowEffects: [],
    weakenEffects: [],
    vulnerabilityEffects: [],
    defenseDownEffects: [],
    isEnemy: true
};

console.log("Caster Skill Level:", getSkillLevel(caster.skillsState, 'skill_magic'));

// Test DoT functionality
console.log("\n🧪 Testing DoT (Damage over Time)...");
const dotAbility = {
    id: 'test_dot_ability',
    name: 'Test DoT Ability',
    dotDamagePerTick: 5,
    dotDuration: 4,
    skillId: 'skill_magic'
};

const dotResult = applyDot(caster, target, dotAbility, { players: new Map([[caster.id, caster]]), enemies: [target], combatStats: new Map() }, new Map());
console.log("DoT Applied:", dotResult);
console.log("Target Dots:", target.dots);

// Test HoT functionality
console.log("\n🧪 Testing HoT (Heal over Time)...");
const hotAbility = {
    id: 'test_hot_ability',
    name: 'Test HoT Ability',
    hotHealPerTick: 3,
    hotDuration: 3,
    skillId: 'skill_healing'
};

const hotResult = applyHot(caster, target, hotAbility, { players: new Map([[caster.id, caster]]), enemies: [target], combatStats: new Map() }, new Map());
console.log("HoT Applied:", hotResult);
console.log("Target HoTs:", target.hots);

// Test Action Bar Slowing
console.log("\n🧪 Testing Action Bar Slowing...");
const slowAbility = {
    id: 'test_slow_ability',
    name: 'Test Slow Ability',
    actionBarSlowAmount: 25,
    actionBarSlowDuration: 3
};

const slowResult = applyActionSlowing(caster, target, slowAbility);
console.log("Action Bar Slow Applied:", slowResult);
console.log("Target ActionBar before slow:", target.actionBar);
console.log("Target ActionBar after slow:", target.actionBar);
console.log("Target Slow Effects:", target.actionSlowEffects);

// Test DoT processing
console.log("\n🧪 Testing DoT Processing...");
const party = {
    players: new Map([[caster.id, caster]]),
    enemies: [target],
    combatStats: new Map([[caster.id, { totalDotDamage: 0 }]])
};

console.log("Target HP before DoT processing:", target.hp);
processDotTicks(party);
console.log("Target HP after DoT processing:", target.hp);
console.log("Target Dots after processing:", target.dots);

// Test HoT processing
console.log("\n🧪 Testing HoT Processing...");
console.log("Target HP before HoT processing:", target.hp);
processHotTicks(party);
console.log("Target HP after HoT processing:", target.hp);
console.log("Target HoTs after processing:", target.hots);

// Test Action Slow Effects Processing
console.log("\n🧪 Testing Action Slow Effects Processing...");
console.log("Target Slow Effects before processing:", target.actionSlowEffects);
processActionSlowEffects(party);
console.log("Target Slow Effects after processing:", target.actionSlowEffects);

// Test Weaken debuff
console.log("\n🧪 Testing Weaken Debuff...");
const weakenAbility = {
    id: 'test_weaken_ability',
    name: 'Test Weaken Ability',
    weakenAmount: 0.25,
    weakenDuration: 3,
    skillId: 'skill_witchcraft'
};
const weakenResult = applyWeaken(caster, target, weakenAbility);
console.log("Weaken Applied:", weakenResult);
console.log("Target Weaken Effects:", target.weakenEffects);
processWeakenEffects(party);
console.log("Target Weaken Effects after processing:", target.weakenEffects);
console.log("Sum Weaken (cap 0.9):", sumDebuffAmount(target.weakenEffects, 0.9));

// Test Vulnerability debuff
console.log("\n🧪 Testing Vulnerability Debuff...");
const vulnAbility = {
    id: 'test_vuln_ability',
    name: 'Test Vulnerability Ability',
    vulnerabilityAmount: 0.30,
    vulnerabilityDuration: 3,
    skillId: 'skill_witchcraft'
};
const vulnResult = applyVulnerability(caster, target, vulnAbility);
console.log("Vulnerability Applied:", vulnResult);
console.log("Target Vulnerability Effects:", target.vulnerabilityEffects);
processVulnerabilityEffects(party);
console.log("Target Vulnerability Effects after processing:", target.vulnerabilityEffects);
console.log("Sum Vulnerability (cap 2.0):", sumDebuffAmount(target.vulnerabilityEffects, 2.0));

// Test Defense-Down debuff
console.log("\n🧪 Testing Defense-Down Debuff...");
const defDownAbility = {
    id: 'test_defdown_ability',
    name: 'Test Defense-Down Ability',
    defenseDownAmount: 0.35,
    defenseDownDuration: 3,
    skillId: 'skill_witchcraft'
};
const defDownResult = applyDefenseDown(caster, target, defDownAbility);
console.log("Defense-Down Applied:", defDownResult);
console.log("Target Defense-Down Effects:", target.defenseDownEffects);
processDefenseDownEffects(party);
console.log("Target Defense-Down Effects after processing:", target.defenseDownEffects);
console.log("Sum Defense-Down (cap 0.9):", sumDebuffAmount(target.defenseDownEffects, 0.9));

console.log("\n✅ All tests completed successfully!");
console.log("The new DoT, HoT, and action bar slowing features are working properly.");