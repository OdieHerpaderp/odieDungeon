let abilityDefinitions = [];
let skillDefinitionsClient = [];
let lastSkillsSnapshot = null;
let lastCooldownsSnapshot = null;
let lastSlotsSnapshot = null;
let lastOwnPlayerForCooldowns = null;
let selectedSlotIndex = 0;
let lastPlayerForSlots = null;
let showAvailableOnly = false;
const expandedSkills = new Set();
const collapsedGroups = new Set();
const collapsedAbilityGroups = new Set();

// Client-side skill curve config (loaded once from shared JSON)
let _skillCurve = null;
async function loadSkillCurve() {
  if (_skillCurve) return _skillCurve;
  try {
    const response = await fetch('/skills/skillCurve.json');
    _skillCurve = await response.json();
  } catch (error) {
    console.warn('Unable to load skill curve config:', error);
    _skillCurve = { xpDivisor: 5, exponent: 0.72, levelDivisor: 15, minLevel: 1 };
  }
  return _skillCurve;
}

// Client-side copy of the skill level calculation formula
function calcSkillLv(xp) {
  const { xpDivisor, exponent, levelDivisor, minLevel } = _skillCurve || { xpDivisor: 5, exponent: 0.72, levelDivisor: 15, minLevel: 1 };
  return Math.max(minLevel, Math.floor((Math.pow(xp / xpDivisor, exponent) / levelDivisor)));
}

// Client-side function to get skill level from skills state (mirrors server-side getSkillLevel)
function getSkillLevelFromClient(skillsState, skillId) {
  const xp = skillsState?.[skillId]?.xp || 0;
  return Math.max(1, Math.floor(calcSkillLv(xp)));
}

// Compact signature of which abilities are currently unlocked for a player.
// Changes only when an ability actually crosses its unlock threshold (not on
// every XP tick), so it can gate ability-list re-renders without flicker.
function getUnlockedAbilitySignature(player) {
  if (!abilityDefinitions.length) return '';
  const skillsState = player?.skillsState || {};
  return abilityDefinitions
    .filter(a => getSkillLevelFromClient(skillsState, a.skillId) >= (a.unlockSkillLevelMin || 1))
    .map(a => a.id)
    .sort()
    .join(',');
}

function calcXpForLevel(level) {
  const { xpDivisor, exponent, levelDivisor } = _skillCurve || { xpDivisor: 5, exponent: 0.72, levelDivisor: 15 };
  return Math.pow((level * levelDivisor), 1 / exponent) * xpDivisor;
}

function calcXpForNextLevel(level) {
  return calcXpForLevel(level + 1);
}

// Client-side tick that refreshes the cooldown countdown text based on local time,
// independent of server state pushes. Only updates text/color in place (no innerHTML rebuild).
// Driven by requestAnimationFrame instead of setInterval so the thread stays idle when there is
// nothing to update (no active cooldowns and no pending text).
let _cooldownsRafId = null;
function tickAbilityCooldowns() {
  const el = document.getElementById('abilitySlotsPanel');
  if (!el || !lastOwnPlayerForCooldowns) return;

  const cooldowns = lastOwnPlayerForCooldowns?.abilityCooldowns || {};
  const anyActive = Object.values(cooldowns).some(end => typeof end === 'number' && end > Date.now());
  const panelHasPending = Array.from(el.querySelectorAll('[data-cd-slot]')).some(n => n.textContent !== 'Ready');
  if (!anyActive && !panelHasPending) return;

  el.querySelectorAll('[data-cd-slot]').forEach(node => {
    const assignedId = node.dataset.cdId || '';
    const cooldownText = formatCooldownText(lastOwnPlayerForCooldowns, assignedId);
    const color = cooldownText === 'Ready' ? '#8fe28b' : '#ffd166';
    if (node.textContent !== cooldownText) node.textContent = cooldownText;
    if (node.style.color !== color) node.style.color = color;
  });
}

