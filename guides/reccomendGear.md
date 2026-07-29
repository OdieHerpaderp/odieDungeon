# Gear Recommendation Guide

## Purpose

This guide helps agents recommend gear for player roles based on the **current state of the codebase**. All gear data lives in JSON files under `public/gear/` and `public/abilities/`. Agents must read these files directly rather than relying on memorized values, since weapon stats, abilities, and offhand options can change.

---

## How to gather current data

### Weapon data

Read the weapon JSON files to get current stats:

| Subtype | File path |
|---|---|
| Melee — Blunt | `public/gear/WeaponMelee/blunt.json` |
| Melee — Long Blade | `public/gear/WeaponMelee/longBlade.json` |
| Melee — Short Blade | `public/gear/WeaponMelee/shortBlade.json` |
| Melee — Polearms | `public/gear/WeaponMelee/polearms.json` |
| Melee — Pugilism | `public/gear/WeaponMelee/pugilism.json` |
| Ranged — Slings | `public/gear/WeaponRanged/slings.json` |
| Ranged — Bow | `public/gear/WeaponRanged/bow.json` |
| Ranged — Thrown | `public/gear/WeaponRanged/thrown.json` |
| Magic — Runes | `public/gear/WeaponMagic/runes.json` |
| Magic — Rods | `public/gear/WeaponMagic/rods.json` |
| Magic — Staves | `public/gear/WeaponMagic/staves.json` |

For each weapon, note: `damage`, `spellPower`, `attackSpeed`, `bonuses`, `damageModifiers`, `twoHanded`, and `subType`.

### Offhand data

Read `public/gear/offHand/offHand.json` for all offhand options (shields and books). Note `defense`, `magicResist`, `bonuses`, and `subType` (shield vs book vs grimoire).

### Armor data

Read the armor JSON files:

| Subtype | File path |
|---|---|
| Light | `public/gear/armor/light.json` |
| Medium | `public/gear/armor/medium.json` |
| Heavy | `public/gear/armor/heavy.json` |

For each armor, note: `defense`, `magicResist`, `bonuses`, and `type`.

### Feet wear data

Read the feet wear JSON files:

| Subtype | File path |
|---|---|
| Light | `public/gear/feetWear/light.json` |
| Medium | `public/gear/feetWear/medium.json` |
| Heavy | `public/gear/feetWear/heavy.json` |

### Ability data

Read the ability JSON files to understand what abilities each weapon subtype unlocks:

| Subtype | File path |
|---|---|
| Melee — Blunt | `public/abilities/skill_melee_blunt.json` |
| Melee — Long Blade | `public/abilities/skill_melee_longBlade.json` |
| Melee — Short Blade | `public/abilities/skill_melee_shortBlade.json` |
| Melee — Polearms | `public/abilities/skill_melee_polearms.json` |
| Melee — Pugilism | `public/abilities/skill_melee_pugilism.json` |
| Ranged — Archery (bows + slings) | `public/abilities/skill_archery.json` |
| Ranged — Thrown | `public/abilities/skill_thrown.json` |
| Magic | `public/abilities/skill_magic.json` |
| Spellcasting (universal) | `public/abilities/skill_spellcasting.json` |
| Two-handed (all 2H weapons) | `public/abilities/skill_twoHanded.json` |
| Healing — Miracles | `public/abilities/skill_miracles.json` |
| Healing — Shamanism | `public/abilities/skill_shamanism.json` |
| Support — Witchcraft | `public/abilities/skill_witchcraft.json` |

For each ability, note: `damageBase`, `healAmount`, `effects`, `targets`, `attributeDamageScale`, `unlockSkillLevelMin`, and `requiredWeaponSubTypes`.

---

## Key mechanics (constant across updates)

