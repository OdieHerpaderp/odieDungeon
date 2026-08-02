import { deepEqual } from "../utils.js";

export const PLAYER_DELTA_FIELDS = [
  'hp', 'ap', 'maxHp', 'maxAp', 'level', 'xp', 'xpToNext', 'gold', 'mp', 'maxMp',
  'pointsToAllocate', 'abilityCooldowns', 'str', 'dex', 'agi', 'vit', 'int', 'cnc',
  'wis', 'for', 'luk', 'pie', 'equipment', 'inventory', 'actionBar', 'maxActionBar',
  'currentVenture', 'effects', 'skillsState',
];

export const ENEMY_DELTA_FIELDS = [
  'hp', 'maxHp', 'ap', 'maxAp', 'mp', 'maxMp', 'actionBar', 'maxActionBar', 'isDead',
];

export const PARTY_DELTA_FIELDS = [
  'combatActive', 'combatTurn', 'floor', 'dungeon',
  'dungeonFloors', 'highestVisitedFloors', 'completedDungeons', 'autoEmbark',
];

const MAP_FIELDS = ['dungeonFloors', 'highestVisitedFloors', 'completedDungeons'];

export function buildSnapshot(entity) {
  const snapshot = { ...entity };
  if (entity.abilityCooldowns) snapshot.abilityCooldowns = { ...entity.abilityCooldowns };
  if (entity.equipment) snapshot.equipment = { ...entity.equipment };
  if (Array.isArray(entity.inventory)) snapshot.inventory = [...entity.inventory];
  if (entity.skillsState) snapshot.skillsState = { ...entity.skillsState };
  return snapshot;
}

export function extractDelta(lastState, current, fields) {
  const delta = {};
  for (const f of fields) {
    if (current[f] !== undefined && !deepEqual(current[f], lastState[f])) {
      delta[f] = current[f];
    }
  }
  return delta;
}

export class DeltaTracker {
  constructor() {
    this.playerLastState = new Map();
    this.enemyLastState = new Map();
    this.partyLastState = new Map();
    this.enemyFullSent = new Set();
  }

  initializeState(partyId, party, socketId) {
    const player = party.players?.get(socketId);
    if (player) this.playerLastState.set(socketId, buildSnapshot(player));
    if (party.enemies) {
      for (const enemy of party.enemies) this.enemyLastState.set(enemy.id, { ...enemy });
    }
    this.partyLastState.set(partyId, this._snapshotParty(party));
  }

  getPlayerDelta(socketId, player) {
    const lastState = this.playerLastState.get(socketId) || {};
    const delta = extractDelta(lastState, player, PLAYER_DELTA_FIELDS);
    if (Object.keys(delta).length === 0) return null;
    const merged = { ...lastState };
    for (const f of PLAYER_DELTA_FIELDS) merged[f] = player[f];
    this.playerLastState.set(socketId, merged);
    return delta;
  }

  getEnemyDelta(enemyId, enemy) {
    const lastState = this.enemyLastState.get(enemyId) || {};
    const delta = extractDelta(lastState, enemy, ENEMY_DELTA_FIELDS);
    const wasDead = lastState.hp !== undefined && lastState.hp <= 0;
    const isDead = enemy.hp <= 0;
    if (wasDead !== isDead) delta.isDead = isDead;
    if (Object.keys(delta).length === 0) return null;
    this.enemyLastState.set(enemyId, { ...enemy });
    return delta;
  }

  collectPlayerUpdate(socketId, player) {
    const delta = this.getPlayerDelta(socketId, player);
    if (!delta) return null;
    return { id: socketId, name: player.name, isDead: player.hp <= 0, ...delta };
  }

  collectEnemyUpdate(enemyId, enemy) {
    const delta = this.getEnemyDelta(enemyId, enemy);
    if (!delta) return null;
    if (this.enemyFullSent.has(enemyId)) {
      return { id: enemyId, isDead: enemy.hp <= 0, ...delta };
    }
    this.enemyFullSent.add(enemyId);
    return { ...enemy, id: enemyId, isDead: enemy.hp <= 0 };
  }

  getPartyDelta(partyId, party) {
    const delta = {};
    const partyPrev = this.partyLastState.get(partyId) || {};
    const partyNext = {};
    let partyDirty = false;
    for (const f of PARTY_DELTA_FIELDS) {
      const cur = party[f] !== undefined
        ? party[f]
        : MAP_FIELDS.includes(f) ? {} : undefined;
      const prev = partyPrev[f] !== undefined
        ? partyPrev[f]
        : MAP_FIELDS.includes(f) ? {} : undefined;
      partyNext[f] = cur;
      if (deepEqual(cur, prev)) continue;
      delta[f] = cur;
      partyDirty = true;
    }
    return { delta, partyNext, partyDirty };
  }

  commitPartyBaseline(partyId, partyNext) {
    this.partyLastState.set(partyId, partyNext);
  }

  seedEnemyFullSent(party) {
    if (!party.enemies) return;
    for (const enemy of party.enemies) this.enemyFullSent.add(enemy.id);
  }

  resetBaseline(partyId, party) {
    if (!party) return;
    for (const [socketId, player] of party.players) {
      this.playerLastState.set(socketId, buildSnapshot(player));
    }
    if (party.enemies) {
      for (const enemy of party.enemies) this.enemyLastState.set(enemy.id, { ...enemy });
    }
    this.partyLastState.set(partyId, this._snapshotParty(party));
    this.enemyFullSent.clear();
  }

  clearParty(partyId, party) {
    if (party) {
      for (const socketId of party.players.keys()) this.playerLastState.delete(socketId);
      for (const enemy of party.enemies || []) {
        this.enemyLastState.delete(enemy.id);
        this.enemyFullSent.delete(enemy.id);
      }
    }
    this.partyLastState.delete(partyId);
  }

  deletePlayer(socketId) {
    this.playerLastState.delete(socketId);
  }

  _snapshotParty(party) {
    return {
      floor: party.floor,
      combatActive: party.combatActive,
      combatTurn: party.combatTurn,
      dungeon: party.dungeon,
      dungeonFloors: party.dungeonFloors ? { ...party.dungeonFloors } : {},
      highestVisitedFloors: party.highestVisitedFloors ? { ...party.highestVisitedFloors } : {},
      completedDungeons: party.completedDungeons ? { ...party.completedDungeons } : {},
      autoEmbark: party.autoEmbark,
    };
  }
}