let _lastCooldownsRefresh = 0;
function _cooldownsHaveWork() {
  const el = document.getElementById('abilitySlotsPanel');
  if (!el) return false;
  // Keep the RAF loop alive while we have an own player whose cooldowns may still
  // be settling in (server pushes every ~400ms). This prevents the loop from dying
  // between standard ticks, so countdowns keep ticking smoothly.
  if (lastOwnPlayerForCooldowns && _lastCooldownsRefresh >= Date.now() - 2000) return true;
  if (!el || !lastOwnPlayerForCooldowns) return false;
  const cooldowns = lastOwnPlayerForCooldowns?.abilityCooldowns || {};
  if (Object.values(cooldowns).some(end => typeof end === 'number' && end > Date.now())) return true;
  return Array.from(el.querySelectorAll('[data-cd-slot]')).some(n => n.textContent !== 'Ready');
}

function _cooldownsRafLoop() {
  tickAbilityCooldowns();
  // Reschedule only while there is work to do; otherwise stop. The loop is
  // restarted lazily whenever a render produces active/pending cooldowns.
  if (_cooldownsHaveWork()) {
    _cooldownsRafId = requestAnimationFrame(_cooldownsRafLoop);
  } else {
    _cooldownsRafId = null;
  }
}

window.startCooldownsTick = function() {
  if (_cooldownsRafId) return;
  _cooldownsRafId = requestAnimationFrame(_cooldownsRafLoop);
};

window.stopCooldownsTick = function() {
  if (_cooldownsRafId) {
    cancelAnimationFrame(_cooldownsRafId);
    _cooldownsRafId = null;
  }
};

window.calcSkillLv = calcSkillLv;

function formatDisplayLabel(id) {
  if (!id) return 'Unknown';
  return id.replace(/^skill_/, '').replace(/_/g, ' ');
}

function formatCooldownText(player, abilityId) {
  const cooldownEnd = player?.abilityCooldowns?.[abilityId];
  if (!cooldownEnd) return 'Ready';
  const remainingMs = Math.max(0, cooldownEnd - Date.now());
  if (remainingMs <= 0) return 'Ready';
  return `${(remainingMs / 1000).toFixed(1)}s`;
}

function getClientEquippedWeaponClass(player) {
  const weapon = player?.equipment?.weapon;
  if (!weapon) return '';
  if (weapon.weaponClass) return String(weapon.weaponClass).toLowerCase();
  if (weapon.id && window.itemGenerator?.resolveItem) {
    const resolved = window.itemGenerator.resolveItem('weapon', weapon.id, weapon.level || 1, weapon.rarity || 1);
    if (resolved?.weaponClass) return String(resolved.weaponClass).toLowerCase();
  }
  return '';
}

function getClientEquippedWeaponSubType(player) {
  const weapon = player?.equipment?.weapon;
  if (!weapon) return null;
  if (weapon.subType) return String(weapon.subType).toLowerCase();
  if (weapon.id && window.itemGenerator?.resolveItem) {
    const resolved = window.itemGenerator.resolveItem('weapon', weapon.id, weapon.level || 1, weapon.rarity || 1);
    if (resolved?.subType) return String(resolved.subType).toLowerCase();
  }
  return null;
}

// Level-only unlock check: returns true when the player's skill level meets the
// ability's `unlockSkillLevelMin`. Unlike isAbilityAvailable (cooldown/MP/weapon
// gated), this is the only criterion the "Available only" filter should use, so
// it never hides an ability based on weapon selection or equip state.
function isAbilityUnlockedByLevel(player, ability) {
  if (!player || !ability) return false;
  const skillLevel = getSkillLevelFromClient(player?.skillsState || {}, ability.skillId);
  return skillLevel >= (ability.unlockSkillLevelMin || 1);
}

