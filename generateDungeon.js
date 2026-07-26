import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const sourcePath = path.join(__dirname, "public", "dungeons.json");
const backupPath = path.join(__dirname, "public", "dungeonsOld.json");

const firstDungeonStats = {
  floorBase: 0.722,
  floorMult: 0.058,
  floorAmount: 8,
};

const dungeonList = [
  { name: "field", emoji: "\ud83c\udf3f", background: "#224422" },
  { name: "backyard", emoji: "\ud83c\udfbb", background: "#2d2a1d" },
  { name: "meadow", emoji: "\ud83c\udf31", background: "#1a3a1a" },
  { name: "farm", emoji: "\ud83c\udf3e", background: "#323311" },
  { name: "orchard", emoji: "\ud83c\udf4e", background: "#24411a" },
  { name: "garden", emoji: "\ud83c\udf37", background: "#72485f" },
  { name: "cellar", emoji: "\ud83e\udea5", background: "#48301c" },
  { name: "village", emoji: "\ud83c\udfe8\ufe0f", background: "#2a3a2a" },
  { name: "school", emoji: "\ud83d\udcd6", background: "#111122" },
  { name: "dojo", emoji: "\ud83e\udd4b", background: "#23363b" },
  { name: "chapel", emoji: "\ud83d\udd6f\ufe0f", background: "#2b2230" },
  { name: "shrine", emoji: "\u26ea", background: "#2a1a2a" },
  { name: "forest", emoji: "\ud83c\udf32", background: "#112200" },
  { name: "watchtower", emoji: "\ud83d\uddfc", background: "#22304a" },
  { name: "outpost", emoji: "\u2694\ufe0f", background: "#2b2b1f" },
  { name: "sewers", emoji: "\ud83d\udd70\ufe0f", background: "#10231d" },
  { name: "mine", emoji: "\u26cf\ufe0f", background: "#2a2520" },
  { name: "cave", emoji: "\ud83e\udea8", background: "#332200" },
  { name: "desert", emoji: "\ud83c\udfd4\ufe0f", background: "#cc9933" },
  { name: "canyon", emoji: "\ud83c\udfd4", background: "#cc7711" },
  { name: "clocktower", emoji: "\ud83d\udd70\ufe0f", background: "#2b241b" },
  { name: "ruins", emoji: "\ud83dd\uddff", background: "#111122" },
  { name: "temple", emoji: "\ud83d\udd55", background: "#2a1b2f" },
  { name: "graveyard", emoji: "\u26b0\ufe0f", background: "#1a1a22" },
  { name: "mausoleum", emoji: "\ud83e\udea6", background: "#221a22" },
  { name: "catacombs", emoji: "\ud83d\udd78\ufe0f", background: "#151018" },
  { name: "crypt", emoji: "\ud83d\udc80", background: "#1a1015" },
  { name: "swamp", emoji: "\ud83e\udea4", background: "#0b2b1f" },
  { name: "castle", emoji: "\ud83c\udff0", background: "#330000" },
  { name: "fortress", emoji: "\ud83c\udfdf\ufe0f", background: "#2a0a0a" },
  { name: "labyrinth", emoji: "\ud83c\udf00", background: "#1b1b2a" },
  { name: "laboratory", emoji: "\ud83d\udd2c", background: "#111111" },
  { name: "frozen wasteland", emoji: "\u2744\ufe0f", background: "#1a2433" },
  { name: "sky", emoji: "\u2601\ufe0f", background: "#1b2b3a" },
  { name: "sanctum", emoji: "\u2728", background: "#1a1330" },
  { name: "volcano", emoji: "\ud83c\udf0b", background: "#330800" },
  { name: "starfield", emoji: "\u2b50", background: "#0f1a33" },
  { name: "nebula", emoji: "\ud83c\udf0c", background: "#2d1b4e" },
  { name: "abyss", emoji: "\ud83d\udd73\ufe0f", background: "#050505" },
  { name: "void", emoji: "\ud83c\udf11", background: "#1a0a0a" },
  { name: "apotheosis", emoji: "\ud83d\uddcb", background: "#040202" },
];

const backup = fs.readFileSync(sourcePath, "utf8");
fs.writeFileSync(backupPath, backup, "utf8");

const result = {};
let prev = null;

for (let i = 0; i < dungeonList.length; i++) {
  const def = dungeonList[i];
  let stats;

  if (i === 0) {
    stats = { ...firstDungeonStats };
  } else {
    const raw = {
      floorBase: prev.floorBase * 1.13 + 1.8 + prev.floorMult * prev.floorAmount * 1.09,
      floorMult: (prev.floorMult + 0.00006) * 1.012,
      floorAmount: prev.floorAmount + 1,
    };
    stats = {
      floorBase: Math.round(raw.floorBase * 10000) / 10000,
      floorMult: Math.round(raw.floorMult * 10000) / 10000,
      floorAmount: raw.floorAmount,
    };
  }

  result[def.name] = {
    ...stats,
    background: def.background,
    emoji: def.emoji,
  };

  prev = stats;
}

fs.writeFileSync(sourcePath, JSON.stringify(result, null, 2) + "\n", "utf8");

const first = result[dungeonList[0].name];
const last = result[dungeonList[dungeonList.length - 1].name];

console.log(`Generated ${dungeonList.length} dungeons.`);
console.log(`First (${dungeonList[0].name}): ${JSON.stringify(first)}`);
console.log(`Last (${dungeonList[dungeonList.length - 1].name}): ${JSON.stringify(last)}`);
