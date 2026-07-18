# Guide: Diagnosing and Fixing Client-Side Missing Element Updates

## Problem Description

When client-side UI elements (like `currentVenture`, venture levels, or top 4 ventures) don't update despite server-side data changing, the issue is typically that:

1. The server isn't sending the updated field in its broadcast packets
2. The client isn't receiving or processing the field when it arrives
3. The client is caching the old value and not refreshing

## Step-by-Step Diagnosis Process

### Step 1: Identify the UI Element That Isn't Updating

First, locate where in the client code the element is displayed:

```javascript
// Example from index.js - current venture display
const ventureHtml = hasVenture ? `💼${calcVentureLv(player.ventures[player.currentVenture] || 0)}...` : '';
```

Key questions:
- What fields are being used? (`currentVenture`, `player.ventures`, etc.)
- What's the function that updates this element? (`updatePlayerElement`, etc.)

### Step 2: Check Server-Side Broadcast Functions

Search for where the field should be sent from the server:

```bash
# Search for related broadcast functions
grep -r "backgroundUpdate" app.js
grep -r "standardUpdate" app.js
grep -r "buildUpdatePacket" app.js
```

### Step 3: Find All bgFields Arrays

The issue is often that `bgFields` arrays are scattered across multiple functions:

```javascript
// In buildUpdatePacket (background case)
const bgFields = ['xp', 'gold', 'str', 'ventures', /* missing: 'currentVenture' */];

// In broadcastPlayerUpdate
const bgFields = ['gold', 'xp', 'ventures', /* missing: 'currentVenture' */];

// In processPriorityUpdates
const bgFields = ['xp', 'gold', 'ventures', /* missing: 'currentVenture' */];
```

### Step 4: Check Client-Side Handlers

Verify the client is set up to receive and process the field:

```javascript
// In clientNetwork.js - handleBackgroundUpdate
const bgFields = ['xp', 'gold', 'ventures', /* added: 'currentVenture' */];
```

### Step 5: Check for Caching Issues

The client might be caching old values:

```javascript
// In updatePlayerElement - caching venture display
const ventureHtml = hasVenture ? `💼${calcVentureLv(...)}` : '';
if (cache.ventureHtml !== ventureHtml) {
    classText.innerHTML = ventureHtml;
    cache.ventureHtml = ventureHtml;
}
```

## The Fix Pattern

### 1. Add Field to All Server-Side bgFields Arrays

```javascript
// BEFORE
const bgFields = ['xp', 'gold', 'ventures'];

// AFTER
const bgFields = ['xp', 'gold', 'ventures', 'currentVenture'];
```

Locations to check in `app.js`:
- `buildUpdatePacket()` function
- `broadcastPlayerUpdate()` function  
- `processPriorityUpdates()` function

### 2. Add Field to Client-Side Handler

```javascript
// In clientNetwork.js - handleBackgroundUpdate
const bgFields = ['xp', 'gold', 'ventures', 'currentVenture'];
```

### 3. Handle Cache Invalidation (If Needed)

If the client caches values, you may need to reset the cache:

```javascript
// In onJoinedParty callback
currentState.ventureCacheReset = Date.now();

// In updatePlayerElement
const cacheResetTime = currentState.ventureCacheReset || 0;
if (cacheResetTime > lastResetTime) {
    cache.ventureHtml = null;
    cache.topVenturesHtml = null;
}
```

## Quick Checklist

- [ ] Identify all UI elements using the field
- [ ] Find all server-side broadcast functions (`buildUpdatePacket`, `broadcastPlayerUpdate`, `processPriorityUpdates`)
- [ ] Add field to each `bgFields` array on server
- [ ] Add field to client-side `bgFields` array in handler
- [ ] Check for caching logic that might prevent updates
- [ ] Test by triggering a change and verifying the update appears

## Example Debug Output

Add logging to trace the data flow:

```javascript
// Server-side
console.log('[SERVER] Sending backgroundUpdate:', bgDelta);

// Client-side  
console.log('[CLIENT] Received backgroundUpdate:', data);
console.log('[CLIENT] Processing playerUpdates:', data.playerUpdates);
```

## Common Fields That Might Be Missing

- `currentVenture` - Player's current class/venture
- `ventures` - Object containing all venture XP values
- `topVentures` - Computed from ventures object
- Any stat field (`str`, `dex`, `agi`, etc.)
- Any gear field (`armour`, `weapon`, etc.)

## Prevention Tips

1. **Centralize broadcast field definitions** - Use a constant or shared function for `bgFields`
2. **Document which update type each field belongs to:**
   - `critical` - HP, AP, maxHp, maxAp
   - `standard` - actionBar, currentVenture, level
   - `background` - xp, gold, stats, gear, ventures
3. **Add integration tests** that verify all fields are sent in updates