async function loadAbilityDefinitions() {
  if (abilityDefinitions.length > 0) return abilityDefinitions;
  try {
    const response = await fetch('/api/abilities');
    const data = await response.json();
    abilityDefinitions = Array.isArray(data) ? data : [];
  } catch (error) {
    console.warn('Unable to load ability definitions:', error);
    abilityDefinitions = [];
  }
  return abilityDefinitions;
}

async function loadSkillDefinitions() {
  if (skillDefinitionsClient.length > 0) return skillDefinitionsClient;
  try {
    const response = await fetch('/skills/skills.json');
    const data = await response.json();
    skillDefinitionsClient = Array.isArray(data) ? data : [];
  } catch (error) {
    console.warn('Unable to load skill definitions:', error);
    skillDefinitionsClient = [];
  }
  return skillDefinitionsClient;
}

function getSkillDefinitionClient(skillId) {
  return skillDefinitionsClient.find(skill => skill.id === skillId) || null;
}

function buildSkillAbilitiesList(player, skillId) {
  const abilities = abilityDefinitions.filter(ability => ability.skillId === skillId);
  if (abilities.length === 0) {
    return `<div style="font-size:11px; color:#777; padding:3px 0 4px 16px;">No abilities yet.</div>`;
  }

  const playerSkillLevel = getSkillLevelFromClient(player?.skillsState || {}, skillId);

  return abilities.map(ability => {
    const requiredLevel = ability.unlockSkillLevelMin || 1;
    const unlocked = playerSkillLevel >= requiredLevel;
    const levelColor = unlocked ? '#8fe28b' : '#ff9e80';
    return `
      <div class="ability-indent">
        <div class="flex-between">
          <span style="color:${unlocked ? '#eee' : '#888'}; font-weight:600;">${ability.name}</span>
          <span class="text-info">Req Lv.${requiredLevel}</span>
        </div>
        <div class="text-dim">${ability.description || ''}</div>
        <div class="text-info">MP: ${ability.mpCostBase ?? '-'} • CD: ${ability.cooldownMsBase ? (ability.cooldownMsBase / 1000).toFixed(1) + 's' : '-'}</div>
      </div>
    `;
  }).join('');
}

function buildSkillRow(player, id, state, def) {
  const label = def?.name || formatDisplayLabel(id);
  const currentXp = Math.floor(state.xp || 0);
  const currentLevel = calcSkillLv(currentXp);

  const nextLevelXp = calcXpForNextLevel(currentLevel);
  const currentLevelXp = calcXpForLevel(currentLevel);
  const xpProgress = currentXp - currentLevelXp;
  const xpNeededForNextLevel = nextLevelXp - currentLevelXp;

  let xpBarWidth = 0;
  let xpWithinLevelText = "Maxed";

  if (xpNeededForNextLevel > 0) {
    xpBarWidth = Math.min(100, (xpProgress / xpNeededForNextLevel) * 100);
    xpWithinLevelText = `${Math.floor(xpProgress)} / ${Math.floor(xpNeededForNextLevel)} xp`;
  } else {
    xpWithinLevelText = `${Math.floor(currentXp)} xp`;
  }

  const isExpanded = expandedSkills.has(id);
  const abilityCount = abilityDefinitions.filter(ability => ability.skillId === id).length;
  const arrow = isExpanded ? '▼' : '▶';
  const listDisplay = isExpanded ? 'block' : 'none';

    return `
      <div class="skill-row mb-6">
        <div class="skill-header clickable-row" onclick="toggleSkillExpand('${id}', this)">
          <span class="text-info" style="font-size:10px; width:10px;">${arrow}</span>
          <strong class="text-truncate" style="flex:1;">${label}</strong>
          <span class="text-dim">Lv${currentLevel}</span>
          <span class="text-muted">(${abilityCount})</span>
        </div>
        <div class="xp-bar-track">
          <div style="width:${xpBarWidth}%; height:100%; background:#4caf50;"></div>
        </div>
        <div class="text-dim">${xpWithinLevelText}</div>
        <div class="skill-abilities" style="display:${listDisplay}; margin-top:2px;">
          ${buildSkillAbilitiesList(player, id)}
        </div>
      </div>`;
}

