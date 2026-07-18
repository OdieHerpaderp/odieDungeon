# Client Protocol Updates (Networking Refactor)

This documents the server-side networking changes from the client/networking
refactor so the client (`public/clientNetwork.js`) stays in sync.

## 1. Delta tracking is now centralized

`utilities/deltaTracker.js` is the single source of truth for delta mechanics
(`buildSnapshot`, `extractDelta`) used by both `app.js` and `appWebRTC.js`.
Per-player / per-enemy field lists remain local to each module to preserve
existing broadcast behavior, but the snapshot/deep-equal logic is shared.

## 2. State update shape (unchanged)

All update events keep their original payloads:

- `criticalUpdate` / `standardUpdate` / `backgroundUpdate`: `{ partyId, timestamp, playerUpdates: { [id]: {...} }, enemyUpdates?: { [id]: {...} } }`
- `partyUpdate` (full state): `{ players, enemies, floor, dungeon, ..., _fullState: true }`
- `hpMpUpdate`: `{ partyId, timestamp, playerUpdates: { [id]: { hp, maxHp, mp, maxMp, ap, maxAp, isDead } } }`
- `combatEvent` / `combatStart` / `combatEnd`: targeted/summary payloads as before

## 3. Batched messages (WebRTC)

Multiple messages bound for the same peer are coalesced into one datachannel
frame (already in place before this refactor):

```json
{
  "t": "batchUpdate",
  "d": { "pr": "critical" | "standard" | "background", "msgs": [ { "t": "<type>", "d": { "<compressed>" } } ] }
}
```

## 4. Backward compatibility

No backend event names or data structures were changed. Reconnecting clients
still receive a fresh `partyUpdate` full state and the server re-baselines its
delta tracker (`webrtcStateRestore` -> `partyUpdate`).
