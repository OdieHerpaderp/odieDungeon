# Client Protocol Updates (Networking Refactor)

This documents the server-side networking changes from the client/networking
refactor so the client (`public/clientNetwork.js`) stays in sync.

## 1. Delta tracking is now centralized

`utilities/deltaTracker.js` is the single source of truth for delta mechanics
(`buildSnapshot`, `extractDelta`) used by both `app.js` and `appWebRTC.js`.
Per-player / per-enemy field lists remain local to each module to preserve
existing broadcast behavior, but the snapshot/deep-equal logic is shared.

## 2. Single consolidated delta emitter (the model)

There is now **one** emitter: `emitPartyDeltas(partyId, party, now, intervals)`
in `app.js`, driven every 500ms by `startBroadcastSystem()`. It replaces the
old `buildUpdatePacket` + `processPriorityUpdates` + HP/MP-flush + priority-queue
system.

Invariants:

- **One baseline consumer.** For every player it computes a single delta
  (`getPlayerDelta(socketId, player, null)` — no consume), classifies each
  changed field into `critical` / `standard` / `background`, then advances the
  shared `playerLastState` baseline exactly once by consuming the union of all
  transmitted fields (`advancePlayerBaseline`). No field (e.g. `maxHp`/`maxAp`)
  can be swallowed by one pass and dropped from another — this fixes the old
  dropped-update bug (BUG 1).
- **HP/MP share the critical cadence (≤150ms in combat).** `hpMpUpdate` is
  derived from the same player delta as `criticalUpdate`; there is no separate
  flush timer anymore.
- **Enemies are on the periodic path (BUG 2).** Each tick, enemy deltas come from
  `getEnemyDelta` and are attached to the `standardUpdate` payload as a COMPLETE
  enemy snapshot (`{ ...enemy, id, isDead }`). Routing the full snapshot through
  a single bucket (`standard`) means a client that receives an `enemyUpdates`
  entry before the full-enemy embark/combatStart packet can create the enemy
  with every rendered attribute (name, level, str/dex/agi/vit, hp/maxHp,
  ap/maxAp, actionBar/maxActionBar). Enemies are no longer split across
  critical/standard/background buckets.

## 3. State update shape

All update events keep their original payloads (plus the `enemyUpdates`/`floor`
fields already expected by the client):

- `criticalUpdate`: `{ partyId, timestamp, playerUpdates: { [id]: { hp, maxHp, ap, maxAp, isDead } } }`
- `standardUpdate`: `{ partyId, timestamp, playerUpdates: { [id]: { id, name, actionBar, maxActionBar, level, isDead, skillsState } }, enemyUpdates: { [id]: { ...full enemy } }, combatActive, combatTurn }`
- `backgroundUpdate`: `{ partyId, timestamp, playerUpdates: { [id]: { id, name, ...stat/gear/gold/xp fields } }, floor, dungeonFloors, highestVisitedFloors }`
- `partyUpdate` (full state): `{ players, enemies, floor, dungeon, dungeonFloors, highestVisitedFloors, completedDungeons, combatActive, combatTurn, autoEmbark, shopStock, _fullState: true }`
- `hpMpUpdate`: `{ partyId, timestamp, playerUpdates: { [id]: { id, name, hp, maxHp, mp, maxMp, ap, maxAp, isDead } } }`
- `combatEvent` / `combatStart` / `combatEnd`: targeted/summary payloads as before

Full-state syncs (reconnect, embark, escape, death, level-up, teleport, allocate
points) are built by `buildFullStatePacket(party, partyId)` and sent via
`broadcastFullState(partyId, party)`. Gear/shop changes use
`broadcastCriticalGearUpdate` (single WebRTC-first emit, no second Socket.IO
emit).

## 4. Batched messages (WebRTC)

Multiple messages bound for the same peer are coalesced into one datachannel
frame (already in place before this refactor). `FIELD_ALIASES` / `compressMessage`
were removed — message compression was never wired and the client never decoded
aliased payloads, so payloads remain un-aliased.

```json
{
  "t": "batchUpdate",
  "d": { "pr": "critical" | "standard" | "background", "msgs": [ { "t": "<type>", "d": { "<payload>" } } ] }
}
```

## 5. Backward compatibility

No backend event names were changed. Reconnecting clients still receive a fresh
`partyUpdate` full state and the server re-baselines its delta tracker. The
client `handleBackgroundUpdate` now also consumes `dungeonFloors` /
`highestVisitedFloors` from the periodic background payload so the dungeon UI
stays in lockstep with a full-state sync.
