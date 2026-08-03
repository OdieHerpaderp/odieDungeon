// database.js - Character Save/Load Module
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { compactEquipment, safeArray } from './utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CHARACTERS_DIR = path.join(__dirname, 'characters');

export function sanitizeName(name) {
  return (name || '').replace(/[^a-zA-Z0-9]/g, '_');
}

function canonicalKey(name) {
  return sanitizeName(name);
}

async function ensureCharactersDir() {
  try {
    await fs.promises.mkdir(CHARACTERS_DIR, { recursive: true });
  } catch (error) {
    console.error('Failed to create characters directory', { err: error.message });
  }
}

export async function saveCharacter(name, character) {
  const key = canonicalKey(name);
  const filePath = path.join(CHARACTERS_DIR, `${key}.json`);

  if (!character.effects) {
    character.effects = [];
  }

  const characterData = {
    name: character.name,
    level: character.level,
    skillsState: character.skillsState,
    abilitySlots: character.abilitySlots,
    abilityCooldowns: character.abilityCooldowns,
    equipment: character.equipment ? compactEquipment(character.equipment) : {},
    xp: character.xp,
    xpToNext: character.xpToNext,
    gold: character.gold,
    donated: character.donated,
    pointsToAllocate: character.pointsToAllocate,
    ap: character.ap,
    maxAp: character.maxAp,
    hp: character.hp,
    maxHp: character.maxHp,
    mp: character.mp,
    maxMp: character.maxMp,
    actionBar: character.actionBar,
    maxActionBar: character.maxActionBar,
    str: character.str,
    dex: character.dex,
    agi: character.agi,
    vit: character.vit,
    int: character.int,
    cnc: character.cnc,
    wis: character.wis,
    luk: character.luk,
    for: character.for,
    pie: character.pie,
    spells: character.spells,
    lastSpellCast: character.lastSpellCast,
    abilities: character.abilities || [],
    effects: character.effects,
    inventory: character.inventory || [],
    lastUpdated: new Date().toISOString(),
  };

  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await ensureCharactersDir();
    await fs.promises.writeFile(tmpPath, JSON.stringify(characterData, null, 2), 'utf8');
    await fs.promises.rename(tmpPath, filePath);
  } catch (error) {
    try { await fs.promises.unlink(tmpPath); } catch {}
    console.error('Failed to save character ' + name, { err: error.message, name });
  }
}

export async function loadCharacter(name) {
  const key = canonicalKey(name);
  const filePath = path.join(CHARACTERS_DIR, `${key}.json`);

  try {
    const data = await fs.promises.readFile(filePath, 'utf8');
    const characterData = JSON.parse(data);
    characterData.gold = characterData.gold || 0;
    characterData.actionBar = characterData.actionBar || 0;
    characterData.maxActionBar = characterData.maxActionBar || 100;
    characterData.spells = characterData.spells || {};
    characterData.lastSpellCast = characterData.lastSpellCast || {};
    characterData.abilities = characterData.abilities || [];
    characterData.skillsState = characterData.skillsState || {};
    characterData.abilitySlots = characterData.abilitySlots || [];
    characterData.abilityCooldowns = characterData.abilityCooldowns || {};
    characterData.equipment = characterData.equipment || {};
    if (characterData.equipment.armour && !characterData.equipment.chest) {
      characterData.equipment.chest = characterData.equipment.armour;
      delete characterData.equipment.armour;
    }
    characterData.effects = characterData.effects || [];
    characterData.inventory = safeArray(characterData.inventory);
    for (const item of characterData.inventory) {
      if (item?.slot === 'armor') item.slot = 'chest';
    }
    delete characterData.currentVenture;
    delete characterData.ventures;

    console.log('Loaded character ' + name + ' (Gold: ' + characterData.gold + ') from ' + filePath);

    return characterData;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    console.error('Failed to load character ' + name, { err: error.message, name });
    return null;
  }
}
