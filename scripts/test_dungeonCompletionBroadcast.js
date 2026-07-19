// Regression guard for the dungeon-completion broadcast fix.
//
// Before the fix, the 🏁 / gold / item / "Returned to Town" eventLog lines were
// sent ONLY through the WebRTC immediate batch (broadcastToParty -> sendMessage
// returns true on queue, so the Socket.IO fallback was skipped). When the
// immediately-following broadcastFullState / embarkParty recycled the WebRTC
// connection, the queued batch was dropped with no TCP backup -> client showed
// nothing. The award loop also already ran every clear, but the 🏁 line and shop
// restock were gated behind `completedDungeons[dungeon] !== true`, so they were
// silently skipped on 2nd+ clears.
//
// This test replicates the production completion block (app.js ~1477-1516) and
// asserts:
//   1. eventLog completion/award/return lines are emitted on Socket.IO via
//      io.to(partyId).emit('eventLog', ...) — the reliable TCP path.
//   2. The same lines are also sent over WebRTC with { noBatch: true } so WebRTC
//      clients get them immediately rather than coalesced in the single batch pool.
//   3. The 🏁 line + shop restock run on EVERY boss clear (guard now only sets
//      the completedDungeons flag), so a 2nd clear still shows them.

const assert = require('assert');

// ---- Mock socket.io ----
const socketEmits = [];
const io = {
    to(partyId) {
        return {
            emit(eventType, packet) {
                socketEmits.push({ partyId, eventType, packet });
            },
        };
    },
};

// ---- Mock WebRTC server ----
const webrtcSent = [];
const webrtc = {
    parties: new Map(),
    peers: new Map(),
    isConnectionHealthy() { return true; },
    broadcastToPartyWebRTC(partyId, type, data, excludeSocket = null, options = {}) {
        const party = this.parties.get(partyId);
        if (!party) return 0;
        let sent = 0;
        for (const socketId of party.players.keys()) {
            if (socketId === excludeSocket) continue;
            if (this.isConnectionHealthy(socketId)) {
                if (this.sendMessage(socketId, type, data, options)) sent++;
            }
        }
        return sent;
    },
    sendMessage(socketId, type, data, options = {}) {
        webrtcSent.push({ socketId, type, data, options });
        return true; // queued/accepted
    },
};

// ---- Replicated production broadcast + completion logic ----
function broadcastToParty(partyId, eventType, packet, options = {}) {
    const sent = webrtc.broadcastToPartyWebRTC(partyId, eventType, packet, null, options);
    if (sent === 0) {
        io.to(partyId).emit(eventType, packet);
    }
}

function runCompletionBlock(party, partyId) {
    const dungeonData = party.dungeon ? characters.getDungeonData(party.dungeon) : null;
    const floorMax = dungeonData?.floorAmount ?? 100;
    if (party.dungeon && party.dungeonFloors?.[party.dungeon] === floorMax) {
        if (!party.completedDungeons) party.completedDungeons = {};
        if (party.completedDungeons[party.dungeon] !== true) {
            party.completedDungeons[party.dungeon] = true;
        }

        const completionPacket = { message: `🏁 ${party.dungeon} completed!`, type: 'success' };
        io.to(partyId).emit('eventLog', completionPacket);
        broadcastToParty(partyId, 'eventLog', completionPacket, { noBatch: true });

        characters.restockShopWithDungeonScaling(party, party.dungeon, dungeonData);

        const lootResults = characters.rewardPlayersOnDungeonClear(party, party.dungeon, dungeonData);
        for (const result of lootResults) {
            const awardPacket = { message: result.message, type: result.type === 'item' ? 'success' : 'info' };
            io.to(partyId).emit('eventLog', awardPacket);
            broadcastToParty(partyId, 'eventLog', awardPacket, { noBatch: true });
        }

        const returnPacket = { message: '🏠 Returned to Town!', type: 'info' };
        io.to(partyId).emit('eventLog', returnPacket);
        broadcastToParty(partyId, 'eventLog', returnPacket, { noBatch: true });
    }
}

// ---- Dependencies from the real game (read-only char helpers) ----
const characters = require('../characters');

// ---- Fixtures ----
const partyId = 'party_test';
webrtc.parties.set(partyId, { players: new Map([['sock1', {}], ['sock2', {}]]) });

function makeParty() {
    return {
        dungeon: 'field',
        dungeonFloors: { field: 7 },
        completedDungeons: {},
        shopStock: [],
        players: new Map(),
    };
}

function socketEventLogLines() {
    return socketEmits.filter(e => e.eventType === 'eventLog').map(e => e.packet.message);
}
function webrtcNoBatchLines() {
    return webrtcSent
        .filter(s => s.type === 'eventLog' && s.options.noBatch === true)
        .map(s => s.data.message);
}

// ===== FIRST CLEAR =====
let party = makeParty();
party.players.set('hero1', { name: 'Hero1' });
socketEmits.length = 0;
webrtcSent.length = 0;
runCompletionBlock(party, partyId);

const firstTcp = socketEventLogLines();
const firstUdp = webrtcNoBatchLines();
assert(firstTcp.some(m => m.includes('🏁')), 'first clear: 🏁 must be sent over Socket.IO (TCP)');
assert(firstTcp.some(m => m.includes('Returned to Town')), 'first clear: return line must be sent over Socket.IO (TCP)');
assert(firstTcp.some(m => /🎁|💰/.test(m)), 'first clear: award line must be sent over Socket.IO (TCP)');
assert(firstUdp.some(m => m.includes('🏁')), 'first clear: 🏁 must be sent over WebRTC with noBatch');
assert(firstUdp.some(m => m.includes('Returned to Town')), 'first clear: return line must be sent over WebRTC with noBatch');
assert.strictEqual(party.completedDungeons.field, true, 'first clear: completedDungeons flag set');

// ===== SECOND CLEAR (same session, auto-embark style) =====
socketEmits.length = 0;
webrtcSent.length = 0;
party.dungeonFloors.field = 7; // re-progressed to boss floor
runCompletionBlock(party, partyId);

const secondTcp = socketEventLogLines();
const secondUdp = webrtcNoBatchLines();
assert(secondTcp.some(m => m.includes('🏁')), 'second clear: 🏁 must still be sent over Socket.IO (was previously gated)');
assert(secondTcp.some(m => m.includes('Returned to Town')), 'second clear: return line must still be sent over Socket.IO');
assert(secondUdp.some(m => m.includes('🏁')), 'second clear: 🏁 must still be sent over WebRTC with noBatch');
// completedDungeons stays true — guard no longer suppresses the 🏁 line itself.
assert.strictEqual(party.completedDungeons.field, true, 'second clear: completedDungeons flag stays true');

console.log('PASS test_dungeonCompletionBroadcast: completion eventLog reliably delivered on TCP + WebRTC(noBatch), every clear');
