//Toast
const toastFrame = new JSFrame();
toastFrame.showToast({ html: 'Henlo :)' });

// Load gear data for itemGenerator
Promise.all([
  fetch('/gear/weaponMelee.json').then(response => response.json()),
  fetch('/gear/weaponRanged.json').then(response => response.json()),
  fetch('/gear/weaponMagic.json').then(response => response.json()),
  fetch('/gear/headgearLight.json').then(response => response.json()),
  fetch('/gear/headgearMedium.json').then(response => response.json()),
  fetch('/gear/headgearHeavy.json').then(response => response.json()),
  fetch('/gear/armorLight.json').then(response => response.json()),
  fetch('/gear/armorMedium.json').then(response => response.json()),
  fetch('/gear/armorHeavy.json').then(response => response.json()),
  fetch('/gear/feetWearLight.json').then(response => response.json()),
  fetch('/gear/feetWearMedium.json').then(response => response.json()),
  fetch('/gear/feetWearHeavy.json').then(response => response.json())
])
.then(([weaponMelee, weaponRanged, weaponMagic, hgL, hgM, hgH, arL, arM, arH, ftL, ftM, ftH]) => {
  // Update the itemGenerator with loaded data
  const headgear = [...hgL, ...hgM, ...hgH];
  const armors = [...arL, ...arM, ...arH];
  const feetWear = [...ftL, ...ftM, ...ftH];
  if (window.itemGenerator && typeof window.itemGenerator.updateCatalogs === 'function') {
    window.itemGenerator.updateCatalogs(weaponMelee, weaponRanged, weaponMagic, headgear, armors, feetWear);
    console.log('Gear catalogs loaded and updated in itemGenerator');
  } else {
    console.warn('itemGenerator not available or updateCatalogs method missing');
  }
})
.catch(err => console.error('Failed to load gear JSON files:', err));

// Load dungeons configuration
let dungeons = {};
fetch('/dungeons.json')
  .then(response => response.json())
  .then(data => {
    dungeons = data;
    console.log('Dungeons loaded:', dungeons);
    // Initialize dungeon UI after loading
    setTimeout(updateDungeonUI, 100);
    // Also update background based on currentDungeon (defaults to 'field')
    setTimeout(() => updateBackgroundColor(currentDungeon), 100);
    // Update dungeon buttons with emojis from dungeons.json
    setTimeout(updateDungeonButtons, 100);
  })
  .catch(err => console.error('Failed to load dungeons.json:', err));

// Current dungeon tracking
let currentDungeon = 'field';

// Update dungeon selector UI based on unlocked dungeons
function updateDungeonUI() {
  const dungeonButtons = document.querySelectorAll('.dungeon-btn');
  if (!dungeons || Object.keys(dungeons).length === 0) return;

  dungeonButtons.forEach(btn => {
    const dungeonKey = btn.dataset.dungeon;
    const dungeonData = dungeons[dungeonKey];
    if (!dungeonData) return;

    // Check if this dungeon is unlocked
    const isUnlocked = isDungeonUnlocked(dungeonKey);

    const isCurrent = currentDungeon === dungeonKey;

    btn.disabled = !isUnlocked;
    btn.classList.toggle('current-dungeon', isCurrent);
    btn.classList.toggle('locked-dungeon', !isUnlocked);

    // Update title with unlock requirement
    if (!isUnlocked) {
      const reqDungeon = getPrerequisiteDungeon(dungeonKey);
      if (reqDungeon) {
        btn.title = `Reach floor 101 in ${reqDungeon} to unlock`;
      }
    }
  });

  // Re-render dungeon buttons too (so lock/gray-out updates immediately after state changes)
  updateEmbarkButtonLabel();
  updateDungeonButtons();
}

// Refresh the dungeon list UI only when completion/unlock progress actually changes,
// so the list updates automatically after a party clears a dungeon (no manual click needed).
let _lastDungeonListSig = '';
function refreshDungeonListIfChanged(state) {
  if (!state) return;
  const sig = JSON.stringify([
    state.completedDungeons || {},
    state.dungeonFloors || {},
    state.highestVisitedFloors || {}
  ]);
  if (sig !== _lastDungeonListSig) {
    _lastDungeonListSig = sig;
    updateDungeonUI();
  }
}

// Update dungeon buttons with emojis from dungeons.json
function updateDungeonButtons() {
  const dungeonButtonsContainer = document.getElementById('dungeonButtons');
  if (!dungeonButtonsContainer || !dungeons || Object.keys(dungeons).length === 0) return;

  // Get dungeon progress from currentState
  const dungeonFloors = currentState.dungeonFloors || {};
  const highestVisitedFloors = currentState.highestVisitedFloors || {};
  const completedDungeons = currentState.completedDungeons || {};
  
  // Generate dungeon buttons dynamically based on dungeons.json
  let buttonsHtml = '';
  Object.keys(dungeons).forEach(dungeonKey => {
    const dungeonData = dungeons[dungeonKey];
    const isCompleted = completedDungeons[dungeonKey] === true;
    const emoji = isCompleted ? '✅' : (dungeonData.emoji || '?');
    const isUnlocked = isDungeonUnlocked(dungeonKey);
    const isCurrent = currentDungeon === dungeonKey;
    const highestFloor = highestVisitedFloors[dungeonKey] || 0;

    const floorBase = Number(dungeonData?.floorBase ?? 0);
    const floorMult = Number(dungeonData?.floorMult ?? 0);
    const floorAmount = Number(dungeonData?.floorAmount ?? 0);

    const difficulty = floorBase + floorMult * floorAmount;

    buttonsHtml += `
      <button class="dungeon-btn floor-btn ${isCurrent ? 'current-dungeon' : ''} ${!isUnlocked ? 'locked-dungeon' : ''}" 
        data-dungeon="${dungeonKey}" 
        onclick="selectDungeon('${dungeonKey}')" 
        ${!isUnlocked ? `title="Locked until you complete the previous dungeon"` : ''}
        ${!isUnlocked ? 'disabled' : ''}
      >
        <div class="dungeon-btn-inner">
          <div class="dungeon-btn-icon">${emoji}</div>
          <div class="dungeon-btn-body">
            <div class="dungeon-btn-title">
              <div class="dungeon-btn-name">${dungeonKey}</div>
              <div class="dungeon-btn-meta">${highestFloor > 0 ? 'H:' + highestFloor : ''}</div>
            </div>
            <div class="dungeon-btn-detail">Floors: ${floorAmount}, Diff.: ${difficulty.toFixed(2)}</div>
          </div>
        </div>
      </button>`;
  });
  
  dungeonButtonsContainer.innerHTML = buttonsHtml;
}

// Check if a dungeon is unlocked
function isDungeonUnlocked(dungeonKey) {
  // Field is always unlocked (first dungeon)
  if (dungeonKey === 'field') return true;

  // Can't check unlock status without player data - assume unlocked if not field
  const ownPlayerData = currentState.players ? currentState.players.find(p => p.name === ownName) : null;
  if (!ownPlayerData) return true;

  // Check prerequisite
  const reqDungeon = getPrerequisiteDungeon(dungeonKey);
  if (!reqDungeon) return true;

  // Prefer server truth: checkmarked dungeons
  const completedDungeons = currentState.completedDungeons || {};
  if (completedDungeons[reqDungeon] === true) return true;

  // Legacy fallback (until completedDungeons is reliably present in state)
  const dungeonFloors = currentState.dungeonFloors || {};
  const prevDungeonFloor = dungeonFloors[reqDungeon] || 0;

  // Unlock at prerequisite dungeon's max floor (floorAmount), defaulting to 100
  const reqDungeonData = dungeons[reqDungeon];
  const reqDungeonMax = reqDungeonData?.floorAmount ?? 100;

  return prevDungeonFloor >= reqDungeonMax;
}

// Get prerequisite dungeon for a given dungeon (soft-coded from dungeons.json order)
function getPrerequisiteDungeon(dungeonKey) {
  if (!dungeons || !dungeonKey) return null;

  const keysInOrder = Object.keys(dungeons);

  // Keep behavior consistent: if "field" exists, always treat it as the first dungeon.
  const sortedKeys = keysInOrder.includes('field')
    ? ['field', ...keysInOrder.filter(k => k !== 'field')]
    : keysInOrder;

  const idx = sortedKeys.indexOf(dungeonKey);
  if (idx <= 0) return null;

  return sortedKeys[idx - 1];
}

// Only select a dungeon in UI; actual start happens via Embark button (embarkDungeon)
window.selectDungeon = function(dungeonKey) {
  if (!dungeons[dungeonKey]) return;
  if (!isDungeonUnlocked(dungeonKey)) {
    addToEventLog(`Dungeon ${dungeonKey} is locked until you complete the previous dungeon.`, 'error');
    return;
  }

  currentDungeon = dungeonKey;
  updateBackgroundColor(currentDungeon);
  updateDungeonUI();

};

// Update background color based on dungeon and floor
// This function handles all background color logic - single source of truth
function updateEmbarkButtonLabel() {
  const embarkBtn = document.getElementById('embarkBtn');
  if (!embarkBtn || !dungeons) return;

  // If we're in town (floor=0) show the selected dungeon; otherwise keep it generic
  const dungeonData = dungeons[currentDungeon] || {};
  const emoji = dungeonData.emoji || '🗺️';

  embarkBtn.textContent = currentState?.floor === 0 && !currentState?.combatActive
    ? `🚀 Embark: ${emoji} ${currentDungeon}`
    : '🚀 Embark';
}

function updateBackgroundColor(dungeonKey) {
  // Remove all dungeon classes
  document.documentElement.classList.remove('dungeon-field', 'dungeon-forest', 'dungeon-cave');
  
  // Apply dungeon background color from dungeons.json when NOT in town (floor > 0)
  // If dungeonKey is 'town' or floor is 0, keep default background
  if (dungeonKey && dungeonKey !== 'town' && currentState.floor > 0) {
    const dungeonData = dungeons[dungeonKey];
    const backgroundColor = dungeonData?.background;
    
    if (backgroundColor) {
      // Use background color from dungeons.json
      document.documentElement.style.backgroundColor = backgroundColor;
    } else {
      // Fallback to default if not found
      document.documentElement.style.backgroundColor = '#222222';
    }
  } else {
    // Reset to default for town
    document.documentElement.style.backgroundColor = '#222222';
  }

  console.log(`Background: ${currentState.floor > 0 && dungeonKey && dungeonKey !== 'town' ? dungeons[dungeonKey]?.background || 'default' : 'default (town)'}`);
}


