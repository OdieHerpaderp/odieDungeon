// Interactive headless game client for odieDungeon.
// Joins a party, stays connected, tracks server state, and accepts commands
// from stdin so you can drive the character during a chat session.
//
// Usage: node scripts/joinGame.js [partyId] [name] [url]
//   partyId  default: test
//   name     default: KiloBot
//   url      default: http://localhost:25561
//
// Commands (type in the terminal while the script runs):
//   help                              show this list
//   status                            print current tracked state
//   embark [dungeon]                 embark on a dungeon (default: current/field)
//   change <dungeon>                 switch dungeon while in town
//   escape                           return to Town
//   auto [on|off]                    toggle auto-embark
//   allocate <stat> <points>         allocate stat points (str/dex/agi/vit/int/cnc/wis/for/luk/pie)
//   equip <slot> <itemId>            equip an inventory item
//   unequip <slot>                   unequip a slot (weapon/armour/helmet/shoes)
//   use <itemId>                     use a consumable
//   sell <itemId>                    sell an inventory item
//   buy <armour|weapon|weaponMelee|weaponRanged|weaponMagic|helmet|shoes|random>
//   buyshop <index>                  buy an item from the shop stock by index
//   ability <slotIndex> <abilityId>  assign an ability to a slot (0-7); abilityId empty to clear
//   donate                           donate 50 gold
//   leave                            leave the party and exit
//   latency                          print latency diagnostics (RTT + command round-trips)
//   ping                             send a one-off ping and measure round-trip time
//
// Note: combat is automated by the server (action-bar auto-attacks). This
// client only issues the player-driven commands above.
//
// WEBRTC TRANSPORT
// The server's broadcastToParty() prefers WebRTC for game broadcasts
// (dungeonChange, combatStart, critical/standard/background deltas, etc.) and
// only falls back to Socket.IO when no WebRTC peer exists for a socket. A pure
// Socket.IO client therefore misses those broadcasts while in combat. This
// script opens a wrtc data channel (same binding the server ships) to receive
// them, mirroring public/clientNetwork.js. If wrtc is unavailable the client
// transparently falls back to Socket.IO-only. Use `webrtc` to inspect the
// channel state.
//
// LATENCY DEBUGGING
// The client measures three latency signals to help diagnose input lag:
//   1. serverRTT   - server-measured round-trip time, pushed every 2s via the
//                    'pingUpdate' event (client ts -> server -> client).
//   2. commandRTT  - time from emitting a command until the server's resulting
//                    state change is observed (e.g. embark -> dungeonChange).
//   3. packetGap   - inter-arrival time between consecutive server packets.
// All timestamps use Date.now() (ms). Rolling samples keep min/avg/max.

const path = require('path');
const readline = require('readline');
const { io } = require(require.resolve('socket.io-client', { paths: [path.join(__dirname, '..')] }));

// WebRTC transport (optional). The server prefers WebRTC for game broadcasts
// (broadcastToParty -> WebRTC-first, Socket.IO fallback). A pure Socket.IO
// client therefore misses broadcasts like dungeonChange while in combat. We use
// the same `wrtc` native binding the server ships with to open a data channel
// and receive those broadcasts, mirroring public/clientNetwork.js.
let wrtc = null;
try {
  wrtc = require(require.resolve('wrtc', { paths: [path.join(__dirname, '..')] }));
} catch (e) {
  console.error('[webrtc] wrtc not available, falling back to Socket.IO only:', e.message);
}

const URL = process.argv[4] || 'http://localhost:25561';
const PARTY = process.argv[2] || 'test';
const NAME = process.argv[3] || 'KiloBot';

const socket = io(URL, { transports: ['websocket', 'polling'] });

// Local view of the game world, updated from server packets.
const state = {
  partyId: null,
  joined: false,
  player: null,            // our own player object (from joinedParty / full state)
  players: new Map(),      // id -> player
  enemies: [],
  floor: 0,
  dungeon: 'field',
  combatActive: false,
  autoEmbark: false,
  shopStock: [],
};

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: `${NAME}> ` });

// ── Latency instrumentation ──────────────────────────────────────────────
// Rolling sample accumulator: keeps count + min/avg/max for a named metric.
function makeSamples() {
  return { count: 0, sum: 0, min: Infinity, max: -Infinity };
}
function recordSample(bucket, value) {
  bucket.count++;
  bucket.sum += value;
  if (value < bucket.min) bucket.min = value;
  if (value > bucket.max) bucket.max = value;
}
function summarize(label, b) {
  if (!b || b.count === 0) return `${label}: no samples`;
  const avg = b.sum / b.count;
  return `${label}: n=${b.count} min=${b.min.toFixed(1)}ms avg=${avg.toFixed(1)}ms max=${b.max.toFixed(1)}ms`;
}

