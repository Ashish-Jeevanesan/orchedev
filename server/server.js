// D:\Ashish_P\AI-Tools\custom-OCT\server\server.js
// Secure Local HTTP & WebSocket Server for Agent Workbench

import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { WebSocketServer, WebSocket } from 'ws';
import { TerminalManager } from './terminal_manager.js';
import { CliSessionRegistry } from './cli_session_registry.js';
import { SessionPairings } from './session_pairings.js';
import { TaskCoordinatorService } from './task_coordinator_service.js';
import { IntercomService, TaskSecurityError } from './intercom_service.js';
import { WorkspaceAuthorizationService } from './workspace_authorization.js';
import { logger } from './logger.js';
import { evaluate as evaluateGeminiApprovalPrompt } from './gemini_approval_policy.js';
import { TranscriptMirror } from './transcript_mirror.js';
import { fileURLToPath as __toPath } from 'url';
const __serverDir = path.dirname(__toPath(import.meta.url));

function openFolderPicker() {
  return new Promise((resolve, reject) => {
    if (process.platform === 'darwin') {
      const osaCmd = 'POSIX path of (choose folder with prompt "Select Working Project Directory")';
      const child = spawn('osascript', ['-e', osaCmd]);

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', d => stdout += d.toString());
      child.stderr.on('data', d => stderr += d.toString());

      child.on('close', (code) => {
        if (code === 0) {
          const selected = stdout.trim();
          resolve(selected || null);
        } else if (stderr.includes('User canceled') || stderr.includes('(-128)')) {
          // User clicked cancel in AppleScript dialog
          resolve(null);
        } else {
          reject(new Error(stderr || `osascript exited with code ${code}`));
        }
      });

      child.on('error', reject);
    } else {
      const psCmd = `Add-Type -AssemblyName System.Windows.Forms; $dialog = New-Object System.Windows.Forms.FolderBrowserDialog; $dialog.Description = 'Select Working Project Directory'; $dialog.ShowNewFolderButton = $true; if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.SelectedPath }`;
      const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', psCmd], {
        windowsHide: false
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', d => stdout += d.toString());
      child.stderr.on('data', d => stderr += d.toString());

      child.on('close', (code) => {
        if (code === 0) {
          const selected = stdout.trim();
          resolve(selected || null);
        } else {
          reject(new Error(stderr || `PowerShell exited with code ${code}`));
        }
      });

      child.on('error', reject);
    }
  });
}

export class WorkbenchServer {
  constructor({ cwd, port = 0 }) {
    this.cwd = cwd;
    this.port = port;
    this.server = null;
    this.wssTerminals = null;
    this.wssEvents = null;
    this.sessionToken = crypto.randomBytes(24).toString('hex');
    this.publicDir = path.join(__serverDir, '..', 'public');

    this.cliSessionRegistry = new CliSessionRegistry({ cwd });
    this.sessionPairings = new SessionPairings({ cwd });
    this.transcriptMirror = new TranscriptMirror({ cwd });
    this.terminalManager = new TerminalManager({ cwd });
    this.terminalManager.onGlobalExit((id) => {
      this._recordSessionPairing();
      const status = this.terminalManager.getStatus(id);
      if (status?.cliSessionId) {
        if (id === 'claude') this.transcriptMirror.mirrorClaude(status.cliSessionId, this.currentProjectCwd);
        if (id === 'gemini') this.transcriptMirror.mirrorGemini(status.cliSessionId, this.currentProjectCwd);
      }
    });
    this.coordinatorService = null;
    this.workspaceAuth = new WorkspaceAuthorizationService({ baseCwd: cwd });
    this.intercomService = null;
    this.currentProjectCwd = cwd;
    this.eventSockets = new Set();
    this.allocatedPort = null;
    this._autoPullInterval = null;
    this._lastAutoPulledTaskId = null;
    this._lastAutoPullTime = 0;
    this._lastApprovalSnapshot = null;
    // Set when a Gemini permission prompt is escalated (not auto-approved) so Claude's
    // get_delegation_status / get_inbox polls can see *why* Gemini looks stuck instead
    // of the delegate_to_gemini call just timing out silently (see BUGS.md BUG-001).
    this._geminiApprovalBlock = null;
    // "Sleep Mode": a human-operated toggle (header button, /api/gemini/sleep-mode) that
    // widens Gemini's shell-prompt auto-approval beyond gemini_approval_policy.js's
    // SAFE_CATEGORIES allowlist -- for unattended stretches (e.g. overnight) where no one
    // is at the terminal to answer prompts. The untrusted-input-marker and
    // DANGEROUS_PATTERNS vetoes in that policy are never affected by this flag. Off by
    // default on every process start; never persisted across restarts.
    this._geminiSleepMode = false;
  }

