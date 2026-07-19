// Mirrors emitPartyDeltas' enemy handling after the trim: the FIRST time an enemy
// is seen on the gameDelta channel it ships a COMPLETE snapshot ({ ...enemy }),
// but subsequent emits carry only ENEMY_DELTA_FIELDS + id + isDead (no name /
// level / stats). This guards Step 2 of the gameDelta trim — combat HP ticks
// must not re-ship the full enemy object every ~70ms.
//
// The "seen" set is seeded by dungeonChange / combatStart (full snapshot already
// delivered via a different channel), so a mid-combat gameDelta emitter starts in
// the partial path but still must NOT drop a brand-new enemy to a nameless partial.

const assert = require('assert');
const { extractDelta } = require('../utilities/deltaTracker');

const ENEMY_DELTA_FIELDS = ['hp', 'maxHp', 'ap', 'maxAp', 'mp', 'maxMp'];
const enemyLastState = new Map();
const enemyFullSent = new Set();

function getEnemyDelta(enemyId, enemy) {
    const lastState = enemyLastState.get(enemyId) || {};
    const delta = extractDelta(lastState, enemy, ENEMY_DELTA_FIELDS);
    const wasDead = lastState.hp !== undefined && lastState.hp <= 0;
    const isDead = enemy.hp <= 0;
    if (wasDead !== isDead) delta.isDead = isDead;
    if (Object.keys(delta).length === 0) return null;
    enemyLastState.set(enemyId, { ...enemy });
    return delta;
}

function collectEnemyUpdate(enemy) {
    const delta = getEnemyDelta(enemy.id, enemy);
    if (!delta) return null;
    if (enemyFullSent.has(enemy.id)) {
        return { id: enemy.id, isDead: enemy.hp <= 0, ...delta };
    }
    enemyFullSent.add(enemy.id);
    return { ...enemy, id: enemy.id, isDead: enemy.hp <= 0 };
}

// --- First sight: full snapshot ------------------------------------------------
const enemy = { id: 'e1', name: '🧫Slime', level: 1, hp: 50, maxHp: 50, ap: 0, maxAp: 30, str: 5, dex: 5, vit: 5 };
let u = collectEnemyUpdate(enemy);
assert.ok(u.name === '🧫Slime', 'first emit is a full snapshot (name present)');
assert.ok(u.str === 5, 'first emit carries stats (full snapshot)');
assert.ok(u.level === 1, 'first emit carries level (full snapshot)');

// --- Subsequent: partial --------------------------------------------------------
enemy.hp = 30;
u = collectEnemyUpdate(enemy);
assert.strictEqual(u.hp, 30, 'partial carries changed hp');
assert.strictEqual(u.isDead, false, 'partial carries isDead');
assert.ok(u.name === undefined, 'partial MUST NOT carry name');
assert.ok(u.str === undefined, 'partial MUST NOT carry str');
assert.ok(u.level === undefined, 'partial MUST NOT carry level');

// --- Seeded seen-set (dungeonChange already sent full): first gameDelta is partial
enemyFullSent.clear();
enemyLastState.clear();
enemyFullSent.add('e1'); // simulate dungeonChange seeding
const e2 = { id: 'e1', name: '🧫Slime', level: 1, hp: 40, maxHp: 50, ap: 0, maxAp: 30 };
const u2 = collectEnemyUpdate(e2);
assert.ok(u2.name === undefined, 'seeded enemy must not re-send full snapshot on gameDelta');
assert.strictEqual(u2.hp, 40, 'seeded partial carries hp');

// --- Brand-new enemy not yet seen: must be full (name present) ------------------
enemyFullSent.clear();
enemyLastState.clear();
const e3 = { id: 'e_spawned', name: '🦇Bat', level: 2, hp: 25, maxHp: 25, ap: 0, maxAp: 20 };
const u3 = collectEnemyUpdate(e3);
assert.ok(u3.name === '🦇Bat', 'brand-new enemy mid-combat must arrive as full snapshot (name)');

console.log('PASS test_enemyPartialDelta: first enemy full, subsequent partial (no name/stats)');
