import { v4 as uuidv4 } from 'uuid';
import skillCurve from './public/skills/skillCurve.json' with { type: 'json' };

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
  const slots = ['weapon', 'armour', 'helmet', 'shoes'];
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
  return { id, level, rarity, slot: itemSlot };
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

export function getAttributeDamageModifier(player, weapon) {
  if (!weapon || typeof weapon !== 'object') return 1;
  const modifiers = weapon.damageModifiers;
  if (!modifiers || typeof modifiers !== 'object') return 1;
  const entries = Object.entries(modifiers);
  if (entries.length === 0) return 1;

  let sum = 0;
  for (const [stat, weight] of entries) {
    if (typeof weight !== 'number') continue;
    sum += getEffectiveAttribute(player, stat) * weight;
  }
  return 1 + sum * 0.03;
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
};