  async start() {
    this.coordinatorService = new TaskCoordinatorService({
      cwd: this.cwd,
      eventBroadcaster: (type, payload) => this.broadcastEvent(type, payload)
    });

    this.intercomService = new IntercomService({
      cwd: this.cwd,
      eventBroadcaster: (type, payload) => this.broadcastEvent(type, payload),
      workspaceAuth: this.workspaceAuth
    });

    this.server = http.createServer((req, res) => this._handleHttp(req, res));

    // Create distinct WebSocket servers for terminals and events
    this.wssTerminals = new WebSocketServer({ noServer: true });
    this.wssEvents = new WebSocketServer({ noServer: true });

    this._setupWebSocketHandlers();

    this.server.on('upgrade', (req, socket, head) => this._handleUpgrade(req, socket, head));

    return new Promise((resolve, reject) => {
      // Bind strictly to 127.0.0.1 (loopback only)
      this.server.listen(this.port, '127.0.0.1', () => {
        this.allocatedPort = this.server.address().port;
        this.terminalManager.setWorkbenchConnection({
          port: this.allocatedPort,
          sessionToken: this.sessionToken
        });
        this.terminalManager.getTerminalConfig('claude');
        this.terminalManager.getTerminalConfig('gemini');
        console.log(`[WorkbenchServer] Listening strictly on 127.0.0.1:${this.allocatedPort}`);

        // Recurring 15-second auto-pull check for Gemini worker terminal (fallback poll;
        // task_state_changed already triggers this immediately -- see broadcastEvent())
        this._autoPullInterval = setInterval(() => {
          this._checkAndTriggerAutoPull();
        }, 15000);

        // Scoped, logged auto-approval for Gemini's own permission prompts -- see
        // gemini_approval_policy.js for the rules. Never acts on anything flagged as
        // carrying untrusted input; those are always left for the human.
        this.terminalManager.onQuietOutput('gemini', (snapshot) => this._handleGeminiApprovalPrompt(snapshot));

        // Mirroring on quiet output for cross-device synchronization
        this.terminalManager.onQuietOutput('claude', () => {
          const status = this.terminalManager.getStatus('claude');
          if (status?.cliSessionId) {
            this.transcriptMirror.mirrorClaude(status.cliSessionId, this.currentProjectCwd);
          }
        });
        this.terminalManager.onQuietOutput('gemini', () => {
          const status = this.terminalManager.getStatus('gemini');
          if (status?.cliSessionId) {
            this.transcriptMirror.mirrorGemini(status.cliSessionId, this.currentProjectCwd);
          }
        });

        resolve({
          port: this.allocatedPort,
          sessionToken: this.sessionToken
        });
      });

      this.server.on('error', reject);
    });
  }

