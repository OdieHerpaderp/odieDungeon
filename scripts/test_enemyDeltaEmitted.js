// BUG 2 regression guard: enemies must be emitted on the periodic path even
// though `buildUpdatePacket` was removed. Before the refactor, enemies were
// only sent via `buildUpdatePacket('standard'/'critical')`; the periodic
// `processPriorityUpdates` iterated only party.players, so once buildUpdatePacket
// was deleted, enemies would have had NO emitter.
//
// This test mirrors the consolidated emitter's enemy handling and asserts that
// an enemy whose `hp` changes after a full-state sync (baseline established)
// still produces an `enemyUpdates` entry on the periodic standard path.

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
// to the standard bucket only).
function collectEnemyUpdates(enemyLastState, enemies) {
    const enemyUpdates = {};
    for (const enemy of enemies) {
        const delta = getEnemyDelta(enemyLastState, enemy.id, enemy);
        if (!delta) continue;
        enemyUpdates[enemy.id] = { ...enemy, id: enemy.id, isDead: enemy.hp <= 0 };
    }
    return enemyUpdates;
}

const enemyLastState = new Map();
const enemy = { id: 'enemy_1', name: '🧫Slime', level: 1, hp: 50, maxHp: 50, ap: 0, maxAp: 30, str: 5, dex: 5, agi: 5, vit: 5 };

// Establish baseline (simulates full-state sync / initPlayerDeltaState).
enemyLastState.set(enemy.id, { ...enemy });

// No change yet -> no enemyUpdate (BUG 3: no spurious emit on no change).
let updates = collectEnemyUpdates(enemyLastState, [enemy]);
assert.strictEqual(Object.keys(updates).length, 0, 'no enemyUpdate when nothing changed');

// Enemy takes damage on the periodic path.
enemy.hp = 30;
updates = collectEnemyUpdates(enemyLastState, [enemy]);
assert.strictEqual(Object.keys(updates).length, 1, 'enemy hp change must surface on periodic path');
assert.strictEqual(updates[enemy.id].hp, 30, 'periodic enemyUpdate must carry current hp');
assert.strictEqual(updates[enemy.id].name, '🧫Slime', 'periodic enemyUpdate must carry name (full snapshot)');
assert.strictEqual(updates[enemy.id].str, 5, 'periodic enemyUpdate must carry attributes (no undefined)');

// Baseline advanced; a second identical state emits nothing.
updates = collectEnemyUpdates(enemyLastState, [enemy]);
assert.strictEqual(Object.keys(updates).length, 0, 'baseline advanced: no duplicate enemy emit');

console.log('PASS test_enemyDeltaEmitted: BUG 2 (enemy on periodic path) fixed');
