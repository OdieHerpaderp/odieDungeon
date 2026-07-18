# Guide: Using the Interactive Test Client (AI Agent Edition)

This guide explains how an AI agent can drive the odieDungeon server using the
headless interactive client at `scripts/joinGame.js`. Use it to test server
behavior, reproduce bugs, and verify gameplay flows without a browser.

## 1. Prerequisites

- The game server (`app.js`) must be running and listening on port `25561`
  (override the URL argument to point elsewhere).
- `socket.io-client` is a devDependency, resolved relative to the repo root, so
  run the script from anywhere but keep the repo layout intact.
- `wrtc` is a dependency (same native binding the server uses) and is required
  for the optional WebRTC data-channel transport. If `wrtc` is unavailable the
  script transparently falls back to Socket.IO-only (see Gotchas).
- Node.js (same runtime that runs `app.js`).

Start the server if it is not already up:

```bash
# from repo root
node app.js
# verify
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:25561/
# expect 200
```

## 2. Launching the client

```bash
node scripts/joinGame.js [partyId] [name] [url]
```

| Argument | Default          | Notes                                            |
|----------|------------------|--------------------------------------------------|
| partyId  | `test`           | Party to join (created on first join).           |
| name     | `KiloBot`        | Character name. A new save is created if absent. |
| url      | `http://localhost:25561` | Base URL of the game server.              |

Example:

```bash
node scripts/joinGame.js test KiloBot
```

The process stays alive, prints a `[game]`-prefixed log, and shows a
`KiloBot> ` prompt. It reads commands from **stdin**, one per line.

### Connecting to the prompt programmatically

Because the client reads stdin line-by-line, an agent (or a test harness) can
drive it by spawning the process and writing commands to its stdin, then
reading stdout. Important timing fact:

- `joinParty` is sent on `connect`, and `joinedParty` arrives asynchronously.
  Do **not** send gameplay commands in the same instant as launch. Wait until
  you see `[game] joined party "..."` (or sleep ~1.5s after launch) before
  issuing commands that require being in a party.

A robust pattern is to wait for the `joined party` log line, then send commands
with small delays (e.g. 1–1.5s) between them so server state settles and the
client's tracked `state` reflects it.

Example harness (bash):

```bash
( sleep 1.5; echo "status"; sleep 1.5; echo "embark field"; sleep 1.5; echo "status"; sleep 1.5; echo "leave" ) \
  | timeout 12 node scripts/joinGame.js test KiloBot
```

## 3. Commands

All commands are typed at the `KiloBot> ` prompt. Each emits the corresponding
Socket.IO event the server already handles (see `app.js` socket handler
section). Combat itself is **server-automated** (action-bar auto-attacks); this
client only issues the player-driven actions.

| Command | Effect | Server event emitted |
|---------|--------|----------------------|
| `help` | Print the command list. | — |
| `status` | Print tracked state: party, dungeon, floor, combat flag, your HP/MP/AP/gold/points, enemies, players, shop count. | — |
| `embark [dungeon]` | Embark the party (defaults to current dungeon, usually `field`). Must be in Town (floor 0). | `embarkDungeon` |
| `change <dungeon>` | Switch dungeon while in Town (respects unlock gates). | `changeDungeon` |
| `escape` | Return to Town and reset dungeon progress. | `escapeDungeon` |
| `auto [on|off]` | Toggle auto-embark (re-embark on the same dungeon from Town). | `toggleAutoEmbark` |
| `allocate <stat> <points>` | Spend unallocated stat points (`str/dex/agi/vit/int/cnc/wis/for/luk/pie`). | `allocatePoints` |
| `equip <slot> <itemId>` | Equip an inventory item into a slot (`weapon/armour/helmet/shoes`). | `equipItem` |
| `unequip <slot>` | Unequip a slot. | `unequipItem` |
| `use <itemId>` | Use a consumable from inventory. | `useItem` |
| `sell <itemId>` | Sell an inventory item for gold. | `sellItem` |
| `buy <kind>` | Buy gear. `kind` ∈ `armour|weapon|weaponMelee|weaponRanged|weaponMagic|helmet|shoes|random`. | `buyArmour` / `buyWeapon` / etc. / `buyRandomGear` |
| `buyshop <index>` | Buy the item at `index` from the current shop stock. | `buyShopItem` |
| `ability <slot 0-7> <abilityId>` | Assign an ability to a slot. Empty `abilityId` clears the slot. | `assignAbilitySlot` |
| `donate` | Donate 50 gold (raises PIE). | `donate` |
| `latency` | Print latency diagnostics (server RTT, command round-trips, packet gaps). | — |
| `ping` | Send a one-off `ping` and measure the round-trip time. Prefers WebRTC when the data channel is open, else Socket.IO. | `ping` |
| `webrtc` | Show the WebRTC data-channel state (`connected`, peer-connection state, channel readiness, queued messages). | — |
| `leave` | Leave the party and exit the process. | `leaveParty` |

