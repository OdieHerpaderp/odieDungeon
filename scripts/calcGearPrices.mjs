import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const GEAR_DIR = path.join(__dirname, "..", "public", "gear");

const FILES = {
  chestLight: { file: path.join('chest', 'light.json'), kind: 'defensive', slot: 'chest' },
  chestMedium: { file: path.join('chest', 'medium.json'), kind: 'defensive', slot: 'chest' },
  chestHeavy: { file: path.join('chest', 'heavy.json'), kind: 'defensive', slot: 'chest' },
  feetWearLight: { file: path.join('feetWear', 'light.json'), kind: 'defensive', slot: 'shoes' },
  feetWearMedium: { file: path.join('feetWear', 'medium.json'), kind: 'defensive', slot: 'shoes' },
  feetWearHeavy: { file: path.join('feetWear', 'heavy.json'), kind: 'defensive', slot: 'shoes' },
  headgearLight: { file: path.join('headGear', 'light.json'), kind: 'defensive', slot: 'helmet' },
  headgearMedium: { file: path.join('headGear', 'medium.json'), kind: 'defensive', slot: 'helmet' },
  headgearHeavy: { file: path.join('headGear', 'heavy.json'), kind: 'defensive', slot: 'helmet' },
  offHand: { file: path.join('offHand', 'offHand.json'), kind: 'defensive', slot: 'offHand' },
  weaponMeleeBlunt: { file: path.join('WeaponMelee', 'blunt.json'), kind: 'weapon', slot: 'weapon' },
  weaponMeleeLongBlade: { file: path.join('WeaponMelee', 'longBlade.json'), kind: 'weapon', slot: 'weapon' },
  weaponMeleeShortBlade: { file: path.join('WeaponMelee', 'shortBlade.json'), kind: 'weapon', slot: 'weapon' },
  weaponMeleePolearms: { file: path.join('WeaponMelee', 'polearms.json'), kind: 'weapon', slot: 'weapon' },
  weaponMeleePugilism: { file: path.join('WeaponMelee', 'pugilism.json'), kind: 'weapon', slot: 'weapon' },
  weaponRangedSlings: { file: path.join('WeaponRanged', 'slings.json'), kind: 'weapon', slot: 'weapon' },
  weaponRangedBow: { file: path.join('WeaponRanged', 'bow.json'), kind: 'weapon', slot: 'weapon' },
  weaponRangedThrown: { file: path.join('WeaponRanged', 'thrown.json'), kind: 'weapon', slot: 'weapon' },
  weaponMagicRunes: { file: path.join('WeaponMagic', 'runes.json'), kind: 'weapon', slot: 'weapon' },
  weaponMagicRods: { file: path.join('WeaponMagic', 'rods.json'), kind: 'weapon', slot: 'weapon' },
  weaponMagicStaves: { file: path.join('WeaponMagic', 'staves.json'), kind: 'weapon', slot: 'weapon' },
};

const DEFENSE_WEIGHT = { chest: 1.0, helmet: 0.99, shoes: 0.99, offHand: 0.99 };

const SURVIVABILITY = new Set(["VIT", "HP"]);

function bonusWeight(stat) {
  if (stat === "HP") return 0.7;
  if (stat === "MP") return 0.8;
  if (stat === "AP") return 0.9;
  if (stat === "VIT") return 1.2;
  return SURVIVABILITY.has(stat) ? 1.2 : 1.0;
}

function sumBonuses(item, weightFn) {
  const b = item.bonuses || {};
  return Object.entries(b).reduce((sum, [stat, val]) => sum + val * (weightFn ? weightFn(stat) : 1.0), 0);
}

function scoreDefensive(item, slot) {
  const defWeight = DEFENSE_WEIGHT[slot] || 1.0;
  return (item.defense || 0) * defWeight + (item.magicResist || 0) * 0.0 + sumBonuses(item, bonusWeight);
}

const TYPICAL_STATS = {
  melee: { STR: 20, DEX: 15, AGI: 15, VIT: 13 },
  ranged: { STR: 10, DEX: 25, AGI: 15 },
  magic: { INT: 25, CNC: 25 },
};

