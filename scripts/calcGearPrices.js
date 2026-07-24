const fs = require('fs');
const path = require('path');

const GEAR_DIR = path.join(__dirname, '..', 'public', 'gear');

const FILES = {
  armorsLight: { file: 'armorLight.json', kind: 'defensive', slot: 'armor' },
  armorsMedium: { file: 'armorMedium.json', kind: 'defensive', slot: 'armor' },
  armorsHeavy: { file: 'armorHeavy.json', kind: 'defensive', slot: 'armor' },
  feetWearLight: { file: 'feetWearLight.json', kind: 'defensive', slot: 'shoes' },
  feetWearMedium: { file: 'feetWearMedium.json', kind: 'defensive', slot: 'shoes' },
  feetWearHeavy: { file: 'feetWearHeavy.json', kind: 'defensive', slot: 'shoes' },
  headgearLight: { file: 'headgearLight.json', kind: 'defensive', slot: 'helmet' },
  headgearMedium: { file: 'headgearMedium.json', kind: 'defensive', slot: 'helmet' },
  headgearHeavy: { file: 'headgearHeavy.json', kind: 'defensive', slot: 'helmet' },
  weaponMelee: { file: 'weaponMelee.json', kind: 'weapon', slot: 'weapon' },
  weaponRanged: { file: 'weaponRanged.json', kind: 'weapon', slot: 'weapon' },
  weaponMagic: { file: 'weaponMagic.json', kind: 'weapon', slot: 'weapon' },
};

const DEFENSE_WEIGHT = { armor: 1.0, helmet: 0.67, shoes: 0.33 };

const SURVIVABILITY = new Set(['VIT', 'HP']);

function bonusWeight(stat) {
  if (stat === 'HP') return 0.7;
  if (stat === 'VIT') return 1.5;
  return SURVIVABILITY.has(stat) ? 1.5 : 1.0;
}

function sumBonuses(item, weightFn) {
  const b = item.bonuses || {};
  return Object.entries(b).reduce(
    (sum, [stat, val]) => sum + val * (weightFn ? weightFn(stat) : 1.0),
    0
  );
}

function scoreDefensive(item, slot) {
  const defWeight = DEFENSE_WEIGHT[slot] || 1.0;
  return (
    (item.defense || 0) * defWeight +
    (item.magicResist || 0) * 0.0 +
    sumBonuses(item, bonusWeight)
  );
}

const TYPICAL_STATS = {
  melee:   { STR: 20, DEX: 15, AGI: 15, VIT: 10 },
  ranged:  { STR: 10, DEX: 25, AGI: 15 },
  magic:   { INT: 25, CNC: 25 },
};

function estimateDamageModifier(item) {
  const mods = item.damageModifiers || {};
  const type = item.type || 'melee';
  const stats = TYPICAL_STATS[type] || TYPICAL_STATS.melee;
  const bonus = Object.entries(mods).reduce((sum, [stat, weight]) => {
    return sum + (stats[stat] || 0) * weight * 0.03;
  }, 0);
  return 1 + bonus;
}

function weaponBonusWeight(stat, item) {
  const type = item?.type || 'melee';
  if (type === 'magic' && (stat === 'INT' || stat === 'CNC')) return 1.5;
  if (type === 'ranged' && stat === 'DEX') return 1.5;
  if (type === 'melee' && stat === 'STR') return 1.5;
  if (stat === 'HP') return 0.7;
  if (stat === 'VIT') return 1.2;
  return 1.0;
}

function scoreWeapon(item) {
  const modMult = estimateDamageModifier(item);
  const effectiveDamage = (item.damage || 0) * modMult;
  const effectiveSpellPower = (item.spellPower || 0) * modMult;
  return (
    effectiveDamage +
    effectiveSpellPower / 8 +
    (item.attackSpeed || 1) * 0.8 +
    sumBonuses(item, stat => weaponBonusWeight(stat, item))
  );
}

function normalize(score, minScore, maxScore) {
  const span = maxScore - minScore;
  if (span === 0) return 30;
  const raw = 20 + ((score - minScore) / span) * 20;
  const rounded = Math.round(raw);
  return Math.round(rounded / 2) * 2;
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : ' '.repeat(n - s.length) + s;
}

function updateGearPrices() {
  for (const { file, kind, slot } of Object.values(FILES)) {
    const filePath = path.join(GEAR_DIR, file);
    const items = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const scoreFn = kind === 'defensive' ? scoreDefensive : scoreWeapon;
    const scores = items.map(item => scoreFn(item, slot));
    const allScores = Object.values(FILES)
      .filter(f => f.kind === kind)
      .flatMap(f => {
        const it = JSON.parse(fs.readFileSync(path.join(GEAR_DIR, f.file), 'utf8'));
        return it.map((item, i) => scoreFn(item, f.slot));
      });
    const minScore = Math.round(Math.min(...allScores) * 100) / 100;
    const maxScore = Math.round(Math.max(...allScores) * 100) / 100;

    items.forEach((item, i) => {
      item.value = normalize(Math.round(scores[i] * 100) / 100, minScore, maxScore);
    });

    fs.writeFileSync(filePath, JSON.stringify(items, null, 2) + '\n');
    console.log(`Updated ${file}`);
  }
}

function main() {
  const mode = process.argv[2];
  if (mode === 'update') {
    updateGearPrices();
    return;
  }

  const categories = { defensive: [], weapon: [] };
  for (const { file, kind, slot } of Object.values(FILES)) {
    const items = JSON.parse(
      fs.readFileSync(path.join(GEAR_DIR, file), 'utf8')
    );
    const scoreFn = kind === 'defensive' ? scoreDefensive : scoreWeapon;
    const scores = items.map(item => scoreFn(item, slot));
    categories[kind].push({ file, items, scores });
  }

  for (const kind of ['defensive', 'weapon']) {
    const allScores = categories[kind].flatMap(c => c.scores);
    const minScore = Math.round(Math.min(...allScores) * 100) / 100;
    const maxScore = Math.round(Math.max(...allScores) * 100) / 100;

    for (const { file, items, scores } of categories[kind]) {
      console.log(`\n=== ${file} (${kind}) ===`);
      console.log(
        pad('id', 16) +
          pad('score', 10) +
          pad('current', 10) +
          pad('calc', 10) +
          pad('delta', 8)
      );
    items.forEach((item, i) => {
      const calc = normalize(Math.round(scores[i] * 100) / 100, minScore, maxScore);
      const delta = calc - item.value;
      console.log(
        pad(item.id, 16) +
          pad(Math.round(scores[i] * 100) / 100, 10) +
          pad(item.value, 10) +
          pad(calc, 10) +
          pad(delta, 8)
      );
    });
    }
  }
}

main();
