const { v4: uuidv4 } = require('uuid');
const EventEmitter = require('events');
const { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate } = require('wrtc');
const { deepEqual } = require('./utils.js');
const { buildSnapshot } = require('./utilities/deltaTracker');


// Batching configuration - optimized for low-latency UDP-like behavior
const DEFAULT_BATCH_CONFIG = {
    critical: { interval: 100, maxBatchSize: 6 },
    standard: { interval: 200, maxBatchSize: 8 },
    background: { interval: 300, maxBatchSize: 10 },
    immediate: { interval: 50, maxBatchSize: 4 }
};

const BATCH_INTERVAL_LIMITS = {
    critical: { min: 100, max: 150 },
    standard: { min: 200, max: 250 },
    background: { min: 300, max: 350 },
    immediate: { min: 50, max: 100 }
};

// Field aliases for message compression - reduces payload size
const FIELD_ALIASES = {
    hp: 'h', ap: 'a', maxHp: 'mh', maxAp: 'ma', actionBar: 'ab',
    maxActionBar: 'mab', level: 'l', xp: 'x',
    gold: 'g', mp: 'm', maxMp: 'mm', str: 's', dex: 'd', agi: 'ag',
    vit: 'v', int: 'i', cnc: 'c', wis: 'w', for: 'f', luk: 'lk',
    pie: 'p', armour: 'ar', weapon: 'wp', weaponMelee: 'wpm',
    weaponRanged: 'wpr', weaponMagic: 'wpmg', shoes: 'sh', helmet: 'h',
    isDead: 'dd', playerId: 'pid', position: 'pos', action: 'act',
    timestamp: 'ts', priority: 'pr', messages: 'msgs', type: 't'
};

// ═══════════════════════════════════════════════════════════════════
// PACKET TRACKING CLASS - For tracking sent/received packet counts and sizes
// ═══════════════════════════════════════════════════════════════════
class PacketTracker {
    constructor() {
        this.sent = { total: { count: 0, bytes: 0 }, byType: {} };
        this.received = { total: { count: 0, bytes: 0 }, byType: {} };
    }

    trackSent(type, data) {
        const size = Buffer.byteLength(JSON.stringify(data), 'utf8');
        this.sent.total.count++;
        this.sent.total.bytes += size;
        if (!this.sent.byType[type]) {
            this.sent.byType[type] = { count: 0, bytes: 0 };
        }
        this.sent.byType[type].count++;
        this.sent.byType[type].bytes += size;
    }

    trackReceived(type, data) {
        const size = Buffer.byteLength(JSON.stringify(data), 'utf8');
        this.received.total.count++;
        this.received.total.bytes += size;
        if (!this.received.byType[type]) {
            this.received.byType[type] = { count: 0, bytes: 0 };
        }
        this.received.byType[type].count++;
        this.received.byType[type].bytes += size;
    }

    reset() {
        this.sent = { total: { count: 0, bytes: 0 }, byType: {} };
        this.received = { total: { count: 0, bytes: 0 }, byType: {} };
    }

    getStats() {
        return {
            sent: this.sent,
            received: this.received
        };
    }

    formatStats(prefix = '') {
        const formatBytes = (bytes) => {
            if (bytes < 1024) return `${bytes} B`;
            if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
            return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
        };

        const formatType = (typeStats) => {
            const lines = [];
            const types = Object.keys(typeStats).sort((a, b) => typeStats[b].count - typeStats[a].count);
            for (const type of types) {
                const stats = typeStats[type];
                lines.push(`    ${type}: ${stats.count} packets, ${formatBytes(stats.bytes)}`);
            }
            return lines.join('\n');
        };

        return `${prefix}Sent: ${this.sent.total.count} packets, ${formatBytes(this.sent.total.bytes)}
${prefix}  By Type:
${formatType(this.sent.byType)}
${prefix}Received: ${this.received.total.count} packets, ${formatBytes(this.received.total.bytes)}
${prefix}  By Type:
${formatType(this.received.byType)}`;
    }
}

// ═══════════════════════════════════════════════════════════════════
// BATCH ACCUMULATOR CLASS
// ═══════════════════════════════════════════════════════════════════
class BatchAccumulator {
    constructor(socketId, priority) {
        this.socketId = socketId;
        this.priority = priority;
        this.messages = [];
        this.lastFlush = 0;
        this.count = 0;
        this.lastFingerprints = new Map(); // For deduplication
    }

    add(message) {
        const fingerprint = this.createFingerprint(message);
        
        // Skip duplicate messages within suppression window
        if (this.lastFingerprints.has(fingerprint)) {
            const lastSent = this.lastFingerprints.get(fingerprint);
            if (Date.now() - lastSent < 1000) return false; // 1 second suppression
        }
        
        const existing = this.messages.find(m => m.type === message.type);
        if (existing && message.data && existing.data) {
            Object.assign(existing.data, message.data);
            this.count++; // Track merged messages toward batch size limit
        } else {
            this.messages.push(message);
            this.count++;
        }
        
        this.lastFingerprints.set(fingerprint, Date.now());
        this.cleanupOldFingerprints();
        
        return true; // Message was successfully added
    }

    isFull() {
        return this.count >= DEFAULT_BATCH_CONFIG[this.priority].maxBatchSize;
    }