function buildSkillsPanel(player) {
  const entries = Object.entries(player?.skillsState || {});
  if (!entries.length) {
    return `
      <div style="font-size:12px; color:#eee; line-height:1.3;">
        <div style="font-weight:700; margin-bottom:4px;">Skills</div>
        <div class="skill-row">No skills trained yet.</div>
      </div>
    `;
  }

  const groupsOrder = [];
  const groups = {};
  for (const [id, state] of entries) {
    const def = getSkillDefinitionClient(id);
    const group = def?.group || 'General';
    if (!groups[group]) {
      groups[group] = [];
      groupsOrder.push(group);
    }
    groups[group].push([id, state, def]);
  }

  const groupHtml = groupsOrder.map(group => {
    const rows = groups[group].map(([id, state, def]) => buildSkillRow(player, id, state, def)).join('');
    const isCollapsed = collapsedGroups.has(group);
    const arrow = isCollapsed ? '▶' : '▼';
    const rowsDisplay = isCollapsed ? 'none' : 'block';
    return `
      <div class="skill-group mb-6">
        <div class="skill-group-header clickable-row" onclick="toggleGroupExpand('${encodeURIComponent(group)}', this)">
          <span class="skill-group-arrow text-info" style="font-size:10px; width:10px;">${arrow}</span>
          <span class="text-info-bold">${group}</span>
        </div>
        <div class="skill-group-rows" style="display:${rowsDisplay};">
          ${rows}
        </div>
      </div>
    `;
  }).join('');

  return `
    <div class="panel-text">
      <div class="font-bold" style="margin-bottom:4px;">Skills</div>
      ${groupHtml}
    </div>
  `;
}

window.toggleGroupExpand = function(groupName, el) {
  const decoded = decodeURIComponent(groupName);
  const groupEl = el.closest('.skill-group');
  const rows = groupEl?.querySelector('.skill-group-rows');
  const arrowEl = groupEl?.querySelector('.skill-group-arrow');

  if (collapsedGroups.has(decoded)) {
    collapsedGroups.delete(decoded);
    if (rows) rows.style.display = 'block';
    if (arrowEl) arrowEl.textContent = '▼';
  } else {
    collapsedGroups.add(decoded);
    if (rows) rows.style.display = 'none';
    if (arrowEl) arrowEl.textContent = '▶';
  }
};

window.toggleSkillExpand = function(skillId, el) {
  const wrap = el.closest('.skill-row');
  const list = wrap?.querySelector('.skill-abilities');
  const arrowEl = wrap?.querySelector('.skill-header > span');
  if (expandedSkills.has(skillId)) {
    expandedSkills.delete(skillId);
    wrap?.classList.remove('expanded');
    if (list) list.style.display = 'none';
    if (arrowEl) arrowEl.textContent = '▶';
  } else {
    expandedSkills.add(skillId);
    wrap?.classList.add('expanded');
    if (list) list.style.display = 'block';
    if (arrowEl) arrowEl.textContent = '▼';
  }
};

window.toggleAbilityGroup = function(skillId, el) {
  const groupEl = el.closest('.ability-group');
  const rows = groupEl?.querySelector('.ability-group-rows');
  const arrowEl = groupEl?.querySelector('.ability-group-arrow');

  if (collapsedAbilityGroups.has(skillId)) {
    collapsedAbilityGroups.delete(skillId);
    if (rows) rows.style.display = 'block';
    if (arrowEl) arrowEl.textContent = '▼';
  } else {
    collapsedAbilityGroups.add(skillId);
    if (rows) rows.style.display = 'none';
    if (arrowEl) arrowEl.textContent = '▶';
  }
};

