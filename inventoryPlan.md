Gear slots:

Weapon
Headgear
Armor

Examples of items ( each category should have its own json file)

Weapon:
- id: "sword"
- Name: "Sword"
- Type: Melee

- Damage: 5
- AttackSpeed: 1.5
- Bonuses: { "STR": 10, HP: 5}

- Range: 1
- Value: 50
- Description: "A basic sword for melee combat."

Player's Weapon Slot:
Name: "sword" # refers to id in json
Level: 14 # item level, scales value, damage and stat modifiers ( 1 + level / 100)
Rarity: 1.3 # rarity factor, randomly 1-6, also scales value, damage and stat modifiers ( 1 + rarity / 100)



Headgear:
- id: "strawHat"
- Name: "Straw Hat"
- Type: Light

- Defense: 3
- Magic Resist: 2
- Bonuses: { "AGI": 2, HP: 5}

- Range: 1
- Value: 50
- Description: "A basic hat for light armor."

Player's Weapon Slot:
Name: "sword" # refers to id in json
Level: 14 # item level, scales value, damage and stat modifiers ( 1 + level / 100)
Rarity: 1.3 # rarity factor, randomly 1-6, also scales value, damage and stat modifiers ( 1 + rarity / 100)


Initial Planned items:

Weapons: sword (melee), bow (ranged), rod (magic) 
Headgear: strawHat (light), wizardHat (light), cowl (medium), helmet (heavy)
Armor: leatherArmor (light), chainMail (medium), plateArmor (heavy)