// Event Log
let eventLogMessages = [];
let eventLogDiv = null;
const EVENT_LOG_LIMIT = 20;

function addToEventLog(message, type = 'info') {
    // Lazy initialization of logDiv
    if (!eventLogDiv) {
        eventLogDiv = document.getElementById('eventLog');
    }
    if (!eventLogDiv) return;

    eventLogMessages.push({ message, type });
    if (eventLogMessages.length > EVENT_LOG_LIMIT) eventLogMessages.shift();

    // Use DocumentFragment for efficient batch DOM updates
    const fragment = document.createDocumentFragment();
    const msgDiv = document.createElement('div');
    msgDiv.className = `event-${type}`;
    msgDiv.textContent = message;
    fragment.appendChild(msgDiv);

    // Append new message first
    eventLogDiv.appendChild(fragment);

    // Remove excess messages from the beginning if over limit (newest messages at top)
    while (eventLogDiv.children.length > EVENT_LOG_LIMIT) {
        eventLogDiv.removeChild(eventLogDiv.firstChild);
    }

    // Scroll to bottom
    eventLogDiv.scrollTop = eventLogDiv.scrollHeight;
}

// Combat Log - Only stores the latest combat summary
let latestCombatSummary = null;

function updateCombatLog() {
    const combatLogEl = document.getElementById('combatLogContent');
    if (!combatLogEl) return;
    
    if (latestCombatSummary) {
        combatLogEl.innerHTML = `${latestCombatSummary}`;
    } else {
        combatLogEl.innerHTML = '';
    }
}

function addToCombatLog(message, type = 'info') {
    // Only show the latest combat summary - regular messages are ignored
    // Use addCombatSummaryToLog() for combat summaries
}

function addCombatSummaryToLog(summaryHtml) {
    latestCombatSummary = summaryHtml;
    updateCombatLog();
}


//JSFrame stuff
let _cachedFrameAppearance = null;

function getOriginalStyle(frameAppearance) {
  if (_cachedFrameAppearance) {
    const cloned = Object.assign(Object.create(Object.getPrototypeOf(_cachedFrameAppearance)), _cachedFrameAppearance);
    cloned.onInitialize = _cachedFrameAppearance.onInitialize;
    return cloned;
  }

  // Window appearance configuration
  Object.assign(frameAppearance, {
    titleBarHeight: '14px', titleBarCaptionFontSize: '13px', titleBarCaptionFontWeight: '600',
    titleBarCaptionLeftMargin: '2px', titleBarCaptionColorDefault: 'gray', titleBarCaptionColorFocused: 'white',
    titleBarCaptionTextShadow: null, titleBarColorDefault: '#161616', titleBarColorFocused: '#161616',
    titleBarBorderBottomDefault: null, titleBarBorderBottomFocused: null, frameBorderRadius: '4px',
    frameBorderWidthDefault: '2px', frameBorderWidthFocused: '2px',
    frameBorderColorDefault: '#161616', frameBorderColorFocused: '#161616',
    titleBarClassNameDefault: ' ', titleBarClassNameFocused: ' '
  });

  frameAppearance.onInitialize = function() {
    const partsBuilder = frameAppearance.getPartsBuilder();
    const closeButtonApr = partsBuilder.buildTextButtonAppearance();
    Object.assign(closeButtonApr, {
      width: 17, height: 17, borderRadius: 0, borderWidth: 0,
      borderColorDefault: 'transparent', borderColorFocused: 'transparent',
      borderColorHovered: 'transparent', borderColorPressed: 'transparent',
      borderStyleDefault: '', borderStyleFocused: '', borderStyleHovered: '', borderStylePressed: '',
      backgroundColorDefault: 'transparent', backgroundColorFocused: 'transparent',
      backgroundColorHovered: 'rgba(33, 33, 33, 0.2)', backgroundColorPressed: 'rgba(33, 33, 33, 0.2)',
      backgroundBoxShadow: null, caption: '\u2716', captionColorDefault: 'gray',
      captionColorFocused: 'white', captionColorHovered: 'white', captionColorPressed: 'white',
      captionShiftYpx: 0, captionFontRatio: 0.6
    });
    const closeButtonEle = partsBuilder.buildTextButton(closeButtonApr);
    const closeButtonY = -closeButtonApr.height / 2 - parseInt(frameAppearance.titleBarHeight) / 2;
    frameAppearance.addFrameComponent('closeButton', closeButtonEle, -1, closeButtonY, 'RIGHT_TOP');
  };

  if (!_cachedFrameAppearance) _cachedFrameAppearance = frameAppearance;
  return frameAppearance;
}

const jsFrame = new JSFrame();

// Helper function to create JSFrame windows with common configuration
function createGameFrame(options) {
  const { name, title, left, top, width, height, minWidth, minHeight, hidden, html } = options;
  const frame = jsFrame.create({
    name,
    title,
    left,
    top,
    width,
    height,
    minWidth,
    minHeight,
    appearance: getOriginalStyle(jsFrame.createFrameAppearance()),
    html,
    style: {
      backgroundColor: '#111',
      overflow: 'hidden'
    }
  });
  hidden ? frame.hide() : frame.show();
  return frame;
}

// Generate ability slot editor HTML
let abilitySlotHtml = `
<div class="ability-slot-editor">
  <div style="font-weight: bold; margin-bottom: 6px;">Ability Slots</div>
  <div id="abilitySlotContainer"></div>
</div>
`;

// HTML Generator Functions
function generateShopHtml() {
  return `
    <div class="frame-pad">
      ${buildGearTabsHtml('shop')}
      <div id="shopBodies" class="gear-scroll"></div>
      <button style="background-color:#68b" class="buy-btn" onclick="donate()" id="donateBtn">👼 Donate (50g)</button>
    </div>
  `;
}

// Shared column definitions used by both the Equipment/Inventory panel and the Shop.
const EQUIPMENT_CATEGORIES = [
  { label: 'Weapon', icon: '⚔️', equippedKey: 'weapon', slots: ['weapon'] },
  { label: 'Headgear', icon: '🪖', equippedKey: 'helmet', slots: ['headgear', 'helmet'] },
  { label: 'Armor', icon: '🛡️', equippedKey: 'armour', slots: ['armor', 'armour'] },
  { label: 'Shoes', icon: '👢', equippedKey: 'shoes', slots: ['shoes'] }
];

function generateEquipmentHtml() {
  return `
    <div class="frame-pad">
      ${buildGearTabsHtml('equip')}
      <div id="equipmentBodies" class="gear-scroll"></div>
    </div>
  `;
}

// Shared tab infrastructure for the Equipment and Shop frames. Each gear category is a
// tab; only the active tab's body is shown. Active selection persists in these vars
// so it survives panel re-renders.
let _activeEquipCat = EQUIPMENT_CATEGORIES[0].label;
let _activeShopCat = EQUIPMENT_CATEGORIES[0].label;

// Categories that currently have un-seen (newly added) items, highlighted yellow
// in the tab bar until the user clicks that tab.
const _newEquipCats = new Set();
const _newShopCats = new Set();

// Previous per-category group-key sets, used to detect *new* items (added keys only).
let _prevEquipKeys = {};
let _prevShopKeys = {};

function buildGearTabsHtml(prefix) {
  const active = prefix === 'equip' ? _activeEquipCat : _activeShopCat;
  return `<div class="gear-tabs">${EQUIPMENT_CATEGORIES.map(c =>
    `<button class="gear-tab ${c.label === active ? 'active' : ''}" onclick="selectGearTab('${prefix}', '${c.label}')">${c.icon} ${c.label}</button>`
  ).join('')}</div>`;
}

window.selectGearTab = function(prefix, label) {
  if (prefix === 'equip') _activeEquipCat = label; else _activeShopCat = label;
  if (prefix === 'equip') _newEquipCats.delete(label); else _newShopCats.delete(label);
  const active = prefix === 'equip' ? _activeEquipCat : _activeShopCat;
  const frame = prefix === 'equip' ? equipmentFrame : shopFrame;
  const tabs = frame?.$('.gear-tabs');
  if (tabs) tabs.querySelectorAll('.gear-tab').forEach((tab, i) => {
    tab.classList.toggle('active', EQUIPMENT_CATEGORIES[i].label === active);
    if (EQUIPMENT_CATEGORIES[i].label === label) tab.classList.remove('new-items');
  });
  const bodies = frame?.$('.gear-scroll');
  if (bodies) bodies.querySelectorAll('.gear-tab-body').forEach(b =>
    b.classList.toggle('active', b.dataset.label === active));
};

// Build one category's tab body: an equipped block (optional) + a flex column of
// compact two-line item cards.
function buildGearCategoryBody(prefix, category, equippedRow, rows) {
  const active = (prefix === 'equip' ? _activeEquipCat : _activeShopCat) === category.label;
  const empty = rows.length ? '' : `<div style="font-size:11px; color:#777; padding:2px;">${prefix === 'shop' ? 'No stock' : 'No spares'}</div>`;
  return `
    <div class="gear-tab-body ${active ? 'active' : ''}" data-label="${category.label}">
      ${equippedRow}
      ${empty}
      <div class="gear-list">${rows.join('')}</div>
    </div>`;
}

window.unequipItem = function(slot) {
  window.equipInventoryItem(null, slot);
};

function generateFloorControlHtml() {
  return `
    <div class="frame-pad">
      <div class="floor-display" style="margin-bottom: 8px; padding: 4px; background: rgba(0,0,0,0.3); border-radius: 4px; text-align: center;">
        <div id="floorDisplayText" style="font-size: 15px; font-weight: bold; color: #ff8;">Floor 0 - Town</div>
      </div>
      <button class="floor-btn btn-block" onclick="embarkDungeon()" id="embarkBtn" style="background: #aa6;">🚀 Embark</button>
      <button class="floor-btn btn-block" onclick="toggleAutoEmbark()" id="autoEmbarkBtn" style="background: #55a;">🔁 Auto-Embark: OFF</button>
      <button class="floor-btn btn-block" onclick="escapeDungeon()" id="escapeBtn" style="background: #a55;">🏃 Escape</button>
      <div style="border-top: 1px solid #444; padding-top: 1px; margin-bottom: 1px;">
        <h4 class="panel-h4">Dungeons</h4>
        <div id="dungeonButtons">
          <!-- Dungeon buttons are generated dynamically from dungeons.json -->
        </div>
      </div>
    </div>
  `;
}

