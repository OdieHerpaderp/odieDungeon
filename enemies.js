// Load dungeons configuration for enemy scaling
const dungeons = require('./public/dungeons.json');

/**
 * Generate enemies for a party.
 * Respects dungeon `floorAmount` from `public/dungeons.json`.
 * The last (boss) floor spawns exactly ONE boss unit.
 */
function generateEnemies(party) {
    const livePlayers = Array.from(party.players.values()).filter(p => p.hp > 0);
    const enemyBonus = livePlayers.length - 0.35;

    // Get dungeon data for scaling
    const dungeonData = party.dungeon ? dungeons[party.dungeon] : null;
    const floorMult = dungeonData?.floorMult || 0.5;
    const floorBase = dungeonData?.floorBase || 1;

    // Get dungeon-relative floor (1..floorAmount per dungeon)
    // Fall back to 1 if dungeonFloors not yet initialized
    const dungeonFloor = party.dungeonFloors?.[party.dungeon] || 1;
    const dungeonFloorMax = dungeonData?.floorAmount ?? 100;

    // Calculate effective floor using dungeon-relative floor with multiplier
    // This makes each subsequent dungeon harder (forest: 0.9x, cave: 1.1x)
    const effectiveFloor = dungeonFloor * floorMult + floorBase;

    let boss = dungeonFloor === dungeonFloorMax;
    let enemyCount = Math.ceil(Math.random() * (0.3 + effectiveFloor / 21)) + enemyBonus * 1.5 + effectiveFloor / 22 + (enemyBonus * 1.1 - 0.3) * (0.28 + effectiveFloor / 24);

    // Last floor boss: force a single boss unit
    if (boss) {
        enemyCount = 1;
    }

    party.enemies = [];

    for (let i = 0; i < enemyCount; i++) {
        // Use effectiveFloor for tier selection
        const enemyData = getRandomEnemy(party.floor, effectiveFloor);
        let enemyName = enemyData.name;
        let floorBonus = Math.pow((enemyBonus * 0.8 + (0.1 + enemyBonus / 1.3) * effectiveFloor * 1.1) / (0.8 + enemyCount / 22) + Math.random() * (0.1 + effectiveFloor / 44), 1.15) * 0.25 + 0.1;
        let calcVit = Math.floor((2 + floorBonus / 1.3) + Math.random() * (0.5 + floorBonus / 9));
        let calcHp = Math.floor(Math.pow(floorBonus * 0.08 * (0.03 + calcVit * 0.02) + calcVit * 6 + floorBonus * 4 + effectiveFloor * 5 + 36 + Math.random() * (calcVit * 0.05 + 0.02 + floorBonus / 55) , 1.03));
        calcHp = Math.round(1.1 * calcHp / (1.1 + enemyCount / 14) * (0.65 + enemyBonus / 1.7));
        let enemyAp = Math.floor(calcHp * 0.05 + floorBonus + Math.random() * (floorBonus + calcHp * 0.1));
        if(boss) {
            // Last-floor boss: single boss unit + stronger stats
            floorBonus += 0.5 + enemyBonus * 0.6;
            floorBonus *= (1.1 + enemyBonus * 0.3);
            calcHp = Math.round(calcHp * (2.3 + enemyBonus * 0.7));
            calcVit += 10;
            enemyAp = Math.floor((20 + enemyAp) * 2.5);
        }
        party.enemies.push({
            id: `enemy_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
            name: enemyName,
            level: floorBonus.toFixed(2),
            gold: floorBonus * 0.0012 + calcHp * 0.00036 + 0.12,
            hp: calcHp,
            maxHp: calcHp,
            ap: enemyAp,
            maxAp: enemyAp,
            mp: Math.floor(8 + floorBonus * 1.1),
            maxMp: Math.floor(8 + floorBonus * 1.1),
            str: Math.floor(((0.6 + enemyBonus / 2.6) * floorBonus * 13) + Math.random() * (1.8 + floorBonus / 2.1)) / 10,
            dex: Math.floor((1 + floorBonus * 12) + Math.random() * (2.2 + floorBonus / 1.8)) / 10,
            agi: Math.floor((1 + floorBonus * 12) + Math.random() * (2.2 + floorBonus / 1.8)) / 10,
            vit: calcVit,
            int: 3, cnc: 3, wis: 3, luk: 3, for:3, pie:3,
            armour: ((0.1 + floorBonus / 31) + Math.random() * (0.3 + floorBonus / 47)),
            weaponMelee: ((0.3 + floorBonus / 15) + Math.random() * (0.2 + floorBonus / 48)),
            weaponRanged: ((0.3 + floorBonus / 15) + Math.random() * (0.2 + floorBonus / 48)),
            weaponMagic: ((0.3 + floorBonus / 15) + Math.random() * (0.2 + floorBonus / 48)),
            shoes: Math.floor((1.1 + floorBonus / 6) + Math.random() * (1 + floorBonus / 5)),
            xpValue: Math.pow(calcHp / 34 + 0.7 + floorBonus / 14 + calcVit / 22, 0.99) / 1.6,
            isEnemy: true,
            isBoss: boss,
            actionBar: 10,
            maxActionBar: 115 + enemyCount * 6
        });
    }
}

// Enemy definitions organized by strength tiers
const enemyTiers = {
    // Weak enemies (Floors 1-10)
    weak: {
        names: ['🧫Slime', '🐀Rat', '🧫Poring', '🦇Bat', '☃️SnowMan', '👺Goblin', '🎅Santa', '🐍DangerNoodle', '😈Kobold', '🧝Elf', '🐌Snail', '🦗Bug', '🐸Frog'],
        floorRange: [1, 10],
        weight: 60 // Higher weight for lower floors
    },
    
    // Medium enemies (Floors 11-40)
    medium: {
        names: ['🦏Rhino', '👽Ayylmao', '🧟livingImpaired', '🀄KnightSlime', '🧜🏼‍♂️Broseidon', '🧌Troll', '👹Ogre', '💀Skeleton', '🐺Wolf', '🦁Lion', '🦂Scorpion'],
        floorRange: [11, 40],
        weight: 30
    },
    
    // Strong enemies (Floors 41-150)
    strong: {
        names: ['🐙Kraken', '🦖T-Rex', '👾Invader', '🧛Vampire', '🤖Robit', '🗿Moai', '🦀GiantCrab', '🦍Harambe', '🫈Yeti', '🐺Werewolf', '🦄Unicorn', '🦑Leviathan'],
        floorRange: [41, 150],
        weight: 10
    },
    
    // Boss enemies (Floors 150+ or boss floors)
    boss: {
        names: ['👑KingSlime', '☠️Lich', '🐉Dragon', '🛸UFO', '☠️BoneLord', '🌚MoonLord', '🐲KingDragon', '🐍Medusa', '🦈SharkLord', '🦅Griffin'],
        floorRange: [150, 300],
        weight: 5,
        bossOnly: true // Only appear on boss floors (50, 100, 150, 200, 250, 300)
    }
};

// Helper function to get appropriate enemy tier for floor level
function getEnemyTierForFloor(actualFloor, effectiveFloor) {
    // Boss enemies only appear on specific floors
    if ((effectiveFloor % 50 === 0) && effectiveFloor > 0) {
        return enemyTiers.boss;
    }
    
    // Check each tier based on effective floor range
    for (const tierName in enemyTiers) {
        const tier = enemyTiers[tierName];
        if (effectiveFloor >= tier.floorRange[0] && effectiveFloor <= tier.floorRange[1]) {
            return tier;
        }
    }
    
    // Default to weak enemies for very low floors or fallback
    return enemyTiers.weak;
}

// Helper function to get weighted random enemy from tier
function getRandomEnemyFromTier(tier) {
    const randomIndex = Math.floor(Math.random() * tier.names.length);
    return tier.names[randomIndex];
}

// Helper function to get a random enemy based on floor level
function getRandomEnemy(actualFloor = 1, effectiveFloor = 1) {
    const tier = getEnemyTierForFloor(actualFloor, effectiveFloor);
    const enemyName = getRandomEnemyFromTier(tier);
    
    return {
        name: enemyName
    };
}

// Helper function to get a random enemy name only (for backward compatibility)
function getRandomEnemyName(floor = 1) {
    const tier = getEnemyTierForFloor(floor, floor);
    return getRandomEnemyFromTier(tier);
}

// Helper function to get all enemy names (for backward compatibility)
function getAllEnemyNames() {
    const allNames = [];
    for (const tierName in enemyTiers) {
        const tier = enemyTiers[tierName];
        allNames.push(...tier.names);
    }
    return allNames;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        generateEnemies,
        getRandomEnemy,
        getRandomEnemyName,
        getAllEnemyNames,
        enemyTiers,
        getEnemyTierForFloor
    };
} else {
    window.generateEnemies = generateEnemies;
    window.getRandomEnemy = getRandomEnemy;
    window.getRandomEnemyName = getRandomEnemyName;
    window.getAllEnemyNames = getAllEnemyNames;
    window.enemyTiers = enemyTiers;
    window.getEnemyTierForFloor = getEnemyTierForFloor;
}

