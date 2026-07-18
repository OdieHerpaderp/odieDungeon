## Skills & Abilities Replacement Plan (venture system → skills/abilities)

### Goal
Replace the current **venture/class system** with a new **Skills & Abilities** system such that:

- **Skills level up by usage**
  - **Weapon successful hits** grant XP to the mapped skill
  - **Successful ability casts** grant XP to the skill that owns that ability
- **Skills unlocking**
  - Abilities have `unlockSkillLevelMin`
  - Leveling a skill unlocks abilities at that threshold
- **Abilities are spells/tricks**
  - Up to **8 unique abilities** can be assigned to slots
  - During cast selection, the system picks the **first available ability** by:
    - cooldown ready
    - enough MP to cast
    - ability is unlocked
  - Ability casting is **independent from weapon attacks** (casting decision loop runs independently of weapon hit callbacks)

- **Inventory + Skills integration (weapon-type aware)**
  - Weapon items define a **weaponClass** (`melee`, `ranged`, `magic`) and the player equips exactly one weapon at a time.
  - WeaponClass determines:
    1. **which skill receives XP** on successful weapon hits (weapon-hit XP mapping)
    2. **which abilities are eligible** to be cast in the 8-slot system (ability weapon compatibility)

---

## 1) What we’re replacing (inventory of existing venture system)

### 1.1 Current venture assets
- `public/ventures.js`
  - `ventureGroups`: lists venture tiers + prerequisites
  - `ventureEffects`: per-venture “behavior objects” with:
    - `modifyStats`
    - `modifyActionBarFill`
    - `use` (MP spending / special activation)
    - `onHit`, `onCrit`, `onMiss`
  - `defaultCharacterValues` includes:
    - `currentVenture`
    - `ventures` (xp by venture key)
  - helper logic:
    - `calcVentureLv(xp)`
    - `getAllPlayerVentures()`
    - DoT/HoT support: `processDotTicks`, `processHotTicks`, `applyDot`, `applyHot`

### 1.2 Runtime dependencies (found via search)
- `enemies.js`:
  - enemies use `enemyData.ventures` and `currentVenture` for combat stat behavior
- `database.js`:
  - persistence exports `currentVenture` and `ventures`
- `debug.js`:
  - logs venture levels derived from `calcVentureLv(actor.ventures[...])`
- UI and combat triggers (not yet fully inspected):
  - likely exist in `app.js`, `appWebRTC.js`, `public/index.js`, `public/clientNetwork.js`, and/or `public/index.html`

**Key replacement implication:** venture behavior currently drives:
- passive stat mods
- action bar fill / tempo mods
- active “use” behaviors consuming MP
- hit/crit/miss reactions
These must be migrated or substituted.

---

## 1b) Inventory contract (so skills/abilities can work correctly)

This section merges `inventoryPlan.md` into the skills/abilities spec so that both systems “agree” on what weapon types are and how they influence skills.

### 1b.1 Gear slots
- Weapon
- Headgear
- Armor

### 1b.2 Weapon item definition (JSON contract)
Base fields (from `inventoryPlan.md`):
- `id`, `Name`
- `Type` (currently examples say `Melee`—this is not sufficient for skills integration)
- `Damage`, `AttackSpeed`, `Bonuses`, `Range`, `Value`, `Description`

**Required new field for skills integration:**
- `weaponClass` (string enum): `"melee" | "ranged" | "magic"`

**Optional field (recommended):**
- `defaultSkillIdOnHit` (string)
  - If present, successful weapon hits grant XP to this specific `skillId`.
  - If absent, fall back to mapping rules by `weaponClass`.

**Player’s equipped weapon slot (runtime representation)**
- `name`: refers to the weapon item `id`
- `Level`, `Rarity`: scales damage/stat modifiers (as currently planned)

---

## 2) New system architecture

### 2.1 Skills (leveled by usage)
A **skill** is static definition + runtime progress.

**Static definition (JSON)**
- `id` (string)
- `name`, `description`
- leveling model:
  - `xpToNextLevel(level)` (or a curve)
- usage-to-xp mapping:
  - weapon success events → grants xp to specific skill
  - ability cast events → grants xp to the ability’s owning skill

**Runtime state (per character)**
- `skillsState: { [skillId]: { level, xp } }`

