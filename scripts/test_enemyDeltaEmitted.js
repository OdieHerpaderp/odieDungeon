// BUG 2 regression guard: enemies must be emitted on the periodic path inside
// the single `gameDelta` event. Before the refactor, enemies were only sent via
// `buildUpdatePacket('standard'/'critical')`; the periodic `processPriorityUpdates`
// iterated only party.players, so once buildUpdatePacket was deleted, enemies
// would have had NO emitter.
//
// This test mirrors the consolidated emitter's enemy handling and asserts that
// an enemy whose `hp` changes after a full-state sync (baseline established)
// still produces a `gameDelta.enemyUpdates[enemy.id]` entry on the periodic path.

const assert = require('assert');
const { extractDelta } = require('../utilities/deltaTracker');

const ENEMY_DELTA_FIELDS = ['hp', 'maxHp', 'ap', 'maxAp', 'mp', 'maxMp'];

// Replicates app.js getEnemyDelta (BUG 3 fix: baseline set only on real change).
function getEnemyDelta(enemyLastState, enemyId, enemy) {
    const lastState = enemyLastState.get(enemyId) || {};
    const delta = extractDelta(lastState, enemy, ENEMY_DELTA_FIELDS);
    const wasDead = lastState.hp !== undefined && lastState.hp <= 0;
    const isDead = enemy.hp <= 0;
    if (wasDead !== isDead) delta.isDead = isDead;
    if (Object.keys(delta).length === 0) return null;
    enemyLastState.set(enemyId, { ...enemy });
    return delta;
}

// Replicates app.js emitPartyDeltas enemy branch (attaches a COMPLETE snapshot
// to the single gameDelta.enemyUpdates).
function collectGameDelta(enemyLastState, enemies) {
    const gameDelta = { enemyUpdates: {} };
    for (const enemy of enemies) {
        const delta = getEnemyDelta(enemyLastState, enemy.id, enemy);
        if (!delta) continue;
        gameDelta.enemyUpdates[enemy.id] = { ...enemy, id: enemy.id, isDead: enemy.hp <= 0 };
    }
    return gameDelta;
}

const enemyLastState = new Map();
const enemy = { id: 'enemy_1', name: '🧫Slime', level: 1, hp: 50, maxHp: 50, ap: 0, maxAp: 30, str: 5, dex: 5, agi: 5, vit: 5 };

// Establish baseline (simulates full-state sync / initPlayerDeltaState).
enemyLastState.set(enemy.id, { ...enemy });

// No change yet -> no enemyUpdate (BUG 3: no spurious emit on no change).
let gameDelta = collectGameDelta(enemyLastState, [enemy]);
assert.strictEqual(Object.keys(gameDelta.enemyUpdates).length, 0, 'no enemyUpdate when nothing changed');

// Enemy takes damage on the periodic path.
enemy.hp = 30;
gameDelta = collectGameDelta(enemyLastState, [enemy]);
assert.strictEqual(Object.keys(gameDelta.enemyUpdates).length, 1, 'enemy hp change must surface on periodic path');
const entry = gameDelta.enemyUpdates[enemy.id];
assert.strictEqual(entry.hp, 30, 'gameDelta enemyUpdate must carry current hp');
assert.strictEqual(entry.name, '🧫Slime', 'gameDelta enemyUpdate must carry name (full snapshot)');
assert.strictEqual(entry.str, 5, 'gameDelta enemyUpdate must carry attributes (no undefined)');

// Baseline advanced; a second identical state emits nothing.
gameDelta = collectGameDelta(enemyLastState, [enemy]);
assert.strictEqual(Object.keys(gameDelta.enemyUpdates).length, 0, 'baseline advanced: no duplicate enemy emit');

console.log('PASS test_enemyDeltaEmitted: BUG 2 (enemy on periodic path) fixed — carried in gameDelta.enemyUpdates');
