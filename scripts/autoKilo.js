// Autonomous odieDungeon player driver (v2, safer).
// Spawns scripts/joinGame.js as kilo/test and plays through to clear the orchard
// (field -> backyard -> meadow -> farm -> orchard) without dying.
//
// Safety model: before advancing to the NEXT dungeon we require BOTH:
//   - average equipped item tier  >= RECOMMENDED_TIER[next]
//   - character level              >= RECOMMENDED_LEVEL[next]
// Otherwise we re-run the CURRENT dungeon to farm levels + loot + shop gear
// until the gate is met. We also gear up (loot + shop buy) after every clear.

const { spawn } = require('child_process');
const path = require('path');

const PARTY = 'test';
const NAME = 'kilo';
const URL = 'http://localhost:25561';
const DUNGEON_ORDER = ['field', 'backyard', 'meadow', 'farm', 'orchard'];

// Minimums required BEFORE LEAVING dungeon idx (i.e. to attempt idx+1).
// The next dungeon's shop/loot scale higher than the current one, so climbing
// happens by advancing — we must not deadlock farming a low-tier dungeon that
// can never produce the gear we demand. Gate is therefore lenient: leave as
// soon as we have real (non-starter) gear and a little level headroom. We also
// cap total farm runs per dungeon so we never loop forever.
const MIN_TIER_TO_LEAVE = [0, 0.5, 1.2, 2.2, 3.2, 4.2];
const MIN_LEVEL_TO_LEAVE = [0, 2, 4, 7, 10, 13];
const MAX_FARM_RUNS = [0, 4, 4, 4, 4, 4]; // max times to re-run before forcing advance

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn('node', ['scripts/joinGame.js', PARTY, NAME, URL], {
  cwd: path.join(__dirname, '..'),
  stdio: ['pipe', 'pipe', 'pipe'],
});

let buffer = '';
const listeners = [];
function onLine(fn) { listeners.push(fn); }
child.stdout.on('data', (d) => {
  buffer += d.toString();
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).replace(/\r$/, '');
    buffer = buffer.slice(idx + 1);
    for (const fn of listeners) fn(line);
  }
});
child.stderr.on('data', (d) => process.stderr.write('[client.err] ' + d));
child.on('exit', (code) => console.log(`[driver] client exited code ${code}`));

// Run a command, collect stdout lines for `ms` ms, return joined text.
function run(cmd, ms = 1600) {
  return new Promise((resolve) => {
    const lines = [];
    const fn = (l) => { if (l.trim()) lines.push(l); };
    onLine(fn);
    child.stdin.write(cmd + '\n');
    setTimeout(() => { listeners.splice(listeners.indexOf(fn), 1); resolve(lines.join('\n')); }, ms);
  });
}

// ---- Parsers ----
function parseStatus(text) {
  const s = { level: -1, gold: -1, points: -1, hp: 0, maxHp: 1, mp: 0, maxMp: 1,
    ap: 0, maxAp: 1, dungeon: null, floor: -1, combat: null, auto: null, shopCount: 0 };
  const num = (re) => { const m = text.match(re); return m ? parseFloat(m[1]) : null; };
  s.level = num(/Lv(\d+)/) ?? s.level; if (s.level === null) s.level = -1;
  s.gold = num(/Gold (-?[\d.]+)/) ?? s.gold;
  s.points = num(/Points (-?[\d.]+)/) ?? s.points;
  const hp = text.match(/HP (-?[\d.]+)\/(-?[\d.]+)/); if (hp) { s.hp = +hp[1]; s.maxHp = +hp[2]; }
  const mp = text.match(/MP (-?[\d.]+)\/(-?[\d.]+)/); if (mp) { s.mp = +mp[1]; s.maxMp = +mp[2]; }
  const ap = text.match(/AP (-?[\d.]+)\/(-?[\d.]+)/); if (ap) { s.ap = +ap[1]; s.maxAp = +ap[2]; }
  const d = text.match(/Party \S+ \| (\S+) floor (-?\d+)/);
  if (d) { s.dungeon = d[1]; s.floor = +d[2]; }
  const cm = text.match(/combat (\S+)/); if (cm) s.combat = cm[1] === 'true';
  const au = text.match(/autoEmbark (\S+)/); if (au) s.auto = au[1] === 'true';
  const shop = text.match(/Shop: (\d+) items/); if (shop) s.shopCount = +shop[1];
  return s;
}

// Parse `inv` listing: "  i. [slot] id - Name Lv3 2★"
function parseInv(text) {
  const items = [];
  const re = /^\s*(\d+)\.\s+\[(\w+)\]\s+([\w-]+)\s+-\s+(.+)$/;
  for (const line of text.split('\n')) {
    const m = line.match(re);
    if (m) items.push({ idx: +m[1], slot: m[2], id: m[3], desc: m[4].trim() });
  }
  return items;
}

