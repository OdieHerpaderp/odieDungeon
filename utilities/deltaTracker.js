const { deepEqual } = require('../utils');

const PLAYER_FIELDS = [
    'hp', 'ap', 'maxHp', 'maxAp',
    'level', 'xp', 'xpToNext', 'gold', 'mp', 'maxMp',
    'pointsToAllocate', 'abilityCooldowns',
    'str', 'dex', 'agi', 'vit', 'int', 'cnc', 'wis', 'for', 'luk', 'pie',
    'equipment', 'inventory', 'armor', 'weapon', 'actionBar', 'maxActionBar',
    'currentVenture', 'effects'
];

const ENEMY_FIELDS = ['hp', 'maxHp', 'ap', 'maxAp', 'mp', 'maxMp', 'actionBar', 'maxActionBar', 'isDead'];

function buildSnapshot(entity) {
    const snapshot = { ...entity };
    if (entity.abilityCooldowns) snapshot.abilityCooldowns = { ...entity.abilityCooldowns };
    if (entity.equipment) snapshot.equipment = { ...entity.equipment };
    if (Array.isArray(entity.inventory)) snapshot.inventory = [...entity.inventory];
    if (entity.skillsState) snapshot.skillsState = { ...entity.skillsState };
    return snapshot;
}

function extractDelta(lastState, current, fields) {
    const delta = {};
    for (const f of fields) {
        if (current[f] !== undefined && !deepEqual(current[f], lastState[f])) {
            delta[f] = current[f];
        }
    }
    return delta;
}

module.exports = { PLAYER_FIELDS, ENEMY_FIELDS, buildSnapshot, extractDelta };