function generatePlayerFrameHtml() {
  return '<div id="frameOwnPlayer" style="width:100%; height:100%; color:white;"></div>';
}

function generateOptionsFrameHtml() {
  const optionSection = (title, body) => `
    <div style="margin-bottom: 10px;">
      <h4 class="panel-h4">${title}</h4>
      ${body}
    </div>
  `;
  return `
    <div style="padding: 10px; color: white; display: flex; gap: 10px;">
      <div style="flex: 1;">
        ${optionSection('Performance', `<div id="perfHud" class="text-dim" style="margin-bottom: 8px;">FPS: -- | Updates: --ms</div>`)}
        ${optionSection('TCP (Socket.IO)', `<div class="text-sm">
          <div>Ping: <span id="tcpPing" class="text-muted">--</span> ms</div>
          <div>Sent: <span id="tcpSentPerSec" class="text-muted">--</span>/sec</div>
          <div>Received: <span id="tcpRecvPerSec" class="text-muted">--</span>/sec</div>
          <div>Packets/sec: <span id="tcpPacketsPerSec" class="text-muted">--</span></div>
          <div>Data: <span id="tcpThroughput" class="text-muted">--</span> KB/s</div>
        </div>`)}
        ${optionSection('UDP (WebRTC)', `<div class="text-sm">
          <div>Ping: <span id="udpPing" class="text-muted">--</span> ms</div>
          <div>Sent: <span id="udpSentPerSec" class="text-muted">--</span>/sec</div>
          <div>Received: <span id="udpRecvPerSec" class="text-muted">--</span>/sec</div>
          <div>Packets/sec: <span id="udpPacketsPerSec" class="text-muted">--</span></div>
          <div>Data: <span id="udpThroughput" class="text-muted">--</span> KB/s</div>
          <div>Status: <span id="udpStatus" class="text-muted">--</span></div>
        </div>`)}
      </div>
      <div style="flex: 1;">
        ${optionSection('Perf. Mode', `<select id="perfModeSelect" onchange="changePerformanceMode(this.value)" class="select-dark">
          <option value="adaptive">Adaptive</option>
          <option value="performance">Performance</option>
          <option value="quality">Quality</option>
        </select>`)}
        ${optionSection('Batching Size', `<select id="batchSizeSelect" onchange="changeBatchSize(this.value)" class="select-dark">
          <option value="75">75ms</option>
          <option value="100">100ms</option>
          <option value="125">125ms</option>
          <option value="150">150ms</option>
          <option value="200" selected>200ms</option>
          <option value="250">250ms</option>
          <option value="300">300ms</option>
          <option value="350">350ms</option>
          <option value="400">400ms</option>
          <option value="450">450ms</option>
          <option value="500">500ms</option>
        </select>`)}
        ${optionSection('Optimizer', `<div class="text-sm">
          <div>Delta: <span id="deltaStatus" class="text-muted">--</span></div>
          <div>Batch: <span id="batchStatus" class="text-muted">--</span></div>
          <div>Prediction: <span id="predStatus" class="text-muted">--</span></div>
        </div>`)}
      </div>
    </div>
  `;
}

// Frame Configurations
const frameConfigs = [
  { name: 'Skills', title: '🎯 Skills', left: 2, top: 285, width: 190, height: 320, minWidth: 160, minHeight: 200, html: `<div id="skillsPanel" style="padding:6px; color:white; font-size:12px; height:100%; overflow-y:auto; box-sizing:border-box;"></div>` },
  { name: 'AbilitySlots', title: '🧩 Ability Slots', left: 195, top: 285, width: 420, minWidth: 252, height: 320, minHeight: 200, html: `<div id="abilitySlotsPanel" style="padding:6px; color:white; font-size:12px; height:100%; box-sizing:border-box; overflow:hidden;"></div>` },
  { name: 'Equipment', title: '🎒 Equipment & Inventory', left: 605, top: 285, width: 300, height: 260, minWidth: 180, minHeight: 160, html: generateEquipmentHtml() },
  { name: 'Shop', title: '🛒 Shop (town only)', left: 845, top: 285, width: 300, height: 260, minWidth: 180, minHeight: 160, html: generateShopHtml() },
  { name: 'Win1', title: '📜 Event Log', left: 720, top: 600, width: 380, height: 100, minWidth: 160, minHeight: 80, html: '<div id="eventLog" style="width:100%; height:100%; color:white; overflow-y:scroll; font-size:12px; z-index:1000;"></div>' },
  { name: 'FloorControls', title: '🗺️ Floor Controls', left: 850, top: 550, width: 200, height: 250, minWidth: 160, minHeight: 200, html: generateFloorControlHtml() },
  { name: 'CurrentPlayer', title: '👤 Current Player', left: 2, top: 50, width: 315, height: 230, minWidth: 200, minHeight: 150, html: generatePlayerFrameHtml() },
  { name: 'Options', title: '⚙️ Options & Performance', left: 750, top: 420, width: 310, height: 280, minWidth: 180, minHeight: 250, hidden: true, html: generateOptionsFrameHtml() },
  { name: 'PartyMembers', title: '🛡️ Party Members', left: 330, top: 50, width: 315, height: 230, minWidth: 200, minHeight: 150, html: '<div id="partyMembers" style="width:100%; height:100%; color:white; overflow-y:auto;"></div>' },
  { name: 'Enemies', title: '👹 Enemies', left: 650, top: 50, width: 440, height: 230, minWidth: 150, minHeight: 150, html: '<div id="enemies" style="width:100%; height:100%; color:white; overflow-y:auto;"></div>' },
  { name: 'CombatLog', title: '⚔️ Combat Log', left: 650, top: 370, width: 440, height: 200, minWidth: 200, minHeight: 150, hidden: true, html: '<div id="combatLogContent" style="width:100%; height:100%; color:#4ecdc4; overflow-y:auto; font-size:12px; padding:5px;"></div>' }
];

// Create all game frames using the helper function
const frames = {};
frameConfigs.forEach(config => {
  frames[config.name] = createGameFrame(config);
});
const { Skills: skillsFrame, AbilitySlots: abilitySlotsFrame, Equipment: equipmentFrame, Shop: shopFrame, Win1: eventFrame, FloorControls: floorControlFrame, CurrentPlayer: playerFrame, Options: optionsFrame, PartyMembers: partyMembersFrame, Enemies: enemiesFrame, CombatLog: combatLogFrame } = frames;

// Window Manager: per-frame show/hide + center, plus global shortcuts. Stays on top.
const createWindowManagerFrame = () => {
  const row = c => `<div style="display:flex;align-items:center;gap:2px;margin:2px 0;font-size:12px;color:#fff;">
      <span style="flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;" title="${c.title}">${c.title}</span>
      <button id="wm-toggle-${c.name}" onclick="wmToggle('${c.name}')" style="font-size:11px;padding:1px 4px;"></button>
      <button onclick="wmCenter('${c.name}')" title="Center" style="font-size:11px;padding:1px 4px;">⤢</button></div>`;
  const wm = jsFrame.create({ name: 'WindowManager', title: 'Window Manager', left: 1182, top: 2, width: 200, height: 360,
      appearance: getOriginalStyle(jsFrame.createFrameAppearance()),
      html: `<div style="padding:4px;color:#fff;">
        <div style="display:flex;gap:2px;margin-bottom:4px;">
          <button onclick="wmShowAll()" style="flex:1;font-size:11px;padding:2px;">Show All</button>
          <button onclick="wmHideAll()" style="flex:1;font-size:11px;padding:2px;">Hide All</button>
          <button onclick="wmCenterAll()" style="flex:1;font-size:11px;padding:2px;">Center All</button></div>
        ${frameConfigs.map(row).join('')}</div>`,
      style: { backgroundColor: '#111', overflow: 'hidden' } }).show();

  // Always on top: when any game frame gains focus, re-pull the manager after its pullUp.
  const toTop = () => setTimeout(() => wm.parentCanvas.pullUp(wm.id), 0);
  Object.values(frames).forEach(f => f.eventEmitter.only('focus', 'wm-keep-top', toTop));

  const isVis = f => f.htmlElement.style.display !== 'none';
  const sync = () => frameConfigs.forEach(c => { const b = document.getElementById('wm-toggle-' + c.name); if (b) b.textContent = isVis(frames[c.name]) ? 'Hide' : 'Show'; });
  window.wmToggle = n => { isVis(frames[n]) ? frames[n].hide() : frames[n].show(); sync(); };
  window.wmCenter = n => frames[n].setPosition(innerWidth / 2, innerHeight / 2, 'CENTER_CENTER');
  window.wmShowAll = () => { Object.values(frames).forEach(f => f.show()); sync(); };
  window.wmHideAll = () => { Object.values(frames).forEach(f => f.hide()); sync(); };
  window.wmCenterAll = () => Object.values(frames).forEach(f => f.setPosition(innerWidth / 2, innerHeight / 2, 'CENTER_CENTER'));
  window.wmSync = sync;
  sync();
};
createWindowManagerFrame();

// Global variables for state
let currentState = {}, ownName, ownId, clientNetwork, ownPlayerElement = null;
const playerElements = new Map(), playerIdElements = new Map(), enemyElements = new Map(), lastHp = {};
// PERF: Unified cache for change detection - stores entity state to avoid unnecessary DOM updates
const _entityCache = new Map(); // playerName -> { lastState, uiRefs, _state }

