// Unit test for ClientNetwork.handleStandardUpdate.
//
// The browser class is loaded in a vm sandbox with stubbed io/window/document
// globals so we can instantiate it headlessly and drive handleStandardUpdate
// directly. Guards against regressions in the network update-frequency refactor,
// specifically:
//   1. A standardUpdate flipping combatActive true -> false clears stale enemies.
//   2. autoEmbark on a standardUpdate is reflected in currentState + lastKnownState.
//   3. floor + combatTurn are applied (regression: an earlier edit returned early
//      and dropped these fields).
//   4. A normal combat-active standardUpdate does NOT wipe enemies.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Load the browser source without executing browser-only globals.
const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'clientNetwork.js'), 'utf8');

function makeSandbox() {
    const calls = { updatePartyDisplay: 0 };
    const sandbox = {
        // io() is called in the constructor; return a no-op socket stub.
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
        // Capture updatePartyDisplay calls so we can assert it was invoked.
        __calls: calls,
    };
    sandbox.global = sandbox;
    return { sandbox, calls };
}

function createClient() {
    const { sandbox, calls } = makeSandbox();
    vm.createContext(sandbox);
    // Evaluate the class declaration in the sandbox, then expose the class.
    vm.runInContext(`${src}\n; global.__ClientNetwork = ClientNetwork;`, sandbox);
    const ClientNetwork = sandbox.__ClientNetwork;
    const client = new ClientNetwork({
        updatePartyDisplay: () => { calls.updatePartyDisplay++; },
    });
    // Seed a realistic in-combat state so we can observe transitions.
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
    client.handleStandardUpdate({ combatActive: false });
    assert.strictEqual(client.currentState.combatActive, false, 'combatActive should be false');
    assert.strictEqual(client.lastKnownState.party.combatActive, false, 'lastKnownState.party.combatActive should be false');
    assert.ok(Array.isArray(client.currentState.enemies) && client.currentState.enemies.length === 0, 'enemies should be cleared when combat ends');
    assert.strictEqual(client.lastKnownState.enemies.size, 0, 'lastKnownState.enemies should be cleared');
}

// --- Test 2: autoEmbark reflected in currentState + lastKnownState -------------
{
    const { client } = createClient();
    client.handleStandardUpdate({ autoEmbark: true });
    assert.strictEqual(client.currentState.autoEmbark, true, 'currentState.autoEmbark should be true');
    assert.strictEqual(client.lastKnownState.party.autoEmbark, true, 'lastKnownState.party.autoEmbark should be true');
    // autoEmbark alone must not wipe enemies (still in combat here).
    assert.strictEqual(client.currentState.enemies.length, 2, 'autoEmbark update must not clear enemies');
}

// --- Test 3: regression guard - floor + combatTurn still applied --------------
{
    const { client } = createClient();
    client.handleStandardUpdate({ floor: 7, combatTurn: 9 });
    assert.strictEqual(client.currentState.floor, 7, 'floor should be updated');
    assert.strictEqual(client.currentState.combatTurn, 9, 'combatTurn should be updated');
}

// --- Test 4: normal combat-active update keeps enemies -------------------------
{
    const { client } = createClient();
    client.handleStandardUpdate({
        playerUpdates: {
            p1: { id: 'p1', hp: 90, maxHp: 100 },
        },
        enemyUpdates: {
            e1: { id: 'e1', hp: 10, maxHp: 50 },
        },
    });
    assert.strictEqual(client.currentState.combatActive, true, 'combatActive stays true');
    assert.strictEqual(client.currentState.enemies.length, 2, 'enemies preserved on normal update');
    assert.strictEqual(client.currentState.players[0].hp, 90, 'player hp delta applied');
    assert.strictEqual(client.currentState.enemies[0].hp, 10, 'enemy hp delta applied');
}

// --- Test 5: enemies array in payload is adopted ------------------------------
{
    const { client } = createClient();
    client.handleStandardUpdate({ combatActive: false, enemies: [{ id: 'e3', name: 'Wisp', hp: 5, maxHp: 5 }] });
    assert.strictEqual(client.currentState.enemies.length, 1, 'explicit enemies payload should be adopted');
    assert.strictEqual(client.currentState.enemies[0].id, 'e3', 'adopted enemy should be the new one');
}

// --- Test 6: updatePartyDisplay is invoked on every standard update ------------
{
    const { client, calls } = createClient();
    const before = calls.updatePartyDisplay;
    client.handleStandardUpdate({ autoEmbark: true });
    assert.ok(calls.updatePartyDisplay > before, 'updatePartyDisplay should be called by handleStandardUpdate');
}

console.log('handleStandardUpdate checks passed');