### 2.2 Abilities (spells/tricks)
An **ability** is static definition + runtime cooldown gating.

**Static definition (JSON)**
- `id` (string)
- `name`, `description`
- `skillId` (owning skill that grants XP on successful casts)
- `unlockSkillLevelMin`
- type: spell/trick

**Cost + gating**
- `mpCostBase`
- `cooldownMsBase`
- optional scaling with owning skill level:
  - `mpCostMultiplierBySkillLevel`
  - `cooldownMultiplierBySkillLevel`

**Targeting**
- single enemy / multi enemy / lowest hp ally / etc. (depends on engine needs)

**Effect execution logic**
- apply damage/heal/buff/debuff/DoT/HoT/CC
- may reuse existing combat effect helpers (DoT/HoT system already exists in ventures.js)

**Runtime state (per character/party combatant)**
- `abilitySlots: Array(8).fill(null).map(slot -> abilityId)`
- `abilityCooldowns: { [abilityId]: nextAvailableTimestamp }`

**NEW: Weapon compatibility for ability casting**
To make ranged/magic weapons meaningful even though casting is independent of weapon hits:

- `allowedWeaponClasses?: Array<string>` (optional enum list)
  - if omitted, ability is compatible with all weapon classes
  - if present, ability can only be cast when the equipped weapon’s `weaponClass` is included
- `requiresWeaponEquipped?: boolean` (optional; default false)
  - if true, block casting when no weapon is equipped
- `castUsesWeaponDamageModel?: boolean` (optional; default true)
  - affects how damage scales during execution (e.g., magic weapons may scale off weapon damage/bonuses)
  - does NOT affect eligibility unless you explicitly want it to

---

## 2b) Weapon-hit → skill XP mapping (weapon type aware)

When a weapon hit resolves as successful, the system must determine the relevant `skillId` using this precedence order:

1) **Weapon-defined mapping**
- If equipped weapon item JSON includes `defaultSkillIdOnHit`, use it.

2) **Weapon-class mapping**
- Else map by `weapon.weaponClass`:
  - `"melee"` → a configured melee hit skill (e.g., `skill_melee`)
  - `"ranged"` → a configured ranged hit skill (e.g., `skill_ranged`)
  - `"magic"` → a configured magic hit skill (e.g., `skill_magic`)

3) **Fallback**
- If neither exists, use a safe fallback skill id (configurable) or ignore XP.

“Successful” here must remain:
- only non-miss / non-dodge / non-blocked hits grant XP.

---

## 3) Casting behavior rules (core requirement) with weapon awareness

### 3.1 Uniqueness (existing)
- Slots may contain up to **8 unique abilities**
- Same abilityId cannot appear in more than one filled slot

### 3.2 Selection (existing, with weapon eligibility extension)
Casting occurs on the combat “cast opportunity” tick (same style as venture “use” loop).

At cast time:
- iterate slots in increasing order (slot 0 → 7)
- choose the **first ability** that satisfies:

1. unlocked  
   - `skillsState[ability.skillId].level >= ability.unlockSkillLevelMin`

2. cooldown ready  
   - `now >= abilityCooldowns[abilityId]`

3. enough MP  
   - `player.mp >= effectiveMpCost`

4. weapon eligibility (NEW)  
   - `allowedWeaponClasses` check:
     - if defined: equipped weaponClass must be included
     - if undefined: compatible with all
   - `requiresWeaponEquipped` check:
     - if true: weapon must be equipped

Then:
- cast it, deduct MP, set cooldown.

### 3.3 Independence from weapon attacks (existing + must not be broken)
The casting loop must not rely on `onHit` / weapon hit triggers.
It runs based on time/action opportunities already used by venture “use” mechanics, or via a new timer/tick loop.

---

## 4) Skill leveling rules (explicit, with weapon type integration)

### 4.1 Weapon successful hits → skill XP (updated)
When a weapon hit resolves as successful:
- determine relevant `skillId` using section **2b**
- add XP:
  - `skillsState[skillId].xp += xpAmount`
- on level up:
  - recompute `level`
  - potentially unlock new abilities

### 4.2 Successful ability casts → skill XP (unchanged)
When an ability cast passes gating and executes effects:
- add XP to:
  - `skillsState[ability.skillId]`