const latency = {
  serverRTT: makeSamples(),   // server-pushed RTT (pingUpdate)
  commandRTT: makeSamples(),   // command emit -> observed effect
  packetGap: makeSamples(),    // gap between consecutive server packets
  lastPacketAt: 0,
  lastServerRTT: 0,
  pendingCommands: new Map(),  // event -> { sentAt, label }
  oneOffPingId: null,
  oneOffPingAt: 0,
};

// ── WebRTC transport ────────────────────────────────────────────────────
// Mirrors the browser client's offer/answer + ICE exchange and data-channel
// message routing so the headless client receives broadcastToParty traffic
// (dungeonChange, combatStart, crit/standard/background deltas, etc.).
const webrtc = {
  pc: null,
  channel: null,
  connected: false,
  generation: 0,
  messageQueue: [],
};

function setupWebRTC() {
  if (!wrtc) return;
  try {
    webrtc.generation++;
    const gen = webrtc.generation;
    const pc = new wrtc.RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
      ],
    });
    webrtc.pc = pc;

    pc.onicecandidate = (e) => {
      if (gen !== webrtc.generation) return;
      if (e.candidate) socket.emit('webrtc-signal', { candidate: e.candidate });
    };
    pc.onconnectionstatechange = () => {
      if (gen !== webrtc.generation) return;
      const s = pc.connectionState;
      if (s === 'failed') {
        console.error('[webrtc] connection failed; staying on Socket.IO');
      }
    };

    const channel = pc.createDataChannel('game-data', { ordered: false, maxRetransmits: 0 });
    webrtc.channel = channel;
    channel.binaryType = 'arraybuffer';

    channel.onopen = () => {
      if (gen !== webrtc.generation) return;
      webrtc.connected = true;
      log('[webrtc] data channel open');
      // Flush anything queued before the channel was ready.
      while (webrtc.messageQueue.length) {
        const m = webrtc.messageQueue.shift();
        try { channel.send(JSON.stringify(m)); } catch (e) { /* drop */ }
      }
      // Ask the server to (re)push a fresh full state so our view is complete.
      sendWebRTC('webrtc-resync', {});
    };
    channel.onmessage = (e) => {
      if (gen !== webrtc.generation) return;
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'batchUpdate') {
          for (const m of msg.data.messages || []) handleWebRTCMessage(m.type, m.data);
        } else {
          handleWebRTCMessage(msg.type, msg.data);
        }
      } catch (err) {
        console.error('[webrtc] message parse error:', err.message);
      }
    };
    channel.onclose = () => { webrtc.connected = false; log('[webrtc] data channel closed'); };
    channel.onerror = (err) => { console.error('[webrtc] data channel error:', err); };

    pc.createOffer()
      .then((o) => pc.setLocalDescription(o))
      .then(() => socket.emit('webrtc-offer', { offer: pc.localDescription }))
      .catch((err) => console.error('[webrtc] offer failed:', err.message));
  } catch (err) {
    console.error('[webrtc] setup failed:', err.message);
  }
}

function sendWebRTC(type, data) {
  if (webrtc.connected && webrtc.channel && webrtc.channel.readyState === 'open') {
    try {
      webrtc.channel.send(JSON.stringify({ id: Math.random().toString(36).slice(2), timestamp: Date.now(), type, data }));
      return true;
    } catch (e) { /* fall through */ }
  }
  webrtc.messageQueue.push({ id: Math.random().toString(36).slice(2), timestamp: Date.now(), type, data });
  return false;
}

// Route a WebRTC-delivered game message to the same handlers the Socket.IO
// path uses, so `state` stays consistent regardless of transport.
function handleWebRTCMessage(type, data) {
  switch (type) {
    case 'dungeonChange': return onDungeonChange(data);
    case 'combatStart': return onCombatStart(data);
    case 'combatEnd': return onCombatEnd(data);
    // Combat hit/crit/damage events are delivered over WebRTC as `combatEvent`
    // (the server's broadcastCriticalUpdate -> combatEvent). They carry the
    // same actor/target shape the browser routes through the critical handler,
    // so reuse onCriticalUpdate to keep player/enemy HP in sync.
    case 'combatEvent': return onCriticalUpdate(data);
    case 'criticalUpdate': return onCriticalUpdate(data);
    case 'standardUpdate': return onStandardUpdate(data);
    case 'backgroundUpdate': return onBackgroundUpdate(data);
    case 'hpMpUpdate': return onHpMpUpdate(data);
    case 'fullState':
    case 'partyUpdate': return onFullState(data);
    case 'eventLog': return onEventLog(data);
    case 'nextFloor': return onNextFloor(data);
    case 'pong': return onPong(data);
    default:
      // Unknown over WebRTC; surface for debugging.
      if (type) log(`[webrtc] unhandled message type "${type}"`);
  }
}