// Tier estimate from an inv description (has Lv/rarity).
function descTier(desc) {
  const lv = desc.match(/Lv(\d+)/); const rar = desc.match(/(\d+)★/);
  const level = lv ? +lv[1] : 1; const rarity = rar ? +rar[1] : 1;
  const levelMul = 0.8 + level / 24, rarityMul = 0.7 + rarity / 13;
  const stat = Math.max(0.01, 37 * levelMul * rarityMul);
  return (stat - 22.2) / 2.05;
}

function parseTier(text) {
  const m = text.match(/Average equipped tier: ♔([\d.]+)/);
  return m ? parseFloat(m[1]) : 0;
}

// ---- Actions ----
async function allocateAll() {
  while (true) {
    const st = parseStatus(await run('status'));
    if (st.points <= 0) break;
    const plan = [['vit', 5], ['str', 5], ['int', 3], ['vit', 3], ['str', 3], ['int', 1], ['vit', 1], ['str', 1]];
    let spent = false;
    for (const [stat, amt] of plan) {
      if (st.points >= amt) { await run(`allocate ${stat} ${amt}`); spent = true; break; }
    }
    if (!spent) { if (st.points > 0) await run(`allocate vit ${st.points}`); break; }
  }
}

async function townSetup() {
  await run('ability 0 firstAid');
  await allocateAll();
  console.log('[driver] town setup done.');
}

// Read per-slot equipped tiers from the `tier` command output.
function parseSlotTiers(text) {
  const tiers = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^(\w+):.*♔([\d.]+)/);
    if (m) tiers[m[1]] = parseFloat(m[2]);
  }
  return tiers;
}

// Equip the best item per slot from inventory (only if better than equipped),
// then buy from shop and equip upgrades, then sell the leftovers.
// Must be called while in Town (floor 0, no combat) or shop buys are rejected.
async function gearUp() {
  // Ensure we're actually in Town before touching gear/shop.
  let st = parseStatus(await run('status'));
  if (st.floor !== 0 || st.combat) {
    console.log('[driver] gearUp: not in town yet (floor ' + st.floor + ', combat ' + st.combat + '); waiting...');
    for (let i = 0; i < 10; i++) {
      await sleep(2000);
      st = parseStatus(await run('status'));
      if (st.floor === 0 && !st.combat) break;
    }
    if (st.floor !== 0 || st.combat) {
      console.log('[driver] gearUp: still not in town; skipping this cycle.');
      return;
    }
  }

  const equipBestFromInv = async (label) => {
    const equippedTiers = parseSlotTiers(await run('tier'));
    const invItems = parseInv(await run('inv'));
    if (!invItems.length) { console.log(`[driver] ${label}: inventory empty.`); return; }
    const best = {};
    for (const it of invItems) {
      const t = descTier(it.desc);
      if (!best[it.slot] || t > best[it.slot].t) best[it.slot] = { ...it, t };
    }
    for (const slot of ['weapon', 'armour', 'helmet', 'shoes']) {
      const b = best[slot];
      const cur = equippedTiers[slot] ?? 0;
      if (b && b.t > cur + 0.01) {
        console.log(`[driver] equip ${slot} ${b.id} (tier≈${b.t.toFixed(2)} > ${cur.toFixed(2)})`);
        await run(`equip ${slot} ${b.id}`);
      }
    }
  };

  // Equip the loot we just picked up.
  await equipBestFromInv('loot');

  // Buy from the freshly-restocked shop; keep buying while affordable.
  for (let i = 0; i < 6; i++) {
    const s = parseStatus(await run('status'));
    if (s.shopCount === 0 || s.gold < 10) break;
    await run('buy random');
  }

  // Equip any shop purchases that beat current gear.
  await equipBestFromInv('shop');

  // Sell leftover duplicates, keeping the best per slot.
  const fin = parseInv(await run('inv'));
  const keepSlot = {};
  for (const it of fin) { const t = descTier(it.desc); if (!keepSlot[it.slot] || t > keepSlot[it.slot].t) keepSlot[it.slot] = it; }
  for (const it of fin) { if (keepSlot[it.slot]?.id !== it.id) await run(`sell ${it.id}`); }

  const tier = parseTier(await run('tier'));
  console.log(`[driver] gear up done. avg equipped tier ♔${tier.toFixed(2)}`);
}