“Successful” should mean:
- cast not blocked by cooldown/MP
- effect execution occurs (even if it misses due to target conditions, depending on your desired design)
- weapon eligibility gates were also satisfied

### 4.3 Leveling unlocks abilities (unchanged)
Unlocking is via `ability.unlockSkillLevelMin`.

Once unlocked:
- abilities can be slotted freely
- slot uniqueness rules still apply

---

## 5) Replacing venture mechanics with skills/abilities

### 5.1 Migration mapping strategy (practical)
Ventures currently mix several concerns:
- passive `modifyStats`
- tempo / action bar effects (`modifyActionBarFill`)
- active MP `use` behaviors
- reactive triggers (`onHit/onCrit/onMiss`)

New system only requires:
- skill leveling by usage
- ability casting independent from weapon attacks

**Minimal viable migration**
1. Convert venture “active” behaviors into abilities:
   - `use(actor, target, party, combatStats)` becomes `ability.cast(...)`
   - MP cost becomes `mpCostBase` (or scaled)
   - venture-driven action bar / tempo becomes an ability effect if needed
2. Keep passive `modifyStats` temporarily:
   - either ignore (if you want a clean cut), or
   - progressively migrate to skills later as “passives”
3. Reactive triggers (`onCrit/onHit`) can remain for now, but should eventually become:
   - either passive skill effects
   - or triggered effects attached to skills/abilities

Because the task explicitly focuses on replacing venture system with skills/abilities, we’ll prioritize:
- removing venture selection/progression
- implementing ability slot + cast selection + cooldown/MP gating
- skill XP awarding

**NEW integration note:** reactive hit triggers should no longer decide ability casting. Weapon hits only award weapon-hit XP to the mapped skill (section 2b). Ability casting selection remains independent.

### 5.2 Runtime hooks to change
We must locate the current venture execution path:
- where action bar “use” functions are triggered
- where venture MP spends occur
- where cooldown-like behavior might already exist

Then replace with:
- ability slot casting loop

**Expected code locations (to inspect next):**
- `app.js` and/or `public/index.js` for tick loop
- `public/clientNetwork.js` for syncing state
- `database.js` for persistence fields

---

## 6) UI and networking changes (inventory-aware)

### 6.1 UI replacement
Replace venture UI elements (if present) with:
- Skill list showing:
  - skill name
  - level
  - XP bar (optional)
  - optional hint: “weaponClass affects which skill gains XP from hits”
- Ability slot editor (8 slots):
  - show assigned ability icons
  - block/ungray abilities not unlocked
  - optionally also block/ungray abilities incompatible with current equipped weaponClass

### 6.2 Networking/persistence updates
- Persist `skillsState` and `abilitySlots`
- Persist cooldowns only during combat session (usually not saved)
- Replace `currentVenture` and `ventures` persistence (or keep for transitional compatibility)

---

## 7) Data files to be introduced (recommended, weapon-aware)

Add JSON definitions (and possibly engines):

- `public/skills/skills.json` (or multiple JSON files)
- `public/abilities/abilities.json`
- `public/skills/skillEngine.js`
- `public/abilities/abilityEngine.js`

**Weapon compatibility data support:**
- Ensure ability JSON supports `allowedWeaponClasses` (or equivalent)
- Ensure weapon JSON supports `weaponClass` (and optional `defaultSkillIdOnHit`)

---

## 8) Testing checklist (must-have, updated for integration)

- [ ] Weapon successful hits grant XP to the correct mapped skill **based on equipped weaponClass**
- [ ] Weapon override works:
  - if `defaultSkillIdOnHit` exists, it is used
- [ ] Successful ability casts grant XP to `ability.skillId`
- [ ] Ability casting chooses first available ability by slot order (0→7) with uniqueness enforced
- [ ] Cooldown prevents cast until ready
- [ ] MP prevents cast when insufficient
- [ ] Casting works independently from weapon attack triggers
- [ ] Ability unlock gating works via `unlockSkillLevelMin`
- [ ] Slot editor enforces uniqueness and allows changing slots freely post-unlock
- [ ] Weapon compatibility gating works:
  - ability with `allowedWeaponClasses` cannot cast with incompatible equipped weapon
  - ability with no `allowedWeaponClasses` is castable with any weaponClass

---

## 9) Step-by-step implementation order (what we’ll do in code)