// Track the gap between consecutive inbound packets (packet arrival jitter).
function markPacketArrival() {
  const now = Date.now();
  if (latency.lastPacketAt) {
    const gap = now - latency.lastPacketAt;
    if (gap >= 0) recordSample(latency.packetGap, gap);
  }
  latency.lastPacketAt = now;
}

// Resolve any pending command whose effect we just observed.
function resolvePendingCommands(matcher) {
  const now = Date.now();
  for (const [event, info] of latency.pendingCommands) {
    if (matcher(event, info)) {
      recordSample(latency.commandRTT, now - info.sentAt);
      log(`[latency] command "${info.label}" -> effect "${event}" in ${now - info.sentAt}ms`);
      latency.pendingCommands.delete(event);
    }
  }
}

// Send a command and register it as pending so we can measure until its effect arrives.
function sendTimed(event, data, effectMatcher, label) {
  socket.emit(event, data);
  if (effectMatcher) {
    latency.pendingCommands.set(effectMatcher, { sentAt: Date.now(), label: label || event });
  }
}

function send(event, data) {
  socket.emit(event, data);
}

function log(...args) {
  console.log('[game]', ...args);
}

// ── Connection lifecycle ────────────────────────────────────────────────
socket.on('connect', () => {
  log('connected as socket', socket.id);
  // The server emits a custom app-level 'ping' event (distinct from the
  // socket.io protocol heartbeat). socket.io-client only auto-answers the
  // protocol ping, so we must explicitly echo this custom ping back as 'pong'
  // to keep the server's pingUpdate RTT stream alive.
  socket.on('ping', (ts) => socket.emit('pong', ts));
  send('joinParty', { partyId: PARTY, name: NAME });
  // Open the optional WebRTC data channel so we receive broadcastToParty
  // traffic (dungeonChange, combat deltas, etc.) that the server sends
  // WebRTC-first and only falls back to Socket.IO when no peer exists.
  setupWebRTC();
});

// WebRTC signaling: server's answer to our offer, and ICE candidates both ways.
socket.on('webrtc-answer', (d) => {
  if (!webrtc.pc) return;
  try { webrtc.pc.setRemoteDescription(new wrtc.RTCSessionDescription(d.answer)); }
  catch (e) { console.error('[webrtc] answer error:', e.message); }
});
socket.on('webrtc-signal', (d) => {
  if (!webrtc.pc || !d.candidate) return;
  try { webrtc.pc.addIceCandidate(new wrtc.RTCIceCandidate(d.candidate)); }
  catch (e) { console.error('[webrtc] signal error:', e.message); }
});
socket.on('webrtc-error', (d) => console.error('[webrtc] server error:', d.message));

socket.on('joinedParty', (d) => {
  state.joined = true;
  state.partyId = d.partyId;
  state.player = d.player;
  state.shopStock = d.fullState.shopStock || [];
  log(`joined party "${d.partyId}" as ${d.player.name} (Level ${d.player.level})`);
  rl.prompt();
});

socket.on('partyFull', () => {
  log('party is full!');
  socket.disconnect();
  process.exit(1);
});

// ── State tracking from server broadcasts ───────────────────────────────
function onServerPacket(d) { markPacketArrival(); }

socket.on('pingUpdate', (ms) => {
  markPacketArrival();
  const rtt = Number(ms) || 0;
  latency.lastServerRTT = rtt;
  recordSample(latency.serverRTT, rtt);
});

socket.on('partyUpdate', (d) => { onServerPacket(d); resolvePendingCommands((e) => e === 'partyUpdate'); onFullState(d); });
socket.on('fullState', (d) => { onServerPacket(d); resolvePendingCommands((e) => e === 'fullState'); onFullState(d); });