// Add a flash class and remove it when the CSS animation ends (instead of a
// setTimeout). Restarts the animation if it is already running. Avoids timer
// proliferation during fast combat.
function flashClass(el, cls) {
  if (!el) return;
  el.classList.remove(cls);
  void el.offsetWidth; // force reflow so the animation restarts
  el.classList.add(cls);
  el.addEventListener('animationend', function handler() {
    el.classList.remove(cls);
    el.removeEventListener('animationend', handler);
  }, { once: true });
}

  function buildClientCallbacks() {
    return {
      updatePartyDisplay: updatePartyDisplay,
      updateShopStock: (shopStock) => {
        if (!shopStock) return;
        if (clientNetwork && clientNetwork.currentState) {
          clientNetwork.currentState.shopStock = shopStock;
        }
        if (window.renderShopStock) window.renderShopStock(shopStock);
      },
      addToEventLog: addToEventLog,
      updatePerformanceStatus: () => {
        if (clientNetwork && clientNetwork.updatePerformanceStatus) clientNetwork.updatePerformanceStatus();
      },
      onJoinedParty: (data) => {
        document.getElementById('gameArea').style.display = 'block';
        playerFrame.show();
        partyMembersFrame.show();
        enemiesFrame.show();
        document.getElementById('ownPlayer').style.display = 'none';
        playerElements.clear();
        enemyElements.clear();
        document.getElementById('partyMembers').innerHTML = '';
        document.getElementById('enemies').innerHTML = '';
        const fullState = data.fullState || data;
        ownId = fullState.players.find(p => p.name === ownName)?.id;
        updatePartyDisplay(fullState);
        updateDungeonUI();
        if (window.wmSync) window.wmSync();
      },
      onLeaveParty: () => {
        if (window.stopCooldownsTick) window.stopCooldownsTick();
        document.getElementById('lobby').style.display = 'block';
        document.getElementById('gameArea').style.display = 'none';
        playerFrame.hide();
        partyMembersFrame.hide();
        enemiesFrame.hide();
        document.getElementById('ownPlayer').style.display = 'block';
        playerElements.clear();
        enemyElements.clear();
        document.getElementById('partyMembers').innerHTML = '';
        document.getElementById('enemies').innerHTML = '';
        const ownContainer = document.getElementById('frameOwnPlayer');
        if (ownContainer) ownContainer.innerHTML = '';
        ownPlayerElement = null;
        if (window.wmSync) window.wmSync();
      },
      onAttack: (data) => {
        const { attackerId, hit, crit } = data;
        let element;
        if (attackerId && attackerId.startsWith('enemy_')) element = enemyElements.get(attackerId);
        else if (attackerId === ownName || attackerId === ownId) element = ownPlayerElement;
        else element = playerIdElements.get(attackerId) || playerElements.get(attackerId);
         if (element) {
          const cls = crit ? 'crit-flash' : hit ? 'hit-flash' : 'miss-flash';
          flashClass(element, cls);
        }
      },
      onCombatStart: () => {
        addToEventLog('⚔️ Combat started! Action bars filling...', 'info');
        addToCombatLog('⚔️ Combat started! Action bars filling...', 'combat');
      },
      onCombatEnd: (data) => {
        addToEventLog(data.message, data.summary ? 'success' : 'info');
        addToCombatLog(data.message, data.summary ? 'victory' : 'combat');
        if (data.summary) addCombatSummaryToLog(data.summary);
      },
      onMovementBlocked: (data) => addToEventLog(data.message, 'error'),
      onNextFloorBlocked: (data) => addToEventLog(data.message, 'error'),
      onDotEffectsUpdate: (data) => {
        const dotEffects = document.getElementById('dotEffects');
        const dotList = document.getElementById('dotList');
        if (!dotEffects || !dotList) return;

        if (data.dots && data.dots.length > 0) {
          dotEffects.style.display = 'block';
          const fragment = document.createDocumentFragment();
          data.dots.forEach(dot => {
            const div = document.createElement('div');
            div.className = 'dot-item';
            div.style.cssText = 'margin-bottom: 2px; padding: 2px; background: rgba(255,255,255,0.1); border-radius: 3px;';

            const sourceSpan = document.createElement('span');
            sourceSpan.style.cssText = 'color: #ff6b6b;';
            sourceSpan.textContent = dot.sourceName;

            const damageSpan = document.createElement('span');
            damageSpan.style.cssText = 'color: #fff;';
            damageSpan.textContent = ` - ${dot.damagePerTick.toFixed(1)} dmg/tick - `;

            const durationSpan = document.createElement('span');
            durationSpan.style.cssText = 'color: #ccc;';
            durationSpan.textContent = `${dot.duration} ticks remaining`;

            div.appendChild(sourceSpan);
            div.appendChild(damageSpan);
            div.appendChild(durationSpan);
            fragment.appendChild(div);
          });
          dotList.innerHTML = '';
          dotList.appendChild(fragment);
        } else {
          dotEffects.style.display = 'none';
        }
      }
    };
  }

  function initializeClientNetwork() {
    clientNetwork = new ClientNetwork(buildClientCallbacks());
  }

   // Initialize networking when page loads
   initializeClientNetwork();

   // Start the client-side cooldown countdown tick so ability cooldowns update
   // frequently during combat without waiting for server state pushes.
   if (window.startCooldownsTick) window.startCooldownsTick(150);

   // Start periodic network statistics updates
  setInterval(() => {
      if (clientNetwork && clientNetwork.updatePerformanceStatus) {
          clientNetwork.updatePerformanceStatus();
      }
  }, 1000); // Update every second

  window.joinParty = function() {
      const name = document.getElementById('playerName').value || `Player${Math.floor(Math.random()*1000)}`;
      ownName = name;
      const partyId = document.getElementById('partyId').value || `party${Math.random().toString(36).substr(2, 6).toUpperCase()}`;
      clientNetwork.joinParty(partyId, name);
      document.getElementById('lobby').style.display = 'none';
  };

  function embarkDungeon() {
      clientNetwork.embarkDungeon(currentDungeon);
  }

  let autoEmbarkEnabled = false;

  window.toggleAutoEmbark = function() {
      autoEmbarkEnabled = !autoEmbarkEnabled;
      updateAutoEmbarkButton();
      clientNetwork.toggleAutoEmbark(autoEmbarkEnabled);
  };

  function updateAutoEmbarkButton() {
      const btn = document.getElementById('autoEmbarkBtn');
      if (!btn) return;
      btn.textContent = autoEmbarkEnabled ? '🔁 Auto-Embark: ON' : '🔁 Auto-Embark: OFF';
      btn.style.background = autoEmbarkEnabled ? '#5a5' : '#55a';
  }

  window.escapeDungeon = function() {
      clientNetwork.escapeDungeon();
  };

  function updateEscapeButton(data) {
      const btn = document.getElementById('escapeBtn');
      if (!btn) return;
      const liveEnemies = data.enemies.filter(e => e.hp > 0);
      const combatActive = data.combatActive || liveEnemies.length > 0;
      const enable = data.floor > 0 && !combatActive;
      btn.disabled = !enable;
  }


  /**
   * Helper function to update a single player's display.
   * Creates or updates the DOM element for a player and handles ownPlayer reference.
   * @param {Object} player - The player data object (optional if playerData provided)
   * @param {boolean} isOwnPlayer - Whether this is the current user's player
   * @param {boolean} canAllocate - Whether the player can allocate points (in town, not in combat)
   * @param {Object} [playerData] - Optional player data to use (for direct updates from handlers)
   */
  function updatePlayerDisplay(player, isOwnPlayer, canAllocate, playerData) {
       const p = playerData || player;
      if (!p) return;

      if (isOwnPlayer) {
          const ownContainer = document.getElementById('frameOwnPlayer');
          if (!ownContainer) return;
          if (!ownPlayerElement) {
              ownPlayerElement = createPlayerElement(p, true);
              ownContainer.innerHTML = '';
              ownContainer.appendChild(ownPlayerElement);
          }
          updatePlayerElement(ownPlayerElement, p, canAllocate);
      } else {
          let element = playerElements.get(p.name);
          if (!element) {
              element = createPlayerElement(p, false);
              document.getElementById('partyMembers').appendChild(element);
              playerElements.set(p.name, element);
              if (p.id) playerIdElements.set(p.id, element);
          }
          updatePlayerElement(element, p, canAllocate);
      }
  }

  // Cache calculated items per (item object, slot). Equipment item references are
  // stable across party-state ticks, so a WeakMap keyed by the item object avoids
  // recomputing calculateItemStats/resolveItem on every render (perf win, no leak).
  const _itemCalcCache = new WeakMap();
  function getCalculatedItem(item, slotKey) {
    if (!item) return item;
    let perSlot = _itemCalcCache.get(item);
    if (!perSlot) { perSlot = new Map(); _itemCalcCache.set(item, perSlot); }
    if (perSlot.has(slotKey)) return perSlot.get(slotKey);
    let result;
    if (item.baseItem) result = window.itemGenerator?.calculateItemStats?.(item) || item;
    else if (item.id) result = window.itemGenerator?.resolveItem?.(slotKey, item.id, item.level, item.rarity) || item;
    else result = item;
    perSlot.set(slotKey, result);
    return result;
  }

  function getEquipmentStatBonus(player, statKey) {
    const equip = player?.equipment || {};
    const key = String(statKey).toUpperCase();
    let total = 0;
    for (const [slot, ref] of Object.entries(equip)) {
      if (!ref || !ref.id) continue;
      const item = window.itemGenerator?.resolveItem(slot, ref.id, ref.level, ref.rarity);
      const b = item?.bonuses;
      if (b && typeof b[key] === 'number') total += b[key];
    }
    return total;
  }

  function statBonusHtml(player, stat) {
    const b = getEquipmentStatBonus(player, stat);
    const text = b ? `+${Math.round(b)}` : '';
    return `<span class="gear-bonus ${stat}-bonus">${text}</span>`;
  }

  function getAverageItemTier(player) {
      const slots = ['weapon', 'armour', 'helmet', 'shoes'];
      let sum = 0, count = 0;
      for (const s of slots) {
          const ref = player.equipment?.[s];
          if (!ref) continue;
          const item = getCalculatedItem(ref, s);
          const tier = window.itemGenerator?.calculateItemTier?.(item);
          if (typeof tier === 'number' && Number.isFinite(tier)) {
              sum += tier;
              count++;
          }
      }
      return count ? sum / count : 0;
  }

  function itemStatsHtml(calculatedItem, fontSize = '11px') {
    const span = (text, color) => `<span style="color:${color};">${text}</span>`;
    const row = (inner) => `<div style="font-size:${fontSize};">${inner}</div>`;
    const parts = [];
    const dmg = [];
    if (calculatedItem.damage) dmg.push(span(`DMG: ${calculatedItem.damage}`, '#ff6b6b'));
    if (calculatedItem.spellPower) dmg.push(span(`SP: ${calculatedItem.spellPower}`, '#4fc3f7'));
    if (dmg.length) parts.push(row(dmg.join(' ')));
    const def = [];
    if (calculatedItem.defense) def.push(span(`DEF: ${calculatedItem.defense}`, '#4db6ac'));
    if (calculatedItem.magicResist) def.push(span(`MR: ${calculatedItem.magicResist}`, '#9575cd'));
    if (def.length) parts.push(row(def.join(' ')));
    if (calculatedItem.damageModifiers) {
      const mods = Object.entries(calculatedItem.damageModifiers)
        .map(([stat, weight]) => `${stat} x${Number(weight).toFixed(2)}`).join(', ');
      parts.push(row(span(`MODS: ${mods}`, '#ff6b6b')));
    }
    if (calculatedItem.attackSpeed) parts.push(row(span(`ASPD: ${calculatedItem.attackSpeed}`, '#ffd54f')));
    if (calculatedItem.bonuses) {
      for (const [stat, value] of Object.entries(calculatedItem.bonuses)) {
        parts.push(row(span(`+${value} ${stat}`, '#ffb74d')));
      }
    }
    return parts.join('');
  }

  // Inline tier marker (e.g. "♔3.5"), shown next to the name/rarity on the card's
  // first line. Returns '' when no tier is available.
  function itemTierBadge(item) {
    const tier = window.itemGenerator?.calculateItemTier?.(item);
    if (typeof tier !== 'number') return '';
    return `<span class="gear-tier">♔${tier.toFixed(1)}</span>`;
  }

  function getColourFromRarity(rarity) {
    const r = Math.floor(Number(rarity) || 1);
    const map = {
      1: { text: '#bbb', bg: '#2a2a2a', border: '#444' },
      2: { text: '#eee', bg: '#3a3a3a', border: '#666' },
      3: { text: '#4caf50', bg: '#1b3a1b', border: '#2e7d32' },
      4: { text: '#42a5f5', bg: '#152238', border: '#1565c0' },
      5: { text: '#ab47bc', bg: '#2a1a3a', border: '#6a1b9a' },
      6: { text: '#ef5350', bg: '#3a1a1a', border: '#c62828' },
    };
    if (r >= 7) return { text: '#ff9800', bg: '#3a2a1a', border: '#ef6c00' };
    return map[r] || map[1];
  }

  // Client-side estimate of the gold a player would get for selling an item (75% of
  // its buy price), mirroring the server's sellValue formula in app.js.
  function getSellPrice(calculated) {
    const calc = calculated || {};
    let price;
    if (typeof calc.baseValue === 'number') {
      price = window.itemGenerator?.calculateItemPrice?.(calc.baseValue, calc.level, calc.rarity) ?? calc.baseValue;
    } else {
      price = calc.price ?? 40;
    }
    return Math.max(1, Math.floor(price * 0.75));
  }

  function itemTooltip(calculatedItem, extra = '') {
    const name = calculatedItem?.displayName || calculatedItem?.name || calculatedItem?.id || 'Unknown';
    const level = calculatedItem?.level ? ` Lv${calculatedItem.level}` : '';
    const rarity = calculatedItem?.rarity ? ` (${calculatedItem.rarity}★)` : '';
    let tooltip = `${name}${level}${rarity}\n${extra}`;
    if (calculatedItem.damage) tooltip += `Damage: ${calculatedItem.damage}\n`;
    if (calculatedItem.spellPower) tooltip += `Spell Power: ${calculatedItem.spellPower}\n`;
    if (calculatedItem.damageModifiers) {
      const mods = Object.entries(calculatedItem.damageModifiers)
        .map(([stat, weight]) => `${stat} x${Number(weight).toFixed(2)}`).join(', ');
      tooltip += `Damage Mods: ${mods}\n`;
    }
    if (calculatedItem.defense) tooltip += `Defense: ${calculatedItem.defense}\n`;
    if (calculatedItem.magicResist) tooltip += `Magic Resist: ${calculatedItem.magicResist}\n`;
    if (calculatedItem.attackSpeed) tooltip += `Attack Speed: ${calculatedItem.attackSpeed}\n`;
    if (calculatedItem.bonuses) {
      for (const [stat, value] of Object.entries(calculatedItem.bonuses)) {
        tooltip += `${stat}: +${value}\n`;
      }
    }
    return tooltip;
  }

  // Compact single-line stat tokens for the two-line gear card. Same colour coding as
  // itemStatsHtml but space-separated so the whole stat block fits on one wrapping line.
  function itemStatsInlineHtml(calculatedItem) {
    const span = (text, color) => `<span style="color:${color};">${text}</span>`;
    const parts = [];
    const dmg = [];
    if (calculatedItem.damage) dmg.push(span(`DMG:${calculatedItem.damage}`, '#ff6b6b'));
    if (calculatedItem.spellPower) dmg.push(span(`SP:${calculatedItem.spellPower}`, '#4fc3f7'));
    if (dmg.length) parts.push(dmg.join(' '));
    const def = [];
    if (calculatedItem.defense) def.push(span(`DEF:${calculatedItem.defense}`, '#4db6ac'));
    if (calculatedItem.magicResist) def.push(span(`MR:${calculatedItem.magicResist}`, '#9575cd'));
    if (def.length) parts.push(def.join(' '));
    if (calculatedItem.damageModifiers) {
      const mods = Object.entries(calculatedItem.damageModifiers)
        .map(([stat, weight]) => `${stat}x${Number(weight).toFixed(2)}`).join(',');
      parts.push(span(`MODS:${mods}`, '#ff6b6b'));
    }
    if (calculatedItem.attackSpeed) parts.push(span(`ASPD:${calculatedItem.attackSpeed}`, '#ffd54f'));
    if (calculatedItem.bonuses) {
      for (const [stat, value] of Object.entries(calculatedItem.bonuses)) {
        parts.push(span(`+${value}${stat}`, '#ffb74d'));
      }
    }
    return parts.join(' ');
  }

  // Shared line-1 fragment for gear cards: name + level + rarity★ + tier + count.
  function gearCardTitle(calculated, count) {
    const name = calculated?.displayName || calculated?.name || calculated?.id || 'Unknown';
    const level = calculated?.level ? ` Lv${calculated.level}` : '';
    const rarity = calculated?.rarity ? ` <span style="color:${getColourFromRarity(calculated.rarity).text};">(${calculated.rarity}★)</span>` : '';
    const countBadge = count > 1 ? ` <span style="font-size:10px; color:#9f9;">x${count}</span>` : '';
    return `${name}${level}${rarity}${itemTierBadge(calculated)}${countBadge}`;
  }

  // Build a full item as a two-line, full-width rarity-banded card. Line 1 holds
  // name/level/rarity/tier/count; line 2 holds the compact inline stats. The price +
  // action button sit on the right, vertically centered, so cards stay short.
  function itemRowCard(calculated, count, fontSize, tooltipPrefix, actionHtml, priceText) {
    const colour = getColourFromRarity(calculated?.rarity);
    const stats = itemStatsInlineHtml(calculated);
    const tip = `${tooltipPrefix}${itemTooltip(calculated)}`;
    const priceBlock = priceText ? `<div class="gear-card-price">${priceText}</div>` : '';
    return `<div class="gear-card" title="${tip}" style="background:${colour.bg}; border:1px solid ${colour.border}; border-left:3px solid ${colour.border}; color:${colour.text};">
      <div class="gear-card-main">
        <div class="gear-card-l1">${gearCardTitle(calculated, count)}</div>
        <div class="gear-card-l2">${stats}</div>
      </div>
      <div class="gear-card-side">${priceBlock}${actionHtml}</div>
    </div>`;
  }

  // Equipped block shown at the top of a category tab, slimmed to two lines so it matches
  // the item cards below it.
  function equippedHeaderHtml(calculated, slot) {
    if (!calculated) return `<div class="gear-card gear-card-equipped gear-sticky-empty" style="color:#ccc;">Empty</div>`;
    const colour = getColourFromRarity(calculated?.rarity);
    const stats = itemStatsInlineHtml(calculated);
    return `<div class="gear-card gear-card-equipped" title="${itemTooltip(calculated)}" style="background:${colour.bg}; border:1px solid ${colour.border}; border-left:3px solid ${colour.border}; color:${colour.text};">
      <div class="gear-card-main">
        <div class="gear-card-l1"><b>Equipped</b> ${gearCardTitle(calculated, 1)}</div>
        <div class="gear-card-l2">${stats}</div>
      </div>
      <div class="gear-card-side"><button class="gear-act-btn gear-act-unequip" onclick="unequipItem('${slot}')">Unequip</button></div>
    </div>`;
  }

  function groupItems(items, keyFn) {
    const groups = new Map();
    for (const entry of items) {
      const item = entry?.item ?? entry;
      if (!item || typeof item !== 'object' || item.id == null) continue; // skip junk entries
      const key = keyFn(item);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(entry);
    }
    return Array.from(groups.values());
  }

  let lastEquipmentSnapshot = null;
  function renderEquipmentPanel(player, force = false) {
    if (!player) return;
    const container = equipmentFrame?.$('#equipmentBodies');
    if (!container) return;

    const equipment = player.equipment || {};
    const inventory = Array.isArray(player.inventory) ? player.inventory : [];

    // Change-detection is the only guard here (no time throttle): only rebuild the
    // panel when the equipment/inventory contents actually changed.
    const snapshot = JSON.stringify({ equipment, inventory });
    if (!force && snapshot === lastEquipmentSnapshot && container.innerHTML) return;
    lastEquipmentSnapshot = snapshot;

    container.innerHTML = EQUIPMENT_CATEGORIES.map(category => {
      const equipped = equipment[category.equippedKey];
      const header = equippedHeaderHtml(equipped ? getCalculatedItem(equipped, category.equippedKey) : null, category.equippedKey);

      const groups = groupItems(inventory.filter(i => i && i.id != null && category.slots.includes(i.slot)),
        i => `${i.baseItem || i.id}|${i.level ?? 1}|${i.rarity ?? 1}`);
      const cur = new Set(groups.map(g => `${g[0].baseItem || g[0].id}|${g[0].level ?? 1}|${g[0].rarity ?? 1}`));
      const prev = _prevEquipKeys[category.label] || new Set();
      for (const k of cur) if (!prev.has(k)) _newEquipCats.add(category.label);
      _prevEquipKeys[category.label] = cur;
      const rows = groups.map(group => {
        const rep = group[0];
        const calc = getCalculatedItem(rep, category.equippedKey);
        const sellPrice = getSellPrice(calc);
        const action = `<button class="gear-act-btn gear-act-equip" onclick="equipInventoryItem('${rep.id}', '${category.equippedKey}')">Equip</button>`
          + `<button class="gear-act-btn gear-act-sell" onclick="sellInventoryItem('${rep.id}')">Sell ${sellPrice}g</button>`;
        return itemRowCard(calc, group.length, '10px', '', action, '');
      });
      return buildGearCategoryBody('equip', category, header, rows);
    }).join('');

    const equipTabs = equipmentFrame?.$('.gear-tabs');
    if (equipTabs) equipTabs.querySelectorAll('.gear-tab').forEach((tab, i) => {
      const label = EQUIPMENT_CATEGORIES[i].label;
      tab.classList.toggle('new-items', label !== _activeEquipCat && _newEquipCats.has(label));
    });
  }