function estimateDamageModifier(item) {
  const mods = item.damageModifiers || {};
  const type = item.type || "melee";
  const stats = TYPICAL_STATS[type] || TYPICAL_STATS.melee;
  const bonus = Object.entries(mods).reduce((sum, [stat, weight]) => {
    return sum + (stats[stat] || 0) * weight * 0.035;
  }, 0);
  return 1 + bonus;
}

function weaponBonusWeight(stat, item) {
  const type = item?.type || "melee";
  if (type === "magic" && (stat === "INT" || stat === "CNC")) return 1.3;
  if (type === "ranged" && stat === "DEX") return 1.3;
  if (type === "melee" && stat === "STR") return 1.3;
  if (stat === "HP") return 0.7;
  if (stat === "VIT") return 1.2;
  return 1.0;
}

function scoreWeapon(item) {
  const modMult = estimateDamageModifier(item);
  const effectiveDamage = (item.damage || 0) * modMult;
  const effectiveSpellPower = (item.spellPower || 0) * modMult;
  return effectiveDamage + effectiveSpellPower / 8 + (item.attackSpeed || 1) * 0.8 + sumBonuses(item, (stat) => weaponBonusWeight(stat, item));
}

function normalize(score, minScore, maxScore) {
  const span = maxScore - minScore;
  if (span === 0) return 30;
  const raw = 20 + ((score - minScore) / span) * 15;
  return Math.round(raw * 10) / 10;
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : " ".repeat(n - s.length) + s;
}

function updateGearPrices() {
  for (const { file, kind, slot } of Object.values(FILES)) {
    const filePath = path.join(GEAR_DIR, file);
    const items = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const scoreFn = kind === "defensive" ? scoreDefensive : scoreWeapon;
    const scores = items.map((item) => scoreFn(item, slot));
    const allScores = Object.values(FILES)
      .filter((f) => f.kind === kind)
.flatMap((f) => {
          const it = JSON.parse(fs.readFileSync(path.join(GEAR_DIR, f.file), "utf8"));
          return it.map((item) => scoreFn(item, f.slot));
        });
    const minScore = Math.round(Math.min(...allScores) * 200) / 200;
    const maxScore = Math.round(Math.max(...allScores) * 200) / 200;

    items.forEach((item, i) => {
      item.value = normalize(Math.round(scores[i] * 200) / 200, minScore, maxScore);
    });

    fs.writeFileSync(filePath, `${JSON.stringify(items, null, 2)}\n`);
    console.log(`Updated ${file}`);
  }
}

function main() {
  const mode = process.argv[2];
  if (mode === "update") {
    updateGearPrices();
    return;
  }

  const categories = { defensive: [], weapon: [] };
  for (const { file, kind, slot } of Object.values(FILES)) {
    const items = JSON.parse(fs.readFileSync(path.join(GEAR_DIR, file), "utf8"));
    const scoreFn = kind === "defensive" ? scoreDefensive : scoreWeapon;
    const scores = items.map((item) => scoreFn(item, slot));
    categories[kind].push({ file, items, scores });
  }

  for (const kind of ["defensive", "weapon"]) {
    const allScores = categories[kind].flatMap((c) => c.scores);
    const minScore = Math.round(Math.min(...allScores) * 200) / 200;
    const maxScore = Math.round(Math.max(...allScores) * 200) / 200;

    for (const { file, items, scores } of categories[kind]) {
      console.log(`\n=== ${file} (${kind}) ===`);
      console.log(pad("id", 16) + pad("score", 10) + pad("current", 10) + pad("calc", 10) + pad("delta", 8));
      items.forEach((item, i) => {
        const calc = normalize(Math.round(scores[i] * 200) / 200, minScore, maxScore);
        const delta = calc - item.value;
        console.log(pad(item.id, 16) + pad(Math.round(scores[i] * 200) / 200, 10) + pad(item.value, 10) + pad(calc, 10) + pad(delta, 8));
      });
    }
  }
}

main();