function onFullState(d) {
  state.partyId = d.partyId || state.partyId;
  if (Array.isArray(d.players)) {
    state.players = new Map(d.players.map(p => [p.id, p]));
    const me = d.players.find(p => p.name === NAME);
    if (me) state.player = me;
  }
  if (Array.isArray(d.enemies)) state.enemies = d.enemies;
  if (d.floor !== undefined) state.floor = d.floor;
  if (d.dungeon !== undefined) state.dungeon = d.dungeon;
  if (d.combatActive !== undefined) state.combatActive = d.combatActive;
  if (d.autoEmbark !== undefined) state.autoEmbark = d.autoEmbark;
  if (Array.isArray(d.shopStock)) state.shopStock = d.shopStock;
}

socket.on('dungeonChange', (d) => onDungeonChange(d));
function onDungeonChange(d) {
  markPacketArrival();
  resolvePendingCommands((e) => e === 'dungeonChange');
  if (d.dungeon !== undefined) state.dungeon = d.dungeon;
  if (d.floor !== undefined) state.floor = d.floor;
  if (d.combatActive !== undefined) state.combatActive = d.combatActive;
  if (d.enemies !== undefined) state.enemies = d.enemies;
  if (Array.isArray(d.shopStock)) state.shopStock = d.shopStock;
  log(`dungeon change -> ${d.dungeon || state.dungeon}, floor ${d.floor ?? state.floor}, combat ${d.combatActive ?? state.combatActive}`);
}

socket.on('combatStart', (d) => onCombatStart(d));
function onCombatStart(d) {
  markPacketArrival();
  resolvePendingCommands((e) => e === 'combatStart');
  if (d.enemies) state.enemies = d.enemies;
  if (d.combatActive !== undefined) state.combatActive = d.combatActive;
  if (d.floor !== undefined) state.floor = d.floor;
  log(`combat started on floor ${state.floor} with ${state.enemies.length} enemies`);
}

socket.on('combatEnd', (d) => onCombatEnd(d));
function onCombatEnd(d) {
  state.combatActive = false;
  log(`combat ended: ${d.message || ''}`);
}

socket.on('criticalUpdate', (d) => onCriticalUpdate(d));
function onCriticalUpdate(d) {
  markPacketArrival();
  if (Array.isArray(d.shopStock)) state.shopStock = d.shopStock;
  if (d.playerUpdates) {
    for (const [id, u] of Object.entries(d.playerUpdates)) {
      const p = state.players.get(id) || (u.name && [...state.players.values()].find(x => x.name === u.name));
      if (p) Object.assign(p, u);
    }
  }
}

socket.on('standardUpdate', (d) => onStandardUpdate(d));
function onStandardUpdate(d) {
  markPacketArrival();
  resolvePendingCommands((e) => e === 'standardUpdate');
  if (d.combatActive !== undefined) state.combatActive = d.combatActive;
  if (d.floor !== undefined) state.floor = d.floor;
  if (d.enemyUpdates) state.enemies = d.enemies || state.enemies;
}

socket.on('backgroundUpdate', (d) => onBackgroundUpdate(d));
function onBackgroundUpdate(d) {
  markPacketArrival();
  if (d.floor !== undefined) state.floor = d.floor;
  if (d.dungeon !== undefined) state.dungeon = d.dungeon;
  if (d.dungeonFloors !== undefined) state.floor = d.floor ?? state.floor;
}

socket.on('hpMpUpdate', (d) => onHpMpUpdate(d));
function onHpMpUpdate(d) {
  markPacketArrival();
  if (d.playerUpdates) {
    for (const [id, u] of Object.entries(d.playerUpdates)) {
      const p = state.players.get(id) || (u.name && [...state.players.values()].find(x => x.name === u.name));
      if (p && u) Object.assign(p, { hp: u.hp, maxHp: u.maxHp, mp: u.mp, maxMp: u.maxMp, ap: u.ap, maxAp: u.maxAp });
    }
  }
}

socket.on('nextFloor', () => onNextFloor());
function onNextFloor() {
  markPacketArrival();
  log('advanced to next floor');
}

socket.on('eventLog', (d) => onEventLog(d));
function onEventLog(d) {
  markPacketArrival();
  console.log(`[event:${d.type || 'info'}] ${d.message}`);
  // Some server actions surface their effect only as an eventLog line; resolve
  // pending commands matched by the message text so we still get a commandRTT.
  resolvePendingCommands((e, info) => info.eventLogMatch && info.eventLogMatch.test(d.message));
}