| Mechanic | Effect |
|---|---|
| **Two-handed weapons** | 50% chance to hit an additional target with every weapon attack. This is a passive proc, not an ability. |
| **Ability cooldowns** | Independent from weapon attacks and ASPD. The primary bottleneck for ability usage is **MP regeneration**. |
| **INT / CNC** | Drives MP pool and regeneration. Higher INT/CNC means more abilities used per fight. Valuable for **all** roles, not just magic users. |
| **AP (Ability Power)** | Multiplies ability damage/healing. Relevant for any build that uses abilities frequently. |
| **Range** | An unused mechanic. Do not factor it into gear decisions. |
| **Two-handed weapons** | Cannot equip an offhand. Sacrifice offhand stat bonuses for exclusive twoHanded abilities (from `skill_twoHanded.json`). |
| **One-handed weapons** | Can equip an offhand. Gain offhand stat bonuses but cannot use twoHanded exclusive abilities. |

---

## Role recommendation methodology

For each role, follow this process:

1. **Identify the primary stat** the role scales with (see Stat Priority table below).
2. **Query weapon JSON files** for subtypes that scale with that stat. Compare `damage`, `attackSpeed`, `bonuses`, and `damageModifiers` across weapons.
3. **Query ability JSON files** for the subtype's proficiency abilities. Note `damageBase`, `healAmount`, `effects`, and `unlockSkillLevelMin`.
4. **Check for two-handed weapons** in the subtype. If present, note the 50% extra target proc and access to `skill_twoHanded.json` abilities.
5. **Select the offhand** that best supplements the primary stat. Shields add defense + STR/VIT; books add INT/CNC/AP/MP.
6. **Select armor and feet wear** that maximize the primary stat while providing adequate defense.
7. **Verify the build is coherent** — the offhand must be compatible with the weapon (one-handed weapons can use offhands; two-handed cannot).

### Stat priority by role

| Role | Primary Stat | Secondary Stat | Tertiary Stat |
|---|---|---|---|
| Melee DPS (1H) | AGI / DEX | STR | INT/CNC (MP regen) |
| Melee DPS (2H) | STR | DEX | INT/CNC (MP regen) |
| Ranged DPS | DEX / CNC | STR | INT/CNC (MP regen) |
| Magic DPS | INT | CNC | AP |
| Tank | VIT | STR | HP |
| Healer / Support | INT | CNC | AP |

### Armor selection by role

| Role | Armor Subtype | Selection Criteria |
|---|---|---|
| Melee DPS | Light | Highest defense with AGI/DEX/STR bonuses |
| Ranged DPS | Light | Highest defense with AGI/DEX/STR bonuses |
| Magic DPS | Light | Highest INT + CNC + AP |
| Tank | Heavy | Highest defense with VIT + HP |
| Healer | Light | Highest CNC + INT + AP |

### Offhand selection by role

| Role | Offhand Type | Selection Criteria |
|---|---|---|
| Melee DPS (1H) | Shield | STR+ bonus, moderate defense |
| Tank | Shield | Highest defense + VIT+ bonus |
| Magic DPS | Book | Highest INT + CNC + AP + MP |
| Healer | Book | Highest INT + CNC + AP + MP |
| Melee DPS (2H) | None | Two-handed weapons cannot equip offhands |

---

## Role Recommendations

### Melee Damage Dealer (Single-Target)

**Process:**
1. Query all melee weapon JSON files for one-handed weapons with the highest `damage` and `attackSpeed`.
2. Check `skill_melee_shortBlade.json` for proficiency abilities (Quick Jab, Backstab, Blade Flurry).
3. Short Blade has the highest ASPD (1.6) and AGI/DEX scaling — ideal for single-target burst.
4. Select Buckler offhand (STR+3, AGI+2) to support melee scaling.
5. Select Assassin Vest (light armor, highest defense at 10, AGI+5, DEX+5, STR+3).
6. Select Assassin Boots (AGI+5, DEX+4, STR+2).

**Alternate two-handed path:** If the player prefers AoE, query `skill_twoHanded.json` for Earthquake (18 dmg, 3-5 targets) and Whirlwind Spin (13 dmg, 2-4 targets). Use a two-handed Great Sword or Halberd. No offhand is possible.

---

### Melee Damage Dealer (AoE / Crowd Control)

