// database.js - Character Save/Load Module
const fs = require('fs');
const path = require('path');
const { compactEquipment } = require('./utils.js');

const CHARACTERS_DIR = path.join(__dirname, 'characters');
if (!fs.existsSync(CHARACTERS_DIR)) {
    fs.mkdirSync(CHARACTERS_DIR);
}

function sanitizeName(name) {
    return (name || '').replace(/[^a-zA-Z0-9]/g, '_');
}

function canonicalKey(name) {
    return sanitizeName(name);
}

function saveCharacter(name, character) {
    const key = canonicalKey(name);
    const filePath = path.join(CHARACTERS_DIR, `${key}.json`);
    
    // Ensure effects array exists
    if (!character.effects) {
        character.effects = [];
    }
    
    const characterData = {
        // NOTE: The 'id' field is NOT saved here because it's a session-specific identifier (socket.id)
        // Each player connection gets a unique ID assigned by the server at join time
        name: character.name,
        level: character.level,
        skillsState: character.skillsState,
        abilitySlots: character.abilitySlots,
        abilityCooldowns: character.abilityCooldowns,
        equipment: character.equipment ? compactEquipment(character.equipment) : {},
        xp: character.xp,
        xpToNext: character.xpToNext,
        gold: character.gold,              // Gold
        donated: character.donated,        // Donations
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
        effects: character.effects,              // Active buff/debuff effects
        inventory: character.inventory || [],            // Player inventory
        lastUpdated: new Date().toISOString()
    };
    
    try {
        fs.writeFileSync(filePath, JSON.stringify(characterData, null, 2));
        // console.log(`Saved character ${name} to ${filePath}`);
    } catch (error) {
        console.error(`Failed to save ${name}:`, error);
    }
}

function loadCharacter(name) {
    const key = canonicalKey(name);
    const filePath = path.join(CHARACTERS_DIR, `${key}.json`);
    
    if (fs.existsSync(filePath)) {
        try {
            const data = fs.readFileSync(filePath, 'utf8');
            const characterData = JSON.parse(data);
            // Initialize missing fields
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
            characterData.effects = characterData.effects || []; // Initialize effects array
            characterData.inventory = Array.isArray(characterData.inventory) ? characterData.inventory : [];
            delete characterData.currentVenture;
            delete characterData.ventures;
            
            console.log(`Loaded character ${name} (Gold: ${characterData.gold}) from ${filePath}`);

            return characterData;
        } catch (error) {
            console.error(`Failed to load ${name}:`, error);
        }
    }
    return null;
}

function graveyardCharacter(name) {
    const key = canonicalKey(name);
    const primarySource = path.join(CHARACTERS_DIR, `${key}.json`);
    const graveyardDir = path.join(__dirname, 'graveyard');
    if (!fs.existsSync(graveyardDir)) {
        fs.mkdirSync(graveyardDir);
    }
    const destPath = path.join(graveyardDir, `${key}.json`);

    if (fs.existsSync(primarySource)) {
        fs.renameSync(primarySource, destPath);
        console.log(`Moved ${name} to graveyard as ${key}.json`);
    }
}

module.exports = { saveCharacter, loadCharacter, graveyardCharacter };