    createFingerprint(message) {
        return `${message.type}:${JSON.stringify(message.data)}`;
    }

    cleanupOldFingerprints() {
        const now = Date.now();
        for (const [fp, timestamp] of this.lastFingerprints) {
            if (now - timestamp > 2000) this.lastFingerprints.delete(fp); // 2 second window
        }
    }

    clear() {
        this.messages = [];
        this.count = 0;
        this.lastFlush = Date.now();
        this.lastFingerprints.clear();
    }

    getMessages() {
        return this.messages;
    }
}

// ═══════════════════════════════════════════════════════════════════
// WEBRTC SERVER CLASS
// ═══════════════════════════════════════════════════════════════════
class WebRTCServer extends EventEmitter {
    constructor() {
        super();
        this.peers = new Map();
        this.iceServers = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];
        this.playerLastState = new Map();
        this.enemyLastState = new Map();
        this.parties = null;
        this.batchQueues = new Map();
        this.batchTimers = {
    critical: null,         // ← Unused after refactor
    standard: null,         // ← Kept for compatibility with legacy stats
    background: null,       // ← Kept for compatibility with legacy stats
    immediate: null         // ← NEW: Combat packets use this
};
        this.packetTracker = new PacketTracker();
        
        this.priorityFields = {
            critical: new Set(['hp', 'ap', 'maxHp', 'maxAp']),
            standard: new Set(['actionBar', 'maxActionBar', 'level']),
            background: new Set(['xp', 'gold', 'str', 'dex', 'agi', 'vit', 'int', 'cnc', 'wis', 'for', 'luk', 'pie', 'armour', 'weapon', 'weaponMelee', 'weaponRanged', 'weaponMagic', 'shoes', 'helmet', 'pointsToAllocate', 'skillsState', 'abilitySlots', 'abilityCooldowns', 'equipment', 'inventory'])
        };
        
        this.clientBatchPreferences = new Map();
        this.defaultBatchSizeMs = 150;
        this.maxAllowedBatchSizeMs = 300;
        this.minAllowedBatchSizeMs = 75;
        