**Process:**
1. Query two-handed melee weapons (Great Sword, Iron Maul, Halberd).
2. Check `skill_twoHanded.json` for Earthquake and Whirlwind Spin — the strongest AoE abilities.
3. The 50% extra target proc on two-handed weapon attacks makes every swing hit multiple targets.
4. Select Assassin Vest + Assassin Boots for mobility.
5. No offhand (two-handed weapon).

---

### Ranged Damage Dealer

**Process:**
1. Query `public/gear/WeaponRanged/bow.json` — bows have the highest damage (9–13) and range among ranged subtypes.
2. Check `skill_archery.json` for proficiency abilities (Snap Shot, Snare Shot, Double Shot, Piercing Volley).
3. Long Bow has the highest base damage (13) and CNC+STR scaling.
4. Select Buckler offhand (STR+3, AGI+2).
5. Select Assassin Vest + Assassin Boots for AGI/DEX/STR scaling.

**Note:** Slings (`public/gear/WeaponRanged/slings.json`) have only 1 weapon and no unique abilities. Bows are strictly superior.

---

### Magic Damage Dealer

**Process:**
1. Query all magic weapon JSON files. Staves have the highest INT (15) and CNC (10).
2. Check `skill_magic.json` and `skill_spellcasting.json` for abilities (Arcane Lance, Mystic Burst, Fireball).
3. Staves are one-handed — they can equip an offhand.
4. Select Grimoire offhand (INT+8, CNC+4, AP+18, MP+6) — the best magic offhand.
5. Select Wizard Robe (INT+4, CNC+4, AP+11) and Wizard's Boots (INT+6, CNC+4, AP+4).
6. INT/CNC from gear drives MP regeneration — the primary bottleneck for ability usage.

---

### Tank

**Process:**
1. Query `public/gear/WeaponMelee/blunt.json` — blunt has the most one-handed options (4 of 5 weapons), allowing shield use.
2. Check `skill_melee_blunt.json` for proficiency abilities (Bash, Wallop, Concussive Slam, Sweep).
3. Select Kite Shield offhand (defense 7, VIT+3, STR+2) — the best defensive offhand.
4. Select Plate Armor (heavy, defense 16, VIT+6, HP+20) and Plate Greaves (defense 8, VIT+6, HP+14).
5. Heavy armor penalties (-1 INT/CNC/AGI) are irrelevant for tanks.

**Alternate two-handed tank path:** Query `skill_melee_polearms.json` and `skill_twoHanded.json`. Halberd (2H) + Earthquake (AoE slow) + 50% extra target proc. Sacrifices shield survivability for AoE crowd control.

---

### Healer / Support

**Process:**
1. Staves are one-handed and can equip an offhand. Query `public/gear/WeaponMagic/staves.json`.
2. Check `skill_miracles.json` for healing abilities (Blessed Touch, Holy Light, Divine Mend).
3. Select Grimoire offhand (INT+8, AP+18, MP+6) — maximizes healing output and MP pool.
4. Select Cleric Robe (light, CNC+6, INT+2, AP+11) and Cleric's Boots (CNC+8, INT+2, AP+4).
5. CNC is the primary healing stat — healing abilities scale with CNC via `attributeDamageScale`.
6. INT drives heal scaling; AP multiplies healing magnitude.

---

## Common mistakes to avoid

1. **Equipping a two-handed weapon and expecting to use a shield.** Two-handed weapons lock the offhand slot.
2. **Ignoring INT/CNC for non-magic builds.** MP is the primary bottleneck for all ability users. Even a melee tank benefits from INT/CNC gear for cooldown reduction.
3. **Using slings as a ranged weapon.** Slings have only 1 weapon and no unique abilities. Bows are strictly superior.
4. **Using runes as a magic weapon.** Runes have only 1 weapon with the lowest SpellPower of all magic subtypes. Rods and staves are vastly better.
5. **Wearing heavy armor as a magic DPS or healer.** Heavy armor penalties (-1 INT, -1 CNC, -1 AGI) directly hurt magic scaling and MP regeneration. Light armor is always better for magic builds.
6. **Forgetting that two-handed weapons get a 50% extra target proc.** This passive AoE effect makes two-handed weapons the dominant choice for multi-target scenarios, even with lower ASPD.