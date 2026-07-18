# Fix Player ID Uniqueness Plan

## Objective
Ensure every player has a unique ID, including those on the same IP address.

## Root Cause Analysis
1. When loading saved characters from database, the `id` field was being preserved from saved data
2. The `id` field is session-specific (should be socket.id) but was being persisted
3. When broadcasting player state, stale IDs could be used instead of current socket IDs

## Implementation Steps - COMPLETED ✅

### Step 1: Fix `database.js` - Don't persist player ID ✅
- [x] Modify `saveCharacter` to exclude `id` from saved data
- [x] Added comment explaining that `id` is a session identifier, not character data

### Step 2: Fix `app.js` joinParty handler - Ensure proper ID assignment ✅
- [x] When loading saved character, explicitly remove any existing `id` field
- [x] Always set `character.id = socket.id` as the authoritative source
- [x] Added validation to ensure ID matches expected socket ID format

### Step 3: Fix `app.js` broadcast functions - Use consistent ID source ✅
- [x] In `buildUpdatePacket` 'full' case, use socket.id from the Map key for all players
- [x] Critical and Standard cases already use socketId from Map key as packet key with `id: socketId`

### Step 4: WebRTC ID handling ✅
- [x] WebRTC peer IDs align with socket IDs since webrtcServer.removePeer(socket.id) is used

## Files Modified
1. `database.js` - Excluded `id` from save data (added comment)
2. `app.js` - Fixed joinParty handler and buildUpdatePacket function

## Result
Each player now receives a unique socket.id when they connect, which is:
- Set as the authoritative player ID in the party Map
- Preserved across all broadcast operations
- Not persisted to database (only session-specific)
- Used consistently for all player identification

This ensures that even players on the same IP address will have unique IDs.

