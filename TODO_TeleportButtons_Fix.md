# TODO: Fix Floor Teleport Buttons

## Issue
After refactoring dungeons and floors to use dungeon-relative floor numbering (1-100 per dungeon), the floor teleport buttons no longer display correctly.

## Root Cause
1. `highestVisitedFloors` tracks dungeon-relative floors, but the client expects absolute floor numbers
2. When first entering a dungeon, `highestVisitedFloors` isn't properly initialized
3. The `updateTeleportButtons` function doesn't convert relative floors to absolute for display

## Fix Plan

### Step 1: Fix `app.js` - Ensure highestVisitedFloors is properly updated
- [x] In `changeDungeon` handler: Update `highestVisitedFloors` to always be at least `currentDungeonFloor` (not just when greater)
- [x] In movement handlers: Update `highestVisitedFloors` when moving to floor 1

### Step 2: Fix `public/index.js` - Convert relative floors to absolute
- [x] In `updateTeleportButtons`: Use dungeon data to convert relative floors to absolute for button display

## Changes Made

### app.js Changes
1. In `handleFloorMove` function:
   ```javascript
   // Always update highestVisitedFloors when entering a new floor to ensure buttons work
   if (newDungeonFloor >= 1 && (!party.highestVisitedFloors[party.dungeon] || newDungeonFloor > currentHighest)) {
       party.highestVisitedFloors[party.dungeon] = newDungeonFloor;
   }
   ```

2. In `handleTeleport` function:
   ```javascript
   // Always update highestVisitedFloors when teleporting to ensure buttons work
   if (targetFloor >= 1 && (!party.highestVisitedFloors[party.dungeon] || targetFloor > currentHighest)) {
       party.highestVisitedFloors[party.dungeon] = targetFloor;
   }
   ```

3. In `changeDungeon` handler:
   ```javascript
   // Always update highestVisitedFloors when entering a dungeon to ensure buttons work
   if (currentDungeonFloor >= 1 && (!party.highestVisitedFloors[dungeon] || currentDungeonFloor > currentHighest)) {
       party.highestVisitedFloors[dungeon] = currentDungeonFloor;
   }
   ```

### public/index.js Changes
1. In `updateTeleportButtons` function:
   ```javascript
   // Get dungeon data to convert relative to absolute floors
   const dungeonData = dungeons[currentDungeon];
   const floorBase = dungeonData?.floorBase || 1;
   const highestAbsoluteFloor = floorBase + highestFloor - 1;
   
   // Calculate the absolute floor number for display
   const absoluteFloor = floorBase + floor - 1;
   ```

## Testing Required
1. Join a party and verify teleport buttons appear when visiting floor 1
2. Move up floors and verify buttons update correctly
3. Change dungeons and verify buttons show correct absolute floor numbers
4. Test teleport functionality to ensure it works with absolute floor numbers

