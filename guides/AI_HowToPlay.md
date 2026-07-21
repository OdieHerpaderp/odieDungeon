# AI How To Play odieDungeon with Playwright

This guide documents how to automate interactions with odieDungeon using Playwright, based on real usage experience.

## Prerequisites

- Node.js installed
- Playwright installed in the project: `npm install @playwright/test`
- Chromium browser installed: `npx playwright install chromium`
- The game server running at `http://localhost:25561/`

### First-Time Browser Setup

If Playwright fails with `Chromium distribution 'chrome' is not found`, your environment likely has `chromium` instead of `chrome`. Fix it by creating a symlink:

```bash
mkdir -p /opt/google/chrome
ln -sf /usr/bin/chromium /opt/google/chrome/chrome
```

## Connecting to the Game

```javascript
await page.goto('http://localhost:25561/');
```

The page title should be `odieDungeon`. A `favicon.ico` 404 error is expected and harmless.

## Joining a Party

```javascript
await page.fill('input[placeholder="Enter your name"]', 'kilo');
await page.fill('input[placeholder="Party ID"]', 'test');
await page.click('button:has-text("Join/Create Party")');
```

- Leaving the Party ID blank enables solo mode.
- Using an existing party ID joins that party.

## Understanding the UI Layout

The game UI is organized into panels. Key panels for automation:

| Panel | Purpose |
|-------|---------|
| 🎯 Skills | View weapon proficiencies, armor proficiencies, magic skills |
| 🧩 Ability Slots | Equip abilities into slots S1-S8 |
| 🎒 Equipment & Inventory | Manage equipped gear and view inventory |
| 🛒 Shop (town only) | Buy new gear while in town |
| 📜 Event Log | Read game events and confirmations |
| 🗺️ Floor Controls | Embark, auto-embark, escape |
| 👤 Current Player | View stats, allocate stat points |
| 🛡️ Party Members | See party status |
| 👹 Enemies | See current enemies |

## Equipping Abilities

1. Open the 🧩 Ability Slots panel if not already visible.
2. Find the ability card with an **"Equip"** button (e.g., First Aid).
3. Click the **Equip** button. The ability is assigned to the first empty slot (S1, S2, ...).
4. Confirm via the Event Log: `Assigned firstAid to slot 1.`

```javascript
await page.click('button:has-text("Equip")');
```

## Allocating Stat Points

In the 👤 Current Player panel, each stat (STR, DEX, AGI, VIT, INT, CNC) has +1, +3, and +5 buttons.

```javascript
// Allocate 3 points to CNC (the 6th stat group, index 5)
await page.click('button:has-text("+3") >> nth=5');
```

Confirm via Event Log: `Allocated 3 points to cnc.`

When you create a new character, you immediately get **3 free attribute points** to assign. Every time you **level up**, you also receive additional attribute points. Be sure to allocate those periodically in the Current Player panel.

## Equipping Abilities

1. Open the 🧩 Ability Slots panel if not already visible.
2. Find the ability card with an **"Equip"** button (e.g., First Aid).
3. Click the **Equip** button. The ability is assigned to the first empty slot (S1, S2, ...).
4. Confirm via the Event Log: `Assigned firstAid to slot 1.`

```javascript
await page.click('button:has-text("Equip")');
```

Don't forget to assign abilities to your slots; they make combat much easier.

## Embarking on a Dungeon

```javascript
await page.click('button:has-text("🚀 Embark: 🌿 field")');
```

Confirm via Event Log: `🚀 Embarked on field (Floor 1)!`

After embarking, the Embark button becomes disabled and enemies appear in the 👹 Enemies panel.

## Auto-Embark

Auto-embark automatically progresses through dungeon floors after each victory.

```javascript
// Enable auto-embark
await page.click('button:has-text("🔁 Auto-Embark: OFF")');

// Disable auto-embark
await page.click('button:has-text("🔁 Auto-Embark: ON")');
```

The button text toggles between `🔁 Auto-Embark: OFF` and `🔁 Auto-Embark: ON`.

## Checking Gold

Gold is displayed with the 💰 emoji in the Current Player panel. Extract it via JavaScript:

```javascript
const gold = await page.evaluate(() => {
  const m = document.body.innerText.match(/💰\s*([\d.]+)/);
  return m ? parseFloat(m[1]) : -1;
});
```

## Waiting for Gold Accumulation

Poll the gold value in a loop while auto-embark is running:

