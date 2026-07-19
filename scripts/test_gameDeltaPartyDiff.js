// Mirrors emitPartyDeltas' party-level diff: party-level fields appear in the
// gameDelta only on the tick they change (compared via deepEqual against the
// last sent baseline). This guards Step 1 of the gameDelta trim — the three map
// fields (dungeonFloors / highestVisitedFloors / completedDungeons) are large
// and change rarely, so they must not serialize every tick.

const assert = require('assert');
const { deepEqual } = require('../utils');

const PARTY_DELTA_FIELDS = ['combatActive', 'combatTurn', 'floor', 'dungeon',
    'dungeonFloors', 'highestVisitedFloors', 'completedDungeons', 'autoEmbark'];

const partyLastState = new Map();

const MAP_FIELDS = ['dungeonFloors', 'highestVisitedFloors', 'completedDungeons'];

// Replicates emitPartyDeltas party-diff + advance logic, returns { delta, next }.
function emitPartyFields(partyId, party) {
    const partyPrev = partyLastState.get(partyId) || {};
    const partyNext = {};
    const delta = {};
    for (const f of PARTY_DELTA_FIELDS) {
        const cur = party[f] !== undefined ? party[f] : (MAP_FIELDS.includes(f) ? {} : undefined);
        const prev = partyPrev[f] !== undefined ? partyPrev[f] : (MAP_FIELDS.includes(f) ? {} : undefined);
        partyNext[f] = cur;
        if (deepEqual(cur, prev)) continue;
        delta[f] = cur;
    }
    partyLastState.set(partyId, partyNext);
    return delta;
}

const party = {
    combatActive: false,
    combatTurn: 0,
    floor: 0,
    dungeon: 'town',
    dungeonFloors: { cave: 3 },
    highestVisitedFloors: { cave: 3 },
    completedDungeons: { cave: true },
    autoEmbark: false,
};

// First emit: every field differs from the empty baseline -> all present.
let d = emitPartyFields('P1', party);
for (const f of PARTY_DELTA_FIELDS) assert.ok(f in d, `field ${f} present on first emit`);

// Second emit, no change: nothing should be included.
d = emitPartyFields('P1', party);
for (const f of PARTY_DELTA_FIELDS) assert.ok(!(f in d), `field ${f} omitted when unchanged`);

// Change only floor: only floor should surface, the map fields stay omitted.
party.floor = 1;
d = emitPartyFields('P1', party);
assert.ok('floor' in d, 'floor present after change');
assert.strictEqual(d.floor, 1, 'floor value correct');
for (const f of ['dungeonFloors', 'highestVisitedFloors', 'completedDungeons', 'autoEmbark', 'combatActive', 'combatTurn', 'dungeon']) {
    assert.ok(!(f in d), `field ${f} still omitted after only floor changed`);
}

// Mutate a map field: it alone should surface (deep change detected).
party.dungeonFloors = { cave: 4, crypt: 1 };
d = emitPartyFields('P1', party);
assert.ok('dungeonFloors' in d, 'dungeonFloors present after deep change');
assert.deepStrictEqual(d.dungeonFloors, { cave: 4, crypt: 1 }, 'dungeonFloors value correct');
for (const f of ['highestVisitedFloors', 'completedDungeons']) {
    assert.ok(!(f in d), `field ${f} omitted when its map unchanged`);
}

console.log('PASS test_gameDeltaPartyDiff: party-level fields diffed, omitted when unchanged');
