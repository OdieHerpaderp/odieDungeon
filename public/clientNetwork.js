class ClientNetwork {
    constructor(uiCallbacks = {}) {
        // Core state
        this.socket = io();
        this.currentPartyId = null;
        this.currentState = {};
        this.ownName = null;
        this.__debug = (typeof window !== 'undefined') ? (window.__webrtcDebug !== false) : true;
        
        // WebRTC state
        this.webrtcPeer = null;
        this.webrtcDataChannel = null;
        this.webrtcConnected = false;
        this.webrtcRetryCount = 0;
        this.webrtcPingInterval = null;
        this.webrtcMessageQueue = [];
        this.maxWebRTCRetries = 3;
        this.webrtcEverConnected = false;        // Has the data channel ever opened? (reconnect detection)
        this.webrtcReconnecting = false;          // True while a connection attempt is in flight
        this.webrtcReconnectScheduled = false;    // True while a reconnect timer is pending (dedup guard)
        this.webrtcManualClose = false;           // Set when we intentionally tear down (e.g. page unload)
        this.webrtcGeneration = 0;                // Monotonic id to ignore stale async callbacks
        this.webrtcReconnectTimer = null;
        this.webrtcIceRestartTimer = null;

        // Performance state
        this.performanceMode = 'adaptive';
        this.clientPrediction = true;
        this.batchEvents = true;
        this.adaptiveIntervalInterval = null;
        this.predictionInterval = null;
        this._cachedPing = 0;
        this.__hudPingMs = 0;
        this.__hudLastFps = 0;
        this.__lastUpdateInterval = 160;
        window.clientPing = 0;

        // Delta compression state
        this.lastKnownState = {
            players: new Map(),
            enemies: new Map(),
            party: {}
        };

        // Network statistics
        this.tcpStats = { packetsSent: 0, packetsReceived: 0, bytesSent: 0, bytesReceived: 0, pingHistory: [], throughputHistory: [] };
        this.udpStats = { packetsSent: 0, packetsReceived: 0, bytesSent: 0, bytesReceived: 0, pingHistory: [], throughputHistory: [], connected: false };
        this.packetTrackingWindow = [];
        this.maxTrackingWindow = 10000;
        this.throughputWindowSize = 5000;

        // UI callbacks
        this.uiCallbacks = {
            updatePartyDisplay: () => {},
            updatePlayerDisplay: () => {},
            addToEventLog: () => {},
            updatePerformanceStatus: () => {},
            onJoinedParty: () => {},
            onLeaveParty: () => {},
            ...uiCallbacks
        };

        this.initEventHandlers();
        this.initPerformanceMonitoring();
        this.initWebRTC();
    }

    // ═══════════════════════════════════════════════════════════════
    // WebRTC
    // ═══════════════════════════════════════════════════════════════

    initWebRTC() {
        this.socket.connected ? this.setupWebRTCConnection() : this.socket.on('connect', () => this.setupWebRTCConnection());
    }

    clearWebRTCTimers() {
        if (this.webrtcReconnectTimer) { clearTimeout(this.webrtcReconnectTimer); this.webrtcReconnectTimer = null; }
        if (this.webrtcIceRestartTimer) { clearTimeout(this.webrtcIceRestartTimer); this.webrtcIceRestartTimer = null; }
    }

    // Cleanly tear down the current WebRTC peer so a reconnect does not leak
    // RTCPeerConnections / data channels.
    closeWebRTCConnection() {
        this.stopWebRTCPing();
        this.clearWebRTCTimers();

        try {
            if (this.webrtcDataChannel) {
                this.webrtcDataChannel.onopen = null;
                this.webrtcDataChannel.onmessage = null;
                this.webrtcDataChannel.onclose = null;
                this.webrtcDataChannel.onerror = null;
                if (this.webrtcDataChannel.readyState !== 'closed') this.webrtcDataChannel.close();
            }
        } catch (e) { console.error('[WebRTC Client] Error closing data channel:', e); }

        try {
            if (this.webrtcPeer) {
                this.webrtcPeer.onicecandidate = null;
                this.webrtcPeer.onconnectionstatechange = null;
                this.webrtcPeer.ondatachannel = null;
                this.webrtcPeer.close();
            }
        } catch (e) { console.error('[WebRTC Client] Error closing peer connection:', e); }

        this.webrtcDataChannel = null;
        this.webrtcPeer = null;
    }

    // Debug logging gated by __debug so verbose WebRTC lifecycle logs stay out of
    // the hot path in performance mode (set false via window.__webrtcDebug = false
    // or performance mode). Preserves debuggability without cluttering normal output.
    _debugLog(...args) {
        if (this.__debug) console.log(...args);
    }

    async setupWebRTCConnection() {
        try {
            this._debugLog('[WebRTC Client] Starting WebRTC connection setup...');

            // Check if already connected
            if (this.webrtcConnected && this.webrtcDataChannel?.readyState === 'open') {
                this._debugLog('[WebRTC Client] Already connected, skipping setup');
                return;
            }

            // Bump generation and tear down any prior connection (reconnection).
            this.webrtcGeneration++;
            this.webrtcReconnecting = true;
            this.webrtcReconnectScheduled = false;
            this.closeWebRTCConnection();

            this.webrtcPeer = new RTCPeerConnection({ 
                iceServers: [
                    { urls: 'stun:stun.l.google.com:19302' }, 
                    { urls: 'stun:stun1.l.google.com:19302' }
                ] 
            });

            const myGeneration = this.webrtcGeneration;
            this._debugLog('[WebRTC Client] Created RTCPeerConnection');
            
            // Handle ICE candidates
            this.webrtcPeer.onicecandidate = (e) => {
                if (myGeneration !== this.webrtcGeneration) return;
                if (e.candidate) {
                    this._debugLog('[WebRTC Client] Sending ICE candidate');
                    this.socket.emit('webrtc-signal', { candidate: e.candidate });
                }
            };
            
            // Handle connection state changes
            this.webrtcPeer.onconnectionstatechange = () => {
                if (myGeneration !== this.webrtcGeneration) return;
                const state = this.webrtcPeer.connectionState;
                console.log(`[WebRTC Client] Connection state changed: ${state}`);
                this.handleWebRTCStateChange();
            };

            // Create data channel with UDP-like settings for low latency
            this._debugLog('[WebRTC Client] Creating data channel...');
            this.webrtcDataChannel = this.webrtcPeer.createDataChannel('game-data', { 
                ordered: false,  // Unordered for lower latency
                maxRetransmits: 0  // No retries for real-time data
            });
            
            this.setupDataChannel();


            this._debugLog('[WebRTC Client] Creating offer...');
            const offer = await this.webrtcPeer.createOffer();
            await this.webrtcPeer.setLocalDescription(offer);
            this._debugLog('[WebRTC Client] Sending offer to server');
            this.socket.emit('webrtc-offer', { offer });
        } catch (error) {
            console.error('[WebRTC Client] Setup failed:', error);
            this.handleWebRTCError(error);
            if (!this.webrtcManualClose) this.scheduleWebRTCReconnect();
        }
    }

    handleWebRTCStateChange() {
        const state = this.webrtcPeer.connectionState;
        this._debugLog('[WebRTC Client] WebRTC connection state:', state);

        if (state === 'connected') {
            this._debugLog('[WebRTC Client] WebRTC connected successfully');
            this.webrtcConnected = true;
            this.webrtcReconnecting = false;
            this.webrtcReconnectScheduled = false;
            this.webrtcRetryCount = 0;
            this.clearWebRTCTimers();
            this.uiCallbacks.addToEventLog('WebRTC connection established', 'success');
            this.uiCallbacks.updatePerformanceStatus();
            this.processMessageQueue();
        } else if (state === 'disconnected') {
            this._debugLog('[WebRTC Client] WebRTC disconnected');
            this.webrtcConnected = false;
            this.stopWebRTCPing();
            // Transient network blip: try a cheap ICE restart before a full reconnect.
            this.attemptWebRTCIceRestart();
        } else if (state === 'failed') {
            console.error('[WebRTC Client] WebRTC connection failed');
            this.webrtcConnected = false;
            this.stopWebRTCPing();
            this.handleWebRTCError(new Error('WebRTC connection failed'));
            this.scheduleWebRTCReconnect();
        } else if (state === 'closed') {
            this._debugLog('[WebRTC Client] WebRTC connection closed');
            this.webrtcConnected = false;
            this.stopWebRTCPing();
            if (!this.webrtcManualClose) this.scheduleWebRTCReconnect();
        }
    }

    // Attempt to recover a dropped connection in-place via ICE restart.
    // Reuses the existing RTCPeerConnection / data channel (cheap, no full renegotiation).
    attemptWebRTCIceRestart() {
        if (this.webrtcManualClose) return;
        const peer = this.webrtcPeer;
        if (!peer || peer.connectionState === 'closed' || peer.connectionState === 'failed') {
            this.scheduleWebRTCReconnect();
            return;
        }
        try {
            if (typeof peer.restartIce === 'function') {
                this._debugLog('[WebRTC Client] Attempting ICE restart...');
                peer.restartIce();
            }
            // (Re)negotiate a new offer so the server can gather fresh candidates.
            this.negotiateWebRTCOffer();

            // If the ICE restart doesn't recover within a window, escalate to full reconnect.
            if (this.webrtcIceRestartTimer) clearTimeout(this.webrtcIceRestartTimer);
            this.webrtcIceRestartTimer = setTimeout(() => {
                if (!this.webrtcConnected) {
                    this._debugLog('[WebRTC Client] ICE restart did not recover - falling back to full reconnect');
                    this.scheduleWebRTCReconnect();
                }
            }, 5000);
        } catch (e) {
            console.error('[WebRTC Client] ICE restart failed:', e);
            this.scheduleWebRTCReconnect();
        }
    }

    async negotiateWebRTCOffer() {
        try {
            const peer = this.webrtcPeer;
            if (!peer) return;
            const generation = this.webrtcGeneration;
            const offer = await peer.createOffer();
            await peer.setLocalDescription(offer);
            if (generation !== this.webrtcGeneration) return; // superseded
            this.socket.emit('webrtc-offer', { offer });
        } catch (e) {
            console.error('[WebRTC Client] Re-negotiation failed:', e);
        }
    }

    // Persistent reconnect: keep retrying with exponential backoff (capped) while
    // Socket.IO is still up, so the UDP-like connection is eventually restored.
    scheduleWebRTCReconnect() {
        if (this.webrtcManualClose) return;
        if (this.webrtcReconnectScheduled) return; // a reconnect timer is already pending
        this.webrtcReconnectScheduled = true;

        const delay = Math.min(30000, Math.pow(2, this.webrtcRetryCount) * 1000);
        this.webrtcRetryCount++;
        console.log(`[WebRTC Client] Scheduling reconnect in ${delay}ms (attempt ${this.webrtcRetryCount})`);
        this.uiCallbacks.addToEventLog(`WebRTC reconnecting... (attempt ${this.webrtcRetryCount})`, 'warning');
        this.uiCallbacks.updatePerformanceStatus();

        this.webrtcReconnectTimer = setTimeout(() => {
            this.webrtcReconnectTimer = null;
            this.webrtcReconnectScheduled = false;
            if (this.webrtcManualClose) return;
            if (!this.socket.connected) {
                // Socket.IO is also down; let its own reconnect re-trigger setup.
                return;
            }
            this._debugLog('[WebRTC Client] Attempting to reconnect...');
            this.setupWebRTCConnection();
        }, delay);
    }

    handleWebRTCDisconnection() {
        // Retained for backward call sites; delegates to the persistent scheduler.
        this.scheduleWebRTCReconnect();
    }

    handleWebRTCError(error) {
        console.error('[WebRTC Client] WebRTC error:', error);
        this.webrtcConnected = false;
        this.uiCallbacks.addToEventLog('WebRTC connection error: ' + error.message, 'error');
    }

    setupDataChannel() {
        this.webrtcDataChannel.binaryType = 'arraybuffer';
        
        this._debugLog('[WebRTC Client] Setting up data channel handlers...');
        
        this.webrtcDataChannel.onopen = () => {
            this._debugLog('[WebRTC Client] Data channel opened successfully');
            this.webrtcConnected = true;
            this.webrtcReconnecting = false;
            this.webrtcRetryCount = 0;
            this.webrtcEverConnected = true;
            this.startWebRTCPing();
            this.processMessageQueue();
            this.uiCallbacks.addToEventLog('WebRTC UDP-like connection established', 'success');
            this.uiCallbacks.updatePerformanceStatus();
        };
        
        // Update UDP ping when pong is received via WebRTC
        this.webrtcDataChannel.onmessage = (e) => {
            try {
                const msg = JSON.parse(e.data);
                this.trackPacket(this.udpStats, false);
                this.udpStats.connected = this.webrtcConnected;
                
                // Update connection quality based on timestamp
                if (msg.serverTimestamp) {
                    const rtt = Date.now() - msg.serverTimestamp;
                    this.updatePing(this.udpStats, rtt);
                    this.udpStats.connected = this.webrtcConnected;
                }
                
                // Handle pong for WebRTC immediately - bypass any delays
                if (msg.type === 'pong' && msg.data?.clientTimestamp) {
                    const rtt = Date.now() - msg.data.clientTimestamp;
                    this.updatePing(this.udpStats, rtt);
                    this.udpStats.connected = this.webrtcConnected;
                    // Immediately update performance status to reflect new ping
                    this.uiCallbacks.updatePerformanceStatus();
                }
                
                this.handleWebRTCMessage(msg);
            } catch (err) {
                console.error('[WebRTC Client] Message parse error:', err);
            }
        };
        
        this.webrtcDataChannel.onclose = () => {
            if (!this.webrtcDataChannel) return;
            this._debugLog('[WebRTC Client] Data channel closed');
            this.webrtcConnected = false;
            this.stopWebRTCPing();
            if (!this.webrtcManualClose) this.scheduleWebRTCReconnect();
        };
        
        this.webrtcDataChannel.onerror = (err) => {
            console.error('[WebRTC Client] Data channel error:', err);
            this.handleWebRTCError(err);
        };
        
        this._debugLog('[WebRTC Client] Data channel handlers set up');
    }

    // Single source of truth for routing WebRTC messages. Used by both the
    // single-message path (handleWebRTCMessage) and the batched path
    // (handleBatchUpdate). Each entry is (self, data) where `data` is the
    // message payload (msg.data for single messages, messageData for batched).
    static WEBRTC_HANDLERS = {
        pong: (s, d) => { 
    if (d?.clientTimestamp) { 
        s.updatePing(s.udpStats, Date.now() - d.clientTimestamp); 
        s.udpStats.connected = s.webrtcConnected; 
    } 
},
        combatUpdate: (s, d) => s._handleWebRTCUpdate('combat', d),
        playerPosition: (s, d) => s._handleWebRTCUpdate('playerPosition', d),
        actionBarUpdate: (s, d) => s._handleWebRTCUpdate('actionBar', d),
        hpApUpdate: (s, d) => s.handleHPMpUpdate(d),
        hpMpUpdate: (s, d) => s.handleHPMpUpdate(d),
        combatEvent: (s, d) => s.handleCriticalUpdate(d), // Combat events go through critical handler
        criticalUpdate: (s, d) => s.handleCriticalUpdate(d),
        combatStart: (s, d) => s.handleCombatStart(d),
        combatEnd: (s, d) => s.handleCombatEnd(d),
        dungeonChange: (s, d) => s.handleDungeonChange(d),
        standardUpdate: (s, d) => s.handleStandardUpdate(d),
        deltaUpdate: (s, d) => s.handleDeltaUpdate(d),
        backgroundUpdate: (s, d) => s.handleBackgroundUpdate(d),
        fullState: (s, d) => s.handleFullStateUpdate(d),
        partyUpdate: (s, d) => s.handleFullStateUpdate(d),
        batchUpdate: (s, d) => s.handleBatchUpdate(d),
        eventLog: (s, d) => s.uiCallbacks.addToEventLog?.(d.message, d.type || 'info'),
        nextFloor: (s, d) => s.uiCallbacks.onNextFloor?.(d),
        teleportToTown: (s, d) => s.uiCallbacks.onTeleportToTown?.(d),
        teleportToFloor: (s, d) => s.uiCallbacks.onTeleportToFloor?.(d),
        moveFloor: (s, d) => s.uiCallbacks.onMoveFloor?.(d),
        leaveParty: (s, d) => s.uiCallbacks.onLeaveParty?.(d)
    };

    handleWebRTCMessage(msg) {
        this.trackPacket(this.udpStats, false);
        this.udpStats.connected = this.webrtcConnected;
        // testResponse reads the timestamp from the envelope, not the payload.
        if (msg.type === 'testResponse') {
            if (msg.serverTimestamp) {
                this.updatePing(this.udpStats, Date.now() - msg.serverTimestamp);
                this.udpStats.connected = this.webrtcConnected;
            }
            return;
        }
        const handler = ClientNetwork.WEBRTC_HANDLERS[msg.type];
        if (handler) handler(this, msg.data);
        else console.log(`Unknown WebRTC message type: ${msg.type}`);
    }

    handleBatchUpdate(data) {
        const { priority, messages } = data;
        if (!messages || !Array.isArray(messages)) {
            console.warn('Invalid batchUpdate: missing or non-array messages', data);
            return;
        }

        // Reuse the shared handler registry; only the payload shape differs
        // (messageData instead of msg.data) and errors are caught per-message.
        messages.forEach(({ type, data: messageData }) => {
            const handler = ClientNetwork.WEBRTC_HANDLERS[type];
            if (handler) {
                try {
                    handler(this, messageData);
                } catch (err) {
                    console.error(`Error processing batched ${type} message:`, err);
                }
            } else {
                console.log(`Unknown batched message type: ${type}`);
            }
        });
    }

    _handleWebRTCUpdate(name, data) {
        const method = `on${name.charAt(0).toUpperCase() + name.slice(1)}Update`;
        this.uiCallbacks[method]?.(data);
    }

    sendWebRTCMessage(type, data) {
        if (this.webrtcConnected && this.webrtcDataChannel.readyState === 'open') {
            this.trackPacket(this.udpStats, true);
            this.udpStats.connected = this.webrtcConnected;
            this.webrtcDataChannel.send(JSON.stringify({ id: this.generateMessageId(), timestamp: Date.now(), type, data }));
            return true;
        }
        this.webrtcMessageQueue.push({ type, data });
        return false;
    }

    processMessageQueue() {
        while (this.webrtcMessageQueue.length > 0) {
            const { type, data } = this.webrtcMessageQueue.shift();
            this.sendWebRTCMessage(type, data);
        }
    }

    generateMessageId() { return Date.now().toString(36) + Math.random().toString(36).substr(2); }

    startWebRTCPing() {
        if (this.webrtcPingInterval) return;
        // Send ping every 2 seconds for more accurate and responsive UDP ping measurement
        this.webrtcPingInterval = setInterval(() => {
            if (this.webrtcConnected && this.webrtcDataChannel.readyState === 'open') {
                this.sendWebRTCMessage('ping', { clientTimestamp: Date.now(), pingId: this.generateMessageId() });
            }
        }, 2000);
    }

    stopWebRTCPing() {
        if (this.webrtcPingInterval) {
            clearInterval(this.webrtcPingInterval);
            this.webrtcPingInterval = null;
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // Event Handlers
    // ═══════════════════════════════════════════════════════════════

    initEventHandlers() {
      this.initLifecycleHandlers();
      this.initWebRTCHandlers();
      this.initDeltaHandlers();
      this.initPartyHandlers();
      this.initCombatHandlers();
      this.initUtilityHandlers();
    }

    initLifecycleHandlers() {
      this.socket.on('connect', () => {
        this.setPerformanceMode('adaptive');
        this.startClientSidePrediction();
        this.uiCallbacks.updatePerformanceStatus();
        this.socket.emit('ping', Date.now());
      });

      this.socket.on('reconnect', () => {
        this._debugLog('[WebRTC Client] Socket.IO reconnected - restoring WebRTC and party');
        this.webrtcManualClose = false;
        this.webrtcReconnecting = false;
        this.webrtcRetryCount = 0;
        this.webrtcConnected = false;
        this.setupWebRTCConnection();
        if (this.currentPartyId && this.ownName) {
          console.log(`[WebRTC Client] Re-joining party ${this.currentPartyId} after reconnect`);
          this.socket.emit('joinParty', { partyId: this.currentPartyId, name: this.ownName });
        }
      });

      this.socket.on('disconnect', (reason) => {
        this._debugLog('[WebRTC Client] Socket.IO disconnected (' + reason + ') - degrading WebRTC');
        this.webrtcConnected = false;
        this.stopWebRTCPing();
      });
    }

    initWebRTCHandlers() {
      this.socket.on('webrtc-answer', async (d) => {
        try { await this.webrtcPeer.setRemoteDescription(d.answer); } catch (e) { console.error('WebRTC answer error:', e); }
      });
      this.socket.on('webrtc-signal', async (d) => {
        try { d.candidate && await this.webrtcPeer.addIceCandidate(d.candidate); } catch (e) { console.error('WebRTC signal error:', e); }
      });
      this.socket.on('webrtc-error', (d) => {
        console.error('WebRTC error from server:', d.message);
        this.uiCallbacks.addToEventLog(d.message, 'error');
      });
    }

    initDeltaHandlers() {
      const regHandler = (event, handler, track = false) => this.socket.on(event, (d) => {
        if (track) this.trackPacket(this.tcpStats, false);
        this[handler](d);
      });
      regHandler('deltaUpdate', 'handleDeltaUpdate', true);
      regHandler('hpMpUpdate', 'handleHPMpUpdate', true);
      regHandler('criticalUpdate', 'handleCriticalUpdate', true);
      regHandler('standardUpdate', 'handleStandardUpdate', true);
      regHandler('backgroundUpdate', 'handleBackgroundUpdate', true);
      regHandler('partyUpdate', 'handleFullStateUpdate', true);
    }

    initPartyHandlers() {
      this.socket.on('joinedParty', (d) => {
        this.initializeDeltaState(d.fullState);
        this.uiCallbacks.onJoinedParty(d);
      });
      this.socket.on('partyFull', () => alert('Party is full!'));
    }

    initCombatHandlers() {
      ['attack', 'combatEnd', 'movementBlocked', 'nextFloorBlocked'].forEach(e => {
        this.socket.on(e, (d) => this.uiCallbacks[`on${e.charAt(0).toUpperCase() + e.slice(1)}`]?.(d));
      });

      this.socket.on('combatStart', (data) => {
        if (data && data.enemies) {
          data.enemies.forEach(enemy => {
            const current = this.currentState.enemies?.find(e => e.id === enemy.id);
            const last = this.lastKnownState.enemies.get(enemy.id);
            if (current && last) {
              Object.assign(current, enemy);
              Object.assign(last, enemy);
            } else if (enemy.id && enemy.name) {
              (this.currentState.enemies || (this.currentState.enemies = [])).push(enemy);
              this.lastKnownState.enemies.set(enemy.id, { ...enemy });
            }
          });
          if (data.floor !== undefined) {
            this.currentState.floor = data.floor;
            this.lastKnownState.party.floor = data.floor;
          }
          if (data.combatActive !== undefined) {
            this.currentState.combatActive = data.combatActive;
            this.lastKnownState.party.combatActive = data.combatActive;
          }
          if (data.dungeonFloors !== undefined) {
            this.currentState.dungeonFloors = data.dungeonFloors;
            this.lastKnownState.party.dungeonFloors = { ...data.dungeonFloors };
          }
          this.uiCallbacks.onCombatStart?.(data);
          this.uiCallbacks.updatePartyDisplay(this.currentState);
        }
      });

      this.socket.on('dotEffectsUpdate', (d) => this.uiCallbacks.onDotEffectsUpdate?.(d));
    }

    initUtilityHandlers() {
      this.socket.on('updateInterval', (interval) => {
        this.__lastUpdateInterval = interval;
        console.log(`Update interval adjusted to ${interval}ms`);
        this.updatePerfHud();
      });

      this.socket.on('eventLog', (d) => this.uiCallbacks.addToEventLog(d.message, d.type || 'info'));

      this.socket.on('dungeonChange', (d) => this.handleDungeonChange(d));

      this.socket.on('ping', (ts) => { this.trackPacket(this.tcpStats, false); this.socket.emit('pong', ts); this.trackPacket(this.tcpStats, true); });
      this.socket.on('pingUpdate', (ms) => {
        this.__hudPingMs = ms;
        window.clientPing = ms;
        this.updatePing(this.tcpStats, ms);
        this.updatePerfHud();
        this.uiCallbacks.updatePerformanceStatus();
      });

      this.socket.on('batchPreferenceAck', (data) => {
        this.uiCallbacks.addToEventLog(`Batch size: ${data.batchSizeMs}ms (C:${data.effectiveIntervals.critical}/S:${data.effectiveIntervals.standard}/B:${data.effectiveIntervals.background}ms)`, 'info');
      });
    }

    // ═══════════════════════════════════════════════════════════════
    // Delta Update Handlers
    // ═══════════════════════════════════════════════════════════════

    initializeDeltaState(fullState) {
        if (!fullState) return;

        this.lastKnownState.players.clear();
        fullState.players?.forEach(p => this.lastKnownState.players.set(p.id, { ...p }));

        this.lastKnownState.enemies.clear();
        fullState.enemies?.forEach(e => this.lastKnownState.enemies.set(e.id, { ...e }));

        const completedDungeons = fullState.completedDungeons || {};

        this.lastKnownState.party = { 
            floor: fullState.floor, 
            combatActive: fullState.combatActive, 
            combatTurn: fullState.combatTurn, 
            dungeon: fullState.dungeon || 'field',
            highestVisitedFloors: { ...(fullState.highestVisitedFloors || {}) }, 
            autoEmbark: fullState.autoEmbark || false,
            completedDungeons: { ...completedDungeons }
        };
        this.currentState = { ...fullState, completedDungeons };
    }

    handleDeltaUpdate(data) {
        const { players, enemies, floor, dungeonFloors, combatActive, combatTurn, highestVisitedFloors, autoEmbark, completedDungeons } = data;
        
        // Update players
        players && Object.entries(players).forEach(([id, delta]) => this._upsertPlayer(delta));

        // Update enemies
        enemies && Object.entries(enemies).forEach(([id, delta]) => this._upsertEnemy(delta));

        // Remove dead enemies
        this.currentState.enemies = (this.currentState.enemies || []).filter(e => {
            if (e.hp <= 0) { 
                this.lastKnownState.enemies.delete(e.id); 
                return false; 
            }
            return true;
        });

        // Update party state
        if (floor !== undefined) { this.currentState.floor = floor; this.lastKnownState.party.floor = floor; }
        if (dungeonFloors !== undefined) { 
            this.currentState.dungeonFloors = dungeonFloors; 
            this.lastKnownState.party.dungeonFloors = { ...dungeonFloors };
        }
        if (combatActive !== undefined) { this.currentState.combatActive = combatActive; this.lastKnownState.party.combatActive = combatActive; }
        if (combatTurn !== undefined) { this.currentState.combatTurn = combatTurn; this.lastKnownState.party.combatTurn = combatTurn; }
        if (highestVisitedFloors !== undefined) { this.currentState.highestVisitedFloors = highestVisitedFloors; this.lastKnownState.party.highestVisitedFloors = { ...highestVisitedFloors }; }
        if (autoEmbark !== undefined) { this.currentState.autoEmbark = autoEmbark; this.lastKnownState.party.autoEmbark = autoEmbark; }

        if (completedDungeons !== undefined) {
            this.currentState.completedDungeons = completedDungeons;
            this.lastKnownState.party.completedDungeons = { ...completedDungeons };
        }

        this.uiCallbacks.updatePartyDisplay(this.currentState);
    }

    // Handle immediate HP/MP updates (high-frequency updates)
    handleHPMpUpdate(data) {
        const { playerUpdates, timestamp } = data;
        
        if (!playerUpdates) return;
        
        Object.entries(playerUpdates).forEach(([id, updates]) => {
            // Skip metadata entries
            if (id === 'id' || id === 'name') return;
            
            const current = this.currentState.players?.find(p => p.id === id || p.name === id);
            const last = this.lastKnownState.players.get(id);
            
            if (current && last) {
                // Apply HP/MP/AP changes using unified handler
                this._updatePlayerStats(current, last, updates);
            }
        });
        
        this.uiCallbacks.updatePartyDisplay(this.currentState);
    }

    // Handle combat start event via WebRTC
    handleCombatStart(data) {
        if (data && data.enemies) {
            // Update enemies in current state
            data.enemies.forEach(enemy => this._upsertEnemy(enemy));
            if (data.floor !== undefined) {
                this.currentState.floor = data.floor;
                this.lastKnownState.party.floor = data.floor;
            }
            if (data.combatActive !== undefined) {
                this.currentState.combatActive = data.combatActive;
                this.lastKnownState.party.combatActive = data.combatActive;
            }
        }
        this.uiCallbacks.onCombatStart?.(data);
        this.uiCallbacks.updatePartyDisplay(this.currentState);
    }

    // Handle combat end event via WebRTC
    handleCombatEnd(data) {
        this.uiCallbacks.onCombatEnd?.(data);
        // Update combat active state
        if (data.combatActive === false || data.message?.includes('Victory') || data.message?.includes('perished') || data.message?.includes('lost')) {
            this.currentState.combatActive = false;
            this.lastKnownState.party.combatActive = false;
            this.uiCallbacks.updatePartyDisplay(this.currentState);
        }
    }

    // Handle dungeon change (embark/return to town) - used for both Socket.IO and WebRTC
    handleDungeonChange(d) {
        if (!this.lastKnownState.party) this.lastKnownState.party = {};

        if (d.dungeon !== undefined) {
            this.currentState.dungeon = d.dungeon;
            this.lastKnownState.party.dungeon = d.dungeon;
        }
        if (d.floor !== undefined) {
            this.currentState.floor = d.floor;
            this.lastKnownState.party.floor = d.floor;
        }
        if (d.highestVisitedFloors !== undefined) {
            this.currentState.highestVisitedFloors = d.highestVisitedFloors;
            this.lastKnownState.party.highestVisitedFloors = { ...d.highestVisitedFloors };
        }
        if (d.dungeonFloors !== undefined) {
            this.currentState.dungeonFloors = d.dungeonFloors;
            this.lastKnownState.party.dungeonFloors = { ...d.dungeonFloors };
        }
        if (d.combatActive !== undefined) {
            this.currentState.combatActive = d.combatActive;
            this.lastKnownState.party.combatActive = d.combatActive;
        }
        if (d.completedDungeons !== undefined) {
            this.currentState.completedDungeons = d.completedDungeons;
            this.lastKnownState.party.completedDungeons = { ...d.completedDungeons };
        }
        if (d.enemies !== undefined) {
            this.currentState.enemies = d.enemies;
            // Update enemies delta tracking so future delta updates apply correctly
            this.lastKnownState.enemies.clear();
            d.enemies.forEach(e => this.lastKnownState.enemies.set(e.id, { ...e }));
        }

        // Update UI
        this.uiCallbacks.updatePartyDisplay(this.currentState);

        // Update dungeon UI
        if (typeof window.updateDungeonUI === 'function') {
            window.updateDungeonUI();
        }
    }

    handleCriticalUpdate(data) {
        // Apply shop stock delivered on the critical path (gear updates).
        if (data.shopStock !== undefined) {
            this.currentState.shopStock = data.shopStock;
            this.uiCallbacks.updateShopStock?.(data.shopStock);
        }

        // Handle combat events (new targeted format)
        if (data.actor || data.target || data.hit !== undefined || data.leveledUp) {
            // Extract attacker ID for the onAttack callback
            if (data.actor && data.actor.id) {
                const attackData = {
                    attackerId: data.actor.id,
                    hit: data.hit,
                    crit: data.crit,
                    damage: data.damage,
                    roll: data.roll
                };
                this.uiCallbacks.onAttack?.(attackData);
            }

            // Handle combat event types
            if (data.type === 'death') {
                this.uiCallbacks.onDeath?.(data);
            } else if (data.type === 'levelUp') {
                this.uiCallbacks.onLevelUp?.(data);
            } else if (data.crit !== undefined && data.damage !== undefined) {
                // Combat hit/crit/damage - update display
                this.uiCallbacks.onCombatUpdate?.(data);
            }

            // Update actor if present
            if (data.actor) {
                const actorId = data.actor.id;
                let current = this.currentState.players?.find(p => p.id === actorId);
                if (!current) {
                    // Actor might be enemy - check enemies
                    current = this.currentState.enemies?.find(e => e.id === actorId);
                }
                if (current) {
                    let lastState = this.lastKnownState.players.get(actorId);
                    if (!lastState) {
                        lastState = this.lastKnownState.enemies.get(actorId);
                    }
                    if (lastState) {
                        Object.assign(current, data.actor);
                        Object.assign(lastState, data.actor);
                    } else {
                        // No lastState exists - this is a new actor, update current only
                        Object.assign(current, data.actor);
                    }
                }

                // Remove actor if dead (enemy)
                if (data.actor.isDead && this.currentState.enemies) {
                    this.currentState.enemies = this.currentState.enemies.filter(e => e.id !== actorId);
                    this.lastKnownState.enemies.delete(actorId);
                }
            }

            // Update target if present
            if (data.target) {
                const targetId = data.target.id;
                let current = this.currentState.players?.find(p => p.id === targetId);
                if (!current) {
                    current = this.currentState.enemies?.find(e => e.id === targetId);
                }
                if (current) {
                    let lastState = this.lastKnownState.players.get(targetId);
                    if (!lastState) {
                        lastState = this.lastKnownState.enemies.get(targetId);
                    }
                    if (lastState) {
                        // Update all target fields including AP
                        const targetFields = ['id', 'name', 'isEnemy', 'hp', 'maxHp', 'ap', 'maxAp', 'isDead'];
                        targetFields.forEach(f => {
                            if (data.target[f] !== undefined) {
                                current[f] = data.target[f];
                                lastState[f] = data.target[f];
                            }
                        });
                    } else {
                        // No lastState exists - this is a new target, update current only
                        Object.assign(current, data.target);
                    }
                }

                // Remove target if dead (enemy)
                if (data.target.isDead && this.currentState.enemies) {
                    this.currentState.enemies = this.currentState.enemies.filter(e => e.id !== targetId);
                    this.lastKnownState.enemies.delete(targetId);
                }
            }

            // Handle leveled up players
            if (data.leveledUp && Array.isArray(data.leveledUp)) {
                data.leveledUp.forEach(player => {
                    const current = this.currentState.players?.find(p => p.id === player.id);
                    const lastState = this.lastKnownState.players.get(player.id);
                    if (current && lastState) {
                        ['hp', 'maxHp', 'maxMp', 'maxAp', 'level'].forEach(f => {
                            if (player[f] !== undefined) {
                                current[f] = player[f];
                                lastState[f] = player[f];
                            }
                        });
                    }
                });
            }

            this.uiCallbacks.updatePartyDisplay(this.currentState);
            return;
        }
        
        // Handle legacy format (playerUpdates object)
        if (data.playerUpdates) {
            this._applyEntityUpdates(data.playerUpdates, {
                currentArr: this.currentState.players, lastMap: this.lastKnownState.players, isPlayer: true,
                applyFn: (cur, last, u) => {
                    this._updatePlayerStats(cur, last, u);
                    // Gear/inventory delivered on the critical path: copy and refresh the panel.
                    ['inventory', 'equipment', 'gold'].forEach(f => {
                        if (u[f] !== undefined) { cur[f] = u[f]; last[f] = u[f]; }
                    });
                },
                skipDisplay: true
            });
            // Render via the live, authoritative currentState below. Do NOT capture `cur`
            // and re-render it from a setTimeout: a full-state sync arriving before that
            // timer fires replaces the player objects, leaving the captured `cur` stale and
            // painting a wrong-category flicker that self-corrects on the next update.
            this.uiCallbacks.updatePartyDisplay(this.currentState);
        }
        
        // Handle enemy updates - remove dead enemies, add new ones
        if (data.enemyUpdates) {
            this._applyEntityUpdates(data.enemyUpdates, {
                currentArr: this.currentState.enemies, lastMap: this.lastKnownState.enemies, isPlayer: false,
                applyFn: (cur, last, u) => this._applyFieldUpdates(cur, last, u, ['hp', 'maxHp', 'ap', 'maxAp', 'isDead']),
                onNew: (u) => this._upsertEnemy({ ...u }),
                skipDisplay: true
            });
            this.uiCallbacks.updatePartyDisplay(this.currentState);
        }
    }

    handleStandardUpdate(data) {
        const eFields = ['hp', 'maxHp', 'ap', 'maxAp', 'actionBar', 'maxActionBar', 'isDead', 'name'];
        const inTown = this.currentState.floor === 0 && !this.currentState.combatActive;

        if (data.playerUpdates) {
            this._applyEntityUpdates(data.playerUpdates, {
                currentArr: this.currentState.players, lastMap: this.lastKnownState.players, isPlayer: true, inTown,
                applyFn: (cur, last, u) => this._updatePlayerStats(cur, last, u)
            });
        }
        this.uiCallbacks.updatePartyDisplay(this.currentState);
        if (data.enemyUpdates) {
            this._applyEntityUpdates(data.enemyUpdates, {
                currentArr: this.currentState.enemies, lastMap: this.lastKnownState.enemies, isPlayer: false, inTown,
                applyFn: (cur, last, u) => this._applyFieldUpdates(cur, last, u, eFields),
                onNew: (u) => this._upsertEnemy({ ...u })
            });
        }
        this.uiCallbacks.updatePartyDisplay(this.currentState);
        if (data.combatActive !== undefined) this.currentState.combatActive = data.combatActive;
        if (data.combatTurn !== undefined) this.currentState.combatTurn = data.combatTurn;
        if (data.floor !== undefined) { this.currentState.floor = data.floor; this.uiCallbacks.updatePartyDisplay(this.currentState); }
        if (data.enemies?.length) {
            data.enemies.forEach(e => {
                const c = this.currentState.enemies?.find(x => x.id === e.id), l = this.lastKnownState.enemies.get(e.id);
                if (c && l) Object.assign(c, e, l);
                else if (e.id && e.name) { (this.currentState.enemies || (this.currentState.enemies = [])).push(e); this.lastKnownState.enemies.set(e.id, { ...e }); }
            });
            this.uiCallbacks.updatePartyDisplay(this.currentState);
        }
    }

    handleBackgroundUpdate(data) {
        const STAT_FIELDS = ['hp', 'maxHp', 'mp', 'maxMp', 'ap', 'maxAp', 'isDead'];
        const inTown = this.currentState.floor === 0 && !this.currentState.combatActive;

        if (data.playerUpdates) {
            this._applyEntityUpdates(data.playerUpdates, {
                currentArr: this.currentState.players, lastMap: this.lastKnownState.players, isPlayer: true, inTown,
                applyFn: (cur, last, u) => {
                    const statsUpdates = {}, otherUpdates = {};
                    Object.keys(u).forEach(field => {
                        if (STAT_FIELDS.includes(field)) statsUpdates[field] = u[field];
                        else otherUpdates[field] = u[field];
                    });
                    if (Object.keys(statsUpdates).length > 0) this._updatePlayerStats(cur, last, statsUpdates);
                    Object.keys(otherUpdates).forEach(f => { cur[f] = otherUpdates[f]; last[f] = otherUpdates[f]; });
                    // The synchronous updatePartyDisplay below re-renders the live
                    // currentState. No captured-closure setTimeout here: a full-state
                    // sync before the timer fires would leave `cur` stale (a wrong-category
                    // flicker that self-corrects on the next update).
                },
                onNew: (u) => {
                    (this.currentState.players || (this.currentState.players = [])).push(u);
                    this.lastKnownState.players.set(u.id, { ...u });
                }
            });
        }
        if (data.floor !== undefined) {
            this.currentState.floor = data.floor;
            this.uiCallbacks.updatePartyDisplay(this.currentState);
        } else {
            this.uiCallbacks.updatePartyDisplay(this.currentState);
        }
    }

    handleFullStateUpdate(data) {
        //console.log('[ClientNetwork] handleFullStateUpdate received:', JSON.stringify(data, null, 2).substring(0, 500));
        this.currentState = data;
        this.initializeDeltaState(data);
        if (data.shopStock !== undefined) {
            this.uiCallbacks.updateShopStock?.(data.shopStock);
        }
        this.uiCallbacks.updatePartyDisplay(data);
    }

    _applyFieldUpdates(target, lastState, updates, fields) {
        fields.forEach(f => { if (updates[f] !== undefined) { target[f] = updates[f]; lastState[f] = updates[f]; } });
    }

    // Add-or-update an entity in currentState + lastKnownState (used by all delta handlers).
    _upsertEnemy(enemy) {
        const current = this.currentState.enemies?.find(e => e.id === enemy.id);
        const last = this.lastKnownState.enemies.get(enemy.id);
        if (current && last) { Object.assign(current, enemy); Object.assign(last, enemy); }
        else if (enemy.id && enemy.name) {
            (this.currentState.enemies || (this.currentState.enemies = [])).push(enemy);
            this.lastKnownState.enemies.set(enemy.id, { ...enemy });
        }
    }

    _upsertPlayer(delta) {
        const current = this.currentState.players?.find(p => p.id === delta.id);
        const last = this.lastKnownState.players.get(delta.id);
        if (current && last) { Object.assign(current, delta); Object.assign(last, delta); }
        else if (delta.id && delta.name) {
            (this.currentState.players || (this.currentState.players = [])).push(delta);
            this.lastKnownState.players.set(delta.id, { ...delta });
        }
    }

    // Unified player stats update handler - ensures maxHp updates are properly handled across all update channels
    _updatePlayerStats(current, lastState, updates) {
        const statsFields = ['hp', 'maxHp', 'mp', 'maxMp', 'ap', 'maxAp', 'isDead', 'level', 'actionBar', 'maxActionBar', 'skillsState'];
        
        statsFields.forEach(field => {
            if (updates[field] !== undefined) {
                const oldValue = current[field];
                const newValue = updates[field];
                
                // Update both current and last known state
                current[field] = newValue;
                lastState[field] = newValue;
            }
        });
    }

    // Shared iteration over an { id: update } map used by the standard/critical/background
    // update handlers. For each entry it locates the current entity and its last-known
    // snapshot, applies the update via `applyFn`, refreshes its display, removes dead
    // enemies, and upserts newly-seen entities via `onNew`.
    _applyEntityUpdates(updates, { currentArr, lastMap, isPlayer, inTown, applyFn, onNew, skipDisplay }) {
        if (!updates) return;
        Object.entries(updates).forEach(([id, u]) => {
            if (id === 'id' || id === 'name') return;
            const cur = currentArr?.find(x => x.id === id || (isPlayer && x.name === id));
            const last = lastMap.get(id);
            if (cur && last) {
                applyFn(cur, last, u);
                if (!skipDisplay) this.uiCallbacks.updatePlayerDisplay(cur, cur.name === this.ownName, inTown, cur);
                if (!isPlayer && cur.hp <= 0) {
                    this.currentState.enemies = this.currentState.enemies.filter(e => e.id !== id);
                    lastMap.delete(id);
                }
            } else if (onNew) {
                onNew(u);
            }
        });
    }

    // ═══════════════════════════════════════════════════════════════
    // Performance Monitoring
    // ═══════════════════════════════════════════════════════════════

    initPerformanceMonitoring() {
        let frames = 0, lastMark = performance.now();
        const tick = (now) => {
            frames++;
            if (now - lastMark >= 1000) {
                this.__hudLastFps = frames * 1000 / (now - lastMark);
                lastMark = now;
                frames = 0;
                this.updatePerfHud();
            }
            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    }

    updatePerfHud() {
        const hud = document.getElementById('perfHud');
        if (!hud) return;
        const fpsTxt = isFinite(this.__hudLastFps) ? Math.round(this.__hudLastFps) : '--';
        const updateTxt = isFinite(this.__lastUpdateInterval) ? this.__lastUpdateInterval : '--';
        const connType = this.webrtcConnected ? 'WebRTC' : 'Socket.IO';
        hud.textContent = `FPS: ${fpsTxt} | Updates: ${updateTxt}ms | ${connType}`;
    }

    trackPacket(stats, sent, estimatedBytes) {
        const now = Date.now();
        stats[sent ? 'packetsSent' : 'packetsReceived']++;
        const bytes = estimatedBytes || (sent ? 200 : 300);
        stats[sent ? 'bytesSent' : 'bytesReceived'] += bytes;
        stats.throughputHistory.push({ bytes, timestamp: now, sent });
        this.packetTrackingWindow.push({ type: stats === this.tcpStats ? 'tcp' : 'udp', sent, timestamp: now, bytes });
        this.cleanupPacketTracking();
        this.cleanupThroughputHistory(stats);
    }

    cleanupThroughputHistory(stats) {
        const now = Date.now();
        stats.throughputHistory = stats.throughputHistory.filter(e => now - e.timestamp < this.throughputWindowSize);
    }

    cleanupPacketTracking() {
        this.packetTrackingWindow = this.packetTrackingWindow.filter(p => Date.now() - p.timestamp < this.maxTrackingWindow);
    }

    calculateThroughputKBps(stats) {
        const now = Date.now();
        const recent = stats.throughputHistory.filter(e => now - e.timestamp < this.throughputWindowSize);
        if (!recent.length) return 0;
        return (recent.reduce((sum, e) => sum + e.bytes, 0) / 1024) / (this.throughputWindowSize / 1000);
    }

    calculatePacketsPerSecond(type) {
        const now = Date.now(), windowSecs = this.maxTrackingWindow / 1000;
        const sent = this.packetTrackingWindow.filter(p => p.type === type && p.sent && now - p.timestamp < this.maxTrackingWindow).length;
        const recv = this.packetTrackingWindow.filter(p => p.type === type && !p.sent && now - p.timestamp < this.maxTrackingWindow).length;
        return { sent: (sent / windowSecs).toFixed(1), received: (recv / windowSecs).toFixed(1), total: ((sent + recv) / windowSecs).toFixed(1) };
    }

    calculateAveragePing(stats) {
        if (!stats.pingHistory.length) return 0;
        return Math.round(stats.pingHistory.reduce((a, b) => a + b, 0) / stats.pingHistory.length);
    }

    updatePing(stats, ping) {
        stats.pingHistory.push(ping);
        stats.lastPingTime = Date.now();
        if (stats.pingHistory.length > 10) stats.pingHistory.shift();
    }

    getNetworkStatistics() {
        return {
            tcp: { ping: this.calculateAveragePing(this.tcpStats), packetsPerSecond: this.calculatePacketsPerSecond('tcp'), totalSent: this.tcpStats.packetsSent, totalReceived: this.tcpStats.packetsReceived, bytesSent: this.tcpStats.bytesSent, bytesReceived: this.tcpStats.bytesReceived, throughputKBps: this.calculateThroughputKBps(this.tcpStats) },
            udp: { ping: this.calculateAveragePing(this.udpStats), packetsPerSecond: this.calculatePacketsPerSecond('udp'), totalSent: this.udpStats.packetsSent, totalReceived: this.udpStats.packetsReceived, bytesSent: this.udpStats.bytesSent, bytesReceived: this.udpStats.bytesReceived, throughputKBps: this.calculateThroughputKBps(this.udpStats), connected: this.udpStats.connected }
        };
    }

    // ═══════════════════════════════════════════════════════════════
    // Game Actions - Prefer WebRTC over TCP
    // ═══════════════════════════════════════════════════════════════

    joinParty(partyId, name) {
        this.ownName = name;
        this.currentPartyId = partyId;
        // Initial connection must use TCP (WebRTC requires Socket.IO connection first)
        this.trackPacket(this.tcpStats, true);
        this.socket.emit('joinParty', { partyId, name });

        // Try to establish WebRTC connection after joining
        setTimeout(() => {
            if (!this.webrtcConnected && this.socket.connected) { 
                this.setupWebRTCConnection(); 
            }
        }, 1000);
    }

    leaveParty() {
        // Use WebRTC if available for leave party notification
        if (this.webrtcConnected) {
            this.sendWebRTCMessage('leaveParty', { partyId: this.currentPartyId });
        } else {
            this.trackPacket(this.tcpStats, true);
            this.socket.emit('leaveParty', this.currentPartyId);
        }
        this.uiCallbacks.onLeaveParty();
        this.currentPartyId = null;
    }

    _sendAction(action, extra = {}) {
        // Use TCP for client-to-server actions that need guaranteed delivery
        // WebRTC is great for server-to-client updates but client actions should use TCP
        // for reliability and to ensure the server receives them
        this.trackPacket(this.tcpStats, true);
        this.socket.emit(action, { partyId: this.currentPartyId, ...extra });
    }

    moveFloor(dir) { this._sendAction('moveFloor', { direction: dir }); }
    nextFloor() { this._sendAction('nextFloor'); }
    teleportToTown() { this._sendAction('teleportToTown'); }
    teleportToFloor(floor) { this._sendAction('teleportToFloor', { floor }); }
    embarkDungeon(dungeonKey) { this._sendAction('embarkDungeon', { dungeon: dungeonKey }); }
    toggleAutoEmbark(enabled) { this._sendAction('toggleAutoEmbark', { enabled }); }
    escapeDungeon() { this._sendAction('escapeDungeon', {}); }
    allocatePoints(stat, points) { this._sendAction('allocatePoints', { stat, points }); }
    assignAbilitySlot(slotIndex, abilityId) { this._sendAction('assignAbilitySlot', { slotIndex, abilityId }); }
    donate() { this._sendAction('donate'); }
    equipItem(slot, itemId) { this._sendAction('equipItem', { slot, itemId }); }
    sellItem(itemId) { this._sendAction('sellItem', { itemId }); }
    changeDungeon(dungeon) { this._sendAction('changeDungeon', { dungeon }); }
    buyGear(type) { 
        this.trackPacket(this.tcpStats, true); 
        if (type.startsWith('shop_')) {
            // Handle shop items differently since they can't be mapped to standard event names
            const index = parseInt(type.split('_')[1]);
            this.socket.emit('buyShopItem', { partyId: this.currentPartyId, index: index });
        } else {
            this.socket.emit('buy' + type.charAt(0).toUpperCase() + type.slice(1), this.currentPartyId); 
        }
    }

    sendPreferWebRTC(type, data) {
        if (this.sendWebRTCMessage(type, data)) return true;
        this.trackPacket(this.tcpStats, true);
        this.socket.emit(type, data);
        return false;
    }

    performCombatAction(actionData) { this.sendPreferWebRTC('combatAction', actionData); }
    updatePlayerPosition(posData) { this.sendPreferWebRTC('playerMove', posData); }
    sendActionBarUpdate(barData) { this.sendPreferWebRTC('actionBarUpdate', barData); }
    sendCombatUpdate(combatData) { this.sendPreferWebRTC('combatUpdate', combatData); }

    // ═══════════════════════════════════════════════════════════════
    // Client-Side Performance Optimizations
    // ═══════════════════════════════════════════════════════════════

    setPerformanceMode(mode) {
        this.performanceMode = mode;
        this.__debug = mode !== 'performance';
        
        if (this.adaptiveIntervalInterval) {
            clearInterval(this.adaptiveIntervalInterval);
            this.adaptiveIntervalInterval = null;
        }
        if (this.predictionInterval) {
            clearInterval(this.predictionInterval);
            this.predictionInterval = null;
        }
        
        switch (mode) {
            case 'quality':
                this.__lastUpdateInterval = 80;
                this.clientPrediction = true;
                this.batchEvents = false;
                break;
            case 'performance':
                this.__lastUpdateInterval = 500;
                this.clientPrediction = false;
                this.batchEvents = true;
                break;
            case 'adaptive':
            default:
                this.clientPrediction = true;
                this.batchEvents = true;
                
                this.adaptiveIntervalInterval = setInterval(() => {
                    this.adjustUpdateIntervalBasedOnPing();
                }, 3000);
                
                this.adjustUpdateIntervalBasedOnPing();
                break;
        }
        
        this.startClientSidePrediction();
        this.updatePerfHud();
    }

    startClientSidePrediction() {
        if (!this.clientPrediction) return;
        
        if (this.predictionInterval) {
            clearInterval(this.predictionInterval);
        }
        
        this.predictionInterval = setInterval(() => {
            if (this.lastKnownState.party?.combatActive) {
                this.predictActionBarUpdates();
            }
        }, this.__lastUpdateInterval);
    }

    predictActionBarUpdates() {
        const players = this.currentState.players || [];

        // Cache the .action-fill node per player so we don't re-scan the entire
        // DOM tree on every prediction tick. Rebuild the cache only when the set
        // of player names or the number of rendered player cards changes.
        const nameKey = players.map(p => p.name).join('|');
        const playerCount = document.querySelectorAll('.player').length;
        if (!this._actionBarCache || this._actionBarCacheKey !== nameKey || this._actionBarCache.size !== playerCount) {
            this._actionBarCache = new Map();
            document.querySelectorAll('.player').forEach(element => {
                const nameEl = element.querySelector('.level-display');
                if (!nameEl) return;
                const txt = nameEl.textContent;
                for (const player of players) {
                    if (txt.includes(player.name)) {
                        const actionFill = element.querySelector('.action-fill');
                        if (actionFill) this._actionBarCache.set(player.name, actionFill);
                        break;
                    }
                }
            });
            this._actionBarCacheKey = nameKey;
        }

        players.forEach(player => {
            if (player.hp > 0 && player.actionBar < player.maxActionBar) {
                const agiFillRate = 5.8 * (1.6 + (player.agi || 5) / 277 + (player.equipment?.shoes?.defense || 3) / 155);
                const predictedFill = Math.min(player.maxActionBar, player.actionBar + agiFillRate);

                const actionBar = this._actionBarCache.get(player.name);
                if (actionBar) {
                    const fillPercent = (predictedFill / player.maxActionBar) * 100;
                    actionBar.style.width = `${fillPercent}%`;
                }
            }
        });
    }

    adjustUpdateIntervalBasedOnPing() {
        let currentPing = 0;
        
        if (this.__hudPingMs > 0) {
            currentPing = this.__hudPingMs;
        } else if (window.clientPing > 0) {
            currentPing = window.clientPing;
        } else if (this._cachedPing > 0) {
            currentPing = this._cachedPing;
        }
        
        if (currentPing <= 0) {
            const defaultInterval = 100;
            if (this.__lastUpdateInterval !== defaultInterval) {
                this.__lastUpdateInterval = defaultInterval;
                console.log(`Adaptive mode: No ping data yet → Default interval ${this.__lastUpdateInterval}ms`);
                this.updatePerfHud();
            }
            return;
        }
        
        this._cachedPing = currentPing;
        
        const baseLowPing = 50;
        const baseMidPing = 100;
        const baseHighPing = 150;
        const baseVeryHighPing = 200;
        
        let newInterval;
        
        if (currentPing < 50) {
            newInterval = baseLowPing;
        } else if (currentPing < 150) {
            const ratio = (currentPing - 50) / 100;
            newInterval = baseLowPing + (baseMidPing - baseLowPing) * ratio;
        } else if (currentPing < 300) {
            const ratio = (currentPing - 150) / 150;
            newInterval = baseMidPing + (baseHighPing - baseMidPing) * ratio;
        } else {
            const ratio = Math.min((currentPing - 300) / 200, 1);
            newInterval = baseHighPing + (baseVeryHighPing - baseHighPing) * ratio;
        }
        
        this.__lastUpdateInterval = Math.round(newInterval);
        console.log(`Adaptive mode: Ping ${currentPing}ms → Update interval ${this.__lastUpdateInterval}ms`);
        this.updatePerfHud();
    }

    // ═══════════════════════════════════════════════════════════════
    // Performance Control
    // ═══════════════════════════════════════════════════════════════

    /**
     * Change batch size preference for this client.
     * Higher values = more batching = fewer packets = less bandwidth but higher latency.
     * @param {number} batchSizeMs - Desired batch interval in milliseconds (75-500ms)
     */
    changeBatchSize(batchSizeMs) {
        const size = parseInt(batchSizeMs);
        if (isNaN(size) || size < 75 || size > 500) {
            console.error(`Invalid batch size: ${batchSizeMs}ms, must be between 75-500ms`);
            return;
        }
        
        this.socket.emit('batchPreference', { batchSizeMs: size });
        this.__lastUpdateInterval = size;
        this.startClientSidePrediction();
        this.updatePerfHud();
        this.uiCallbacks.updatePerformanceStatus();
    }

    // ═══════════════════════════════════════════════════════════════
    // Performance Status Updates
    // ═══════════════════════════════════════════════════════════════

    updatePerformanceStatus() {
        if (!this.uiCallbacks.updatePerformanceStatus) return;

        const stats = this.getPerformanceStats();
        const networkStats = this.getNetworkStatistics();

        // Update optimizer settings
        [['deltaStatus', stats.clientPrediction], ['batchStatus', stats.batchEvents], ['predStatus', stats.clientPrediction]].forEach(([id, active]) => {
            const el = document.getElementById(id);
            if (el) el.textContent = active ? 'Active' : 'Disabled';
        });

        // Update network statistics
        ['tcp', 'udp'].forEach(protocol => {
            const pingEl = document.getElementById(`${protocol}Ping`);
            const sentEl = document.getElementById(`${protocol}SentPerSec`);
            const recvEl = document.getElementById(`${protocol}RecvPerSec`);
            const packetsEl = document.getElementById(`${protocol}PacketsPerSec`);
            const throughputEl = document.getElementById(`${protocol}Throughput`);
            const pingValue = networkStats[protocol].ping || 0;
            const throughputValue = networkStats[protocol].throughputKBps || 0;
            const pps = networkStats[protocol].packetsPerSecond || { sent: '0.0', received: '0.0', total: '0.0' };

            if (pingEl) {
                pingEl.textContent = pingValue > 0 ? `${pingValue}` : '--';
                pingEl.style.color = pingValue > 0 ? (pingValue < 50 ? '#4a4' : pingValue < 150 ? '#aa4' : '#a44') : '#888';
            }

            if (sentEl) sentEl.textContent = pps.sent;
            if (recvEl) recvEl.textContent = pps.received;
            if (packetsEl) packetsEl.textContent = pps.total;

            if (throughputEl) {
                throughputEl.textContent = throughputValue > 0 ? throughputValue.toFixed(2) : '--';
                throughputEl.style.color = throughputValue > 0 ? '#4a4' : '#888';
            }

            if (protocol === 'udp') {
                const statusEl = document.getElementById('udpStatus');
                if (statusEl) {
                    statusEl.textContent = networkStats.udp.connected ? 'Connected' : 'Disconnected';
                    statusEl.style.color = networkStats.udp.connected ? '#4a4' : '#a44';
                }
            }
        });
    }

    // ═══════════════════════════════════════════════════════════════
    // ═══════════════════════════════════════════════════════════════

    getPerformanceStats() {
        return {
            updateInterval: this.__lastUpdateInterval,
            performanceMode: this.performanceMode,
            clientPrediction: this.clientPrediction,
            batchEvents: this.batchEvents,
            lastUpdate: Date.now(),
            webrtcConnected: this.webrtcConnected,
            webrtcRetryCount: this.webrtcRetryCount,
            queuedMessages: this.webrtcMessageQueue.length,
            connectionType: this.webrtcConnected ? 'WebRTC' : 'Socket.IO'
        };
    }

    disconnect() {
        this.webrtcManualClose = true;
        this.clearWebRTCTimers();
        this.webrtcDataChannel?.close();
        this.webrtcPeer?.close();
        this.socket?.disconnect();
    }
}

// Export
if (typeof module !== 'undefined' && module.exports) { module.exports = ClientNetwork; }
else if (typeof window !== 'undefined') { window.ClientNetwork = ClientNetwork; }
