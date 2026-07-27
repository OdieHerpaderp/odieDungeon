import { v4 as uuidv4 } from 'uuid';
import skillCurve from './public/skills/skillCurve.json' with { type: 'json' };
import * as characters from './characters.js';

export function deepEqual(obj1, obj2) {
  if (obj1 === obj2) return true;
  if (obj1 == null || obj2 == null) return false;
  if (typeof obj1 !== typeof obj2) return false;
  if (typeof obj1 !== 'object') return obj1 === obj2;
  const keys1 = Object.keys(obj1),
    keys2 = Object.keys(obj2);
  if (keys1.length !== keys2.length) return false;
  return keys1.every((key) => keys2.includes(key) && deepEqual(obj1[key], obj2[key]));
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

// ═══════════════════════════════════════════════════════════════════
// PACKET TRACKING - Track sent/received packet counts and sizes
// ═══════════════════════════════════════════════════════════════════
export const socketIoPacketTracker = {
  sent: { total: { count: 0, bytes: 0 }, byType: {} },
  received: { total: { count: 0, bytes: 0 }, byType: {} },
};

export function trackSocketIoSent(type, data) {
  const size = Buffer.byteLength(JSON.stringify(data), 'utf8');
  socketIoPacketTracker.sent.total.count++;
  socketIoPacketTracker.sent.total.bytes += size;
  if (!socketIoPacketTracker.sent.byType[type]) {
    socketIoPacketTracker.sent.byType[type] = { count: 0, bytes: 0 };
  }
  socketIoPacketTracker.sent.byType[type].count++;
  socketIoPacketTracker.sent.byType[type].bytes += size;
}

export function trackSocketIoReceived(type, data) {
  const jsonString = JSON.stringify(data || {});
  const size = Buffer.byteLength(jsonString, 'utf8');
  socketIoPacketTracker.received.total.count++;
  socketIoPacketTracker.received.total.bytes += size;
  if (!socketIoPacketTracker.received.byType[type]) {
    socketIoPacketTracker.received.byType[type] = { count: 0, bytes: 0 };
  }
  socketIoPacketTracker.received.byType[type].count++;
  socketIoPacketTracker.received.byType[type].bytes += size;
}

export function formatPacketStats(prefix = '', stats) {
  const formatType = (typeStats) => {
    const lines = [];
    const types = Object.keys(typeStats).sort((a, b) => typeStats[b].count - typeStats[a].count);
    for (const type of types) {
      const stat = typeStats[type];
      lines.push(`    ${type}: ${stat.count} packets, ${formatBytes(stat.bytes)}`);
    }
    return lines.length > 0 ? lines.join('\n') : '    (none)';
  };

  return `${prefix}Sent: ${stats.sent.total.count} packets, ${formatBytes(stats.sent.total.bytes)}
${prefix}  By Type:
${formatType(stats.sent.byType)}
${prefix}Received: ${stats.received.total.count} packets, ${formatBytes(stats.received.total.bytes)}
${prefix}  By Type:
${formatType(stats.received.byType)}`;
}

export function calcSkillLv(xp) {
  const { xpDivisor, exponent, levelDivisor, minLevel } = skillCurve;
  return Math.max(minLevel, Math.floor(Math.pow(xp / xpDivisor, exponent) / levelDivisor));
}

export function calcXpForLevel(level) {
  const { xpDivisor, exponent, levelDivisor } = skillCurve;
  return Math.pow(level * levelDivisor, 1 / exponent) * xpDivisor;
}

export function calcXpForNextLevel(level) {
  return calcXpForLevel(level + 1);
}

export const DEFAULT_CHARACTER_STATS = {
  hp: 60,
  maxHp: 60,
  mp: 40,
  maxMp: 40,
  ap: 0,
  maxAp: 0,
  str: 5,
  dex: 5,
  agi: 5,
  vit: 5,
  int: 5,
  cnc: 5,
  for: 1,
  wis: 1,
  luk: 1,
  pie: 1,
  level: 1,
  xp: 0,
  xpToNext: 96,
  pointsToAllocate: 3,
  actionBar: 0,
  maxActionBar: 100,
  gold: 20,
  donated: 75,
  dots: [],
  hots: [],
};

export function createDefaultCharacter(name) {
  return { ...DEFAULT_CHARACTER_STATS, name };
}

export function compactEquipment(equipment) {
  const slots = ['weapon', 'armour', 'helmet', 'shoes', 'offHand'];
  const out = {};
  for (const slot of slots) {
    const item = equipment ? equipment[slot] : undefined;
    if (item && typeof item === 'object') {
      const id = item.baseItem || item.id;
      if (typeof id === 'string' && id) {
        out[slot] = {
          id,
          level: Number.isFinite(Number(item.level)) ? Number(item.level) : 1,
          rarity: Number.isFinite(Number(item.rarity)) ? Number(item.rarity) : 1,
        };
      }
    }
  }
  return out;
}

export function toCompactRef(raw, slot) {
  if (!raw || typeof raw !== 'object') return null;
  const id = raw.baseItem || raw.id;
  if (typeof id !== 'string' || !id) return null;
  const level = Number.isFinite(Number(raw.level)) ? Number(raw.level) : 1;
  const rarity = Number.isFinite(Number(raw.rarity)) ? Number(raw.rarity) : 1;
  return { id, level, rarity };
}

export function toInventoryItem(raw, slot) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.baseItem || raw.id || raw.name || '');
  if (!id) return null;
  const level = Number.isFinite(Number(raw.level)) ? Number(raw.level) : 1;
  const rarity = Number.isFinite(Number(raw.rarity)) ? Number(raw.rarity) : 1;
  let itemSlot = raw.slot || slot || '';
  if (itemSlot === 'helmet') itemSlot = 'headgear';
  if (itemSlot === 'armour') itemSlot = 'armor';
  if (itemSlot === 'shield' || itemSlot === 'book') itemSlot = 'offHand';
  return {
    id,
    level,
    rarity,
    slot: itemSlot,
    baseItem: raw.baseItem || id,
    displayName: raw.displayName || raw.name || id,
    name: raw.name || id,
    baseDamage: raw.baseDamage,
    baseSpellPower: raw.baseSpellPower,
    baseAttackSpeed: raw.baseAttackSpeed,
    baseDefense: raw.baseDefense,
    baseMagicResist: raw.baseMagicResist,
    baseDamageModifiers: raw.baseDamageModifiers,
    baseValue: raw.baseValue,
    baseRange: raw.baseRange,
    baseBonuses: raw.baseBonuses,
    type: raw.type,
    subType: raw.subType,
    twoHanded: raw.twoHanded,
    description: raw.description,
  };
}