        // ═══════════════════════════════════════════════════════════
        // CONNECTION HEALTH TRACKING
        // ═══════════════════════════════════════════════════════════
        this.connectionHealth = new Map(); // socketId -> { connected, lastPing, lastPong, qualityScore, connectionState, dataChannelState }
        this.healthCheckInterval = null;
        this.maxPingLatency = 500; // ms - consider unhealthy above this
        this.minQualityScore = 0.3; // consider unhealthy below this
        this.startHealthCheckSystem();
    }

    // ═══════════════════════════════════════════════════════════
    // CONNECTION HEALTH SYSTEM
    // ═══════════════════════════════════════════════════════════
    startHealthCheckSystem() {
        if (this.healthCheckInterval) return;
        
        this.healthCheckInterval = setInterval(() => {
            this.checkAllConnections();
        }, 5000); // Check every 5 seconds
    }

    checkAllConnections() {
        const now = Date.now();
        
        for (const [socketId, peerData] of this.peers) {
            
            const health = this.connectionHealth.get(socketId) || {};
            
            // Check if connection is stale
            if (peerData.connected && !peerData.dataChannel) {
                console.warn(`WebRTC peer ${socketId} has no data channel despite being marked connected`);
                health.dataChannelState = 'missing';
            }
            
            if (peerData.dataChannel) {
                health.dataChannelState = peerData.dataChannel.readyState;
                health.lastActivity = peerData.lastActivity || now;
                
                // Update connection quality
                if (peerData.ping) {
                    health.lastPing = peerData.ping;
                    health.qualityScore = Math.max(0, 1 - (peerData.ping / this.maxPingLatency));
                }
            }
            
            health.connectionState = peerData.pc?.connectionState || 'unknown';
            health.lastCheck = now;
            this.connectionHealth.set(socketId, health);
        }
    }

    isConnectionHealthy(socketId) {
        const health = this.connectionHealth.get(socketId);
        const peerData = this.peers.get(socketId);
        
        if (!peerData) return false;
        if (!peerData.connected) return false;
        if (!peerData.dataChannel || peerData.dataChannel.readyState !== 'open') return false;
        return true;
    }

    getConnectionStats(socketId) {
        return this.connectionHealth.get(socketId) || null;
    }

    updatePeerPing(socketId, pingMs) {
        const peerData = this.peers.get(socketId);
        if (peerData) {
            peerData.ping = pingMs;
        }
        
        const health = this.connectionHealth.get(socketId) || {};
        health.lastPing = pingMs;
        health.qualityScore = Math.max(0, 1 - (pingMs / this.maxPingLatency));
        this.connectionHealth.set(socketId, health);
    }

    updatePeerActivity(socketId) {
        const peerData = this.peers.get(socketId);
        if (peerData) {
            peerData.lastActivity = Date.now();
        }
    }
    
    initialize(parties, io, webrtcServer) {
        this.parties = parties;
        this.io = io;
        this.webrtcServer = webrtcServer;
        this.setupDefaultEventHandlers();
    }
    
    setupDefaultEventHandlers() {
        const handlers = {
            combatAction: (s, d) => this.handleFastCombatAction(s, d),
            playerMove: (s, d) => this.handlePlayerMovement(s, d),
            test: (s, d) => this.sendMessage(s, 'testResponse', { originalMessage: d, timestamp: Date.now(), serverTimestamp: Date.now() }),
            ping: (s, d) => this.sendMessage(s, 'pong', { pingId: d.pingId, clientTimestamp: d.clientTimestamp })
        };

        handlers.iceCandidate = (s, c) => { if (this.io) this.io.to(s).emit('webrtc-signal', { candidate: c }); };

        Object.entries(handlers).forEach(([event, handler]) => this.on(event, handler));
    }
    
    // ═══════════════════════════════════════════════════════════════
    // PARTY BROADCASTING METHODS
    // ═══════════════════════════════════════════════════════════════
    broadcastToPartyWebRTC(partyId, type, data, excludeSocket = null) {
        if (!this.parties) return 0;
        const party = this.parties.get(partyId);
        if (!party) return 0;
        
        let sent = 0;
        for (const socketId of party.players.keys()) {
            if (socketId !== excludeSocket && this.sendMessage(socketId, type, data)) sent++;
        }
        return sent;
    }
    
    // ═══════════════════════════════════════════════════════════════
    // COMBAT & MOVEMENT HANDLERS
    // ═══════════════════════════════════════════════════════════════
    handleFastCombatAction(socketId, actionData) {
        if (!this.parties) return;
        for (const [partyId, party] of this.parties.entries()) {
            const player = party.players.get(socketId);
            if (player) {
                this.broadcastToParty(partyId, 'combatUpdate', { playerId: socketId, action: actionData, timestamp: Date.now() }, socketId);
                return;
            }
        }
    }
    
    handlePlayerMovement(socketId, moveData) {
        if (!this.parties) return;
        for (const [partyId, party] of this.parties.entries()) {
            const player = party.players.get(socketId);
            if (player) {
                this.broadcastToParty(partyId, 'playerPosition', { playerId: socketId, position: moveData, timestamp: Date.now() }, socketId);
                return;
            }
        }
    }
    
    // ═══════════════════════════════════════════════════════════════
    // DELTA TRACKING - Optimized unified delta function
    // ═══════════════════════════════════════════════════════════════
    getDelta(entityId, entity, type = 'player') {
        const lastState = this[`${type}LastState`].get(entityId) || {};
        const delta = {};
        const fields = type === 'player' 
            ? ['hp', 'ap', 'maxHp', 'maxAp', 'actionBar', 'maxActionBar', 'level', 'xp', 'gold', 'mp', 'maxMp', 'str', 'dex', 'agi', 'vit', 'int', 'cnc', 'wis', 'for', 'luk', 'pie', 'armour', 'weapon', 'weaponMelee', 'weaponRanged', 'weaponMagic', 'shoes', 'helmet', 'abilityCooldowns']
            : ['hp', 'maxHp', 'ap', 'maxAp', 'actionBar', 'mp', 'maxMp'];
        
        fields.forEach(f => {
            if (entity[f] !== undefined && !deepEqual(entity[f], lastState[f])) 
                delta[f] = entity[f];
        });
        
        if (type === 'enemy') {
            const wasDead = lastState.hp !== undefined && lastState.hp <= 0;
            const isDead = entity.hp <= 0;
            if (wasDead !== isDead) delta.isDead = isDead;
        }
        
        if (Object.keys(delta).length > 0) {
            this[`${type}LastState`].set(entityId, buildSnapshot(entity));
            return delta;
        }
        return null;
    }

    initializePlayerDeltaState(partyId, party, socketId) {
        const player = party.players.get(socketId);
        if (player) this.playerLastState.set(socketId, buildSnapshot(player));
        if (party.enemies) party.enemies.forEach(e => this.enemyLastState.set(e.id, { ...e }));
    }
    
    clearPartyDeltaState(partyId) {
        if (!this.parties) return;
        const party = this.parties.get(partyId);
        if (party) {
            party.players.forEach((_, s) => { this.playerLastState.delete(s); this.clientBatchPreferences.delete(s); });
        }
        this.enemyLastState.forEach((_, k) => k.startsWith('enemy_') && this.enemyLastState.delete(k));
    }
    
    // ═══════════════════════════════════════════════════════════════
    // CLIENT BATCH PREFERENCES
    // ═══════════════════════════════════════════════════════════════
    setClientBatchPreference(socketId, batchSizeMs) {
        const clampedSize = Math.max(this.minAllowedBatchSizeMs, Math.min(this.maxAllowedBatchSizeMs, batchSizeMs));
        this.clientBatchPreferences.set(socketId, { batchSizeMs: clampedSize, timestamp: Date.now() });
        this.restartBatchTimerForSocket(socketId);
    }
    
    getBatchIntervalForClient(socketId, priority) {
        const preference = this.clientBatchPreferences.get(socketId);
        if (!preference) return DEFAULT_BATCH_CONFIG[priority].interval;
        
        const scalingFactor = preference.batchSizeMs / this.defaultBatchSizeMs;
        const adjustedInterval = Math.round(DEFAULT_BATCH_CONFIG[priority].interval * scalingFactor);
        const limits = BATCH_INTERVAL_LIMITS[priority];
        return Math.max(limits.min, Math.min(limits.max, adjustedInterval));
    }
    
    restartBatchTimerForSocket() {
        this.stopBatchTimers();
        ['critical', 'standard', 'background', 'immediate'].forEach(p => this.startBatchTimer(p));
    }
    
    getBatchStats() {
        const stats = { totalQueues: this.batchQueues.size, clientsWithPreferences: this.clientBatchPreferences.size,
            timerStatus: {
                critical: !!this.batchTimers.critical,
                standard: !!this.batchTimers.standard,
                background: !!this.batchTimers.background,
                immediate: !!this.batchTimers.immediate      // NEW
            },
            queuedMessages: {
                critical: 0,
                standard: 0,
                background: 0,
                immediate: 0                                 // NEW
            }
        };
        this.batchQueues.forEach(accumulators => {
            Object.entries(accumulators).forEach(([p, a]) => stats.queuedMessages[p] += a.count);
        });
        return stats;
    }
    
    // ═══════════════════════════════════════════════════════════════
    // BATCH MANAGEMENT
    // ═══════════════════════════════════════════════════════════════
    getBatchAccumulator(socketId, priority) {
        if (!this.batchQueues.has(socketId)) {
            this.batchQueues.set(socketId, {
                critical: new BatchAccumulator(socketId, 'critical'),
                standard: new BatchAccumulator(socketId, 'standard'),
                background: new BatchAccumulator(socketId, 'background'),
                immediate: new BatchAccumulator(socketId, 'immediate')  // NEW
            });
        }
        return this.batchQueues.get(socketId)[priority];
    }
    
    determineImmediatePriority(packet) {
        // Determine batch priority based on how frequently packet sends and urgency
        if (!packet || !packet.type) return 'immediate';  // Default for invalid data

        // Combat-urgent packets: batch with 50ms/3 to capture combat frame events
        const combatPackets = ['combatEvent', 'criticalUpdate', 'combatStart', 'combatEnd', 'death', 'levelUp'];
        for (const type of combatPackets) {
            if (packet.type === type) return 'immediate';  // Combat frame batching
        }

        // Standard updates: batch with 200ms/15
        // Background updates: batch with 300ms/20
        return 'immediate';  // Default: all WebRTC messages batch (20ms/3 default fallback)
    }
    
    determinePriority(data) {
        if (!data) return 'standard';
        const hasField = (fields) => [...fields].some(f => data[f] !== undefined || (data.playerUpdates && data.playerUpdates[f] !== undefined));
        if (hasField(this.priorityFields.critical)) return 'critical';
        if (hasField(this.priorityFields.standard)) return 'standard';
        return 'background';
    }

    // Message compression using field aliases
    compressMessage(data) {
        if (typeof data !== 'object' || data === null) return data;
        
        const compressed = {};
        for (const [key, value] of Object.entries(data)) {
            const alias = FIELD_ALIASES[key] || key;
            compressed[alias] = value;
        }
        return compressed;
    }
    
    queueForBatch(socketId, type, data, priority) {
        if (!priority) priority = this.determinePriority(data);
        const accumulator = this.getBatchAccumulator(socketId, priority);
        const message = { id: uuidv4(), timestamp: Date.now(), type, data, _batched: true };
        const added = accumulator.add(message);
        if (!this.batchTimers[priority]) this.startBatchTimer(priority);
        if (added && accumulator.isFull()) {
            console.log(`[WebRTC Batch] Flushing full batch for socket=${socketId} priority=${priority} count=${accumulator.count} triggeredBy=${type}`);
            this.flushBatchQueue(priority);
        }
        return added;
    }
    
    _buildBatchMessage(accumulator, priority, now) {
        const messages = accumulator.getMessages().map(m => ({ type: m.type, data: m.data }));
        return { id: uuidv4(), timestamp: now, type: 'batchUpdate', data: { priority, messages } };
    }

    startBatchTimer(priority) {
        if (this.batchTimers[priority]) return;
        const interval = DEFAULT_BATCH_CONFIG[priority].interval;
        this.batchTimers[priority] = setInterval(() => this.flushBatchQueue(priority), interval);
    }
    
    flushBatchQueue(priority) {
        const now = Date.now();
        let totalMessages = 0, flushedPeers = 0;
        
    this.batchQueues.forEach((accumulators, socketId) => {
        const accumulator = accumulators[priority];
        // FIX: Always clear empty queues to prevent memory leak
        if (accumulator.count === 0) {
            accumulator.clear();
            return;
        }
            
            const clientInterval = this.getBatchIntervalForClient(socketId, priority);
            const timeSinceLastFlush = now - accumulator.lastFlush;
            if (timeSinceLastFlush < clientInterval && accumulator.count < DEFAULT_BATCH_CONFIG[priority].maxBatchSize) return;
            
            const peerData = this.peers.get(socketId);
            if (!peerData?.connected || !peerData.dataChannel) { accumulator.clear(); return; }
            
            try {
                const batchMessage = this._buildBatchMessage(accumulator, priority, now);
                peerData.dataChannel.send(JSON.stringify(batchMessage));
                totalMessages += accumulator.count;
                flushedPeers++;
                this.packetTracker.trackSent('batchUpdate', batchMessage);
                accumulator.clear();
            } catch (error) {
                console.error(`[WebRTC Batch] Flush error for ${socketId} (${priority}):`, 
                              error.message, 
                              `(${accumulator.count} pending messages cleared)`);

                // Always clear on error to prevent memory growth
                accumulator.clear();
            }
        });
    }
    
    flushSocketBatches(socketId) {
        const accumulators = this.batchQueues.get(socketId);
        if (!accumulators) return;
        
        const now = Date.now();
        ['critical', 'standard', 'background', 'immediate'].forEach(priority => {
            const accumulator = accumulators[priority];
            if (accumulator.count === 0) return;
            
            const peerData = this.peers.get(socketId);
            if (!peerData?.connected || !peerData.dataChannel) { accumulator.clear(); return; }
            
            try {
                const batchMessage = this._buildBatchMessage(accumulator, priority, now);
                peerData.dataChannel.send(JSON.stringify(batchMessage));
                this.packetTracker.trackSent('batchUpdate', batchMessage);
                accumulator.clear();
            } catch (error) {
                console.error(`Failed to flush batch to ${socketId}:`, error);
                accumulator.clear();
            }
        });
    }
    
    stopBatchTimers() {
        Object.entries(this.batchTimers).forEach(([p, t]) => { if (t) { clearInterval(t); this.batchTimers[p] = null; } });
    }

    // FIX: Stop per-socket batch timers before cleanup to prevent orphaned intervals
    stopBatchTimersForSocket(socketId) {
        const accumulators = this.batchQueues.get(socketId);
        if (!accumulators) return;

        ['critical', 'standard', 'background', 'immediate'].forEach(p => {
            if (this.batchTimers[p]) {
                clearInterval(this.batchTimers[p]);
                this.batchTimers[p] = null;
            }
        });
    }

    clearAllBatches() {
        this.batchQueues.forEach(accumulators => Object.values(accumulators).forEach(a => a.clear()));
    }

    // FIX: Periodic cleanup for orphaned queues from disconnected clients
    cleanupOrphanedBatchQueues() {
        let cleanedCount = 0;

        for (const [socketId, accumulators] of this.batchQueues.entries()) {
            // Check if peer still exists
            if (!this.peers.has(socketId)) {
                // Socket disconnected - clean up its queues
                Object.values(accumulators).forEach(a => a.clear());
                this.batchQueues.delete(socketId);
                cleanedCount++;

                // Optional: Log cleanup for debugging (uncomment if needed)
                // console.log(`[WebRTC] Cleaned orphaned batch queues for disconnected socket ${socketId}`);
            }
        }

        return cleanedCount;
    }

    // ═══════════════════════════════════════════════════════════════
    // MESSAGE SENDING - ENHANCED WITH CONNECTION HEALTH CHECKS
    // ═══════════════════════════════════════════════════════════════
    sendMessage(socketId, type, data, options = {}) {
        const peerData = this.peers.get(socketId);

        if (!peerData) return false;
        if (!peerData.connected) return false;
        if (!peerData.dataChannel) return false;
        if (peerData.dataChannel.readyState !== 'open') return false;

        const message = { id: uuidv4(), timestamp: Date.now(), type, data };

        // Track sent packet
        this.packetTracker.trackSent(type, message);

        // Update peer activity timestamp
        this.updatePeerActivity(socketId);

        // ⚠️ PING/PONG EXCLUSION: Must be sent immediately for accurate latency measurement
        if (type === 'ping' || type === 'pong') {
            try {
                peerData.dataChannel.send(JSON.stringify(message));
                return true;
            } catch (error) {
                console.error(`[WebRTC Send Error] Failed to send ${type} to ${socketId}:`, error);
                return false;
            }
        }
        
        // CONFIG: Allow temporary noBatch flag for specific use cases (testing, edge cases)
        if (options.noBatch) {
            try {
                peerData.dataChannel.send(JSON.stringify(message));
                return true;
            } catch (error) {
                console.error(`[WebRTC Send Error] Failed to send immediate ${type} to ${socketId}:`, error);
                return false;
            }
        }
        

        // Determine batching priority based on packet type and content
        const combatPackets = ['combatEvent', 'criticalUpdate', 'combatStart', 'combatEnd', 'death', 'levelUp'];
        const priority = combatPackets.includes(type) ? 'immediate' : this.determinePriority(data);
        return this.queueForBatch(socketId, type, data, priority);
    }
    
    broadcastToParty(partyId, type, data, excludeSocket = null, options = {}) {
        if (!this.parties) return 0;
        const party = this.parties.get(partyId);
        if (!party) return 0;
        
        let sentCount = 0;
        party.players.forEach((_, socketId) => {
            if (socketId !== excludeSocket && this.sendMessage(socketId, type, data, options)) sentCount++;
        });
        return sentCount;
    }
    
    // ═══════════════════════════════════════════════════════════════
    // BROADCAST TO PARTY VIA WEBRTC - Enhanced with connection health checks
    // ═══════════════════════════════════════════════════════════════
    broadcastToPartyWebRTC(partyId, type, data, excludeSocket = null) {
        if (!this.parties) return 0;
        const party = this.parties.get(partyId);
        if (!party) return 0;
        
        let sentCount = 0;
        let failedCount = 0;
        const now = Date.now();
        
        // Check each peer before attempting to send
        for (const socketId of party.players.keys()) {
            if (socketId === excludeSocket) continue;
            
            // Check if connection is healthy using the new health system
            const isHealthy = this.isConnectionHealthy(socketId);
            const peerData = this.peers?.get(socketId);
            
            if (!isHealthy) {
                failedCount++;
                continue;
            }
            
            // Try to send the message
            if (this.sendMessage(socketId, type, data)) {
                sentCount++;
            } else {
                failedCount++;
            }
        }
        
        // Log summary for debugging
        if (sentCount > 0 || failedCount > 0) {
            //console.log(`[WebRTC Broadcast] ${type} to party ${partyId}: sent=${sentCount}, failed=${failedCount}, totalPeers=${party.players.size}`);
        }
        
        return sentCount;
    }
    
    // ═══════════════════════════════════════════════════════════════
    // SOCKET.IO HANDLERS - WebRTC signaling and preferences
    // ═══════════════════════════════════════════════════════════════
    
    /**
     * Handle WebRTC offer from client
     */
    handleWebRTCOffer(socketId, data) {
        try {
            const existing = this.peers.get(socketId);
            const state = existing?.pc?.connectionState;
            // Reuse the existing RTCPeerConnection for ICE restarts (it is still
            // alive and has its data channel). Only recreate when it is dead/failed.
            const canReuse = existing && existing.pc && state &&
                !['failed', 'disconnected', 'closed'].includes(state) &&
                existing.generation === this.peers.get(socketId)?.generation;

            const peer = canReuse ? existing : this.createPeer(socketId);

            this.handleOffer(socketId, data.offer)
                .then(answer => {
                    if (this.io) {
                        this.io.to(socketId).emit('webrtc-answer', { answer });
                    }
                })
                .catch(error => {
                    console.error('WebRTC offer error:', error);
                    if (this.io) {
                        this.io.to(socketId).emit('webrtc-error', { message: 'Failed to establish WebRTC connection' });
                    }
                });
        } catch (error) {
            console.error('WebRTC offer error:', error);
            if (this.io) {
                this.io.to(socketId).emit('webrtc-error', { message: 'Failed to establish WebRTC connection' });
            }
        }
    }
    
    /**
     * Handle WebRTC ICE candidate from client
     */
    handleWebRTCSignal(socketId, data) {
        try {
            this.handleIceCandidate(socketId, data.candidate);
        } catch (error) {
            console.error('WebRTC signal error:', error);
        }
    }
    
    /**
     * Handle batch size preference from client
     */
    handleBatchPreference(socketId, data) {
        const { batchSizeMs } = data;
        
        // Validate batch size (75ms to 500ms range)
        if (typeof batchSizeMs !== 'number' || isNaN(batchSizeMs) || batchSizeMs < 75 || batchSizeMs > 500) {
            console.log(`Invalid batch preference from ${socketId}: ${batchSizeMs}ms`);
            return;
        }
        
        // Set preference on WebRTC server
        this.setClientBatchPreference(socketId, batchSizeMs);
        
        // Send acknowledgment with effective intervals
        const ackData = {
            batchSizeMs,
            timestamp: Date.now(),
            effectiveIntervals: {
                critical: this.getBatchIntervalForClient(socketId, 'critical'),
                standard: this.getBatchIntervalForClient(socketId, 'standard'),
                background: this.getBatchIntervalForClient(socketId, 'background'),
                immediate: this.getBatchIntervalForClient(socketId, 'immediate')  // NEW
            }
        };
        
        if (this.io) {
            this.io.to(socketId).emit('batchPreferenceAck', ackData);
        }
    }
    
    /**
     * Set up all Socket.IO handlers for WebRTC
     * Call this method from app.js after WebRTC initialization
     */
    setupSocketIOHandlers(io) {
        this.io = io;
        
        io.on('connection', (socket) => {
            // WebRTC offer handler
            socket.on('webrtc-offer', async (data) => {
                this.handleWebRTCOffer(socket.id, data);
            });
            
            // WebRTC signal (ICE candidate) handler
            socket.on('webrtc-signal', async (data) => {
                this.handleWebRTCSignal(socket.id, data);
            });
            
            // Batch preference handler
            socket.on('batchPreference', (data) => {
                this.handleBatchPreference(socket.id, data);
            });
            
            // Handle disconnect - clean up WebRTC peer
            socket.on('disconnect', () => {
                console.log(`Socket disconnect: ${socket.id} - removing WebRTC peer`);
                this.removePeer(socket.id);
            });
        });
    }
    
    // ═══════════════════════════════════════════════════════════════
    // PEER CONNECTION MANAGEMENT - ENHANCED WITH HEALTH TRACKING
    // ═══════════════════════════════════════════════════════════════
    /**
     * Safely close and detach an existing RTCPeerConnection / data channel.
     * Used before recreating a peer so reconnection does not leak connections.
     */
    closePeerConnection(socketId) {
        const peerData = this.peers.get(socketId);
        if (!peerData) return false;

        try {
            if (peerData.dataChannel && peerData.dataChannel.readyState !== 'closed') {
                peerData.dataChannel.onopen = null;
                peerData.dataChannel.onmessage = null;
                peerData.dataChannel.onclose = null;
                peerData.dataChannel.onerror = null;
                peerData.dataChannel.close();
            }
        } catch (e) { console.error(`[WebRTC] Error closing data channel for ${socketId}:`, e); }

        try {
            if (peerData.pc) {
                peerData.pc.onicecandidate = null;
                peerData.pc.onconnectionstatechange = null;
                peerData.pc.ondatachannel = null;
                peerData.pc.close();
            }
        } catch (e) { console.error(`[WebRTC] Error closing peer connection for ${socketId}:`, e); }

        return true;
    }

    /**
     * Reset the per-socket delta baseline so a freshly pushed full state becomes
     * the new reference for subsequent deltas after a reconnect.
     */
    resetDeltaStateForSocket(socketId) {
        this.playerLastState.delete(socketId);
        this.enemyLastState.forEach((_, k) => k.startsWith('enemy_') && this.enemyLastState.delete(k));
    }

    createPeer(socketId) {
        // Reconnection without a socket.io drop: tear down any pre-existing peer
        // for this socketId first so we don't leak RTCPeerConnections.
        if (this.peers.has(socketId)) {
            console.log(`[WebRTC] Closing pre-existing peer for ${socketId} before recreating`);
            this.closePeerConnection(socketId);
            this.peers.delete(socketId);
        }

        // Monotonic generation guard: stale callbacks from an old/closed pc are ignored.
        const generation = (this._peerGeneration = (this._peerGeneration || 0) + 1);

        const pc = new RTCPeerConnection({ iceServers: this.iceServers });
        const peerData = { 
            socketId, 
            pc, 
            connected: false, 
            dataChannel: null, 
            messages: [], 
            createdAt: new Date(),
            lastActivity: Date.now(),
            ping: null,
            generation
        };
        
        // Initialize connection health tracking
        this.connectionHealth.set(socketId, {
            connectionState: 'new',
            dataChannelState: 'none',
            qualityScore: 1,
            lastPing: null,
            lastActivity: Date.now(),
            createdAt: new Date(),
            everConnected: this.connectionHealth.get(socketId)?.everConnected || false,
            generation
        });
        
        pc.onicecandidate = (event) => { 
            if (event.candidate) {
                this.emit('iceCandidate', socketId, event.candidate); 
            }
        };
        
        const isCurrent = () => this.peers.get(socketId)?.generation === generation;

        pc.onconnectionstatechange = () => {
            if (!isCurrent()) return; // Ignore stale callbacks from a superseded connection
            const state = pc.connectionState;
            console.log(`[WebRTC] Connection state for ${socketId}: ${state}`);
            
            // Update health tracking
            const health = this.connectionHealth.get(socketId) || {};
            health.connectionState = state;
            health.lastStateChange = Date.now();
            this.connectionHealth.set(socketId, health);
            
            if (state === 'connected') { 
                peerData.connected = true;
                health.qualityScore = 1;
                this.emit('peerConnected', socketId, peerData.dataChannel); 
            }
            else if (state === 'disconnected') { 
                peerData.connected = false;
                health.qualityScore = 0;
                // Transient network blip - the client will attempt an ICE restart / recreate.
                this.emit('peerDisconnected', socketId); 
            }
            else if (state === 'failed') { 
                peerData.connected = false;
                health.qualityScore = 0;
                health.connectionFailed = true;
                this.emit('peerDisconnected', socketId); 
            }
        };
        
        pc.ondatachannel = (event) => {
            if (!isCurrent()) return;
            const dataChannel = event.channel;
            
            dataChannel.onopen = () => { 
                if (!isCurrent()) return;
                console.log(`[WebRTC] Data channel opened for ${socketId}`); 
                peerData.connected = true;
                peerData.dataChannel = dataChannel;
                
                // Update health tracking
                const health = this.connectionHealth.get(socketId) || {};
                const wasReconnect = health.everConnected;
                health.dataChannelState = 'open';
                health.connectionState = 'connected';
                health.qualityScore = 1;
                health.openedAt = Date.now();
                health.everConnected = true;
                this.connectionHealth.set(socketId, health);
                
                this.emit('peerConnected', socketId, dataChannel); 

                // A data channel that re-opens after a prior successful connection is a
                // reconnection - ask the app layer to push a fresh full state so the
                // client can restore its view and re-baseline deltas.
                if (wasReconnect) {
                    console.log(`[WebRTC] Re-established data channel for ${socketId} - requesting state restore`);
                    this.emit('webrtcStateRestore', socketId);
                }
            };
            
            dataChannel.onmessage = (e) => { 
                if (!isCurrent()) return;
                peerData.lastActivity = Date.now();
                const health = this.connectionHealth.get(socketId);
                if (health) health.lastActivity = Date.now();
                
                try { 
                    const m = JSON.parse(e.data); 
                    this.handleMessage(socketId, m); 
                } catch (error) { 
                    console.error(`[WebRTC] Failed to parse message from ${socketId}:`, error); 
                } 
            };
            
            dataChannel.onclose = () => { 
                if (!isCurrent()) return;
                peerData.connected = false;
                
                // Update health tracking
                const health = this.connectionHealth.get(socketId) || {};
                health.dataChannelState = 'closed';
                health.closedAt = Date.now();
                this.connectionHealth.set(socketId, health);
                
                this.emit('peerDisconnected', socketId); 
            };
            
            dataChannel.onerror = (err) => { 
                if (!isCurrent()) return;
                console.error(`[WebRTC] Data channel error for ${socketId}:`, err); 
                
                // Update health tracking
                const health = this.connectionHealth.get(socketId) || {};
                health.dataChannelState = 'error';
                health.lastError = err;
                this.connectionHealth.set(socketId, health);
            };
            
            peerData.dataChannel = dataChannel;
        };
        
        this.peers.set(socketId, peerData);
        return peerData;
    }
    
    async handleOffer(socketId, offer) {
        const peerData = this.peers.get(socketId);
        if (!peerData) throw new Error(`No peer found for socket ${socketId}`);
        await peerData.pc.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await peerData.pc.createAnswer();
        await peerData.pc.setLocalDescription(answer);
        return answer;
    }
    
    async handleIceCandidate(socketId, candidate) {
        const peerData = this.peers.get(socketId);
        if (peerData?.pc && candidate?.candidate) {
            try { await peerData.pc.addIceCandidate(new RTCIceCandidate(candidate)); }
            catch (error) { console.error(`Failed to add ICE candidate for ${socketId}:`, error); }
        }
    }
    
    // ═══════════════════════════════════════════════════════════════
    // MESSAGE HANDLING
    // ═══════════════════════════════════════════════════════════════
    handleMessage(socketId, message) {
        // Track received packet
        this.packetTracker.trackReceived(message.type, message);
        
        switch (message.type) {
            case 'test': case 'ping': case 'testResponse': case 'combatAction': case 'playerMove':
            case 'deltaUpdate': case 'criticalUpdate': case 'standardUpdate': case 'backgroundUpdate': case 'hpMpUpdate':
            case 'nextFloor': case 'teleportToTown': case 'teleportToFloor': case 'moveFloor':
            case 'leaveParty': case 'combatStart': case 'combatEnd': case 'eventLog':
                this.emit(message.type, socketId, message.data);
                break;
            case 'webrtc-resync':
                // Client requests a fresh full state after (re)connecting.
                this.emit('webrtcStateRestore', socketId);
                break;
            default: console.warn(`Unknown WebRTC message type: ${message.type}`);
        }
    }
    
    removePeer(socketId) {
        const peerData = this.peers.get(socketId);
        if (peerData) {
            if (peerData.dataChannel) peerData.dataChannel.close();
            if (peerData.pc) peerData.pc.close();
            peerData.connected = false;
            this.peers.delete(socketId);
            this.emit('peerDisconnected', socketId);
        }

        // FIX: Stop timers before cleaning up queues to prevent orphaned intervals
        this.stopBatchTimersForSocket(socketId);

        const accumulators = this.batchQueues.get(socketId);
        if (accumulators) {
            // Clean and delete batch queues for this socket
            Object.values(accumulators).forEach(a => a.clear());
        }
        this.batchQueues.delete(socketId);
        this.playerLastState.delete(socketId);
        this.connectionHealth.delete(socketId);
        this.clientBatchPreferences.delete(socketId);
    }
    
    getPeerStats() {
        const stats = { totalPeers: this.peers.size, connectedPeers: 0, batchStats: { totalQueues: this.batchQueues.size, timersRunning: {
                critical: !!this.batchTimers.critical,
                standard: !!this.batchTimers.standard,
                background: !!this.batchTimers.background,
                immediate: !!this.batchTimers.immediate      // NEW
            }, queuedMessages: {
                critical: 0,
                standard: 0,
                background: 0,
                immediate: 0                                 // NEW
            } }, peers: [] };
        
        this.batchQueues.forEach(accumulators => {
            Object.entries(accumulators).forEach(([p, a]) => stats.batchStats.queuedMessages[p] += a.count);
        });
        
        this.peers.forEach((peerData, socketId) => {
            if (peerData.connected) stats.connectedPeers++;
            const batchQueue = this.batchQueues.get(socketId);
            const queuedByPriority = batchQueue ? {
                critical: batchQueue.critical.count,
                standard: batchQueue.standard.count,
                background: batchQueue.background.count,
                immediate: batchQueue.immediate.count      // NEW
            } : {};
            stats.peers.push({ socketId, connected: peerData.connected, connectionState: peerData.pc?.connectionState || 'unknown', dataChannelState: peerData.dataChannel?.readyState || 'unknown', createdAt: peerData.createdAt, messageCount: peerData.messages.length, batchQueued: queuedByPriority });
        });
        
        return stats;
    }

    // DIAGNOSTIC: Get batch queue statistics for debugging memory issues
    getBatchQueueStats() {
        const stats = {
            totalQueues: this.batchQueues.size,
            totalAccumulators: 0,
            totalMessagesPending: 0,
            byPriority: { critical: 0, standard: 0, background: 0, immediate: 0 },
            bySocket: []
        };

        for (const [socketId, accumulators] of this.batchQueues.entries()) {
            const peer = this.peers.get(socketId);
            stats.bySocket.push({
                socketId,
                connected: !!peer,
                queues: Object.keys(accumulators),
                totalPending: 0
            });

            for (const [priority, accumulator] of Object.entries(accumulators)) {
                const count = accumulator.count;
                const messagesLen = accumulator.messages.length;
                const fingerprintsSize = accumulator.lastFingerprints.size;

                stats.totalAccumulators++;
                stats.byPriority[priority] += count;
                stats.totalMessagesPending += count + messagesLen + fingerprintsSize;

                if (!peer) {
                    console.warn(`[WebRTC Memory Leak] Socket ${socketId} disconnected but batch queue still has ${count} pending`);
                }
            }
        }

        return stats;
    }
}

module.exports = WebRTCServer;