async function waitForClear(target, maxMs = 300000) {
  const start = Date.now();
  let lastLog = 0;
  while (Date.now() - start < maxMs) {
    await sleep(4000);
    const st = parseStatus(await run('status'));
    if (Date.now() - lastLog > 15000) {
      console.log(`[driver] poll: Lv${st.level} floor=${st.floor} combat=${st.combat} dungeon=${st.dungeon} gold=${st.gold}`);
      lastLog = Date.now();
    }
    if (st.floor === 0 && !st.combat) {
      // Back in town. The clear broadcast (🏁 + rewards + restock + full state)
      // happens in one tick, so a short settle then re-check confirms completion.
      await sleep(2500);
      const st2 = parseStatus(await run('status'));
      if (st2.floor === 0 && !st2.combat) return true;
    }
  }
  return false;
}

async function safeToAdvance(idx, farmRuns) {
  const st = parseStatus(await run('status'));
  const tier = parseTier(await run('tier'));
  const needTier = MIN_TIER_TO_LEAVE[idx + 1] ?? 0;
  const needLvl = MIN_LEVEL_TO_LEAVE[idx + 1] ?? 0;
  const cap = MAX_FARM_RUNS[idx] ?? 4;
  // Force advance if we've farmed enough here regardless (avoid deadlock).
  if (farmRuns >= cap) {
    console.log(`[driver] gate: farmed ${farmRuns} runs on ${DUNGEON_ORDER[idx]} (cap ${cap}) -> FORCE ADVANCE (Lv${st.level} ♔${tier.toFixed(2)})`);
    return true;
  }
  const ok = st.level >= needLvl && tier >= needTier;
  console.log(`[driver] gate for next (idx ${idx + 1}): Lv${st.level}>=${needLvl}? ${st.level >= needLvl}; tier ♔${tier.toFixed(2)}>=♔${needTier}? ${tier >= needTier}; farmRuns=${farmRuns}/${cap} -> ${ok ? 'SAFE' : 'NOT SAFE, farming more'}`);
  return ok;
}

async function tryAdvance(next) {
  await run('auto off');
  await sleep(800);
  const out = await run(`change ${next}`);
  if (/reject|not unlocked|error|invalid/i.test(out)) {
    console.log(`[driver] advance to ${next} rejected.`);
    return false;
  }
  let st = parseStatus(await run('status'));
  if (st.dungeon !== next) { await sleep(1500); st = parseStatus(await run('status')); }
  if (st.dungeon === next) { console.log(`[driver] advanced to ${next}.`); return true; }
  console.log(`[driver] change to ${next} did not take (still ${st.dungeon}).`);
  return false;
}

// ---- Main loop ----
async function main() {
  let joined = false;
  for (let i = 0; i < 40 && !joined; i++) {
    const ok = await new Promise((res) => {
      const fn = (l) => { if (l.includes('joined party')) { listeners.splice(listeners.indexOf(fn), 1); res(true); } };
      onLine(fn);
      setTimeout(() => { listeners.splice(listeners.indexOf(fn), 1); res(false); }, 1000);
    });
    if (ok) { joined = true; break; }
    console.log('[driver] waiting for join...');
  }
  if (!joined) { console.log('[driver] never joined; abort.'); child.kill(); return; }
  console.log('[driver] joined.');
  await sleep(1000);

  let idx = 0;
  let farmRuns = 0;
  while (idx < DUNGEON_ORDER.length) {
    const target = DUNGEON_ORDER[idx];
    console.log(`\n[driver] === Dungeon ${idx + 1}/5: ${target} (farmRuns=${farmRuns}) ===`);

    let st = parseStatus(await run('status'));
    console.log(`[driver] state: Lv${st.level} gold=${st.gold} points=${st.points} floor=${st.floor} combat=${st.combat} auto=${st.auto}`);

    if (st.floor === 0 && !st.combat) {
      await townSetup();
      console.log(`[driver] embarking ${target}`);
      await run(`embark ${target}`);
    } else {
      console.log(`[driver] not in town; waiting for current run to resolve...`);
    }

    const cleared = await waitForClear(target);

    if (!cleared) {
      console.log(`[driver] ${target} run did not return to town in time; retrying.`);
      await run('auto off');
      await run('escape'); // ensure back in town
      await sleep(1500);
      continue;
    }

    console.log(`[driver] ${target} cleared! Gearing up...`);
    await gearUp();
    farmRuns++;

    if (idx + 1 >= DUNGEON_ORDER.length) {
      console.log('[driver] orchard cleared — goal complete!');
      await run('leave');
      child.kill();
      return;
    }

    if (await safeToAdvance(idx, farmRuns)) {
      if (await tryAdvance(DUNGEON_ORDER[idx + 1])) { idx++; farmRuns = 0; }
      else { console.log(`[driver] change failed; farming ${target} again.`); }
    } else {
      console.log(`[driver] not safe yet; farming ${target} again to gain levels/gear.`);
    }
    // Loop re-embarks current dungeon (or newly advanced one) next iteration.
  }
}

main().catch((e) => { console.error('[driver] fatal', e); child.kill(); process.exit(1); });