// Render shop stock items
let lastShopSnapshot = null;
function renderShopStock(shopStock, force = false) {
  if (!shopFrame) return;

  const container = shopFrame.$('#shopBodies');
  if (!container) return;

  // Incremental party-state updates usually omit shopStock; don't let an
  // undefined payload clear a populated shop.
  if (shopStock === undefined) return;

  // Change-detection is the only guard here (no time throttle): only rebuild the
  // panel when the shop stock actually changed.
  const snapshot = JSON.stringify(shopStock);
  if (!force && snapshot === lastShopSnapshot && container.innerHTML) return;
  lastShopSnapshot = snapshot;

  if (!shopStock || shopStock.length === 0) {
    container.innerHTML = '<div style="color:#888; font-size:12px; padding:4px;">No items in stock. Complete a dungeon to restock!</div>';
    return;
  }

  // Keep original indices (buyGear('shop_<index>') references the server array) but
  // skip any entry that isn't a real item object, which would otherwise crash
  // on .baseItem / .id access during grouping.
  const indexed = [];
  shopStock.forEach((item, index) => {
    if (item && typeof item === 'object' && item.id != null) indexed.push({ item, index });
  });
  const groups = groupItems(indexed, it =>
    `${it.baseItem || it.id}|${it.level ?? 1}|${it.rarity ?? 1}`);

  // price lookup table keyed by the same group key, so each tab can price its own rows
  const priceByKey = new Map();
  for (const g of groups) {
    const { item } = g[0];
    const calc = window.itemGenerator?.calculateItemStats?.(item) || item;
    const price = Math.max(20,
      typeof calc?.baseValue === 'number'
        ? (window.itemGenerator?.calculateItemPrice?.(calc.baseValue, calc.level, calc.rarity) ?? calc.price ?? 40)
        : (calc?.price ?? 40));
    priceByKey.set(`${item.baseItem || item.id}|${item.level ?? 1}|${item.rarity ?? 1}`, price);
  }

  container.innerHTML = EQUIPMENT_CATEGORIES.map(category => {
    const catGroups = groups.filter(g => category.slots.includes(g[0].item.slot));
    const cur = new Set(catGroups.map(g => {
      const it = g[0].item;
      return `${it.baseItem || it.id}|${it.level ?? 1}|${it.rarity ?? 1}`;
    }));
    const prev = _prevShopKeys[category.label] || new Set();
    for (const k of cur) if (!prev.has(k)) _newShopCats.add(category.label);
    _prevShopKeys[category.label] = cur;
    const rows = catGroups.map(group => {
      const { item, index } = group[0];
      const price = priceByKey.get(`${item.baseItem || item.id}|${item.level ?? 1}|${item.rarity ?? 1}`);
      const calc = window.itemGenerator?.calculateItemStats?.(item) || item;
      const action = `<button class="gear-act-btn gear-act-buy" onclick="buyGear('shop_${index}')">Buy</button>`;
      return itemRowCard(calc, group.length, '10px', `Price: ${price}g\n`, action, `${price}g`);
    });
    return buildGearCategoryBody('shop', category, '', rows);
  }).join('');

  const shopTabs = shopFrame?.$('.gear-tabs');
  if (shopTabs) shopTabs.querySelectorAll('.gear-tab').forEach((tab, i) => {
    const label = EQUIPMENT_CATEGORIES[i].label;
    tab.classList.toggle('new-items', label !== _activeShopCat && _newShopCats.has(label));
  });
  }