1. Update weapon data schema:
   - add `weaponClass` and (optional) `defaultSkillIdOnHit`

2. Implement weapon hit → skill XP mapping:
   - apply section **2b** precedence order

3. Implement skillsState persistence + skill leveling

4. Update ability data schema:
   - add `allowedWeaponClasses` and optional execution scaling flags

5. Implement ability cast selection loop:
   - 8-slot uniqueness
   - slot order iteration
   - cooldown/MP/unlock gating
   - weapon compatibility gating (section **3.2**)

6. Implement skill XP award hooks:
   - weapon hit success → skill XP (section **4.1**)
   - successful cast execution → XP (section **4.2**)

7. Update UI + client networking:
   - slot editor enforces uniqueness
   - UI can reflect unlock + weapon compatibility

8. Migrate/reset existing saves:
   - ensure old saves don’t break new schema (fallback to defaults for new fields)

This combined plan ensures:
- skills level by usage (successful hits + successful casts)
- abilities remain independent from weapon attack triggers
- weaponClass from inventory meaningfully affects:
  - which skill receives XP on hits
  - which abilities are eligible to cast
- casting chooses the first available ability from 8 slots
- ability unlock and free slot assignment are supported

---

## 2) New system architecture

### 2.1 Skills (leveled by usage)
A **skill** is static definition + runtime progress.

**Static definition (JSON)**
- `id` (string)
- `name`, `description`
- leveling model:
  - `xpToNextLevel(level)` (or a curve)
- usage-to-xp mapping:
  - weapon success events → grants xp to specific skill
  - ability cast events → grants xp to the ability’s owning skill

**Runtime state (per character)**
- `skillsState: { [skillId]: { level, xp } }`

### 2.2 Abilities (spells/tricks)
An **ability** is static definition + runtime cooldown gating.

**Static definition (JSON)**
- `id` (string)
- `name`, `description`
- `skillId` (owning skill that grants XP on successful casts)
- `unlockSkillLevelMin` (we confirmed YES)
- type: spell/trick
- cost + gating:
  - `mpCostBase`
  - `cooldownMsBase`
  - optional scaling with owning skill level:
    - `mpCostMultiplierBySkillLevel`
    - `cooldownMultiplierBySkillLevel`
- cast targeting:
  - single enemy / multi enemy / lowest hp ally / etc. (depends on engine needs)
- effect execution logic:
  - apply damage/heal/buff/debuff/DoT/HoT/CC
  - may reuse existing combat effect helpers (DoT/HoT system already exists in ventures.js)

**Runtime state (per character/party combatant)**
- `abilitySlots: Array(8).fill(null).map(slot -> abilityId)`
- `abilityCooldowns: { [abilityId]: nextAvailableTimestamp }`

### 2.3 Casting behavior rules (core requirement)
**Uniqueness**
- Slots may contain up to **8 unique abilities**
- Same abilityId cannot appear in more than one filled slot

**Selection**
- Casting occurs on the combat “cast opportunity” tick (same style as venture use loop).
- At cast time:
  - iterate slots in increasing order (slot 0 → 7)
  - choose the **first ability** that satisfies:
    1. unlocked (`skillsState[ability.skillId].level >= unlockSkillLevelMin`)
    2. cooldown ready (`now >= cooldowns[abilityId]`)
    3. enough MP (`player.mp >= effectiveMpCost`)
- Cast it, deduct MP, set cooldown.

**Independence from weapon attacks**
- The casting loop must not rely on `onHit` / weapon hit triggers.
- It should run based on time/action opportunities already used by venture “use” mechanics, or via a new timer/tick loop.

---

## 3) Skill leveling rules (explicit)

### 3.1 Weapon successful hits → skill XP
When a weapon hit resolves as successful:
- determine the relevant `skillId` (mapping rules)
- add XP:
  - `skillsState[skillId].xp += xpAmount`
- on level up:
  - recompute `level`
  - potentially unlock new abilities

**Success definition**
- only successful hits (no miss/dodge) should grant XP.

### 3.2 Successful ability casts → skill XP
When an ability cast passes gating and executes effects:
- add XP to `skillsState[ability.skillId]`

“Successful” should mean:
- cast not blocked by cooldown/MP
- effect execution occurs (even if it misses due to target conditions, depending on desired design)