function buildAbilitySlotsColumn(player) {
  const slotCards = Array.from({ length: 8 }, (_, index) => {
    const assignedId = player?.abilitySlots?.[index] || '';
    const ability = abilityDefinitions.find(ability => ability.id === assignedId);
    const name = ability ? ability.name : 'Empty';
    const mpCost = ability ? (ability.mpCostBase ?? '-') : '-';
    const skillLabel = ability ? formatDisplayLabel(ability.skillId) : '-';
    const isSelected = index === selectedSlotIndex;
    const highlightStyle = isSelected ? 'background:#4caf50;' : 'background:#2a2a2a;';
    const clearButton = assignedId ? `<button onclick="event.stopPropagation(); window.unequipAbilitySlot(${index})" class="btn-sm">✕ Clear</button>` : '';
    const cooldownText = formatCooldownText(player, assignedId);
    const cooldownColor = cooldownText === 'Ready' ? '#8fe28b' : '#ffd166';

    return `
      <div class="ability-slot-row">
        <div data-cd-slot="${index}" data-cd-id="${assignedId}" class="ability-cd-text" style="color:${cooldownColor}; min-width:38px; font-size:11px; text-align:center;">${cooldownText}</div>
        <div onclick="window.selectAbilitySlot(${index})" class="ability-card" style="${highlightStyle} border-radius:3px;">
          <div class="text-info-bold" style="min-width:30px;">S${index + 1}</div>
          <div class="flex-col">
            <div class="text-truncate">${name}</div>
            <div class="text-dim ability-meta">MP:${mpCost} • ${skillLabel}</div>
          </div>
          ${clearButton}
        </div>
      </div>
    `;
  }).join('');

  return `<div class="col-scroll" style="padding-right:4px;">${slotCards}</div>`;
}

function formatWeaponRequirement(ability) {
  const parts = [];
  if (ability.requiresWeaponEquipped) {
    if (ability.requiredWeaponSubTypes && ability.requiredWeaponSubTypes.length > 0) {
      parts.push(ability.requiredWeaponSubTypes.join('/'));
    } else if (ability.allowedWeaponClasses && ability.allowedWeaponClasses.length > 0) {
      parts.push(ability.allowedWeaponClasses.join('/'));
    } else {
      parts.push('equipped weapon');
    }
  } else if (ability.allowedWeaponClasses && ability.allowedWeaponClasses.length > 0) {
    parts.push(ability.allowedWeaponClasses.join('/'));
  }
  if (!parts.length) return '';
  return `Wpn: ${parts.join(' + ')}`;
}