  broadcastEvent(type, payload) {
    const msg = JSON.stringify({ type, payload, timestamp: Date.now() });
    for (const ws of this.eventSockets) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
      }
    }

    if (type === 'task_state_changed' && (payload?.to === 'QUEUED_FOR_CLAIM' || payload?.to === 'QUEUED') && payload?.task?.toAgent === 'gemini') {
      setTimeout(() => this._checkAndTriggerAutoPull(), 1000);
    }
  }

  _checkAndTriggerAutoPull() {
    try {
      if (!this.intercomService || !this.terminalManager) return;
      const geminiStatus = this.terminalManager.getStatus('gemini');
      if (!geminiStatus || geminiStatus.status !== 'RUNNING') return;

      const allDelegations = this.intercomService.getAllDelegations();
      const isGeminiBusy = allDelegations.some(
        t => t.toAgent === 'gemini' && (t.state === 'CLAIMED' || t.state === 'RUNNING')
      );
      if (isGeminiBusy) return;

      const queuedTasks = allDelegations.filter(
        t => t.toAgent === 'gemini' && (t.state === 'QUEUED_FOR_CLAIM' || t.state === 'QUEUED')
      );
      if (queuedTasks.length === 0) return;

      const targetTask = queuedTasks[0];
      const now = Date.now();
      if (this._lastAutoPulledTaskId === targetTask.correlationId && (now - this._lastAutoPullTime) < 60000) {
        return;
      }

      // Don't interleave with Gemini's own live output or an open permission prompt --
      // if it's mid-output, skip this tick; the 15s fallback poll (or the next
      // task_state_changed event) will retry once it goes idle. Only a successful
      // write below marks the task as "already notified".
      if (!this.terminalManager.isIdle('gemini')) {
        return;
      }

      this._lastAutoPulledTaskId = targetTask.correlationId;
      this._lastAutoPullTime = now;
      // Named handover instead of the old ambiguous "check queue" text: tells Gemini
      // exactly which task and which tools to call, rather than relying on it to infer
      // intent from an unrecognized phrase.
      const handoverMessage = `A new task is waiting in your inbox (correlationId: ${targetTask.correlationId}). Call get_inbox to see it, then claim_task to pick it up.`;
      logger.info('TERMINAL:AUTO_PULL', `Notifying Gemini ConPTY of queued task ${targetTask.correlationId}`, {
        correlationId: targetTask.correlationId
      });
      // Write the text and the submitting Enter as two separate writes with a short
      // gap. A single write() containing the text plus a trailing \r arrives as one
      // chunk with no inter-character timing -- Gemini's ink-based input treats that
      // shape as a paste, which inserts the content but does NOT auto-submit it (the
      // user has to press Enter themselves). Splitting it mirrors real typing closely
      // enough that the terminal treats the final \r as a genuine submit keystroke.
      this.terminalManager.write('gemini', handoverMessage);
      setTimeout(() => {
        try {
          this.terminalManager.write('gemini', '\r');
        } catch (err) {
          logger.warn('TERMINAL:AUTO_PULL_WARN', `Failed to submit handover message: ${err.message}`);
        }
      }, 150);
    } catch (err) {
      logger.warn('TERMINAL:AUTO_PULL_WARN', `Auto-pull trigger error: ${err.message}`);
    }
  }

  // Records whichever Claude/Gemini CLI session ids are currently active as a pair, so
  // resuming the Claude side later can automatically bring its Gemini side back too.
  _recordSessionPairing() {
    try {
      const claudeId = this.terminalManager.getStatus('claude').cliSessionId;
      const geminiId = this.terminalManager.getStatus('gemini').cliSessionId;
      this.sessionPairings.recordActive({ claudeSessionId: claudeId, geminiSessionId: geminiId });
    } catch (err) {
      logger.warn('SESSION_PAIRINGS:RECORD_ERROR', `Failed to record session pairing: ${err.message}`);
    }
  }

  // Merges persisted pairing metadata with each CLI's own live, authoritative session
  // store (CliSessionRegistry), so the list only ever offers sessions that genuinely
  // exist and are genuinely resumable -- a pairing entry referencing an id neither CLI
  // actually persisted (e.g. a terminal opened and closed with no real exchange) is
  // dropped rather than shown as a dead "ghost" entry.
  async _buildMergedSessionList() {
    const [realSessions, pairs] = await Promise.all([
      this.cliSessionRegistry.list(),
      Promise.resolve(this.sessionPairings.list())
    ]);

    const realClaudeById = new Map(realSessions.filter((s) => s.agent === 'claude').map((s) => [s.id, s]));
    const realGeminiById = new Map(realSessions.filter((s) => s.agent === 'gemini').map((s) => [s.id, s]));

    const merged = [];
    const usedClaudeIds = new Set();
    const usedGeminiIds = new Set();

    for (const pair of pairs) {
      const claudeReal = pair.claudeSessionId ? realClaudeById.get(pair.claudeSessionId) : null;
      const geminiReal = pair.geminiSessionId ? realGeminiById.get(pair.geminiSessionId) : null;
      if (!claudeReal && !geminiReal) continue; // neither side ever actually persisted -- drop

      const cId = claudeReal ? claudeReal.id : null;
      const gId = geminiReal ? geminiReal.id : null;

      // Prevent duplicate merged entries across multiple pairing references
      const alreadyMerged = merged.some((m) => m.claudeSessionId === cId && m.geminiSessionId === gId);
      if (alreadyMerged) continue;

      if (claudeReal) usedClaudeIds.add(claudeReal.id);
      if (geminiReal) usedGeminiIds.add(geminiReal.id);

      merged.push({
        claudeSessionId: cId,
        geminiSessionId: gId,
        title: claudeReal ? claudeReal.title : geminiReal.title,
        lastActiveAt: [claudeReal?.lastActiveAt, geminiReal?.lastActiveAt].filter(Boolean).sort().pop()
      });
    }

    // Any real Claude session not referenced by any pair gets its own entry so it is
    // never dropped on restart, termination, or buffer clearing.
    for (const [id, s] of realClaudeById) {
      if (!usedClaudeIds.has(id)) {
        merged.push({ claudeSessionId: id, geminiSessionId: null, title: s.title, lastActiveAt: s.lastActiveAt });
      }
    }

    // Any real Gemini session not referenced by any pair is one that was never paired
    // with a Claude session at all -- i.e. genuinely used standalone -- and gets its
    // own entry per the user's own framing of this feature.
    for (const [id, s] of realGeminiById) {
      if (!usedGeminiIds.has(id)) {
        merged.push({ claudeSessionId: null, geminiSessionId: id, title: s.title, lastActiveAt: s.lastActiveAt });
      }
    }

    merged.sort((a, b) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime());
    return merged;
  }

  _handleGeminiApprovalPrompt(snapshot) {
    try {
      const claimedClaudeDelegatedTasks = this.intercomService
        ? this.intercomService.getAllDelegations().filter(
            (t) => t.toAgent === 'gemini' && t.fromAgent === 'claude' &&
                   (t.state === 'CLAIMED' || t.state === 'RUNNING')
          )
        : [];

      const result = evaluateGeminiApprovalPrompt(snapshot, {
        claimedClaudeDelegatedTasks,
        sleepMode: this._geminiSleepMode
      });

      if (!result.isPrompt) {
        // Gemini's output has moved past any recognized prompt -- if we had it marked
        // as blocked, the human must have answered it directly in the terminal.
        if (this._geminiApprovalBlock) {
          logger.info('GEMINI_APPROVAL:RESOLVED', 'Gemini approval prompt no longer present; clearing block', {
            correlationId: this._geminiApprovalBlock.correlationId
          });
          this._geminiApprovalBlock = null;
        }
        return;
      }

      if (result.decision === 'AUTO_APPROVE') {
        if (this._lastApprovalSnapshot === snapshot) return; // cheap guard against re-firing on an unchanged buffer
        this._lastApprovalSnapshot = snapshot;
        this._geminiApprovalBlock = null;
        this.terminalManager.write('gemini', '1\r');
        logger.info('GEMINI_APPROVAL:AUTO_APPROVED', `Auto-approved Gemini permission prompt (category: ${result.reason})`, {
          command: result.command,
          reason: result.reason,
          sleepMode: this._geminiSleepMode
        });
        this.broadcastEvent('gemini_approval', {
          decision: 'AUTO_APPROVED',
          command: result.command,
          reason: result.reason,
          sleepMode: this._geminiSleepMode,
          timestamp: Date.now()
        });
      } else {
        // Escalated: the human decides, never Claude. Record it against whichever task
        // is currently claimed/running so Claude's status polls can see it and wait for
        // the user, instead of the delegate_to_gemini call just timing out silently.
        const activeTask = claimedClaudeDelegatedTasks[0] || null;
        const alreadyBlockedOnSame = this._geminiApprovalBlock &&
          this._geminiApprovalBlock.command === result.command &&
          this._geminiApprovalBlock.reason === result.reason;

        this._geminiApprovalBlock = {
          correlationId: activeTask ? activeTask.correlationId : null,
          command: result.command || null,
          reason: result.reason,
          since: alreadyBlockedOnSame ? this._geminiApprovalBlock.since : Date.now()
        };

        logger.info('GEMINI_APPROVAL:ESCALATED', `Left Gemini permission prompt for human review (${result.reason})`, {
          command: result.command || null,
          reason: result.reason,
          correlationId: this._geminiApprovalBlock.correlationId
        });

        if (!alreadyBlockedOnSame) {
          this.broadcastEvent('gemini_approval', {
            decision: 'ESCALATED',
            command: result.command || null,
            reason: result.reason,
            correlationId: this._geminiApprovalBlock.correlationId,
            timestamp: Date.now()
          });
        }
      }
    } catch (err) {
      logger.warn('GEMINI_APPROVAL:HANDLER_ERROR', `Approval prompt handler error: ${err.message}`);
    }
  }

  _isTokenValid(token) {
    if (!token || typeof token !== 'string' || typeof this.sessionToken !== 'string') return false;
    const candBuf = Buffer.from(token.trim());
    const sessBuf = Buffer.from(this.sessionToken);
    if (candBuf.length !== sessBuf.length) return false;
    return crypto.timingSafeEqual(candBuf, sessBuf);
  }

  _isOriginValid(origin, isWebSocket = false) {
    if (!origin) {
      // Browser WebSockets MUST supply an Origin header; reject missing Origin on WebSockets
      return !isWebSocket;
    }
    try {
      const u = new URL(origin);
      const isLoopbackHost = (u.hostname === '127.0.0.1' || u.hostname === 'localhost');
      const isMatchingPort = Number(u.port) === this.allocatedPort;
      return isLoopbackHost && isMatchingPort;
    } catch (e) {
      return false;
    }
  }

  _isAuthenticated(req) {
    const headerToken = req.headers['x-session-token'];
    if (this._isTokenValid(headerToken)) return true;

    const auth = req.headers['authorization'];
    if (auth && typeof auth === 'string' && auth.startsWith('Bearer ')) {
      return this._isTokenValid(auth.slice(7));
    }

    return false;
  }

  _handleUpgrade(req, socket, head) {
    const origin = req.headers['origin'];
    if (!this._isOriginValid(origin, true)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    const parsedUrl = new URL(req.url, `http://127.0.0.1:${this.allocatedPort}`);
    const pathname = parsedUrl.pathname;

    // Check Sec-WebSocket-Protocol for token or allow initial auth message
    let protocolToken = null;
    const protocols = req.headers['sec-websocket-protocol'];
    if (protocols) {
      const parts = protocols.split(',').map(s => s.trim());
      for (const p of parts) {
        if (p.startsWith('token.')) {
          protocolToken = p.slice(6);
        }
      }
    }

    const isProtoAuthed = this._isTokenValid(protocolToken);

    if (pathname === '/ws/terminals' || pathname === '/ws/terminal') {
      this.wssTerminals.handleUpgrade(req, socket, head, (ws) => {
        ws.authenticated = isProtoAuthed;
        ws.terminalId = parsedUrl.searchParams.get('id') || 'claude';
        this.wssTerminals.emit('connection', ws, req);
      });
    } else if (pathname === '/ws/events') {
      this.wssEvents.handleUpgrade(req, socket, head, (ws) => {
        ws.authenticated = isProtoAuthed;
        this.wssEvents.emit('connection', ws, req);
      });
    } else {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
    }
  }

  _setupWebSocketHandlers() {
    // 1. Events WebSocket
    this.wssEvents.on('connection', (ws) => {
      let authTimer = null;

      if (!ws.authenticated) {
        // Allow 3 seconds for initial auth packet
        authTimer = setTimeout(() => {
          if (!ws.authenticated) {
            ws.close(4001, 'Authentication timeout');
          }
        }, 3000);
      } else {
        this.eventSockets.add(ws);
      }

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'auth') {
            if (msg.token === this.sessionToken) {
              ws.authenticated = true;
              if (authTimer) clearTimeout(authTimer);
              this.eventSockets.add(ws);
              ws.send(JSON.stringify({ type: 'auth_success', persistence: 'SESSION_ONLY' }));
            } else {
              ws.close(4003, 'Invalid token');
            }
          }
        } catch (e) {}
      });

      ws.on('close', () => {
        if (authTimer) clearTimeout(authTimer);
        this.eventSockets.delete(ws);
      });
    });

    // 2. Terminals WebSocket
    this.wssTerminals.on('connection', (ws) => {
      const terminalId = ws.terminalId;
      let authTimer = null;
      let currentDataHandler = null;
      let currentExitHandler = null;
      let isAttached = false;

      const setupPtyForwarding = () => {
        if (isAttached) return;
        isAttached = true;

        currentDataHandler = (output) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'output', data: output }));
          }
        };

        currentExitHandler = (exitCode, signal) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'exit', exitCode, signal }));
          }
          this.broadcastEvent('terminal_status', this.terminalManager.getAllStatuses());
        };

        // Start or attach to existing terminal with scrollback replay
        this.terminalManager.startTerminal(terminalId, { cols: 80, rows: 24 }, currentDataHandler, currentExitHandler);
        this._recordSessionPairing();
        this.broadcastEvent('terminal_status', this.terminalManager.getAllStatuses());
      };

      if (!ws.authenticated) {
        authTimer = setTimeout(() => {
          if (!ws.authenticated) {
            ws.close(4001, 'Authentication timeout');
          }
        }, 3000);
      } else {
        setupPtyForwarding();
      }

      ws.on('message', (msgData) => {
        try {
          const msg = JSON.parse(msgData.toString());
          if (msg.type === 'auth') {
            if (msg.token === this.sessionToken) {
              ws.authenticated = true;
              if (authTimer) clearTimeout(authTimer);
              if (!isAttached) {
                setupPtyForwarding();
              }
            } else {
              ws.close(4003, 'Invalid token');
            }
            return;
          }

          if (!ws.authenticated) return;

          if (msg.type === 'input' && typeof msg.data === 'string') {
            this.terminalManager.write(terminalId, msg.data);
          } else if (msg.type === 'resize' && msg.cols && msg.rows) {
            this.terminalManager.resize(terminalId, msg.cols, msg.rows);
          }
        } catch (e) {}
      });

      ws.on('close', () => {
        if (authTimer) clearTimeout(authTimer);
        this._recordSessionPairing();
        if (currentDataHandler || currentExitHandler) {
          this.terminalManager.detachListener(terminalId, currentDataHandler, currentExitHandler);
        }
      });
    });
  }

  async _handleHttp(req, res) {
    const rawUrl = req.url || '';
    if (rawUrl.includes('..') || /%2e%2e/i.test(rawUrl)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      return res.end('Forbidden: Path Traversal Denied');
    }

    const origin = req.headers['origin'];
    if (origin && !this._isOriginValid(origin)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      return res.end('Forbidden: Invalid Origin');
    }

    const parsedUrl = new URL(req.url, `http://127.0.0.1:${this.allocatedPort}`);
    const pathname = parsedUrl.pathname;

    // REST API handling
    if (pathname.startsWith('/api/')) {
      return this._handleRestApi(req, res, pathname, parsedUrl);
    }

    // Static Assets serving
    return this._serveStatic(req, res, pathname);
  }

  async _handleRestApi(req, res, pathname, parsedUrl) {
    // Health endpoint is public for loopback probe
    if (pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
    }

    // All other /api/ endpoints require valid session token
    if (!this._isAuthenticated(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Unauthorized: Invalid or missing X-Session-Token' }));
    }

    // 1. Session verification
    if (pathname === '/api/session/verify' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        authenticated: true,
        persistence: 'SESSION_ONLY',
        projectCwd: this.currentProjectCwd,
        appDir: this.cwd,
        allowedRoots: this.workspaceAuth ? this.workspaceAuth.getAllowedRoots() : [this.cwd],
        terminals: this.terminalManager.getAllStatuses(),
        geminiSleepMode: this._geminiSleepMode
      }));
    }

    // Gemini Sleep Mode: human-operated toggle for unattended shell auto-approval.
    // See the _geminiSleepMode field comment in the constructor and
    // gemini_approval_policy.js for exactly what this does and does not bypass.
    if (pathname === '/api/gemini/sleep-mode' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ enabled: this._geminiSleepMode }));
    }

    if (pathname === '/api/gemini/sleep-mode' && req.method === 'POST') {
      try {
        const body = await this._readBody(req, res);
        const data = JSON.parse(body);
        if (typeof data.enabled !== 'boolean') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: '"enabled" boolean is required' }));
        }

        const previous = this._geminiSleepMode;
        this._geminiSleepMode = data.enabled;

        if (previous !== this._geminiSleepMode) {
          logger.info(
            this._geminiSleepMode ? 'GEMINI_SLEEP_MODE:ENABLED' : 'GEMINI_SLEEP_MODE:DISABLED',
            `Gemini sleep mode ${this._geminiSleepMode ? 'enabled' : 'disabled'} by human operator`,
            { enabled: this._geminiSleepMode }
          );
          this.broadcastEvent('gemini_sleep_mode_changed', {
            enabled: this._geminiSleepMode,
            timestamp: Date.now()
          });
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ enabled: this._geminiSleepMode }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      }
    }

    // Workspace Project Directory Endpoints
    if (pathname === '/api/workspace' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        projectCwd: this.currentProjectCwd,
        appDir: this.cwd,
        allowedRoots: this.workspaceAuth ? this.workspaceAuth.getAllowedRoots() : [this.cwd]
      }));
    }

    if (pathname === '/api/workspace/select' && req.method === 'POST') {
      try {
        const body = await this._readBody(req, res);
        const data = JSON.parse(body);
        const rawPath = data.path;
        if (!rawPath || typeof rawPath !== 'string' || rawPath.includes('\0') || rawPath.includes('%00')) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Valid directory path is required without null bytes' }));
        }
        const resolved = path.resolve(rawPath);
        if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: `Directory does not exist or is inaccessible: ${resolved}` }));
        }

        const realResolved = fs.realpathSync(resolved);
        this.workspaceAuth.addAllowedRoot(realResolved);
        if (this.intercomService) {
          this.intercomService.addAllowedRoot(realResolved);
        }
        this.currentProjectCwd = realResolved;
        this.terminalManager.setProjectCwd(realResolved);
        this.coordinatorService.setProjectCwd(realResolved);
        this.broadcastEvent('workspace_changed', { projectCwd: realResolved });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ projectCwd: realResolved }));
      } catch (e) {
        if (e.message === 'Payload Too Large') return;
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    if (pathname === '/api/workspace/browse' && req.method === 'POST') {
      try {
        const selectedPath = await openFolderPicker();
        if (!selectedPath) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ cancelled: true, projectCwd: this.currentProjectCwd }));
        }

        const resolved = path.resolve(selectedPath);
        if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: `Selected directory is invalid: ${resolved}` }));
        }

        const realResolved = fs.realpathSync(resolved);
        this.workspaceAuth.addAllowedRoot(realResolved);
        if (this.intercomService) {
          this.intercomService.addAllowedRoot(realResolved);
        }
        this.currentProjectCwd = realResolved;
        this.terminalManager.setProjectCwd(realResolved);
        this.coordinatorService.setProjectCwd(realResolved);
        this.broadcastEvent('workspace_changed', { projectCwd: realResolved });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ projectCwd: realResolved }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // 2. Terminals status
    if (pathname === '/api/terminals' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(this.terminalManager.getAllStatuses()));
    }

    // 3. Terminals control
    const termActionMatch = pathname.match(/^\/api\/terminals\/([a-zA-Z0-9_-]+)\/(start|restart|terminate|clear)$/);
    if (termActionMatch && req.method === 'POST') {
      const termId = termActionMatch[1];
      const action = termActionMatch[2];

      try {
        logger.info('API:TERMINAL_ACTION_REQUEST', `Terminal ${termId} action requested: ${action}`, {
          terminalId: termId,
          action,
          currentProjectCwd: this.currentProjectCwd
        });

        if (action === 'start') {
          this.terminalManager.startTerminal(termId);
          this._recordSessionPairing();
        } else if (action === 'restart') {
          this._recordSessionPairing();
          await this.terminalManager.restartTerminal(termId);
          this._recordSessionPairing();
        } else if (action === 'terminate') {
          this._recordSessionPairing();
          await this.terminalManager.terminate(termId);
        } else if (action === 'clear') {
          this.terminalManager.clearScrollback(termId);
        }

        const status = this.terminalManager.getStatus(termId);
        this.broadcastEvent('terminal_status', this.terminalManager.getAllStatuses());

        logger.info('API:TERMINAL_ACTION_SUCCESS', `Terminal ${termId} action '${action}' completed. Status: ${status.status}, PID: ${status.pid}, CWD: ${status.cwd}`, {
          terminalId: termId,
          action,
          status
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(status));
      } catch (err) {
        logger.error('API:TERMINAL_ACTION_ERROR', `Terminal ${termId} action '${action}' failed: ${err.message}`, {
          terminalId: termId,
          action,
          error: err.message
        });
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // 3b. CLI session history: Claude sessions are the primary unit; a Gemini session
    // Claude delegated to is merged under its paired Claude session rather than listed
    // separately, and only appears on its own when it was genuinely used standalone.
    if (pathname === '/api/sessions' && req.method === 'GET') {
      try {
        const sessions = await this._buildMergedSessionList();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ sessions }));
      } catch (err) {
        logger.warn('API:SESSIONS_LIST_ERROR', `Failed to build session list: ${err.message}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ sessions: [] }));
      }
    }

    if (pathname === '/api/sessions/preflight' && req.method === 'POST') {
      try {
        const bodyStr = await this._readBody(req, res);
        const { sessionId, agent, expectedFiles = [], hydrate = false } = JSON.parse(bodyStr || '{}');

        if (!sessionId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'sessionId is required' }));
        }

        const preflight = await this.transcriptMirror.checkPreflight({
          sessionId,
          agent,
          expectedFiles,
          hydrate,
          projectCwd: this.currentProjectCwd
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(preflight));
      } catch (err) {
        logger.error('API:SESSION_PREFLIGHT_ERROR', `Preflight check failed: ${err.message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    if (pathname === '/api/sessions/resume' && req.method === 'POST') {
      try {
        const body = await this._readBody(req, res);
        const { claudeSessionId, geminiSessionId } = JSON.parse(body || '{}');
        if (!claudeSessionId && !geminiSessionId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'claudeSessionId and/or geminiSessionId is required' }));
        }

        logger.info('API:SESSION_RESUME_REQUEST', 'Resuming session', { claudeSessionId, geminiSessionId });

        // Resume whichever side(s) this session actually has -- one click restores the
        // whole work session, not just the terminal the user happened to click from.
        if (claudeSessionId) {
          const resClaude = this.transcriptMirror.restoreClaude(claudeSessionId, this.currentProjectCwd);
          if (!resClaude.exists) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: `Claude session ${claudeSessionId} transcript not found locally or in mirrored sessions` }));
          }
          await this.terminalManager.restartTerminal('claude', { resumeSessionId: claudeSessionId });
        }
        if (geminiSessionId) {
          const resGemini = this.transcriptMirror.restoreGemini(geminiSessionId, this.currentProjectCwd);
          if (!resGemini.exists) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: `Gemini session ${geminiSessionId} chat not found locally or in mirrored sessions` }));
          }
          await this.terminalManager.restartTerminal('gemini', { resumeSessionId: geminiSessionId });
        }
        this._recordSessionPairing();

        this.broadcastEvent('terminal_status', this.terminalManager.getAllStatuses());
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          claude: claudeSessionId ? this.terminalManager.getStatus('claude') : null,
          gemini: geminiSessionId ? this.terminalManager.getStatus('gemini') : null
        }));
      } catch (err) {
        logger.error('API:SESSION_RESUME_ERROR', `Session resume failed: ${err.message}`, { error: err.message });
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // 4. Tasks API (Unified Intercom Delegation Pipeline with Single-Agent Support)
    if (pathname === '/api/tasks' && req.method === 'GET') {
      const allDelegations = this.intercomService.getAllDelegations();
      const coordTasks = this.coordinatorService ? this.coordinatorService.getAllTasks() : [];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        persistence: 'DURABLE',
        tasks: [...allDelegations, ...coordTasks]
      }));
    }

    if (pathname === '/api/tasks' && req.method === 'POST') {
      try {
        const body = await this._readBody(req, res);
        const data = JSON.parse(body);
        if (!data.prompt || typeof data.prompt !== 'string' || !data.prompt.trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'prompt is required' }));
        }

        // By default, all tasks route through Intercom delegation pipeline with human approval.
        // Direct headless execution is only triggered if requiresApproval is explicitly false or headless: true.
        const isIntercomDelegation = data.requiresApproval !== false && !data.headless;

        if (isIntercomDelegation) {
          const task = this.intercomService.createDelegation({
            fromAgent: 'user',
            toAgent: 'gemini',
            plan: `User Task: ${data.prompt.trim()}`,
            instructions: data.prompt.trim(),
            cwd: data.cwd || this.currentProjectCwd,
            correlationId: data.correlationId,
            requiresApproval: true,
            approvalTimeoutMs: data.approvalTimeoutMs || data.timeoutMs || null,
            claimTimeoutMs: data.claimTimeoutMs || null,
            executionTimeoutMs: data.executionTimeoutMs || data.timeoutMs || null
          });

          res.writeHead(201, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            message: 'Task accepted into approval pipeline',
            task
          }));
        }

        // Direct single-agent execution (used by single-agent UI integration tests)
        const task = this.coordinatorService.createTask({
          correlationId: data.correlationId,
          targetAgent: data.targetAgent,
          prompt: data.prompt,
          cwd: data.cwd || this.currentProjectCwd
        });

        const defaultTimeout = 45000;
        this.coordinatorService.dispatchTask(task, data.timeoutMs || defaultTimeout).catch((err) => {
          console.error(`[Task Execution Error ${task.correlationId}]`, err.message);
        });

        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          message: 'Task accepted and scheduled',
          task: this.coordinatorService.getTask(task.correlationId)
        }));
      } catch (e) {
        if (e.message === 'Payload Too Large') return;
        const statusCode = (e instanceof TaskSecurityError || e.name === 'TaskSecurityError' || e.code === 'ERR_CWD_NOT_AUTHORIZED' || e.code === 'ERR_SECURITY_VIOLATION') ? 403 : 400;
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.code || 'ERR_INVALID_PARAMETERS', message: e.message }));
      }
      return;
    }

    const taskMatch = pathname.match(/^\/api\/tasks\/([a-zA-Z0-9_-]+)$/);
    if (taskMatch && req.method === 'GET') {
      const task = this.intercomService.getDelegation(taskMatch[1]) || (this.coordinatorService ? this.coordinatorService.getTask(taskMatch[1]) : null);
      if (!task) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Task not found' }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(task));
    }

    const cancelMatch = pathname.match(/^\/api\/tasks\/([a-zA-Z0-9_-]+)\/cancel$/);
    if (cancelMatch && req.method === 'POST') {
      try {
        const result = this.intercomService.cancelDelegation(cancelMatch[1], 'Cancelled by user via UI');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ cancelled: result.status === 'cancelled', ...result }));
      } catch (err) {
        // Fallback to coordinatorService cancel
        try {
          const cancelled = await this.coordinatorService.cancelTask(cancelMatch[1]);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ cancelled }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: err.message }));
        }
      }
    }

    // 5. Agent Intercom & MCP Bridge API
    if (pathname === '/api/intercom/peers' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(this.intercomService.getPeers()));
    }

    if (pathname === '/api/intercom/register' && req.method === 'POST') {
      try {
        const body = await this._readBody(req, res);
        const data = JSON.parse(body);
        const peer = this.intercomService.registerAgent(data);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'registered', peer }));
      } catch (e) {
        if (e.message === 'Payload Too Large') return;
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message, code: e.code }));
      }
      return;
    }

    if (pathname === '/api/intercom/heartbeat' && req.method === 'POST') {
      try {
        const body = await this._readBody(req, res);
        const data = JSON.parse(body);
        const ok = this.intercomService.recordHeartbeat(data);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: ok ? 'ok' : 'unrecognized_peer' }));
      } catch (e) {
        if (e.message === 'Payload Too Large') return;
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    if (pathname === '/api/intercom/disconnect' && req.method === 'POST') {
      try {
        const body = await this._readBody(req, res);
        const data = JSON.parse(body);
        const ok = this.intercomService.disconnectAgent(data);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: ok ? 'disconnected' : 'not_found' }));
      } catch (e) {
        if (e.message === 'Payload Too Large') return;
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    if (pathname === '/api/intercom/delegate' && req.method === 'POST') {
      try {
        const body = await this._readBody(req, res);
        const data = JSON.parse(body);
        const task = this.intercomService.createDelegation(data);
        const result = await this.intercomService.waitForCompletion(task.correlationId, data.timeoutMs);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        if (e.message === 'Payload Too Large') return;
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    if (pathname === '/api/intercom/inbox' && req.method === 'GET') {
      const agentId = parsedUrl.searchParams.get('agentId') || 'gemini';
      const cwd = parsedUrl.searchParams.get('cwd') || null;
      const inbox = this.intercomService.getInbox(agentId, cwd);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(inbox));
    }

    if (pathname === '/api/intercom/approvals/pending' && req.method === 'GET') {
      const pending = this.intercomService.getPendingApprovals();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(pending));
    }

    const approveMatch = pathname.match(/^\/api\/intercom\/approvals\/([a-zA-Z0-9_-]+)\/approve$/);
    if (approveMatch && req.method === 'POST') {
      try {
        const body = await this._readBody(req, res);
        const data = body ? JSON.parse(body) : {};
        const task = this.intercomService.approveDelegation({
          correlationId: approveMatch[1],
          editedInstructions: data.editedInstructions || null,
          approver: data.approver || 'human-ui'
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'approved', task }));
      } catch (e) {
        if (e.message === 'Payload Too Large') return;
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    const rejectMatch = pathname.match(/^\/api\/intercom\/approvals\/([a-zA-Z0-9_-]+)\/reject$/);
    if (rejectMatch && req.method === 'POST') {
      try {
        const body = await this._readBody(req, res);
        const data = body ? JSON.parse(body) : {};
        const task = this.intercomService.rejectDelegation({
          correlationId: rejectMatch[1],
          reason: data.reason || 'Rejected by user',
          rejecter: data.rejecter || 'human-ui'
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'rejected', task }));
      } catch (e) {
        if (e.message === 'Payload Too Large') return;
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    const intercomCancelMatch = pathname.match(/^\/api\/intercom\/tasks\/([a-zA-Z0-9_-]+)\/cancel$/);
    if (intercomCancelMatch && req.method === 'POST') {
      try {
        const body = await this._readBody(req, res);
        const data = body ? JSON.parse(body) : {};
        const result = this.intercomService.cancelDelegation({
          correlationId: intercomCancelMatch[1],
          reason: data.reason || 'Cancelled by user',
          actor: data.actor || 'human-ui'
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        if (e.message === 'Payload Too Large') return;
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    if (pathname === '/api/intercom/tasks' && req.method === 'GET') {
      const allTasks = this.intercomService.getAllDelegations();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(allTasks));
    }

    const intercomTaskMatch = pathname.match(/^\/api\/intercom\/tasks\/([a-zA-Z0-9_-]+)$/);
    if (intercomTaskMatch && req.method === 'GET') {
      const task = this.intercomService.getDelegation(intercomTaskMatch[1]);
      if (!task) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Delegation not found' }));
      }
      // Surface a pending Gemini approval prompt on its task's status, so a client
      // polling this (e.g. get_delegation_status) can see *why* Gemini looks stuck
      // instead of just timing out -- and knows the decision is the human's, not
      // Claude's, to make.
      const responseBody = { ...task };
      if (this._geminiApprovalBlock && this._geminiApprovalBlock.correlationId === task.correlationId) {
        responseBody.geminiApprovalBlock = {
          ...this._geminiApprovalBlock,
          waitingSeconds: Math.round((Date.now() - this._geminiApprovalBlock.since) / 1000),
          note: 'Gemini is holding on its own permission prompt for this command/file. This requires the human to approve or reject it directly in the Gemini terminal -- do not assume approval and do not proceed as if it were granted.'
        };
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(responseBody));
    }

    const waitMatch = pathname.match(/^\/api\/intercom\/tasks\/([a-zA-Z0-9_-]+)\/wait$/);
    if (waitMatch && req.method === 'GET') {
      const taskId = waitMatch[1];
      const pollTimeout = parseInt(parsedUrl.query?.pollTimeout, 10) || 30000;

      let cleanedUp = false;
      let waiterRecord = null;

      // Clean up when client disconnects
      req.on('close', () => {
        if (!cleanedUp && waiterRecord) {
          cleanedUp = true;
          this.intercomService._removeWaiter(taskId, waiterRecord);
        }
      });

      try {
        const result = await this.intercomService.waitForCompletion(taskId, pollTimeout, (record) => {
          waiterRecord = record;
        });
        cleanedUp = true;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(result));
      } catch (e) {
        cleanedUp = true;
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    }

    if (pathname === '/api/intercom/claim' && req.method === 'POST') {
      try {
        const body = await this._readBody(req, res);
        const data = JSON.parse(body);
        const task = this.intercomService.claimTask(data);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(task));
      } catch (e) {
        if (e.message === 'Payload Too Large') return;
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    if (pathname === '/api/intercom/progress' && req.method === 'POST') {
      try {
        const body = await this._readBody(req, res);
        const data = JSON.parse(body);
        const result = this.intercomService.reportProgress(data);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        if (e.message === 'Payload Too Large') return;
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message, code: e.code }));
      }
      return;
    }

    if (pathname === '/api/intercom/complete' && req.method === 'POST') {
      try {
        const body = await this._readBody(req, res);
        const data = JSON.parse(body);
        const task = this.intercomService.completeTask(data);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(task));
      } catch (e) {
        if (e.message === 'Payload Too Large') return;
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    if (pathname === '/api/intercom/fail' && req.method === 'POST') {
      try {
        const body = await this._readBody(req, res);
        const data = JSON.parse(body);
        const ok = this.intercomService.failTask(data);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: ok ? 'reported' : 'failed' }));
      } catch (e) {
        if (e.message === 'Payload Too Large') return;
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // 6. Shutdown endpoint
    if (pathname === '/api/shutdown' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'shutting_down' }));
      setTimeout(() => this.shutdown(), 200);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Endpoint not found' }));
  }

  _readBody(req, res, maxBytes = 1048576) {
    return new Promise((resolve, reject) => {
      const contentLength = parseInt(req.headers['content-length'], 10);
      if (!isNaN(contentLength) && contentLength > maxBytes) {
        let responded = false;
        req.on('data', () => {});
        req.on('end', () => {
          if (!responded) {
            responded = true;
            res.writeHead(413, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Payload Too Large: Content-Length exceeds 1MB limit' }));
          }
        });
        req.resume();
        return reject(new Error('Payload Too Large'));
      }

      let body = '';
      let receivedBytes = 0;
      let responded = false;

      req.on('data', (chunk) => {
        if (responded) return;
        receivedBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
        if (receivedBytes > maxBytes) {
          responded = true;
          req.on('data', () => {});
          req.on('end', () => {
            res.writeHead(413, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Payload Too Large: Streamed body exceeds 1MB limit' }));
          });
          req.resume();
          return reject(new Error('Payload Too Large'));
        }
        body += chunk;
      });

      req.on('end', () => {
        if (!responded) resolve(body);
      });

      req.on('error', (err) => {
        if (!responded) {
          responded = true;
          reject(err);
        }
      });
    });
  }

  _serveStatic(req, res, pathname) {
    if (pathname.includes('\0') || pathname.includes('%00')) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      return res.end('Bad Request: Null Byte Detected');
    }

    let decodedPathname;
    try {
      decodedPathname = decodeURIComponent(pathname);
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      return res.end('Bad Request: Malformed URI');
    }

    if (decodedPathname.includes('\0')) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      return res.end('Bad Request: Null Byte Detected');
    }

    let filePath = decodedPathname === '/' ? '/index.html' : decodedPathname;
    const safeTarget = path.resolve(this.publicDir, '.' + filePath);

    // Relative containment check (handles Windows case-insensitivity)
    const rel = path.relative(this.publicDir, safeTarget);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      return res.end('Forbidden: Access Denied');
    }

    // Check whether realpath (resolving symlinks) escapes publicDir
    let realTarget;
    try {
      realTarget = fs.realpathSync(safeTarget);
      const realPublic = fs.realpathSync(this.publicDir);
      const realRel = path.relative(realPublic, realTarget);
      if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        return res.end('Forbidden: Symlink Escape Denied');
      }
    } catch (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('File Not Found');
    }

    fs.stat(realTarget, (err, stats) => {
      if (err || !stats.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('File Not Found');
      }

      const ext = path.extname(realTarget).toLowerCase();
      const mimeTypes = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.mjs': 'application/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.woff2': 'font/woff2'
      };

      const contentType = mimeTypes[ext] || 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'X-Content-Type-Options': 'nosniff'
      });

      fs.createReadStream(realTarget).pipe(res);
    });
  }

  async shutdown() {
    console.log('[WorkbenchServer] Shutting down server and all child processes...');
    this._recordSessionPairing();

    if (this._autoPullInterval) {
      clearInterval(this._autoPullInterval);
      this._autoPullInterval = null;
    }

    for (const ws of this.eventSockets) {
      try { ws.close(); } catch (e) {}
    }
    this.eventSockets.clear();

    await this.terminalManager.shutdownAll();
    if (this.coordinatorService) {
      await this.coordinatorService.shutdown();
    }
    if (this.intercomService) {
      await this.intercomService.shutdown();
    }

    if (this.wssTerminals) this.wssTerminals.close();
    if (this.wssEvents) this.wssEvents.close();

    if (this.server) {
      await new Promise(r => this.server.close(r));
    }
    console.log('[WorkbenchServer] Shutdown complete.');
  }
}