export function generateMessageId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

export function getEffectiveAttribute(player, statName) {
  if (!statName) return 0;
  const statKey = String(statName).toLowerCase();
  const base = Number.isFinite(player[statKey]) ? player[statKey] : 0;
  // Note: at module load time we don't have access to character equipment bonuses yet
  // This function is called with fully loaded character objects that include equipment
  return base;
}

export function attributeScaling(player, modifiers, multiplier = 0.02) {
  if (!modifiers || typeof modifiers !== 'object') return 1;
  let sum = 0;
  for (const [stat, weight] of Object.entries(modifiers)) {
    if (typeof weight !== 'number') continue;
    sum += getEffectiveAttribute(player, stat) * weight;
  }
  return 1 + sum * multiplier;
}

export function getAttributeDamageModifier(player, weapon) {
  return attributeScaling(player, weapon?.damageModifiers, 0.02);
}

export function findInventoryItem(inventory, itemId) {
  return safeArray(inventory).find(
    (entry) =>
      entry &&
      (entry.id === itemId || entry.baseItem === itemId || entry.name === itemId || entry.displayName === itemId),
  );
}

// Array coerce

export function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

// Ensure every core stat meets its minimum floor so derived calculations can't
// divide by zero or produce degenerate displays. Mutates in place.
export function normalizeCharacterStats(character) {
  character.level = Math.max(1, character.level || 1);
  character.vit = Math.max(5, character.vit || 5);
  character.str = Math.max(5, character.str || 5);
  character.dex = Math.max(5, character.dex || 5);
  character.agi = Math.max(5, character.agi || 5);
  character.int = Math.max(5, character.int || 5);
  character.cnc = Math.max(5, character.cnc || 5);
  character.for = Math.max(1, character.for || 1);
  character.wis = Math.max(1, character.wis || 1);
  character.luk = Math.max(1, character.luk || 1);
  character.pie = Math.max(1, character.pie || 1);
}

// After gear/stat changes, recompute max HP/MP/AP from scratch and scale the
// current values by the same delta so the player doesn't lose stored progress.
export function recalcDerivedMaxAndClampCurrents(player) {
  const oldMax = { ap: player.maxAp, hp: player.maxHp, mp: player.maxMp };
  player.maxAp = characters.calcMaxAp(player);
  player.ap = Math.min(player.maxAp, player.ap + (player.maxAp - oldMax.ap));
  player.maxHp = characters.calcMaxHp(player);
  player.hp = Math.min(player.maxHp, player.hp + (player.maxHp - oldMax.hp));
  player.maxMp = characters.calcMaxMp(player);
  player.mp = Math.min(player.maxMp, player.mp + (player.maxMp - oldMax.mp));
}

// Canonical empty stats object for a newly-tracked combatant.
export function createEmptyCombatStats() {
  return {
    attacks: 0,
    hits: 0,
    totalDamage: 0,
    rollSum: 0,
    totalHealed: 0,
    crits: 0,
    maxDamage: 0,
    totalDamageTaken: 0,
    totalMitigated: 0,
    maxDamageTaken: 0,
  };
}

export default {
  deepEqual,
  formatBytes,
  calcSkillLv,
  calcXpForLevel,
  calcXpForNextLevel,
  DEFAULT_CHARACTER_STATS,
  createDefaultCharacter,
  compactEquipment,
  toCompactRef,
  toInventoryItem,
  generateMessageId,
  socketIoPacketTracker,
  trackSocketIoSent,
  trackSocketIoReceived,
  formatPacketStats,
  getEffectiveAttribute,
  getAttributeDamageModifier,
  attributeScaling,
  findInventoryItem,
  safeArray,
  normalizeCharacterStats,
  recalcDerivedMaxAndClampCurrents,
  createEmptyCombatStats,
};