socket.on('pong', (ts) => onPong(ts));
function onPong(ts) {
  markPacketArrival();
  if (latency.oneOffPingId !== null) {
    const rtt = Date.now() - latency.oneOffPingAt;
    log(`[latency] one-off ping round-trip: ${rtt}ms`);
    latency.oneOffPingId = null;
  }
}

socket.on('connect_error', (err) => console.error('[connect_error]', err.message));
socket.on('disconnect', (reason) => log('disconnected:', reason));

// ── Command handling ────────────────────────────────────────────────────
function status() {
  const me = state.player;
  if (!me) return log('not joined yet');
  log(`Party ${state.partyId} | ${state.dungeon} floor ${state.floor} | combat ${state.combatActive} | autoEmbark ${state.autoEmbark}`);
  log(`You: Lv${me.level} HP ${me.hp}/${me.maxHp} MP ${me.mp}/${me.maxMp} AP ${me.ap}/${me.maxAp} Gold ${me.gold} Points ${me.pointsToAllocate}`);
  log(`Enemies: ${state.enemies.length ? state.enemies.map(e => `${e.name}(${e.hp}/${e.maxHp})`).join(', ') : 'none'}`);
  log(`Players: ${[...state.players.values()].map(p => p.name).join(', ')}`);
  log(`Shop: ${state.shopStock.length} items (use 'buyshop <index>')`);
}

rl.on('line', (line) => {
  const input = line.trim();
  if (!input) { rl.prompt(); return; }
  const [cmd, ...args] = input.split(/\s+/);

  switch (cmd.toLowerCase()) {
    case 'help':
      showHelp();
      break;
    case 'status':
      status();
      break;
    case 'embark': {
      const dungeon = args[0] || state.dungeon || 'field';
      sendTimed('embarkDungeon', { partyId: PARTY, dungeon }, 'dungeonChange', `embark ${dungeon}`);
      log(`requested embark on ${dungeon}`);
      break;
    }
    case 'change':
      if (!args[0]) { log('usage: change <dungeon>'); break; }
      sendTimed('changeDungeon', { partyId: PARTY, dungeon: args[0] }, 'dungeonChange', `change ${args[0]}`);
      log(`requested change to ${args[0]}`);
      break;
    case 'escape':
      sendTimed('escapeDungeon', { partyId: PARTY }, 'dungeonChange', 'escape');
      log('requested escape to Town');
      break;
    case 'auto':
      if (!args[0]) { log('usage: auto [on|off]'); break; }
      sendTimed('toggleAutoEmbark', { partyId: PARTY, enabled: args[0].toLowerCase() === 'on' }, 'standardUpdate', `auto ${args[0]}`);
      log(`requested auto-embark ${args[0]}`);
      break;
    case 'allocate': {
      const stat = args[0];
      const points = parseInt(args[1], 10);
      if (!stat || !points) { log('usage: allocate <stat> <points>'); break; }
      sendTimed('allocatePoints', { partyId: PARTY, stat, points }, 'fullState', `allocate ${stat}`);
      log(`allocated ${points} to ${stat}`);
      break;
    }
    case 'equip': {
      const [slot, itemId] = args;
      if (!slot || !itemId) { log('usage: equip <slot> <itemId>'); break; }
      sendTimed('equipItem', { partyId: PARTY, slot, itemId }, 'fullState', `equip ${itemId}`);
      log(`equip ${itemId} in ${slot}`);
      break;
    }
    case 'unequip':
      if (!args[0]) { log('usage: unequip <slot>'); break; }
      sendTimed('unequipItem', { partyId: PARTY, slot: args[0] }, 'fullState', `unequip ${args[0]}`);
      log(`unequip ${args[0]}`);
      break;
    case 'use':
      if (!args[0]) { log('usage: use <itemId>'); break; }
      sendTimed('useItem', { partyId: PARTY, itemId: args[0] }, 'fullState', `use ${args[0]}`);
      log(`use ${args[0]}`);
      break;
    case 'sell':
      if (!args[0]) { log('usage: sell <itemId>'); break; }
      sendTimed('sellItem', { partyId: PARTY, itemId: args[0] }, 'fullState', `sell ${args[0]}`);
      log(`sell ${args[0]}`);
      break;
    case 'buy': {
      const kind = args[0];
      const map = {
        armour: 'buyArmour', weapon: 'buyWeapon', weaponmelee: 'buyWeaponMelee',
        weaponranged: 'buyWeaponRanged', weaponmagic: 'buyWeaponMagic',
        helmet: 'buyHelmet', shoes: 'buyShoes', random: 'buyRandomGear',
      };
      const event = map[(kind || '').toLowerCase()];
      if (!event) { log('usage: buy <armour|weapon|weaponMelee|weaponRanged|weaponMagic|helmet|shoes|random>'); break; }
      sendTimed(event, PARTY, 'fullState', `buy ${kind}`);
      log(`buy ${kind}`);
      break;
    }
    case 'buyshop': {
      const index = parseInt(args[0], 10);
      if (isNaN(index)) { log('usage: buyshop <index>'); break; }
      sendTimed('buyShopItem', { partyId: PARTY, index }, 'fullState', `buyshop ${index}`);
      log(`buy shop item ${index}`);
      break;
    }
    case 'ability': {
      const slotIndex = parseInt(args[0], 10);
      const abilityId = args[1] || null;
      if (isNaN(slotIndex) || slotIndex < 0 || slotIndex > 7) { log('usage: ability <slotIndex 0-7> <abilityId>'); break; }
      sendTimed('assignAbilitySlot', { partyId: PARTY, slotIndex, abilityId }, 'fullState', `ability ${slotIndex}`);
      log(`assign ${abilityId || 'nothing'} to slot ${slotIndex}`);
      break;
    }
    case 'donate':
      sendTimed('donate', { partyId: PARTY }, null, 'donate');
      log('donated 50 gold');
      break;
    case 'latency':
      printLatency();
      break;
    case 'webrtc':
      if (!wrtc) { log('WebRTC unavailable (wrtc not installed) - Socket.IO only'); break; }
      log(`WebRTC: connected=${webrtc.connected}, pc=${(webrtc.pc && webrtc.pc.connectionState) || 'none'}, channel=${(webrtc.channel && webrtc.channel.readyState) || 'none'}, queued=${webrtc.messageQueue.length}`);
      break;
    case 'ping': {
      const id = Math.random().toString(36).slice(2);
      latency.oneOffPingId = id;
      latency.oneOffPingAt = Date.now();
      // Prefer WebRTC for the round-trip measurement when the channel is up.
      if (webrtc.connected && webrtc.channel && webrtc.channel.readyState === 'open') {
        sendWebRTC('ping', { clientTimestamp: latency.oneOffPingAt, pingId: id });
        log('[latency] sent one-off ping (WebRTC), awaiting pong...');
      } else {
        socket.emit('ping', latency.oneOffPingAt);
        log('[latency] sent one-off ping (Socket.IO), awaiting pong...');
      }
      break;
    }
    case 'leave':
      send('leaveParty', { partyId: PARTY });
      log('leaving party');
      if (webrtc.pc) { try { webrtc.pc.close(); } catch (e) {} }
      socket.disconnect();
      process.exit(0);
      break;
    default:
      log(`unknown command "${cmd}". Type "help" for commands.`);
  }
  rl.prompt();
});

