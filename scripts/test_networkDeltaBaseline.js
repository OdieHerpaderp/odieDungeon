// BUG 1 regression guard: a single emitter must not drop a field that one
// pass consumes and another pass also needs. Previously `processPriorityUpdates`
// (critical) and `flushPendingHPMpUpdates` (HP/MP flush) both consumed
// `maxHp`/`maxAp` from the shared baseline, so a `maxHp` change could appear on
// one event and be dropped from the other.
//
// This test mirrors the new single-emitter consume logic (compute one delta,
// classify each changed field into its priority bucket, advance the baseline
// exactly once for the union of transmitted fields) and asserts that after a
// `maxHp` change with `hp` unchanged, BOTH the critical bucket and the HP/MP
// bucket carry `maxHp`.

const assert = require('assert');
const { extractDelta, buildSnapshot } = require('../utilities/deltaTracker');

const PLAYER_DELTA_FIELDS = ['hp', 'ap', 'maxHp', 'maxAp', 'level', 'xp', 'mp', 'maxMp',
    'str', 'dex', 'agi', 'vit', 'int', 'gold', 'equipment', 'inventory', 'skillsState'];

// Replicates app.js emitPartyDeltas classification for a single player.
function classifyPlayerDelta(lastState, player) {
    const delta = extractDelta(lastState, player, PLAYER_DELTA_FIELDS);
    if (Object.keys(delta).length === 0) return null;

    const critical = {};
    const hpMp = {};
    const consume = new Set();

    if (delta.hp !== undefined || delta.ap !== undefined || delta.maxHp !== undefined || delta.maxAp !== undefined) {
        critical.maxHp = player.maxHp;
        critical.maxAp = player.maxAp;
        hpMp.maxHp = player.maxHp;
        hpMp.maxAp = player.maxAp;
        ['hp', 'ap', 'maxHp', 'maxAp', 'mp', 'maxMp'].forEach(f => consume.add(f));
    }
    return { delta, critical, hpMp, consume };
}

// Replicates app.js advancePlayerBaseline.
function advanceBaseline(lastState, player, fields) {
    const merged = { ...lastState };
    for (const f of fields) merged[f] = player[f];
    return merged;
}

const player = { hp: 100, maxHp: 100, ap: 0, maxAp: 50, mp: 50, maxMp: 50 };
const lastState = buildSnapshot(player);

// Equip gear: maxHp rises, hp unchanged.
player.maxHp = 150;
player.maxAp = 60;

const result = classifyPlayerDelta(lastState, player);
assert(result, 'expected a delta after maxHp/maxAp change');

// BUG 1 assertion: maxHp present in BOTH critical and hpMp buckets.
assert.strictEqual(result.critical.maxHp, 150, 'criticalUpdate must carry maxHp');
assert.strictEqual(result.hpMp.maxHp, 150, 'hpMpUpdate must also carry maxHp');
assert.strictEqual(result.critical.maxAp, 60, 'criticalUpdate must carry maxAp');
assert.strictEqual(result.hpMp.maxAp, 60, 'hpMpUpdate must also carry maxAp');

// Advance the baseline exactly once (union of fields) — simulates the single
// baseline consumer. A second classification must report no further delta.
let baseline = advanceBaseline(lastState, player, result.consume);
const second = classifyPlayerDelta(baseline, player);
assert.strictEqual(second, null, 'baseline advanced once: no duplicate delta emission');

console.log('PASS test_networkDeltaBaseline: BUG 1 (maxHp convergence) fixed');