function buildAbilityList(player, filterAvailable = false) {
  const grouped = {};
  for (const ability of abilityDefinitions) {
    if (!grouped[ability.skillId]) grouped[ability.skillId] = [];
    grouped[ability.skillId].push(ability);
  }

  let skillOrder = Object.keys(grouped).sort((a, b) => {
    const defA = getSkillDefinitionClient(a);
    const defB = getSkillDefinitionClient(b);
    const nameA = defA?.name || formatDisplayLabel(a);
    const nameB = defB?.name || formatDisplayLabel(b);
    return nameA.localeCompare(nameB);
  });

  if (filterAvailable) {
    skillOrder = skillOrder.filter(skillId => {
      return grouped[skillId].some(ability => isAbilityUnlockedByLevel(player, ability));
    });
  }

  const groupsHtml = skillOrder.map(skillId => {
    const abilities = grouped[skillId];
    const def = getSkillDefinitionClient(skillId);
    const groupLabel = def?.name || formatDisplayLabel(skillId);
    const playerSkillLevel = getSkillLevelFromClient(player?.skillsState || {}, skillId);
    const isCollapsed = collapsedAbilityGroups.has(skillId);
    const arrow = isCollapsed ? '▶' : '▼';
    const rowsDisplay = isCollapsed ? 'none' : 'block';

    const visibleAbilities = filterAvailable
      ? abilities.filter(ability => isAbilityUnlockedByLevel(player, ability))
      : abilities;

    const rows = visibleAbilities.map(ability => {
      const requiredLevel = ability.unlockSkillLevelMin || 1;
      const unlocked = playerSkillLevel >= requiredLevel;
      const inSlotIndex = (player?.abilitySlots || []).indexOf(ability.id);
      const inSelectedSlot = inSlotIndex === selectedSlotIndex;
      const inOtherSlot = inSlotIndex >= 0 && !inSelectedSlot;

      let btnLabel = 'Equip';
      let btnDisabled = '';
      if (inSelectedSlot) {
        btnLabel = 'Equipped';
        btnDisabled = 'disabled';
      } else if (inOtherSlot) {
        btnLabel = 'Move';
      }
      if (!unlocked) {
        btnDisabled = 'disabled';
        btnLabel = `Lv.${requiredLevel}`;
      }

      const weaponReq = formatWeaponRequirement(ability);

      return `
        <div class="ability-card">
          <div class="ability-card-left">
            <div class="text-truncate" style="font-weight:600; color:${unlocked ? '#eee' : '#888'};">${ability.name}</div>
            <div class="text-dim ability-desc">${ability.description || ''}</div>
            <div class="text-info ability-meta">MP:${ability.mpCostBase ?? '-'} • CD:${ability.cooldownMsBase ? (ability.cooldownMsBase / 1000).toFixed(1) + 's' : '-'}${!unlocked ? ` • Req Lv.${requiredLevel}` : ''}</div>
            ${weaponReq ? `<div class="text-warn ability-meta">${weaponReq}</div>` : ''}
          </div>
          <button onclick="window.equipAbility('${ability.id}')" ${btnDisabled} class="btn-sm">${btnLabel}</button>
        </div>
      `;
    }).join('');

    if (visibleAbilities.length === 0 && filterAvailable) {
      return '';
    }

    return `
      <div class="ability-group mb-6">
        <div class="ability-group-header clickable-row" onclick="window.toggleAbilityGroup('${skillId}', this)" style="margin-bottom:3px;">
          <span class="ability-group-arrow text-info" style="font-size:10px; width:10px;">${arrow}</span>
          <span class="text-info-bold">${groupLabel}</span>
        </div>
        <div class="ability-group-rows" style="display:${rowsDisplay};">
          ${rows}
        </div>
      </div>
    `;
  }).join('');

  return `<div style="flex:1; min-width:200px; overflow-y:auto; padding-left:6px; border-left:1px solid #444; min-height:0;">${groupsHtml}</div>`;
}

function buildAbilitySlotsPanel(player) {
  return `
    <div class="panel-text" style="display:flex; flex-direction:column; height:100%; box-sizing:border-box;">
      <div class="flex-between" style="margin-bottom:4px;">
        <div class="text-info-bold">Slots</div>
        <div style="display:flex; align-items:center; gap:8px;">
          <span class="text-info-bold">Abilities</span>
          <label class="ability-filter-label" style="display:flex; align-items:center; gap:4px; font-size:11px; color:#ccc; cursor:pointer;">
            <input type="checkbox" id="availableOnlyFilter" onchange="window.toggleAvailableFilter(this.checked)" ${showAvailableOnly ? 'checked' : ''}>
            Unlocked only
          </label>
        </div>
      </div>
      <div style="display:flex; gap:8px; flex:1; min-height:0;">
        ${buildAbilitySlotsColumn(player)}
        ${buildAbilityList(player, showAvailableOnly)}
      </div>
    </div>
  `;
}

window.selectAbilitySlot = function(index) {
  selectedSlotIndex = index;
  if (lastPlayerForSlots) {
    window.renderAbilitySlotsPanel(lastPlayerForSlots);
  }
};