// Make functions available globally for clientNetwork access
window.renderShopStock = renderShopStock;

window.forceRefreshEquipment = function() {
  if (window.renderEquipmentPanel && currentState) {
    const me = (currentState.players || []).find(p => p.name === ownName);
    if (me) window.renderEquipmentPanel(me, true);
  }
};

// Update party display function (moved after renderShopStock to ensure function availability)
function updatePartyDisplay(data) {
  if (!data || !Array.isArray(data.players) || !Array.isArray(data.enemies)) {
    console.warn("no data for updatePartydisplay!", { players: data?.players, enemies: data?.enemies });
    return;
  }
  currentState = data;
  const ownPlayerDataTemp = data.players.find(p => p.name === ownName);
  if (window.renderSkillPanel && ownPlayerDataTemp) window.renderSkillPanel(ownPlayerDataTemp);

  syncDungeonUI(data);
  syncEmbarkAndAuto(data);
  renderActivePlayers(data);
  renderActiveEnemies(data);
  refreshSidePanels(data, ownPlayerDataTemp);
}

function syncDungeonUI(data) {
  const dungeonName = data.dungeon ? data.dungeon.charAt(0).toUpperCase() + data.dungeon.slice(1) : 'Town';
  const dungeonFloors = data.dungeonFloors || {};
  const currentDungeonFloor = dungeonFloors[data.dungeon] || data.floor;

  let floorDisplayText = document.getElementById('floorDisplayText');
  if (!floorDisplayText) floorDisplayText = floorControlFrame?.$('#floorDisplayText');

  if (floorDisplayText) {
    const floorDisplayMsg = currentDungeonFloor === 0 ? 'Town' : `${dungeonName} Floor ${currentDungeonFloor}`;
    floorDisplayText.textContent = floorDisplayMsg;
  }

  // Keep currentDungeon in sync whenever a dungeon is reported, regardless of
  // whether it already matches. The clicker who selected the dungeon pre-embark
  // already has currentDungeon set, so gating on a mismatch would skip the
  // background refresh and leave them stuck on the Town background.
  if (data.dungeon && data.dungeon !== currentDungeon) {
    currentDungeon = data.dungeon;
  }

  if (data.floor > 0) {
    // In a dungeon: always refresh the background so the player that embarked
    // (whose currentDungeon was pre-selected) also gets the new dungeon colour.
    if (data.dungeon) updateBackgroundColor(data.dungeon);
  } else {
    updateBackgroundColor(currentDungeon);
  }
}

function syncEmbarkAndAuto(data) {
  const liveEnemies = data.enemies.filter(e => e.hp > 0);
  const combatActive = data.combatActive || liveEnemies.length > 0;

  if (data.autoEmbark !== undefined) {
    autoEmbarkEnabled = data.autoEmbark;
    updateAutoEmbarkButton();
  }

  const embarkBtn = document.getElementById('embarkBtn');
  if (embarkBtn) embarkBtn.disabled = !(data.floor === 0 && !combatActive);

  updateEscapeButton(data);
}

// Lightweight signature of the player fields shown in the card. Used instead of
// JSON.stringify(player) for change detection so we skip the deep traversal/allocation
// of the whole player object on every render tick.
function playerRenderSig(p) {
  const eq = p.equipment || {};
  const eqSig = ['weapon', 'armour', 'helmet', 'shoes'].map(s => {
    const it = eq[s];
    if (!it) return '-';
    return `${it.id || ''}|${it.level || ''}|${it.rarity || ''}|${it.defense ?? ''}|${it.damage ?? ''}|${it.weaponClass || it.type || ''}`;
  }).join('/');
  const deb = `${p.weakenEffects?.length || 0}|${p.vulnerabilityEffects?.length || 0}|${p.defenseDownEffects?.length || 0}|${p.actionSlowEffects?.length || 0}`;
  return [
    p.level, p.hp, p.maxHp, p.mp, p.maxMp, p.ap, p.maxAp, p.xp, p.xpToNext, p.gold,
    p.pointsToAllocate, p.actionBar, p.maxActionBar,
    p.str, p.dex, p.agi, p.vit, p.int, p.cnc, p.wis, p.luk, p.for, p.pie,
    eqSig, deb
  ].join('|');
}

function renderActivePlayers(data) {
  const inTown = data.floor === 0 && (data.enemies.filter(e => e.hp > 0).length === 0 && !data.combatActive);
  const currentPlayerIds = new Set(data.players.map(p => p.name));

  data.players.forEach(player => {
    const isOwnPlayer = player.name === ownName;
    const prev = _entityCache.get(player.name);
    const sig = playerRenderSig(player);
    if (!prev || prev.lastState !== sig) {
      _entityCache.set(player.name, { lastState: sig });
      updatePlayerDisplay(player, isOwnPlayer, inTown);
    }
  });

  for (let [name, element] of playerElements) {
    if (!currentPlayerIds.has(name)) {
      if (element.parentNode) element.remove();
      playerElements.delete(name);
      playerIdElements.delete(name);
      delete lastHp[name];
      _entityCache.delete(name);
    }
  }
}

function renderActiveEnemies(data) {
  const currentEnemyIds = new Set(data.enemies.map(e => e.id));
  data.enemies.forEach(enemy => {
    let element = enemyElements.get(enemy.id);
    if (!element) {
      element = createEnemyElement(enemy);
      document.getElementById('enemies').appendChild(element);
      enemyElements.set(enemy.id, element);
    }
    updateEnemyElement(element, enemy);
  });

  for (let [id, element] of enemyElements) {
    if (!currentEnemyIds.has(id)) {
      if (element.parentNode) element.remove();
      enemyElements.delete(id);
    }
  }
}