### 3.3 Leveling unlocks abilities
We confirmed:
- unlocking is via `ability.unlockSkillLevelMin`
- once unlocked, abilities can be slotted freely

So if a player already has an ability unlocked:
- they can assign it to any of the 8 slots (still respecting uniqueness)

---

## 4) Replacing venture mechanics with skills/abilities

### 4.1 Migration mapping strategy (practical)
Ventures currently mix several concerns:
- passive `modifyStats`
- tempo / action bar effects (`modifyActionBarFill`)
- active MP `use` behaviors
- reactive triggers (`onHit/onCrit/onMiss`)

New system only requires:
- skill leveling by usage
- ability casting independent from weapon attacks

**Minimal viable migration**
1. Convert venture “active” behaviors into abilities:
   - `use(actor, target, party, combatStats)` becomes `ability.cast(...)`
   - MP cost becomes `mpCostBase` (or scaled)
   - venture-driven action bar / tempo becomes an ability effect if needed
2. Keep passive `modifyStats` temporarily:
   - either ignore (if you want a clean cut), or
   - progressively migrate to skills later as “passives”
3. Reactive triggers (`onCrit/onHit`) can remain for now, but should eventually become:
   - either passive skill effects
   - or triggered effects attached to skills/abilities

Because the task explicitly focuses on replacing venture system with skills/abilities, we’ll prioritize:
- removing venture selection/progression
- implementing ability slot + cast selection + cooldown/MP gating
- skill XP awarding

### 4.2 Runtime hooks to change
We must locate the current venture execution path:
- where action bar “use” functions are triggered
- where venture MP spends occur
- where cooldown-like behavior might already exist

Then replace with:
- ability slot casting loop

**Expected code locations (to inspect next):**
- `app.js` and/or `public/index.js` for tick loop
- `public/clientNetwork.js` for syncing state
- `database.js` for persistence fields

---

## 5) UI and networking changes

### 5.1 UI replacement
Replace venture UI elements (if present) with:
- Skill list showing:
  - skill name
  - level
  - XP bar (optional)
- Ability slot editor (8 slots):
  - show assigned ability icons
  - block abilities not unlocked (optional UX)
  - allow swapping freely for unlocked abilities

### 5.2 Networking/persistence updates
- Persist `skillsState` and `abilitySlots`
- Persist cooldowns only during combat session (usually not saved)
- Replace `currentVenture` and `ventures` persistence (or keep for transitional compatibility)

---

## 6) Data files to be introduced (recommended)
Add JSON definitions (and possibly engines):

- `public/skills/skills.json` (or multiple JSON files)
- `public/abilities/abilities.json`
- `public/skills/skillEngine.js`
- `public/abilities/abilityEngine.js`

---

## 7) Testing checklist (must-have)
- [ ] Weapon successful hits grant XP to the correct mapped skill
- [ ] Successful ability casts grant XP to `ability.skillId`
- [ ] Ability casting chooses first available ability by slot order
- [ ] Cooldown prevents cast until ready
- [ ] MP prevents cast when insufficient
- [ ] Casting works independently from weapon attack triggers
- [ ] Ability unlock gating works via `unlockSkillLevelMin`
- [ ] Slot editor enforces uniqueness and allows changing slots freely post-unlock

---

## 8) Step-by-step implementation order (what we’ll do in code)

1. Locate venture execution trigger loop (where `ventureEffects[...].use` gets called / where action bar full results in MP/ability usage).
2. Replace venture progression storage:
   - add `skillsState` and `abilitySlots` to character schema
   - remove `currentVenture`/`ventures` usage from combat stat scaling and UI
3. Implement ability cast selection:
   - slot order iteration
   - cooldown/MP/unlock gating
   - cast effect execution
   - cooldown + MP deduction
4. Implement skill XP award hooks:
   - weapon hit success → skill XP
   - successful cast → skill XP
5. Implement unlock gating:
   - ability unlock checks against owning skill level
6. Update UI + client networking:
   - allow editing 8 slots for unlocked abilities
   - sync slot changes to server
7. Migrate or reset existing saved characters:
   - ensure old saves don’t break new schema

---

This plan is structured to ensure:
- skills level by usage (successful hits + successful casts)
- abilities are independent of weapons
- casting chooses the first available ability from 8 slots
- ability unlock and free slot assignment are supported