window.equipAbility = async function(abilityId) {
  if (!lastPlayerForSlots) return;
  const ability = abilityDefinitions.find(a => a.id === abilityId);
  if (!ability) return;

  const requiredLevel = ability.unlockSkillLevelMin || 1;
  const playerSkillLevel = getSkillLevelFromClient(lastPlayerForSlots?.skillsState || {}, ability.skillId);
  if (playerSkillLevel < requiredLevel) {
    toastFrame.showToast({
      html: `Cannot equip ${ability.name}: Requires level ${requiredLevel} ${formatDisplayLabel(ability.skillId)}`,
      duration: 3000
    });
    return;
  }

  await clientNetwork.assignAbilitySlot(selectedSlotIndex, abilityId);

  const currentSlots = Array.isArray(lastPlayerForSlots.abilitySlots) ? lastPlayerForSlots.abilitySlots : Array(8).fill(null);
  const nextSlots = currentSlots.map((id, i) => i === selectedSlotIndex ? abilityId : id);
  const dupIndex = nextSlots.findIndex((id, i) => i !== selectedSlotIndex && id === abilityId);
  if (dupIndex !== -1) nextSlots[dupIndex] = null;
  lastPlayerForSlots.abilitySlots = nextSlots;
  lastSlotsSnapshot = null;
  window.renderAbilitySlotsPanel(lastPlayerForSlots);
};

window.unequipAbilitySlot = async function(index) {
  await clientNetwork.assignAbilitySlot(index, '');

  const currentSlots = Array.isArray(lastPlayerForSlots.abilitySlots) ? lastPlayerForSlots.abilitySlots : Array(8).fill(null);
  const nextSlots = [...currentSlots];
  nextSlots[index] = null;
  lastPlayerForSlots.abilitySlots = nextSlots;
  lastSlotsSnapshot = null;
  window.renderAbilitySlotsPanel(lastPlayerForSlots);
};

window.toggleAvailableFilter = function(checked) {
  showAvailableOnly = checked;
  lastSlotsSnapshot = null;
  if (lastPlayerForSlots) window.renderAbilitySlotsPanel(lastPlayerForSlots);
};

window.renderSkillsPanel = async function(player) {
  const el = document.getElementById('skillsPanel');
  if (!el) return;
  const snapshot = JSON.stringify(player?.skillsState || {});
  if (snapshot === lastSkillsSnapshot && el.innerHTML) {
    return;
  }
  lastSkillsSnapshot = snapshot;
  await loadAbilityDefinitions();
  await loadSkillDefinitions();
  el.innerHTML = buildSkillsPanel(player);
};

window.renderAbilitySlotsPanel = async function(player) {
  const el = document.getElementById('abilitySlotsPanel');
  if (!el) return;
  await loadAbilityDefinitions();
  const snapshot = JSON.stringify({ slots: player?.abilitySlots || [], selection: selectedSlotIndex, filter: showAvailableOnly, unlocked: getUnlockedAbilitySignature(player) });
  if (snapshot === lastSlotsSnapshot && el.innerHTML) {
    return;
  }
  lastSlotsSnapshot = snapshot;
  lastPlayerForSlots = player;
  el.innerHTML = buildAbilitySlotsPanel(player);
};

let _skillPanelLastRender = 0;
window.renderSkillPanel = async function(player, force = false) {
  // Keep a live reference to the own player's cooldowns for the RAF tick, and mark
  // the refresh time so the loop stays alive between server pushes (~400ms standard).
  if (player) {
    lastOwnPlayerForCooldowns = player;
    _lastCooldownsRefresh = Date.now();
    if (window.startCooldownsTick) window.startCooldownsTick();
  }
  // Throttle full skill-panel rebuilds to at most ~2x/sec during rapid combat ticks.
  const now = Date.now();
  if (!force && now - _skillPanelLastRender < 500) return;
  _skillPanelLastRender = now;
  await loadSkillCurve();
  await Promise.all([
    window.renderSkillsPanel(player),
    window.renderAbilitySlotsPanel(player)
  ]);
};
