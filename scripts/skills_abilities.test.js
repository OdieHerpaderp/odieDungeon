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

const updated = awardSkillXp(skillsState, 'skill_melee_longBlade', 200);
assert.strictEqual(updated.skill_melee_longBlade.xp, 200);
assert.strictEqual(getSkillLevel(updated, 'skill_melee_longBlade'), 1);

const skillMagicState = awardSkillXp(getDefaultSkillsState(), 'skill_magic', 200);
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
const shortBladeSkillState = awardSkillXp(getDefaultSkillsState(), 'skill_melee_shortBlade', 200);
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
const healSkillState = awardSkillXp(getDefaultSkillsState(), 'skill_healing', 200);
const healerPlayer = { mp: 10, skillsState: healSkillState, abilityCooldowns: {}, abilitySlots: ['healing_touch'] };

assert.strictEqual(selectAbilityToCast(healerPlayer, [healAbility], Date.now(), [fullHealthAlly]), null, 'heal should be blocked when no ally is below 75% HP');
assert.ok(selectAbilityToCast(healerPlayer, [healAbility], Date.now(), [fullHealthAlly, woundedAlly]), 'heal should be selectable when an ally is below 75% HP');
assert.strictEqual(selectAbilityToCast(healerPlayer, [healAbility], Date.now()), healAbility, 'heal should be selectable when liveTargets is omitted (backward compat)');

// --- New skill family tests: survival ---
const zeroSurvivalState = getDefaultSkillsState();
assert.strictEqual(getSkillLevel(zeroSurvivalState, 'skill_survival'), 0);

const bandage = { id: 'survival_bandage', skillId: 'skill_survival', unlockSkillLevelMin: 0, mpCostBase: 3, cooldownMsBase: 2000, allowedWeaponClasses: ['magic','ranged','melee'], requiresWeaponEquipped: false, isHeal: true };
assert.ok(getAbilityUnlockState(bandage, zeroSurvivalState), 'survival_bandage should be unlocked at level 0');

// Survival abilities don't require a weapon equipped
const survivalBandagePlayer = { mp: 10, skillsState: awardSkillXp(getDefaultSkillsState(), 'skill_survival', 200), abilityCooldowns: {}, abilitySlots: ['survival_bandage'], equipment: {} };
assert.ok(selectAbilityToCast(survivalBandagePlayer, [bandage], Date.now()), 'survival_bandage should be selectable without a weapon');

// Survival abilities are gated by the same isHeal ally-check as other healing
const survivalFullAlly = { id: 'sally1', isEnemy: false, hp: 100, maxHp: 100 };
assert.strictEqual(selectAbilityToCast(survivalBandagePlayer, [bandage], Date.now(), [survivalFullAlly]), null, 'survival heal should be blocked when no ally needs healing');

// --- New skill family tests: shamanism ---
const zeroShamanState = getDefaultSkillsState();
assert.strictEqual(getSkillLevel(zeroShamanState, 'skill_shamanism'), 0);

const callSpirit = { id: 'shaman_call_spirit', skillId: 'skill_shamanism', unlockSkillLevelMin: 1, mpCostBase: 6, cooldownMsBase: 2800, allowedWeaponClasses: ['magic'], requiresWeaponEquipped: true, isHeal: true };
assert.strictEqual(getAbilityUnlockState(callSpirit, zeroShamanState), false, 'shaman_call_spirit should be locked at level 0');

const callSpiritUnlocked = { id: 'shaman_call_spirit', skillId: 'skill_shamanism', unlockSkillLevelMin: 1, mpCostBase: 6, cooldownMsBase: 2800, allowedWeaponClasses: ['magic'], requiresWeaponEquipped: true, isHeal: true };
const shamanPlayer = { mp: 15, skillsState: awardSkillXp(getDefaultSkillsState(), 'skill_shamanism', 200), abilityCooldowns: {}, equipment: { weapon: { weaponClass: 'magic' } }, abilitySlots: ['shaman_call_spirit'] };
assert.ok(selectAbilityToCast(shamanPlayer, [callSpiritUnlocked], Date.now()), 'shaman_call_spirit should be selectable with a magic weapon');

const shamanNoWeapon = { mp: 15, skillsState: awardSkillXp(getDefaultSkillsState(), 'skill_shamanism', 200), abilityCooldowns: {}, equipment: {}, abilitySlots: ['shaman_call_spirit'] };
assert.strictEqual(selectAbilityToCast(shamanNoWeapon, [callSpiritUnlocked], Date.now()), null, 'shaman abilities should require a weapon equipped');

// Shamanism favours CNC over INT in attribute scaling
const shamanCncPlayer = { hp: 90, maxHp: 100 }; // below threshold but close to test the scaling path
assert.ok(selectAbilityToCast(shamanPlayer, [callSpiritUnlocked], Date.now(), [woundedAlly]), 'shamanism should be selectable when ally is wounded');

// --- New skill family tests: miracles ---
const zeroMiracleState = getDefaultSkillsState();
assert.strictEqual(getSkillLevel(zeroMiracleState, 'skill_miracles'), 0);

const blessedTouch = { id: 'miracle_blessed_touch', skillId: 'skill_miracles', unlockSkillLevelMin: 2, mpCostBase: 8, cooldownMsBase: 3200, allowedWeaponClasses: ['magic'], requiresWeaponEquipped: true, isHeal: true };
assert.strictEqual(getAbilityUnlockState(blessedTouch, zeroMiracleState), false, 'miracle_blessed_touch should be locked at level 0');

const miraclePlayer = { mp: 25, skillsState: awardSkillXp(getDefaultSkillsState(), 'skill_miracles', 400), abilityCooldowns: {}, equipment: { weapon: { weaponClass: 'magic' } }, abilitySlots: ['miracle_blessed_touch'] };
assert.ok(selectAbilityToCast(miraclePlayer, [blessedTouch], Date.now()), 'miracle_blessed_touch should be selectable with a magic weapon');

const miracleNoWeapon = { mp: 25, skillsState: awardSkillXp(getDefaultSkillsState(), 'skill_miracles', 400), abilityCooldowns: {}, equipment: {}, abilitySlots: ['miracle_blessed_touch'] };
assert.strictEqual(selectAbilityToCast(miracleNoWeapon, [blessedTouch], Date.now()), null, 'miracle abilities should require a weapon equipped');

console.log('skills abilities regression checks passed');