function refreshSidePanels(data, ownPlayerDataTemp) {
  if (window.renderEquipmentPanel && ownPlayerDataTemp) window.renderEquipmentPanel(ownPlayerDataTemp);
  if (window.renderShopStock) window.renderShopStock(data.shopStock);
  if (window.renderSkillPanel) window.renderSkillPanel(ownPlayerDataTemp);
  refreshDungeonListIfChanged(currentState);
}

  function getWeaponDamageForClass(player, weaponClass) {
    const weapon = player.equipment?.weapon;
    if (!weapon) return 0;
    const wClass = (weapon.weaponClass || weapon.type || '').toLowerCase();
    return wClass === weaponClass ? (weapon.damage || 0) : 0;
  }

  function getGearDefense(player, slot) {
    return player.equipment?.[slot]?.defense || 0;
  }

  function renderEquippedHtml(player) {
      const eq = player.equipment || {};
      return EQUIPMENT_CATEGORIES.map(c => {
          const it = getCalculatedItem(eq[c.equippedKey], c.equippedKey);
          const name = it ? (it.displayName || it.name || it.id) : 'Empty';
          const tier = window.itemGenerator?.calculateItemTier?.(it);
          const meta = typeof tier === 'number' ? ` ♔${tier.toFixed(1)}` : '';
          const colour = getColourFromRarity(it?.rarity);
          const bg = it ? colour.bg : '#1d1d1d';
          const border = it ? colour.border : '#444';
          const textColor = it ? colour.text : '#ccc';
          return `<div class="eq-cell" title="${it ? itemTooltip(it) : ''}" style="background:${bg}; border:1px solid ${border};"><span style="color:${textColor};">${c.icon}${name}${meta}</span></div>`;
      }).join('');
  }

  // Shared player-card template. The "own" card shows stat-allocation buttons and
  // uses the stats-owned style; party cards omit the buttons and use stats-party.
  function buildPlayerCard(player, { statsClass, includeStatButtons }) {
    const statDefs = [
      ['STR', 'str'], ['DEX', 'dex'],
      ['AGI', 'agi'], ['VIT', 'vit'],
      ['INT', 'int'], ['CNC', 'cnc'],
    ];
    const rows = statDefs.map(([label, stat]) =>
      `<div class="stat-row">` +
        `<span class="stat-label">${label}</span>` +
        `<span class="${stat}-val stat-val">${stat === 'for' || stat === 'pie' ? (player[stat] || 0).toFixed(1) : (player[stat] ?? 0)}</span>` +
        statBonusHtml(player, stat) +
        (includeStatButtons ? statButtons(stat) : '') +
      `</div>`
    ).join('');
    const statsHtml = `<div class="stats ${statsClass}">${rows}</div>`;
    return `
      <span class="player-toggle" onclick="togglePlayerCard(this)">▸</span><span class="level-display">⚖️${player.level} ♔${getAverageItemTier(player).toFixed(1)} ${player.name}</span>
      <div class="player-details">
          <div class="gold-display">
              💰 <span class="gold-text">${player.gold}</span>
              ⚔️ <span class="weapon-melee-text">${getWeaponDamageForClass(player, 'melee')}</span>
              🏹 <span class="weapon-ranged-text">${getWeaponDamageForClass(player, 'ranged')}</span>
              🔮 <span class="weapon-magic-text">${getWeaponDamageForClass(player, 'magic')}</span><br>
              🛡️ <span class="armour-text">${getGearDefense(player, 'armour')}</span>
              🪖 <span class="helmet-text">${getGearDefense(player, 'helmet')}</span>
              🥾 <span class="shoes-text">${getGearDefense(player, 'shoes')}</span>
          </div>
          <div class="xp-bar"><div class="xp-fill"></div></div>
          <div class="xp-points">📖XP: <span class="xp-text">0/0</span> | Points: <span class="points-text">0</span></div>
          ${statsHtml}
          <div class="player-equipped"></div>
      </div>
      <div class="ap-bar"><div class="ap-fill"></div></div>
      <div class="ap-text">🛡️0/0</div>
      <div class="hp-bar"><div class="hp-fill"></div></div>
      <div class="hp-text">❤️0/0</div>
      <div class="mp-bar"><div class="mp-fill"></div></div>
      <div class="mp-text">🔮0/0</div>
      <div class="debuffs">${buildDebuffsHtml(player)}</div>
    `;
  }

  function buildPlayerContent(player) {
    return buildPlayerCard(player, { statsClass: 'stats-owned', includeStatButtons: true });
  }

  function buildPartyPlayerContent(player) {
    return buildPlayerCard(player, { statsClass: 'stats-party', includeStatButtons: false });
  }

  function createPlayerElement(player, isOwn = false) {
      const div = document.createElement('div');
      div.className = 'player';
      const content = isOwn ? buildPlayerContent(player) : buildPartyPlayerContent(player);

      if (!isOwn) {
          div.innerHTML = `<div class="player-left">${content}</div>`;
      } else {
          div.innerHTML = content;
      }
      div.querySelector('.player-equipped').innerHTML = renderEquippedHtml(player);
      if (!isOwn) {
          div.classList.add('collapsed');
          div.dataset.collapsed = 'true';
      }
      return div;
  }

  window.togglePlayerCard = function (btn) {
      const el = btn.closest('.player');
      const collapsed = el.dataset.collapsed === 'true';
      const newCollapsed = !collapsed;
      el.dataset.collapsed = String(newCollapsed);
      el.classList.toggle('collapsed', newCollapsed);
      btn.textContent = newCollapsed ? '▸' : '▾';
      if (newCollapsed) return;
      const p = el._lastPlayer; if (p) el.querySelector('.player-equipped').innerHTML = renderEquippedHtml(p);
  };

function statButtons(stat) {
      return ['pie', 'for'].includes(stat) ? '' :
        `<span class="stat-buttons">${[1, 3, 5].map(p => `<button onclick="allocatePoints('${stat}', ${p})">+${p}</button>`).join('')}</span>`;
  }

function updatePlayerElement(el, player, canAllocate) {
  el._lastPlayer = player;
  const ui = el._ui || (el._ui = {
    xpFill: el.querySelector('.xp-fill'), hpFill: el.querySelector('.hp-fill'), mpFill: el.querySelector('.mp-fill'), apFill: el.querySelector('.ap-fill'),
    xpText: el.querySelector('.xp-text'), pointsText: el.querySelector('.points-text'), hpText: el.querySelector('.hp-text'), mpText: el.querySelector('.mp-text'), apText: el.querySelector('.ap-text'),
    levelDisplay: el.querySelector('.level-display'), goldText: el.querySelector('.gold-text'),
    strVal: el.querySelector('.str-val'), dexVal: el.querySelector('.dex-val'), agiVal: el.querySelector('.agi-val'), vitVal: el.querySelector('.vit-val'),
    intVal: el.querySelector('.int-val'), cncVal: el.querySelector('.cnc-val'), wisVal: el.querySelector('.wis-val'), lukVal: el.querySelector('.luk-val'),
    forVal: el.querySelector('.for-val'), pieVal: el.querySelector('.pie-val'),
    strBonus: el.querySelector('.str-bonus'), dexBonus: el.querySelector('.dex-bonus'),
    agiBonus: el.querySelector('.agi-bonus'), vitBonus: el.querySelector('.vit-bonus'),
    intBonus: el.querySelector('.int-bonus'), cncBonus: el.querySelector('.cnc-bonus'),
    wisBonus: el.querySelector('.wis-bonus'), lukBonus: el.querySelector('.luk-bonus'),
    forBonus: el.querySelector('.for-bonus'), pieBonus: el.querySelector('.pie-bonus'),
    weaponMeleeText: el.querySelector('.weapon-melee-text'), weaponRangedText: el.querySelector('.weapon-ranged-text'), weaponMagicText: el.querySelector('.weapon-magic-text'),
    armourText: el.querySelector('.armour-text'), helmetText: el.querySelector('.helmet-text'), shoesText: el.querySelector('.shoes-text'),
    debuffs: el.querySelector('.debuffs'),
    playerEquipped: el.querySelector('.player-equipped')
  });
  const c = el._state || (el._state = { 
    hp: -1, hpVal: null, hpMax: null,
    mp: -1, mpVal: null, mpMax: null,
    ap: -1, apVal: null, apMax: null,
    xp: -1, gold: -1, stats: {}, bonuses: {}, pointsToAllocate: -1,
    _lastWeaponMelee: -1, _lastWeaponRanged: -1, _lastWeaponMagic: -1,
    _lastArmour: -1, _lastHelmet: -1, _lastShoes: -1,
    _lastGold: -1,
    _equipSnap: ''
  });
  const isOwnPlayer = player.name === ownName;
  updatePlayerBars(ui, c, player);
  updatePlayerVitals(ui, c, player);
  updatePlayerShopAndGear(ui, c, player, isOwnPlayer);
  updatePlayerStats(ui, c, player);
  updatePlayerDebuffs(ui, c, player);
  updatePlayerEquipped(el, c, player);
}

function updatePlayerBars(ui, c, player) {
  const hpPct = `${Math.max(0, player.maxHp ? player.hp / player.maxHp * 100 : 0)}%`;
  if (c.hp !== hpPct || c.hpVal !== player.hp || c.hpMax !== player.maxHp) {
    ui.hpFill.style.width = hpPct;
    ui.hpText.textContent = `❤️${Math.round(player.hp)}/${player.maxHp}`;
    c.hp = hpPct; c.hpVal = player.hp; c.hpMax = player.maxHp;
  }
  const lastHp = c._lastHpVal;
  if (lastHp != null && ui.hpFill) {
    if (player.hp < lastHp) flashClass(ui.hpFill, 'hp-damaged');
    else if (player.hp - 10 > lastHp) flashClass(ui.hpFill, 'hp-healed');
  }
  c._lastHpVal = player.hp;

  const mpPct = `${Math.max(0, player.maxMp ? player.mp / player.maxMp * 100 : 0)}%`;
  if (c.mp !== mpPct || c.mpVal !== player.mp || c.mpMax !== player.maxMp) {
    ui.mpFill.style.width = mpPct;
    ui.mpText.textContent = `🔮${Math.round(player.mp)}/${player.maxMp}`;
    c.mp = mpPct; c.mpVal = player.mp; c.mpMax = player.maxMp;
  }

  const apPct = `${Math.max(0, player.maxAp ? (player.ap || 0) / player.maxAp * 100 : 0)}%`;
  if (c.ap !== apPct || c.apVal !== (player.ap || 0) || c.apMax !== player.maxAp) {
    ui.apFill.style.width = apPct;
    ui.apText.textContent = `🛡️${Math.round(player.ap || 0)}/${player.maxAp || 0}`;
    c.ap = apPct; c.apVal = player.ap || 0; c.apMax = player.maxAp;
  }

  const xpPct = `${Math.max(0, player.xpToNext ? player.xp / player.xpToNext * 100 : 0)}%`;
  const currentPoints = (player.pointsToAllocate || 0).toString();
  if (c.xp !== xpPct) { 
    ui.xpFill.style.width = xpPct; 
    ui.xpText.textContent = `${Math.floor(player.xp)}/${player.xpToNext}`; 
    ui.pointsText.textContent = currentPoints; 
    c.xp = xpPct; 
    c.pointsToAllocate = currentPoints;
  } else if (c.pointsToAllocate !== currentPoints) {
    ui.pointsText.textContent = currentPoints;
    c.pointsToAllocate = currentPoints;
  }
}