### Notes on arguments

- `itemId` / `abilityId` values come from the live server state. Use `status`
  and the `criticalUpdate` / `fullState` packets to discover real ids. The
  client prints `[event:...]` lines from the server `eventLog` channel, which
  surface validation errors (e.g. "You do not own that item.", "Not enough
  gold...", "Invalid ability slot.").
- Stat allocation is rejected server-side if `pointsToAllocate` is insufficient
  or `points <= 0`.
- Gear purchases are only allowed in Town (`floor === 0`) and out of combat.

## 4. What the client tracks

The script maintains an in-memory `state` object updated from server broadcasts:

- `partyUpdate` / `fullState` → full snapshot (`onFullState`).
- `dungeonChange` / `combatStart` / `combatEnd` → floor, dungeon, combat flag,
  enemies.
- `criticalUpdate` / `combatEvent` / `standardUpdate` / `backgroundUpdate` /
  `hpMpUpdate` → incremental player/enemy stat deltas (same channels the browser
  client uses). These arrive over WebRTC when the data channel is open, and over
  Socket.IO otherwise, but are routed through identical handlers either way.
- `eventLog` → surfaced as `[event:type] message` lines for debugging.

`status` renders this local view. Treat it as the agent's "screen": after any
command, re-run `status` (with a short delay) to observe the result.

## 5. Typical test flows

### Smoke test: join + embark + verify combat

```
status            # confirm joined, floor 0, in Town
embark field      # -> dungeonChange floor 1, combat true
status            # enemies present, HP ticking down as auto-combat runs
leave
```

### Gear / economy test

```
buy random        # purchase a random item into inventory
status            # inspect gold / inventory via eventLog + full state
buyshop 0         # buy first shop-stock item if available
equip weapon <id> # equip it (id from a prior fullState/status)
sell <id>         # sell something back
donate            # gold must be >= 50
```

### Progression test

```
embark field
# let auto-combat clear floors; watch floor advance via nextFloor / dungeonChange
change forest     # only works once field floor 101 reached (gated server-side)
escape            # back to Town, progress reset
auto on           # re-embark automatically next time in Town
```

## 5b. Latency / input-lag diagnosis

The client instruments three latency signals to diagnose input lag and
network jitter. All timestamps use `Date.now()` (ms) and are summarized as
`n=count min/avg/max`.

| Signal | Source | What it tells you |
|--------|--------|-------------------|
| `serverRTT` | server-pushed `pingUpdate` (every ~2s) | Authoritative client→server→client round-trip time. |
| `commandRTT` | command emit → observed effect | **Input latency**: time from your command until the server's resulting state change arrives (e.g. `embark` → `dungeonChange`). |
| `packetGap` | inter-arrival time of consecutive server packets | Broadcast cadence / jitter (expected ~200–800ms from the server's delta intervals). |
| one-off `ping` | `ping` command → `pong` | Single-shot round-trip measurement, independent of the server's 2s stream. |

### How it works

- On `connect` the client echoes the server's **custom** `ping` event back as
  `pong`. This is required: socket.io-client only auto-answers the protocol-level
  heartbeat, not the app's custom `ping`, so without this echo the server never
  sends `pingUpdate` and never falls back to Socket.IO for game broadcasts.
- Each gameplay command (`embark`, `change`, `escape`, `auto`, `allocate`,
  `equip`, `unequip`, `use`, `sell`, `buy`, `buyshop`, `ability`) is sent via
  `sendTimed`, which records a pending entry and resolves it (recording a
  `commandRTT` sample + a `[latency] command "X" -> effect "Y" in Nms` line)
  when the matching effect event arrives (e.g. `dungeonChange`, `fullState`).

### Usage

```
latency           # print all rolling samples
ping              # one-off round-trip measurement (WebRTC if channel open, else Socket.IO)
webrtc            # show WebRTC data-channel state
```

Example output (WebRTC channel open, in active combat):

```
[game] ── Latency diagnostics ──
[game] serverRTT (pingUpdate): n=14 min=0.0ms avg=0.6ms max=1.0ms
[game] commandRTT (cmd -> effect): n=1 min=64.0ms avg=64.0ms max=64.0ms
[game] packetGap (arrival jitter): n=196 min=0.0ms avg=150.4ms max=504.0ms
[game] current serverRTT: 1ms
```

With WebRTC connected, `packetGap` reflects the real game-traffic cadence
(~100–300ms batches) rather than the flat ~2000ms `pingUpdate` heartbeat a
Socket.IO-only run would show.

### What to look for when diagnosing lag

- **High `commandRTT` on a specific action** → that handler is slow server-side
  (or the effect event is delayed). Compare across commands.
- **`packetGap` max ≫ avg** → sporadic broadcast stalls / jitter.
- **`serverRTT` climbing** → network/transport degradation between client and
  server.
- **`pending unresolved commands`** listed by `latency` → the expected effect
  event never arrived (the action may have been rejected server-side; check the
  `[event:error]` lines).

## 5c. WebRTC transport

The server's `broadcastToParty()` prefers WebRTC for game broadcasts
(`dungeonChange`, `combatStart`, `criticalUpdate`/`standardUpdate`/`backgroundUpdate`,
`hpMpUpdate`, `combatEvent`, etc.) and only falls back to Socket.IO when no WebRTC
peer exists for a socket. A pure Socket.IO client therefore misses those
broadcasts while in combat (e.g. it never sees `dungeonChange` directly, and the
`embark` command's `commandRTT` never resolves).

The client opens a `wrtc` data channel (the same native binding the server ships
with) to receive that traffic, mirroring the browser client in
`public/clientNetwork.js`:

1. On `connect` it creates an `RTCDataChannel('game-data')`, makes an offer, and
   sends it via `webrtc-offer`.
2. The server answers via `webrtc-answer`; both sides exchange ICE candidates
   over `webrtc-signal`.
3. On channel open the server streams batched (`batchUpdate`) and single game
   messages. The client routes them through the **same** `on*` state handlers the
   Socket.IO path uses, so `state` stays consistent regardless of transport.
4. The client also sends `webrtc-resync` on open so the server pushes a fresh
   full state, and `ping` over WebRTC when the channel is up.

Run `webrtc` at the prompt to confirm the channel is live:

```
KiloBot> webrtc
[game] WebRTC: connected=true, pc=connected, channel=open, queued=0
```

With WebRTC connected, an `embark field` resolves its `commandRTT` via the
received `dungeonChange`, and `packetGap` reflects the real game-traffic cadence
(~100–300ms batches) rather than the flat ~2000ms `pingUpdate` heartbeat.

### WebRTC gotchas

- **`wrtc` is required** for the data channel. If it is not installed the client
  logs a warning and runs Socket.IO-only; everything still works, you just miss
  the WebRTC-preferred broadcasts (as described in the old "Embark routing
  note" below).
- **Channel can drop mid-session:** the server may close the data channel on a
  transient party/peer state change (e.g. another player dies and the party
  churns). The client falls back to Socket.IO automatically and state tracking
  continues; `webrtc` will then report `channel=closed`. There is no automatic
  re-open yet — re-join to re-establish it.
- **`combatEvent` messages** (per-hit/crit/damage) arrive over WebRTC and are
  routed through the critical-update handler to keep player/enemy HP in sync;
  they are not surfaced as separate log lines.

## 6. Exit

- `leave` cleanly leaves the party and calls `process.exit(0)`.
- If you launched with `timeout`, the process is killed when the timeout hits;
  the socket disconnect triggers server-side `handleDisconnect`, which saves the
  character and prunes empty parties.
- A character save persists per `name` (database), so re-joining the same name
  resumes prior level/gold/gear.

## 7. Gotchas

- **Connect transport:** the script lists `['websocket','polling']`. If you see
  repeated `[connect_error] websocket error`, the server/environment may not
  expose the websocket transport; the client will still fall back to polling. If
  it never connects, confirm the server is actually running (`curl` the root).
- **WebRTC now default-on:** the client opens a `wrtc` data channel so it
  receives the server's WebRTC-preferred broadcasts (`dungeonChange`,
  `combatStart`, `criticalUpdate`, `combatEvent`, deltas, etc.). With the channel
  open, `embark`'s `commandRTT` resolves via the received `dungeonChange` and
  `packetGap` shows the real ~100–300ms game-traffic batches. If `wrtc` is absent
  (or the channel drops), the client transparently falls back to Socket.IO; state
  tracking continues but you lose those WebRTC-preferred broadcasts. Run `webrtc`
  to confirm the channel state (see §5c).
- **Don't spam commands:** the server processes actions synchronously per
  socket; issuing many commands with no delay can race with `joinedParty` or
  combat-state checks. Insert 1–1.5s gaps between commands.
- **Don't spam commands:** the server processes actions synchronously per
  socket; issuing many commands with no delay can race with `joinedParty` or
  combat-state checks. Insert 1–1.5s gaps between commands.