function printLatency() {
  log('── Latency diagnostics ──');
  log(summarize('serverRTT (pingUpdate)', latency.serverRTT));
  log(summarize('commandRTT (cmd -> effect)', latency.commandRTT));
  log(summarize('packetGap (arrival jitter)', latency.packetGap));
  log(`current serverRTT: ${latency.lastServerRTT}ms`);
  if (latency.pendingCommands.size > 0) {
    log(`pending unresolved commands: ${[...latency.pendingCommands.values()].map(v => v.label).join(', ')}`);
  }
}

function showHelp() {
  console.log([
    'Commands:',
    '  help                              show this list',
    '  status                            print current tracked state',
    '  embark [dungeon]                 embark (default current/field)',
    '  change <dungeon>                 switch dungeon in town',
    '  escape                           return to Town',
    '  auto [on|off]                    toggle auto-embark',
    '  allocate <stat> <points>         allocate stat points',
    '  equip <slot> <itemId>            equip an inventory item',
    '  unequip <slot>                   unequip a slot',
    '  use <itemId>                     use a consumable',
    '  sell <itemId>                    sell an inventory item',
    '  buy <kind>                       buy gear (armour|weapon|weaponMelee|weaponRanged|weaponMagic|helmet|shoes|random)',
    '  buyshop <index>                  buy from shop stock',
    '  ability <slot 0-7> <abilityId>   assign ability to slot',
    '  donate                           donate 50 gold',
    '  latency                          print latency diagnostics (server RTT, command round-trips, packet gaps)',
    '  webrtc                           show WebRTC data-channel state',
    '  ping                             send a one-off ping and measure round-trip time',
    '  leave                            leave party and exit',
  ].join('\n'));
}

log('interactive client starting. Type "help" for commands.');
