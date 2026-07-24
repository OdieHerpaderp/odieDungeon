const fs = require('fs');
const path = require('path');

const sourcePath = path.join(__dirname, 'public', 'dungeons.json');
const backupPath = path.join(__dirname, 'public', 'dungeonsOld.json');

const firstDungeonStats = {
  floorBase: 0.722,
  floorMult: 0.062,
  floorAmount: 8
};

const dungeonList = [
  { name: 'field', emoji: '🌿', background: '#224422' },
  { name: 'backyard', emoji: '🌻', background: '#2d2a1d' },
  { name: 'meadow', emoji: '🌱', background: '#1a3a1a' },
  { name: 'farm', emoji: '🌾', background: '#323311' },
  { name: 'orchard', emoji: '🍎', background: '#24411a' },
  { name: 'garden', emoji: '🌷', background: '#72485f' },
  { name: 'cellar', emoji: '🪵', background: '#48301c' },
  { name: 'village', emoji: '🏘️', background: '#2a3a2a' },
  { name: 'school', emoji: '📖', background: '#111122' },
  { name: 'dojo', emoji: '🥋', background: '#23363b' },
  { name: 'chapel', emoji: '🕯️', background: '#2b2230' },
  { name: 'shrine', emoji: '⛩️', background: '#2a1a2a' },
  { name: 'forest', emoji: '🌲', background: '#112200' },
  { name: 'watchtower', emoji: '🗼', background: '#22304a' },
  { name: 'outpost', emoji: '⚔️', background: '#2b2b1f' },
  { name: 'sewers', emoji: '🚰', background: '#10231d' },
  { name: 'mine', emoji: '⛏️', background: '#2a2520' },
  { name: 'cave', emoji: '🪨', background: '#332200' },
  { name: 'desert', emoji: '🏜️', background: '#cc9933' },
  { name: 'canyon', emoji: '🌄', background: '#cc7711' },
  { name: 'clocktower', emoji: '🕰️', background: '#2b241b' },
  { name: 'ruins', emoji: '🗿', background: '#111122' },
  { name: 'temple', emoji: '🛕', background: '#2a1b2f' },
  { name: 'graveyard', emoji: '⚰️', background: '#1a1a22' },
  { name: 'mausoleum', emoji: '🪦', background: '#221a22' },
  { name: 'catacombs', emoji: '🕸️', background: '#151018' },
  { name: 'crypt', emoji: '💀', background: '#1a1015' },
  { name: 'swamp', emoji: '🪤', background: '#0b2b1f' },
  { name: 'castle', emoji: '🏰', background: '#330000' },
  { name: 'fortress', emoji: '🏯', background: '#2a0a0a' },
  { name: 'labyrinth', emoji: '🌀', background: '#1b1b2a' },
  { name: 'laboratory', emoji: '🔬', background: '#111111' },
  { name: 'frozen wasteland', emoji: '❄️', background: '#1a2433' },
  { name: 'sky', emoji: '☁️', background: '#1b2b3a' },
  { name: 'sanctum', emoji: '✨', background: '#1a1330' },
  { name: 'volcano', emoji: '🌋', background: '#330800' },
  { name: 'starfield', emoji: '⭐', background: '#0f1a33' },
  { name: 'nebula', emoji: '🌌', background: '#2d1b4e' },
  { name: 'abyss', emoji: '🕳️', background: '#050505' },
  { name: 'void', emoji: '🌑', background: '#1a0a0a' },
  { name: 'apotheosis', emoji: '🕋', background: '#040202' }
];

const backup = fs.readFileSync(sourcePath, 'utf8');
fs.writeFileSync(backupPath, backup, 'utf8');

const result = {};
let prev = null;

for (let i = 0; i < dungeonList.length; i++) {
  const def = dungeonList[i];
  let stats;

  if (i === 0) {
    stats = { ...firstDungeonStats };
  } else {
    const raw = {
      floorBase: prev.floorBase * 1.13 + 2.4 + (prev.floorMult * prev.floorAmount) * 1.09,
      floorMult: (prev.floorMult + 0.00006) * 1.012,
      floorAmount: prev.floorAmount + 1
    };
    stats = {
      floorBase: Math.round(raw.floorBase * 10000) / 10000,
      floorMult: Math.round(raw.floorMult * 10000) / 10000,
      floorAmount: raw.floorAmount
    };
  }

  result[def.name] = {
    ...stats,
    background: def.background,
    emoji: def.emoji
  };

  prev = stats;
}

fs.writeFileSync(sourcePath, JSON.stringify(result, null, 2) + '\n', 'utf8');

const first = result[dungeonList[0].name];
const last = result[dungeonList[dungeonList.length - 1].name];

console.log(`Generated ${dungeonList.length} dungeons.`);
console.log(`First (${dungeonList[0].name}): ${JSON.stringify(first)}`);
console.log(`Last (${dungeonList[dungeonList.length - 1].name}): ${JSON.stringify(last)}`);