```javascript
for (let i = 0; i < 60; i++) {
  const gold = await page.evaluate(() => {
    const m = document.body.innerText.match(/💰\s*([\d.]+)/);
    return m ? parseFloat(m[1]) : -1;
  });
  if (gold >= 100) return `gold_reached_${gold}`;
  await page.waitForTimeout(2000);
}
```

## Buying Gear from the Shop

The shop is only available in town. The shop and equipment panels both have category buttons (Weapon, Headgear, Armor, Shoes) — make sure to click the **Shop** panel's buttons.

### Shop Tab Structure

- ⚔️ Weapon
- 🪖 Headgear
- 🛡️ Armor
- 👢 Shoes

### Identifying Shop Items

Shop items are rendered as `.gear-card` elements containing a price, item name, stats, and a **Buy** button. Equipped inventory items also use `.gear-card` but contain **Unequip** instead of Buy.

```javascript
// Get all buyable shop items in the current tab
const items = await page.evaluate(() => {
  return [...document.querySelectorAll('.gear-card')]
    .filter(c => c.textContent.includes('g') && !c.textContent.includes('Unequip'))
    .map(c => c.textContent.trim().replace(/\s+/g, ' ').slice(0, 250));
});
```

### Buying a Specific Item

```javascript
await page.click('button:has-text("👢 Shoes")'); // switch to shoes tab
await page.waitForTimeout(500);

await page.evaluate(() => {
  const card = [...document.querySelectorAll('.gear-card')]
    .find(c => c.textContent.includes("Wizard's Boots Lv3") && c.textContent.includes('4.95INT'));
  if (!card) return 'not found';
  const btn = card.querySelector('button');
  if (btn) btn.click();
  return 'bought';
});
```

### Item Text Format

Shop item text typically follows this pattern:

```
ItemName LvX (X★)♔X.X Price: XgBuy
DMG:X.XX SP:X.XX MODS:STRxX.XX,DEXxX.XX ASPD:X.X +X.XXSTR +X.XXAGI
```

Or for armor:

```
ItemName LvX (X★)♔X.X DEF:X.XX MR:X.XX +X.XXINT +X.XXCNC XgBuy
```

## Common Patterns

### Running Multiple Actions

```javascript
await page.click('button:has-text("🔁 Auto-Embark: OFF")');
await page.waitForTimeout(1000);
const gold = await page.evaluate(() => { /* ... */ });
```

### Waiting for UI Updates

Always wait after clicking a tab or action button before reading the DOM:

```javascript
await page.click('button:has-text("⚔️ Weapon")');
await page.waitForTimeout(500); // wait for shop content to update
```

### Reading Event Log

The Event Log panel shows confirmations like:

- `Assigned firstAid to slot 1.`
- `Allocated 3 points to cnc.`
- `🚀 Embarked on field (Floor 1)!`
- `✅ Auto-progressing to next floor...`
- `⚔️ Combat started! Action bars filling...`
- `Victory! You can move now!`
- `Sold Plate Greaves for 53g.`

Use these text confirmations to verify that actions succeeded.

## Tips

- Use `page.evaluate()` to run JavaScript in the browser context for complex DOM queries.
- The `.gear-card` class is the primary selector for both shop and inventory items.
- Shop items have a price + "Buy"; equipped items have "Unequip". Filter accordingly.
- The Current Player gold value is best read from `document.body.innerText` with a regex.
- When in doubt, take a screenshot: `await page.screenshot({ path: 'debug.png' })`.

**Dungeon change procedure:** before switching dungeons, turn auto-embark off (`auto off`) and either finish the current dungeon run or use `escape` to return to Town. Once in Town, select the new dungeon and click `embark`. As a rule of thumb, bring your average equipped item tier up to at least 3 before attempting a new dungeon — weaker gear will make higher difficulties much harder.

**Dungeon unlock chain:** dungeons are unlocked sequentially. You must fully clear a dungeon at least once before the next one becomes available. The known order is: `field` → `backyard` → `meadow`, and so on. Attempting to `change` to a locked dungeon will be rejected server-side.

**Separate level vs floor:** the character's `Lv` shown in the Current Player panel is the character level, which is independent of the current dungeon `Field Floor N`. Don't confuse them when deciding whether to advance.

**Average equipped item tier:** the `♔X.Y` value shown on the character's summary line (`▸⚖️X ♔X.Y name`) reflects the average tier of currently equipped items only, not inventory or shop listings. Use it to gauge whether your gear is strong enough for the next dungeon.

**Auto-embark caution:** toggling auto-embark on and then clicking a different dungeon button can cause the game to re-embark the previously cleared dungeon instead of the newly selected one. Always disable auto-embark first, then explicitly click `embark` after selecting the new dungeon.