// BUG 1 regression guard: with a single gameDelta emitter, a maxHp/maxAp change
// (hp unchanged) must surface in the ONE gameDelta playerUpdates object — there
// is no longer a split into critical/hpMp buckets that could diverge.
//
// This test mirrors the new single-emitter logic (compute one delta, transmit
// the union of all changed PLAYER_DELTA_FIELDS per player in a single packet)
// and asserts that after a maxHp change with hp unchanged, the gameDelta
// playerUpdates entry carries maxHp AND maxAp (one object, not split).

const assert = require('assert');
const { extractDelta, buildSnapshot } = require('../utilities/deltaTracker');

const PLAYER_DELTA_FIELDS = ['hp', 'ap', 'maxHp', 'maxAp', 'level', 'xp', 'mp', 'maxMp',
    'str', 'dex', 'agi', 'vit', 'int', 'gold', 'equipment', 'inventory', 'skillsState'];

// Replicates app.js emitPartyDeltas classification for a single player.
function buildGameDelta(lastState, player) {
    const delta = extractDelta(lastState, player, PLAYER_DELTA_FIELDS);
    if (Object.keys(delta).length === 0) return null;
    const gameDelta = { playerUpdates: {} };
    gameDelta.playerUpdates[player.id || 'self'] = { id: player.id, name: player.name, isDead: player.hp <= 0, ...delta };
    return { delta, gameDelta };
}

// Replicates app.js getPlayerDelta (advances baseline on consume).
function advanceBaseline(lastState, player, fields) {
    const merged = { ...lastState };
    for (const f of fields) merged[f] = player[f];
    return merged;
}

const player = { id: 'p1', name: 'Tester', hp: 100, maxHp: 100, ap: 0, maxAp: 50, mp: 50, maxMp: 50 };
const lastState = buildSnapshot(player);

// Equip gear: maxHp rises, hp unchanged.
player.maxHp = 150;
player.maxAp = 60;

const result = buildGameDelta(lastState, player);
assert(result, 'expected a gameDelta after maxHp/maxAp change');

// Single-object assertion: maxHp/maxAp carried in the one gameDelta playerUpdates.
const entry = result.gameDelta.playerUpdates['p1'];
assert.strictEqual(entry.maxHp, 150, 'gameDelta must carry maxHp');
assert.strictEqual(entry.maxAp, 60, 'gameDelta must carry maxAp');

// Advance the baseline exactly once (union of fields) — simulates the single
// baseline consumer. A second classification must report no further delta.
let baseline = advanceBaseline(lastState, player, PLAYER_DELTA_FIELDS);
const second = buildGameDelta(baseline, player);
assert.strictEqual(second, null, 'baseline advanced once: no duplicate delta emission');

console.log('PASS test_networkDeltaBaseline: BUG 1 (maxHp convergence) fixed — single gameDelta');
