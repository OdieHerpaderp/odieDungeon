// Unit test for ClientNetwork.handleGameDelta (the single coalesced state channel).
//
// The browser class is loaded in a vm sandbox with stubbed io/window/document
// globals so we can instantiate it headlessly and drive handleGameDelta
// directly. Guards against regressions in the singular-networking refactor,
// specifically:
//   1. A gameDelta flipping combatActive true -> false clears stale enemies.
//   2. autoEmbark on a gameDelta is reflected in currentState + lastKnownState.
//   3. floor + combatTurn + dungeon fields are applied.
//   4. A normal combat-active gameDelta does NOT wipe enemies.
//   5. enemyUpdates (full snapshot) are adopted via _upsertEnemy.
//   6. updatePartyDisplay is invoked when a real change is present.
//   7. An empty gameDelta (no player/enemy/party field) does NOT call updatePartyDisplay.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Load the browser source without executing browser-only globals.
const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'clientNetwork.js'), 'utf8');

function makeSandbox() {
    const calls = { updatePartyDisplay: 0 };
    const sandbox = {
        io: () => ({ on() {}, emit() {}, connect() {} }),
        window: {},
        performance: { now: () => Date.now() },
        requestAnimationFrame: () => 0,
        cancelAnimationFrame: () => {},
        document: { getElementById: () => null },
        console,
        Map,
        Set,
        Array,
        Object,
        Date,
        __calls: calls,
    };
    sandbox.global = sandbox;
    return { sandbox, calls };
}

function createClient() {
    const { sandbox, calls } = makeSandbox();
    vm.createContext(sandbox);
    vm.runInContext(`${src}\n; global.__ClientNetwork = ClientNetwork;`, sandbox);
    const ClientNetwork = sandbox.__ClientNetwork;
    const client = new ClientNetwork({
        updatePartyDisplay: () => { calls.updatePartyDisplay++; },
    });
    client.ownName = 'Tester';
    client.currentState = {
        floor: 3,
        combatActive: true,
        combatTurn: 2,
        autoEmbark: false,
        dungeon: 'cave',
        players: [
            { id: 'p1', name: 'Tester', hp: 100, maxHp: 100 },
            { id: 'p2', name: 'Ally', hp: 80, maxHp: 100 },
        ],
        enemies: [
            { id: 'e1', name: 'Goblin', hp: 40, maxHp: 50 },
            { id: 'e2', name: 'Orc', hp: 30, maxHp: 60 },
        ],
    };
    client.lastKnownState = {
        players: new Map([
            ['p1', { ...client.currentState.players[0] }],
            ['p2', { ...client.currentState.players[1] }],
        ]),
        enemies: new Map([
            ['e1', { ...client.currentState.enemies[0] }],
            ['e2', { ...client.currentState.enemies[1] }],
        ]),
        party: { combatActive: true, autoEmbark: false },
    };
    return { client, calls };
}

// --- Test 1: combatActive true -> false clears stale enemies -------------------
{
    const { client } = createClient();
    client.handleGameDelta({ combatActive: false });
    assert.strictEqual(client.currentState.combatActive, false, 'combatActive should be false');
    assert.strictEqual(client.lastKnownState.party.combatActive, false, 'lastKnownState.party.combatActive should be false');
    assert.ok(Array.isArray(client.currentState.enemies) && client.currentState.enemies.length === 0, 'enemies should be cleared when combat ends');
    assert.strictEqual(client.lastKnownState.enemies.size, 0, 'lastKnownState.enemies should be cleared');
}

// --- Test 2: autoEmbark reflected in currentState + lastKnownState -------------
{
    const { client } = createClient();
    client.handleGameDelta({ autoEmbark: true });
    assert.strictEqual(client.currentState.autoEmbark, true, 'currentState.autoEmbark should be true');
    assert.strictEqual(client.lastKnownState.party.autoEmbark, true, 'lastKnownState.party.autoEmbark should be true');
    // autoEmbark alone must not wipe enemies (still in combat here).
    assert.strictEqual(client.currentState.enemies.length, 2, 'autoEmbark update must not clear enemies');
}

// --- Test 3: regression guard - floor + combatTurn + dungeon still applied -----
{
    const { client } = createClient();
    client.handleGameDelta({ floor: 7, combatTurn: 9, dungeon: 'forest' });
    assert.strictEqual(client.currentState.floor, 7, 'floor should be updated');
    assert.strictEqual(client.currentState.combatTurn, 9, 'combatTurn should be updated');
    assert.strictEqual(client.currentState.dungeon, 'forest', 'dungeon should be updated');
}

// --- Test 4: normal combat-active update keeps enemies -------------------------
{
    const { client } = createClient();
    client.handleGameDelta({
        combatActive: true,
        playerUpdates: {
            p1: { id: 'p1', name: 'Tester', hp: 90, maxHp: 100 },
        },
        enemyUpdates: {
            e1: { id: 'e1', name: 'Goblin', hp: 10, maxHp: 50 },
        },
    });
    assert.strictEqual(client.currentState.combatActive, true, 'combatActive stays true');
    assert.strictEqual(client.currentState.enemies.length, 2, 'enemies preserved on normal update');
    assert.strictEqual(client.currentState.players[0].hp, 90, 'player hp delta applied');
    assert.strictEqual(client.currentState.enemies[0].hp, 10, 'enemy hp delta applied');
}

// --- Test 5: enemyUpdates full snapshot is adopted (new enemy) -----------------
{
    const { client } = createClient();
    client.handleGameDelta({ enemyUpdates: { e3: { id: 'e3', name: 'Wisp', hp: 5, maxHp: 5, ap: 0, maxAp: 30 } } });
    assert.strictEqual(client.currentState.enemies.length, 3, 'new enemy from enemyUpdates should be adopted');
    assert.strictEqual(client.currentState.enemies[2].id, 'e3', 'adopted enemy should be the new one');
}

// --- Test 6: updatePartyDisplay is invoked when a real change is present -------
{
    const { client, calls } = createClient();
    const before = calls.updatePartyDisplay;
    client.handleGameDelta({ autoEmbark: true });
    assert.ok(calls.updatePartyDisplay > before, 'updatePartyDisplay should be called by handleGameDelta on change');
}

// --- Test 7: empty gameDelta does NOT call updatePartyDisplay ------------------
{
    const { client, calls } = createClient();
    const before = calls.updatePartyDisplay;
    // A gameDelta with the no-op guard would never be emitted, but if it were
    // (empty player/enemy updates, no party fields), the client must not re-render.
    client.handleGameDelta({ partyId: 'P1', timestamp: Date.now(), playerUpdates: {}, enemyUpdates: {} });
    assert.strictEqual(calls.updatePartyDisplay, before, 'empty gameDelta must not call updatePartyDisplay');
}

console.log('handleGameDelta checks passed');
