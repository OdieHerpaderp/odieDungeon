const assert = require('assert');
const { getDefaultSkillsState, getWeaponSkillId, awardSkillXp, getSkillLevel, getAbilityUnlockState, selectAbilityToCast, getEquippedWeaponClass, getEquippedWeaponSubType, getEquippedItem } = require('../public/skills/skillEngine');

const skillsState = getDefaultSkillsState();
assert.ok(skillsState.skill_melee_longBlade, 'default skill state should include the long blade melee skill');

const meleeWeapon = { weaponClass: 'melee', subType: 'longBlade', defaultSkillIdOnHit: 'skill_melee_longBlade' };
assert.strictEqual(getWeaponSkillId(meleeWeapon), 'skill_melee_longBlade');

const bluntWeapon = { weaponClass: 'melee', subType: 'blunt' };
assert.strictEqual(getWeaponSkillId(bluntWeapon), 'skill_melee_blunt');

const rangedWeapon = { weaponClass: 'ranged' };
assert.strictEqual(getWeaponSkillId(rangedWeapon), 'skill_ranged');

const updated = awardSkillXp(skillsState, 'skill_melee_longBlade', 100);
assert.strictEqual(updated.skill_melee_longBlade.xp, 100);
assert.strictEqual(getSkillLevel(updated, 'skill_melee_longBlade'), 1);

const skillMagicState = awardSkillXp(getDefaultSkillsState(), 'skill_magic', 100);
const ability = { id: 'arcane_bolt', skillId: 'skill_magic', unlockSkillLevelMin: 1, mpCostBase: 4, cooldownMsBase: 2000, allowedWeaponClasses: ['magic'] };
const player = { mp: 10, skillsState: skillMagicState, abilityCooldowns: {}, equipment: { weapon: { weaponClass: 'magic' } }, abilitySlots: ['arcane_bolt'] };
const chosen = selectAbilityToCast(player, [ability], Date.now());
assert.strictEqual(chosen?.id, 'arcane_bolt');

const zeroSkillState = getDefaultSkillsState();
assert.strictEqual(getSkillLevel(zeroSkillState, 'skill_healing'), 0, 'fresh character should have healing skill level 0');
const firstAid = { id: 'firstAid', skillId: 'skill_healing', unlockSkillLevelMin: 0, mpCostBase: 6, cooldownMsBase: 2500, allowedWeaponClasses: ['magic', 'ranged', 'melee'], requiresWeaponEquipped: false, isHeal: true };
assert.ok(getAbilityUnlockState(firstAid, zeroSkillState), 'firstAid with unlockSkillLevelMin 0 should be unlocked at level 0');

const equippedWeapon = getEquippedItem({ equipment: { weapon: { weaponClass: 'magic' } } }, 'weapon');
assert.strictEqual(getEquippedWeaponClass(equippedWeapon), 'magic');

// SubType gating: a short blade ability requires a dagger equipped.
const shortBladeSkillState = awardSkillXp(getDefaultSkillsState(), 'skill_melee_shortBlade', 100);
const shortBladeAbility = { id: 'shortblade_backstab', skillId: 'skill_melee_shortBlade', unlockSkillLevelMin: 1, mpCostBase: 6, cooldownMsBase: 2000, allowedWeaponClasses: ['melee'], requiredWeaponSubTypes: ['shortBlade'], requiresWeaponEquipped: true };
const daggerPlayer = { mp: 10, skillsState: shortBladeSkillState, abilityCooldowns: {}, equipment: { weapon: { weaponClass: 'melee', subType: 'shortBlade' } }, abilitySlots: ['shortblade_backstab'] };
assert.ok(selectAbilityToCast(daggerPlayer, [shortBladeAbility], Date.now()), 'short blade ability should be selectable with a dagger equipped');

const swordPlayer = { mp: 10, skillsState: shortBladeSkillState, abilityCooldowns: {}, equipment: { weapon: { weaponClass: 'melee', subType: 'longBlade' } }, abilitySlots: ['shortblade_backstab'] };
assert.strictEqual(selectAbilityToCast(swordPlayer, [shortBladeAbility], Date.now()), null, 'short blade ability should be blocked with a sword equipped');

const unarmedPlayer = { mp: 10, skillsState: shortBladeSkillState, abilityCooldowns: {}, equipment: {}, abilitySlots: ['shortblade_backstab'] };
assert.strictEqual(selectAbilityToCast(unarmedPlayer, [shortBladeAbility], Date.now()), null, 'short blade ability should be blocked when unequipped');

const healAbility = { id: 'healing_touch', skillId: 'skill_healing', unlockSkillLevelMin: 1, mpCostBase: 5, cooldownMsBase: 1000, isHeal: true };
const fullHealthAlly = { id: 'ally1', isEnemy: false, hp: 100, maxHp: 100 };
const woundedAlly = { id: 'ally2', isEnemy: false, hp: 50, maxHp: 100 };
const healSkillState = awardSkillXp(getDefaultSkillsState(), 'skill_healing', 100);
const healerPlayer = { mp: 10, skillsState: healSkillState, abilityCooldowns: {}, abilitySlots: ['healing_touch'] };

assert.strictEqual(selectAbilityToCast(healerPlayer, [healAbility], Date.now(), [fullHealthAlly]), null, 'heal should be blocked when no ally is below 75% HP');
assert.ok(selectAbilityToCast(healerPlayer, [healAbility], Date.now(), [fullHealthAlly, woundedAlly]), 'heal should be selectable when an ally is below 75% HP');
assert.strictEqual(selectAbilityToCast(healerPlayer, [healAbility], Date.now()), healAbility, 'heal should be selectable when liveTargets is omitted (backward compat)');

console.log('skills abilities regression checks passed');