function updatePlayerVitals(ui, c, player) {
  if (ui.levelDisplay) { const ld = `⚖️${player.level} ♔${getAverageItemTier(player).toFixed(1)} ${player.name}`; if (c.level !== ld) { ui.levelDisplay.textContent = ld; c.level = ld; } }
  if (ui.goldText && c.gold !== player.gold) { ui.goldText.textContent = player.gold.toFixed(2); c.gold = player.gold; }
}

function updatePlayerShopAndGear(ui, c, player, isOwnPlayer) {
  if (!isOwnPlayer) return;
  const goldChanged = Math.abs(player.gold - (c._lastGold ?? -1)) > 0.01;
  const gearChanged = Math.abs(getWeaponDamageForClass(player, 'melee') - (c._lastWeaponMelee ?? -1)) > 0 ||
                     Math.abs(getWeaponDamageForClass(player, 'ranged') - (c._lastWeaponRanged ?? -1)) > 0 ||
                     Math.abs(getWeaponDamageForClass(player, 'magic') - (c._lastWeaponMagic ?? -1)) > 0 ||
                     Math.abs(getGearDefense(player, 'armour') - (c._lastArmour ?? -1)) > 0 ||
                     Math.abs(getGearDefense(player, 'helmet') - (c._lastHelmet ?? -1)) > 0 ||
                     Math.abs(getGearDefense(player, 'shoes') - (c._lastShoes ?? -1)) > 0;
  if (goldChanged || gearChanged) {
    const gs = ui.goldText?.textContent;
    if (gs) {
      const randomGearButton = shopFrame.$('#buyRandomGearBtn');
      if (randomGearButton) randomGearButton.textContent = `🎲 Random Gear: 40g`;
    }
    c._lastGold = player.gold;
  }
  if (ui.weaponMeleeText && c._lastWeaponMelee !== getWeaponDamageForClass(player, 'melee')) { ui.weaponMeleeText.textContent = getWeaponDamageForClass(player, 'melee'); c._lastWeaponMelee = getWeaponDamageForClass(player, 'melee'); }
  if (ui.weaponRangedText && c._lastWeaponRanged !== getWeaponDamageForClass(player, 'ranged')) { ui.weaponRangedText.textContent = getWeaponDamageForClass(player, 'ranged'); c._lastWeaponRanged = getWeaponDamageForClass(player, 'ranged'); }
  if (ui.weaponMagicText && c._lastWeaponMagic !== getWeaponDamageForClass(player, 'magic')) { ui.weaponMagicText.textContent = getWeaponDamageForClass(player, 'magic'); c._lastWeaponMagic = getWeaponDamageForClass(player, 'magic'); }
  if (ui.armourText && c._lastArmour !== getGearDefense(player, 'armour')) { ui.armourText.textContent = getGearDefense(player, 'armour'); c._lastArmour = getGearDefense(player, 'armour'); }
  if (ui.helmetText && c._lastHelmet !== getGearDefense(player, 'helmet')) { ui.helmetText.textContent = getGearDefense(player, 'helmet'); c._lastHelmet = getGearDefense(player, 'helmet'); }
  if (ui.shoesText && c._lastShoes !== getGearDefense(player, 'shoes')) { ui.shoesText.textContent = getGearDefense(player, 'shoes'); c._lastShoes = getGearDefense(player, 'shoes'); }
}

function updatePlayerStats(ui, c, player) {
  const stats = ['str', 'dex', 'agi', 'vit', 'int', 'cnc', 'wis', 'luk', 'for', 'pie'];
  const sels = [ui.strVal, ui.dexVal, ui.agiVal, ui.vitVal, ui.intVal, ui.cncVal, ui.wisVal, ui.lukVal, ui.forVal, ui.pie];
  const bonusSels = [ui.strBonus, ui.dexBonus, ui.agiBonus, ui.vitBonus, ui.intBonus, ui.cncBonus, ui.wisBonus, ui.lukBonus, ui.forBonus, ui.pieBonus];
  stats.forEach((k, i) => {
    const el = sels[i];
    if (el) {
      const v = i < 6 ? (player[k] ?? 0).toString() : (player[k] ?? 0).toFixed(1);
      if (c.stats[k] !== v) { el.textContent = v; c.stats[k] = v; }
    }
    const be = bonusSels[i];
    if (be) {
      const b = getEquipmentStatBonus(player, k);
      const bv = b ? `+${Math.round(b)}` : '';
      if (c.bonuses[k] !== bv) { be.textContent = bv; c.bonuses[k] = bv; }
    }
  });
}

function updatePlayerDebuffs(ui, c, player) {
  const debuffsHtml = buildDebuffsHtml(player);
  if (c.debuffsHtml !== debuffsHtml) { if (ui.debuffs) ui.debuffs.innerHTML = debuffsHtml; c.debuffsHtml = debuffsHtml; }
}

function updatePlayerEquipped(el, c, player) {
  if (!el.dataset.collapsed && el._ui?.playerEquipped) {
    const snap = JSON.stringify(player.equipment);
    if (c._equipSnap !== snap) { el._ui.playerEquipped.innerHTML = renderEquippedHtml(player); c._equipSnap = snap; }
  }
}
window.updatePartyDisplay = updatePartyDisplay;
  function buildDebuffsHtml(entity) {
    const badges = [];
    const add = (arr, label, color) => {
      const n = (arr || []).filter(e => (e.duration || 0) > 0).length;
      if (n > 0) badges.push(`<span class="debuff-badge" style="color:${color};border-color:${color};">${label} ${n}</span>`);
    };
    add(entity.weakenEffects, 'Weakened', '#b388ff');
    add(entity.vulnerabilityEffects, 'Vulnerable', '#ff6b6b');
    add(entity.defenseDownEffects, 'Exposed', '#4fc3f7');
    add(entity.actionSlowEffects, 'Slowed', '#ffd166');
    return badges.length ? `<div class="debuffs">${badges.join('')}</div>` : '';
  }

  function buildEnemyContent(enemy) {
    return `
    <div class="stats enemy-stats">
      <strong>⚖️${enemy.level} ${enemy.name}</strong><br>
      <b> STR ${enemy.str} DEX ${enemy.dex} AGI ${enemy.agi} VIT ${enemy.vit}</b>
    </div>
    <div class="ap-bar"><div class="ap-fill"></div></div>
    <div class="ap-text">🛡️0/0</div>
    <div class="hp-bar"><div class="hp-fill"></div></div>
    <div class="hp-text">❤️${Math.round(enemy.hp)}/${enemy.maxHp}</div>
    <div class="debuffs">${buildDebuffsHtml(enemy)}</div>
  `;
  }

  function createEnemyElement(enemy) {
    const div = document.createElement('div');
    div.className = enemy.isBoss ? 'enemy boss' : 'enemy';
    div.innerHTML = buildEnemyContent(enemy);
    return div;
  }

  function updateEnemyElement(el, enemy) {
    // PERF: Cache DOM queries + change detection
    const ui = el._ui || (el._ui = { hpFill: el.querySelector('.hp-fill'), hpText: el.querySelector('.hp-text'), apFill: el.querySelector('.ap-fill'), apText: el.querySelector('.ap-text'), debuffs: el.querySelector('.debuffs') });
    const cache = el._state || (el._state = { hpPct: '', apPct: '', debuffsHtml: '' });
    
    const hpPct = `${Math.max(0, enemy.hp / enemy.maxHp * 100)}%`;
  if (cache.hpPct !== hpPct) { ui.hpFill.style.width = hpPct; ui.hpText.textContent = `❤️${Math.round(enemy.hp)}/${enemy.maxHp}`; cache.hpPct = hpPct; }
  
  const apPct = `${Math.max(0, (enemy.ap || 0) / (enemy.maxAp || 1) * 100)}%`;
  if (cache.apPct !== apPct) { ui.apFill.style.width = apPct; ui.apText.textContent = `🛡️${Math.round(enemy.ap || 0)}/${enemy.maxAp || 0}`; cache.apPct = apPct; }

  const debuffsHtml = buildDebuffsHtml(enemy);
  if (cache.debuffsHtml !== debuffsHtml) { if (ui.debuffs) ui.debuffs.innerHTML = debuffsHtml; cache.debuffsHtml = debuffsHtml; }
}

  window.allocatePoints = function(stat, points) {
      clientNetwork.allocatePoints(stat, points);
  };

  window.buyGear = function(type) {
        clientNetwork.buyGear(type);
    };

  window.equipInventoryItem = function(itemId, slot) {
      clientNetwork.equipItem(slot, itemId);
  };

  window.sellInventoryItem = function(itemId) {
      clientNetwork.sellItem(itemId);
  };

  window.donate = function() {
      clientNetwork.donate().then(() => {
        // Force local UI update immediately after the network request is sent,
        // assuming state change locally for better responsiveness.
        updatePartyDisplay(currentState);
      });
  };

  window.leaveParty = function() {
      clientNetwork.leaveParty();
  };

  // Override clientNetwork methods to add local flashing for player attacks
  const originalPerformCombatAction = clientNetwork.performCombatAction;
  clientNetwork.performCombatAction = function(actionData) {
      // Flash player locally for attack actions
      if (actionData.type === 'attack') {
          window.flashPlayerAttack(actionData.hit, actionData.crit);
      }
      return originalPerformCombatAction.call(this, actionData);
  };

  // Global function to flash the player's own element on attack
  window.flashPlayerAttack = function(hit, crit) {
      if (!ownPlayerElement) return;

      let cls;
      if (crit) cls = 'crit-flash';
      else if (hit) cls = 'hit-flash';
      else cls = 'miss-flash';

      flashClass(ownPlayerElement, cls);
  };

  // Performance control functions
  function changePerformanceMode(mode) {
      clientNetwork.setPerformanceMode(mode);
      clientNetwork.updatePerformanceStatus();
  }

  function changeBatchSize(batchSize) {
      clientNetwork.changeBatchSize(batchSize);
  }
