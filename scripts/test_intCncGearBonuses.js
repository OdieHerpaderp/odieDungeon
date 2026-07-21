// Gear bonus regression test for INT/CNC.
//
// Verifies that equipping wizardHat, clericRobe, and magicRod as compact
// equipment refs produces non-zero INT and CNC bonuses when the server-side
// gear-bonus pipeline resolves them against the catalog.
//
// This guards against the issue where INT/CNC bonuses were missing from
// client display and/or server-side stat calculations.

const assert = require('assert');
const itemGenerator = require('../public/gear/itemGenerator');
const characters = require('../characters');

const WIZARD_HAT = 'wizardHat';
const CLERIC_ROBE = 'clericRobe';
const MAGIC_ROD = 'magicRod';

function makeRef(id, level = 1, rarity = 1) {
    return { id, level, rarity };
}

function bonuses(player) {
    return {
        int: characters.getEquipmentBonus(player, 'int'),
        cnc: characters.getEquipmentBonus(player, 'cnc'),
    };
}

// --- Baseline: empty equipment yields zero INT/CNC bonuses -------------------
{
    const player = { equipment: {} };
    const b = bonuses(player);
    assert.strictEqual(b.int, 0, 'INT bonus should be 0 with no equipment');
    assert.strictEqual(b.cnc, 0, 'CNC bonus should be 0 with no equipment');
}

// --- Single items: each must contribute a positive INT and/or CNC bonus --------
{
    const hatPlayer = { equipment: { helmet: makeRef(WIZARD_HAT) } };
    const hatBonuses = bonuses(hatPlayer);
    assert.ok(hatBonuses.int > 0, `wizardHat should grant INT bonus, got ${hatBonuses.int}`);
    assert.ok(hatBonuses.cnc > 0, `wizardHat should grant CNC bonus, got ${hatBonuses.cnc}`);

    const robePlayer = { equipment: { armour: makeRef(CLERIC_ROBE) } };
    const robeBonuses = bonuses(robePlayer);
    assert.ok(robeBonuses.int > 0, `clericRobe should grant INT bonus, got ${robeBonuses.int}`);
    assert.ok(robeBonuses.cnc > 0, `clericRobe should grant CNC bonus, got ${robeBonuses.cnc}`);

    const rodPlayer = { equipment: { weapon: makeRef(MAGIC_ROD) } };
    const rodBonuses = bonuses(rodPlayer);
    assert.ok(rodBonuses.int > 0, `magicRod should grant INT bonus, got ${rodBonuses.int}`);
    assert.ok(rodBonuses.cnc > 0, `magicRod should grant CNC bonus, got ${rodBonuses.cnc}`);
}

// --- Combined: all three equipped must stack INT and CNC bonuses ---------------
{
    const player = {
        equipment: {
            helmet: makeRef(WIZARD_HAT),
            armour: makeRef(CLERIC_ROBE),
            weapon: makeRef(MAGIC_ROD),
        },
    };
    const b = bonuses(player);
    assert.ok(b.int > 0, 'combined INT bonus should be positive');
    assert.ok(b.cnc > 0, 'combined CNC bonus should be positive');

    // Verify the stacked value is at least as large as any single-item contribution.
    const hatBonuses = bonuses({ equipment: { helmet: makeRef(WIZARD_HAT) } });
    const robeBonuses = bonuses({ equipment: { armour: makeRef(CLERIC_ROBE) } });
    const rodBonuses = bonuses({ equipment: { weapon: makeRef(MAGIC_ROD) } });

    assert.ok(
        b.int >= hatBonuses.int + robeBonuses.int + rodBonuses.int - 0.01,
        'combined INT should equal sum of individual INT bonuses (within float tolerance)'
    );
    assert.ok(
        b.cnc >= hatBonuses.cnc + robeBonuses.cnc + rodBonuses.cnc - 0.01,
        'combined CNC should equal sum of individual CNC bonuses (within float tolerance)'
    );
}

// --- Direct catalog assertion: base INT/CNC values are non-zero ---------------
{
    const hatBase = itemGenerator.findBaseItem('helmet', WIZARD_HAT);
    assert.ok(hatBase, 'wizardHat should exist in catalog');
    assert.ok((hatBase.bonuses?.INT || 0) > 0, 'wizardHat base INT should be positive');
    assert.ok((hatBase.bonuses?.CNC || 0) > 0, 'wizardHat base CNC should be positive');

    const robeBase = itemGenerator.findBaseItem('armour', CLERIC_ROBE);
    assert.ok(robeBase, 'clericRobe should exist in catalog');
    assert.ok((robeBase.bonuses?.INT || 0) > 0, 'clericRobe base INT should be positive');
    assert.ok((robeBase.bonuses?.CNC || 0) > 0, 'clericRobe base CNC should be positive');

    const rodBase = itemGenerator.findBaseItem('weapon', MAGIC_ROD);
    assert.ok(rodBase, 'magicRod should exist in catalog');
    assert.ok((rodBase.bonuses?.INT || 0) > 0, 'magicRod base INT should be positive');
    assert.ok((rodBase.bonuses?.CNC || 0) > 0, 'magicRod base CNC should be positive');
}

console.log('INT/CNC gear bonus checks passed');
