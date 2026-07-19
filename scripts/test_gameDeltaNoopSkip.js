// Mirrors emitPartyDeltas' no-op decision: with established baselines and no
// change anywhere (players, enemies, party-level fields), the gameDelta packet
// is skipped entirely — broadcastToParty is NOT called.
//
// This guards Step 3 of the gameDelta trim: idle / in-town ticks must not ship
// an empty-ish gameDelta every ~70ms.

const assert = require('assert');
const { extractDelta, buildSnapshot } = require('../utilities/deltaTracker');
const { deepEqual } = require('../utils');

const PLAYER_DELTA_FIELDS = ['hp', 'ap', 'maxHp', 'maxAp', 'level', 'xp', 'mp', 'maxMp', 'str'];
const ENEMY_DELTA_FIELDS = ['hp', 'maxHp', 'ap', 'maxAp', 'mp', 'maxMp'];
const PARTY_DELTA_FIELDS = ['combatActive', 'combatTurn', 'floor', 'dungeon',
    'dungeonFloors', 'highestVisitedFloors', 'completedDungeons', 'autoEmbark'];

const playerLastState = new Map();
const enemyLastState = new Map();
const partyLastState = new Map();

function getPlayerDelta(socketId, player, consumeFields) {
    const lastState = playerLastState.get(socketId) || {};
    const delta = extractDelta(lastState, player, PLAYER_DELTA_FIELDS);
    if (Object.keys(delta).length === 0) return null;
    if (consumeFields) {
        const merged = { ...lastState };
        for (const f of consumeFields) merged[f] = player[f];
        playerLastState.set(socketId, merged);
    }
    return delta;
}

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

// Replicates emitPartyDeltas, returning null when the packet would be skipped.
function emitPartyDeltas(partyId, party) {
    const delta = { partyId, timestamp: Date.now(), playerUpdates: {}, enemyUpdates: {} };

    const partyPrev = partyLastState.get(partyId) || {};
    const partyNext = {};
    let partyDirty = false;
    for (const f of PARTY_DELTA_FIELDS) {
        const cur = party[f] !== undefined ? party[f] : (['dungeonFloors', 'highestVisitedFloors', 'completedDungeons'].includes(f) ? {} : undefined);
        const prev = partyPrev[f] !== undefined ? partyPrev[f] : (['dungeonFloors', 'highestVisitedFloors', 'completedDungeons'].includes(f) ? {} : undefined);
        partyNext[f] = cur;
        if (deepEqual(cur, prev)) continue;
        delta[f] = cur;
        partyDirty = true;
    }

    for (const [socketId, player] of party.players) {
        const playerDelta = getPlayerDelta(socketId, player, PLAYER_DELTA_FIELDS);
        if (!playerDelta) continue;
        delta.playerUpdates[socketId] = { id: socketId, name: player.name, isDead: player.hp <= 0, ...playerDelta };
    }

    if (party.enemies?.length) {
        for (const enemy of party.enemies) {
            const enemyDelta = getEnemyDelta(enemy.id, enemy);
            if (!enemyDelta) continue;
            delta.enemyUpdates[enemy.id] = { id: enemy.id, isDead: enemy.hp <= 0, ...enemyDelta };
        }
    }

    if (!partyDirty && Object.keys(delta.playerUpdates).length === 0 && Object.keys(delta.enemyUpdates).length === 0) {
        return null;
    }
    partyLastState.set(partyId, partyNext);
    return delta;
}

// --- Setup: establish baselines so a repeat tick should emit nothing -----------
const party = {
    partyId: 'P1',
    combatActive: false,
    combatTurn: 0,
    floor: 0,
    dungeon: 'town',
    dungeonFloors: { cave: 3 },
    highestVisitedFloors: { cave: 3 },
    completedDungeons: { cave: true },
    autoEmbark: false,
    players: new Map([['p1', { id: 'p1', name: 'Tester', hp: 100, maxHp: 100, ap: 0, maxAp: 50, mp: 50, maxMp: 50, level: 5, xp: 0, str: 10 }]]),
    enemies: [],
};
playerLastState.set('p1', buildSnapshot(party.players.get('p1')));
partyLastState.set('P1', {});

// First emit produces a packet (party fields differ from empty baseline).
let first = emitPartyDeltas('P1', party);
assert.ok(first, 'first emit should produce a packet');
assert.strictEqual(first.combatActive, false, 'first emit carries combatActive');

// Second emit with no change must be skipped entirely.
let second = emitPartyDeltas('P1', party);
assert.strictEqual(second, null, 'no-op tick must skip the gameDelta packet');

// A single player hp change flips it back to emitting.
party.players.get('p1').hp = 90;
let third = emitPartyDeltas('P1', party);
assert.ok(third, 'player hp change must re-enable the packet');
assert.strictEqual(third.playerUpdates.p1.hp, 90, 'player delta carried');
assert.strictEqual(third.combatActive, undefined, 'unchanged party field omitted');

console.log('PASS test_gameDeltaNoopSkip: no-op gameDelta packets are skipped');
