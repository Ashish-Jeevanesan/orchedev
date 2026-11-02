// D:\Ashish_P\AI-Tools\custom-OCT\server\intercom_service.js
// Central Agent Intercom & Coordination Service for Workbench MCP Bridges
// Workstreams A & B: Formal Transition Matrix, Serialized Persistence Queue, & Fault Recovery

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { logger } from './logger.js';
import { WorkspaceAuthorizationService } from './workspace_authorization.js';

// ────────────────────────────────────────────────────────────────────────────
// Structured Typed Errors
// ────────────────────────────────────────────────────────────────────────────

export class TaskStateError extends Error {
  constructor(message, code = 'ERR_INVALID_TRANSITION', details = {}) {
    super(message);
    this.name = 'TaskStateError';
    this.code = code;
    this.details = details;
  }
}

export class TaskTerminalError extends TaskStateError {
  constructor(message, details = {}) {
    super(message, 'ERR_TERMINAL_STATE', details);
    this.name = 'TaskTerminalError';
  }
}

export class TaskDuplicateError extends TaskStateError {
  constructor(message, details = {}) {
    super(message, 'ERR_DUPLICATE_TASK', details);
    this.name = 'TaskDuplicateError';
  }
}

export class TaskSecurityError extends TaskStateError {
  constructor(message, code = 'ERR_SECURITY_VIOLATION', details = {}) {
    if (typeof code === 'object' && code !== null) {
      super(message, 'ERR_SECURITY_VIOLATION', code);
    } else {
      super(message, code, details);
    }
    this.name = 'TaskSecurityError';
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Lifecycle States & Strict Allowed Transitions Matrix
// ────────────────────────────────────────────────────────────────────────────

export const AgentStatus = Object.freeze({
  ONLINE: 'ONLINE',
  BUSY: 'BUSY',
  UNREACHABLE: 'UNREACHABLE',
  OFFLINE: 'OFFLINE'
});

export const DelegationState = Object.freeze({
  CREATED: 'CREATED',
  APPROVAL_REQUESTED: 'APPROVAL_REQUESTED',
  APPROVED: 'APPROVED',
  QUEUED_FOR_CLAIM: 'QUEUED_FOR_CLAIM',
  QUEUED: 'QUEUED_FOR_CLAIM', // Backward-compatibility alias
  CLAIMED: 'CLAIMED',
  RUNNING: 'RUNNING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  TIMED_OUT: 'TIMED_OUT',
  REJECTED: 'REJECTED',
  EXPIRED: 'EXPIRED'
});

export const TERMINAL_STATES = new Set([
  DelegationState.COMPLETED,
  DelegationState.FAILED,
  DelegationState.CANCELLED,
  DelegationState.TIMED_OUT,
  DelegationState.REJECTED,
  DelegationState.EXPIRED
]);

export const ALLOWED_TRANSITIONS = Object.freeze({
  [DelegationState.CREATED]: new Set([
    DelegationState.APPROVAL_REQUESTED,
    DelegationState.QUEUED_FOR_CLAIM,
    DelegationState.CANCELLED
  ]),
  [DelegationState.APPROVAL_REQUESTED]: new Set([
    DelegationState.APPROVED,
    DelegationState.REJECTED,
    DelegationState.CANCELLED,
    DelegationState.TIMED_OUT,
    DelegationState.EXPIRED
  ]),
  [DelegationState.APPROVED]: new Set([
    DelegationState.QUEUED_FOR_CLAIM,
    DelegationState.CANCELLED
  ]),
  [DelegationState.QUEUED_FOR_CLAIM]: new Set([
    DelegationState.CLAIMED,
    DelegationState.CANCELLED,
    DelegationState.TIMED_OUT,
    DelegationState.EXPIRED
  ]),
  [DelegationState.CLAIMED]: new Set([
    DelegationState.RUNNING,
    DelegationState.FAILED,
    DelegationState.CANCELLED,
    DelegationState.TIMED_OUT
  ]),
  [DelegationState.RUNNING]: new Set([
    DelegationState.COMPLETED,
    DelegationState.FAILED,
    DelegationState.CANCELLED,
    DelegationState.TIMED_OUT
  ]),
  // Terminal states allow NO further transitions:
  [DelegationState.COMPLETED]: new Set(),
  [DelegationState.FAILED]: new Set(),
  [DelegationState.CANCELLED]: new Set(),
  [DelegationState.TIMED_OUT]: new Set(),
  [DelegationState.REJECTED]: new Set(),
  [DelegationState.EXPIRED]: new Set()
});

export class IntercomService {
  constructor({
    cwd = process.cwd(),
    eventBroadcaster,
    defaultTimeoutMs = 900000,
    approvalTimeoutMs = 900000,
    claimTimeoutMs = 900000,
    executionTimeoutMs = 900000,
    workspaceAuth = null,
    allowedRoots = []
  } = {}) {
    this.cwd = path.resolve(cwd);
    this.broadcastEvent = eventBroadcaster; // (type, payload) => void
    this.storageFile = path.join(this.cwd, '.workbench_tasks.json');

    // Centralized CWD authorization service
    this.workspaceAuth = workspaceAuth || new WorkspaceAuthorizationService({
      baseCwd: this.cwd,
      allowedRoots
    });

    // Configurable decoupled timeout budgets
    this.timeouts = {
      defaultTimeoutMs,
      approvalTimeoutMs,
      claimTimeoutMs,
      executionTimeoutMs
    };

    // Registered agent peers: agentId -> PeerRecord
    this.activePeers = new Map();

    // Coordinator-controlled monotonic registration generations: agentId -> number
    this.agentGenerations = new Map();

    // Durable delegation task store: correlationId -> TaskRecord
    this.delegations = new Map();

    // Pending delegation response promises: correlationId -> { resolve, reject, timer }
    this.pendingResolutions = new Map();

    // Serialized asynchronous persistence queue
    this.isPersisting = false;
    this.persistWaiters = [];

    // Clean up any orphaned temporary files left by abnormal crashes
    this._cleanOrphanedTempFiles();

    // Load persisted tasks from disk with crash recovery and expiry catch-up
    this._loadPersistedTasks();

    // Heartbeat & lifecycle timeout check interval (2500ms evaluation cadence)
    this.heartbeatTimer = setInterval(() => {
      this._checkHeartbeats();
      this._checkLifecycleTimeouts();
    }, 2500);
    this.heartbeatTimer.unref();
  }

  addAllowedRoot(rootPath) {
    return this.workspaceAuth.addAllowedRoot(rootPath);
  }

  removeAllowedRoot(rootPath) {
    return this.workspaceAuth.removeAllowedRoot(rootPath);
  }

  getAllowedRoots() {
    return this.workspaceAuth.getAllowedRoots();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Workstream B: Serialized Atomic Persistence & Crash Recovery
  // ──────────────────────────────────────────────────────────────────────────

  _cleanOrphanedTempFiles() {
    try {
      const files = fs.readdirSync(this.cwd);
      const now = Date.now();
      for (const file of files) {
        if (file.startsWith('.workbench_tasks.json.tmp_')) {
          const filePath = path.join(this.cwd, file);
          try {
            const stat = fs.statSync(filePath);
            // Only clean temp files older than 5 seconds to prevent racing active in-flight writers
            if (now - stat.mtimeMs > 5000) {
              fs.unlinkSync(filePath);
              logger.info('INTERCOM:CLEAN_TEMP_FILE', `Cleaned orphaned persistence temp file: ${file}`);
            }
          } catch (e) {}
        }
      }
    } catch (err) {
      logger.error('INTERCOM:CLEAN_TEMP_ERROR', `Failed to scan for temp files: ${err.message}`);
    }
  }

  _loadPersistedTasks() {
    try {
      if (!fs.existsSync(this.storageFile)) return;

      const raw = fs.readFileSync(this.storageFile, 'utf8');
      if (!raw || !raw.trim()) return;

      let tasks;
      try {
        tasks = JSON.parse(raw);
      } catch (parseErr) {
        // Emergency backup of corrupted file before starting fresh
        const backupPath = `${this.storageFile}.corrupt_${Date.now()}`;
        try {
          fs.writeFileSync(backupPath, raw, 'utf8');
          logger.error('INTERCOM:CORRUPTION_BACKUP_CREATED', `Corrupted tasks file preserved at ${backupPath}`, {
            error: parseErr.message,
            backupPath
          });
        } catch (e) {}
        throw parseErr;
      }

      if (Array.isArray(tasks)) {
        const now = Date.now();
        let recoveryChanges = false;

        for (const task of tasks) {
          task.stateHistory = task.stateHistory || [];

          // 1. Crash recovery: In-flight execution tasks safely transition to FAILED
          if (task.state === DelegationState.CLAIMED || task.state === DelegationState.RUNNING) {
            const previousState = task.state;
            task.state = DelegationState.FAILED;
            task.error = `Server or coordinator restarted while task was in state ${previousState}`;
            task.completedAt = now;
            task.stateHistory.push({
              from: previousState,
              to: DelegationState.FAILED,
              timestamp: now,
              reason: 'Crash recovery: in-flight task marked FAILED on startup',
              actor: 'coordinator_recovery'
            });
            recoveryChanges = true;
          }
          // 2. Expiry catch-up: Check if unapproved tasks expired while offline
          else if (task.state === DelegationState.APPROVAL_REQUESTED) {
            const budget = task.approvalTimeoutMs || this.timeouts.approvalTimeoutMs;
            if (now - (task.approvalRequestedAt || task.createdAt) > budget) {
              const previousState = task.state;
              task.state = DelegationState.EXPIRED;
              task.error = `Delegation approval timed out after ${budget}ms while offline`;
              task.completedAt = now;
              task.stateHistory.push({
                from: previousState,
                to: DelegationState.EXPIRED,
                timestamp: now,
                reason: 'Boot recovery: approval budget expired while offline',
                actor: 'coordinator_recovery'
              });
              recoveryChanges = true;
            }
          }
          // 3. Expiry catch-up: Check if unclaimed queued tasks expired while offline
          else if (task.state === DelegationState.QUEUED_FOR_CLAIM || task.state === 'QUEUED') {
            const budget = task.claimTimeoutMs || this.timeouts.claimTimeoutMs;
            if (now - (task.approvedAt || task.createdAt) > budget) {
              const previousState = task.state;
              task.state = DelegationState.EXPIRED;
              task.error = `Task claim timed out after ${budget}ms while offline`;
              task.completedAt = now;
              task.stateHistory.push({
                from: previousState,
                to: DelegationState.EXPIRED,
                timestamp: now,
                reason: 'Boot recovery: claim budget expired while offline',
                actor: 'coordinator_recovery'
              });
              recoveryChanges = true;
            } else {
              // Revalidate CWD against authorized roots on boot recovery
              try {
                this.workspaceAuth.authorizeCwd(task.cwd, this.cwd);
              } catch (authErr) {
                const previousState = task.state;
                task.state = DelegationState.EXPIRED;
                task.error = `ERR_CWD_NOT_AUTHORIZED: Persisted task working directory is outside authorized roots: ${task.cwd}`;
                task.completedAt = now;
                task.stateHistory.push({
                  from: previousState,
                  to: DelegationState.EXPIRED,
                  timestamp: now,
                  reason: 'Boot recovery: CWD outside authorized roots',
                  actor: 'coordinator_recovery'
                });
                recoveryChanges = true;
              }
            }
          }

          this.delegations.set(task.correlationId, task);
        }

        logger.info('INTERCOM:TASKS_LOADED', `Loaded ${this.delegations.size} persisted tasks from ${this.storageFile}`);
        if (recoveryChanges) {
          this._persist();
        }
      }
    } catch (err) {
      logger.error('INTERCOM:STORAGE_READ_ERROR', `Failed to load persisted tasks: ${err.message}`, { error: err.message });
    }
  }

  // Serialized asynchronous persistence queue
  _persist() {
    return new Promise((resolve, reject) => {
      this.persistWaiters.push({ resolve, reject });
      if (!this.isPersisting) {
        this._drainPersistQueue();
      }
    });
  }

  async _drainPersistQueue() {
    if (this.isPersisting || this.persistWaiters.length === 0) return;
    this.isPersisting = true;

    // Snapshot current batch of waiters
    const currentWaiters = this.persistWaiters;
    this.persistWaiters = [];

    let persistError = null;
    try {
      await this._atomicWriteWithRetry();
    } catch (err) {
      persistError = err;
      logger.error('INTERCOM:STORAGE_WRITE_ERROR', `Failed to persist tasks: ${err.message}`, { error: err.message });
    } finally {
      this.isPersisting = false;
      for (const { resolve, reject } of currentWaiters) {
        if (persistError) reject(persistError);
        else resolve();
      }

      // If overlapping state updates arrived while writing, drain the next batch immediately
      if (this.persistWaiters.length > 0) {
        this._drainPersistQueue();
      }
    }
  }

  async _atomicWriteWithRetry() {
    const serialized = Array.from(this.delegations.values());
    const tempFile = path.join(
      this.cwd,
      `.workbench_tasks.json.tmp_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`
    );

    // 1. Write full content to unique temporary file
    await fs.promises.writeFile(tempFile, JSON.stringify(serialized, null, 2), 'utf8');

    // 2. Windows atomic rename with exponential backoff retry for transient EPERM/EBUSY locks
    let lastErr = null;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        await fs.promises.rename(tempFile, this.storageFile);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        if (['EPERM', 'EBUSY', 'EACCES'].includes(err.code) && attempt < 5) {
          await new Promise((r) => setTimeout(r, attempt * 20));
          continue;
        }
        break;
      }
    }

    if (lastErr) {
      try { await fs.promises.unlink(tempFile); } catch (e) {}
      throw lastErr;
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Workstream A: State Machine Validation & State Transitions
  // ──────────────────────────────────────────────────────────────────────────

  // ──────────────────────────────────────────────────────────────────────────
  // Workstream D: Canonical WorkbenchEvent Emission
  // ──────────────────────────────────────────────────────────────────────────

  _emitEvent({ eventType, level = 'INFO', correlationId = null, agentId = 'system', summary, details = {} }) {
    const event = {
      eventId: `EVT_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      eventType,
      level,
      timestamp: Date.now(),
      correlationId: correlationId || null,
      agentId: agentId || 'system',
      summary: summary || eventType,
      details: details || {}
    };

    if (this.broadcastEvent) {
      // 1. Canonical WorkbenchEvent broadcast (single source of truth for Activity Feed & event loggers)
      this.broadcastEvent('workbench_event', event);

      // 2. Backward compatibility broadcasts for existing listeners and tests
      this.broadcastEvent('intercom_event', {
        eventType,
        task: details.task || null,
        ...event
      });

      if (details.task) {
        this.broadcastEvent('task_state_changed', {
          correlationId: details.task.correlationId,
          from: details.from,
          to: details.to || details.task.state,
          reason: details.reason,
          actor: details.actor || agentId,
          task: details.task
        });
      }
    }

    return event;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Workstream A: State Machine Validation & State Transitions
  // ──────────────────────────────────────────────────────────────────────────

  _transitionTask(task, newState, reason = '', actor = 'system') {
    if (TERMINAL_STATES.has(task.state)) {
      throw new TaskTerminalError(
        `Invalid state transition: Cannot transition task '${task.correlationId}' from terminal state '${task.state}' to '${newState}'`,
        { correlationId: task.correlationId, currentState: task.state, requestedState: newState }
      );
    }

    const allowed = ALLOWED_TRANSITIONS[task.state];
    if (!allowed || !allowed.has(newState)) {
      throw new TaskStateError(
        `Invalid state transition: Transition from '${task.state}' to '${newState}' is not permitted for task '${task.correlationId}'`,
        'ERR_INVALID_TRANSITION',
        { correlationId: task.correlationId, currentState: task.state, requestedState: newState }
      );
    }

    const previousState = task.state;
    task.state = newState;
    task.stateHistory = task.stateHistory || [];
    task.stateHistory.push({
      from: previousState,
      to: newState,
      timestamp: Date.now(),
      reason,
      actor
    });

    this._persist();

    logger.info('INTERCOM:STATE_TRANSITION', `Task ${task.correlationId} transitioned: ${previousState} -> ${newState} (${reason})`, {
      correlationId: task.correlationId,
      from: previousState,
      to: newState,
      actor
    });

    // Determine eventType and severity level
    let eventType = `TASK_${newState}`;
    let level = 'INFO';
    if (newState === DelegationState.FAILED || newState === DelegationState.TIMED_OUT) {
      level = 'ERROR';
    } else if (newState === DelegationState.CANCELLED || newState === DelegationState.REJECTED || newState === DelegationState.EXPIRED) {
      level = 'WARN';
    } else if (newState === DelegationState.APPROVED) {
      eventType = 'APPROVAL_GRANTED';
    } else if (newState === DelegationState.QUEUED_FOR_CLAIM) {
      eventType = 'TASK_QUEUED';
    } else if (newState === DelegationState.RUNNING) {
      eventType = 'EXECUTION_STARTED';
    }

    // Informative 1-line summary
    let summary = `Task ${task.correlationId} transitioned to ${newState}`;
    if (newState === DelegationState.APPROVED) summary = `Delegation ${task.correlationId} approved by ${actor}`;
    else if (newState === DelegationState.REJECTED) summary = `Delegation ${task.correlationId} rejected by ${actor}: ${reason}`;
    else if (newState === DelegationState.QUEUED_FOR_CLAIM) summary = `Task ${task.correlationId} queued in ${task.toAgent} inbox`;
    else if (newState === DelegationState.CLAIMED) summary = `Task ${task.correlationId} claimed by ${actor}`;
    else if (newState === DelegationState.RUNNING) summary = `Task ${task.correlationId} execution started by ${actor}`;
    else if (newState === DelegationState.COMPLETED) {
      const dur = task.completedAt ? (task.completedAt - (task.startedAt || task.createdAt)) : 0;
      summary = `Task ${task.correlationId} completed in ${dur}ms: ${task.result?.substring(0, 80) || 'Done'}`;
    }
    else if (newState === DelegationState.FAILED) summary = `Task ${task.correlationId} failed: ${reason || task.error}`;
    else if (newState === DelegationState.TIMED_OUT) summary = `Task ${task.correlationId} timed out in state ${previousState}: ${reason || task.error}`;
    else if (newState === DelegationState.CANCELLED) summary = `Task ${task.correlationId} cancelled: ${reason}`;
    else if (newState === DelegationState.EXPIRED) summary = `Task ${task.correlationId} expired: ${reason || task.error}`;

    this._emitEvent({
      eventType,
      level,
      correlationId: task.correlationId,
      agentId: actor,
      summary,
      details: { from: previousState, to: newState, reason, actor, task }
    });

    return task;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Agent Registration & Discovery
  // ──────────────────────────────────────────────────────────────────────────

  registerAgent({ agentId, sessionId, pid, cliVersion, cwd = null, capabilities = [] }) {
    if (!agentId || !sessionId) {
      throw new TaskSecurityError('agentId and sessionId are required for registration', 'ERR_SECURITY_VIOLATION');
    }

    const existingPeer = this.activePeers.get(agentId);
    const currentGen = this.agentGenerations.get(agentId) || 0;
    const now = Date.now();

    // Idempotent duplicate registration from the exact same active session
    if (existingPeer && existingPeer.sessionId === sessionId) {
      existingPeer.lastHeartbeat = now;
      if (cwd) existingPeer.cwd = path.resolve(cwd);
      if (pid) existingPeer.pid = pid;
      if (Array.isArray(capabilities) && capabilities.length > 0) {
        existingPeer.capabilities = capabilities;
      }
      // If peer was UNREACHABLE or OFFLINE, restore appropriate state
      if (existingPeer.status === AgentStatus.UNREACHABLE || existingPeer.status === AgentStatus.OFFLINE) {
        const hasRunningTask = Array.from(this.delegations.values()).some(
          t => t.toAgent === agentId && (t.state === DelegationState.CLAIMED || t.state === DelegationState.RUNNING)
        );
        existingPeer.status = hasRunningTask ? AgentStatus.BUSY : AgentStatus.ONLINE;
      }
      logger.info('INTERCOM:AGENT_RE_REGISTERED_SAME_SESSION', `Idempotent re-registration for agent '${agentId}' session '${sessionId}'`, {
        agentId,
        sessionId,
        generation: existingPeer.generation
      });
      if (this.broadcastEvent) {
        this.broadcastEvent('peer_status', this.getPeers());
      }
      return existingPeer;
    }

    // Stale session protection:
    // If an existing session is registered and actively ONLINE or BUSY with fresh heartbeats (< 15s),
    // and a DIFFERENT session attempts to register without an explicit disconnect, reject with conflict.
    if (existingPeer && (existingPeer.status === AgentStatus.ONLINE || existingPeer.status === AgentStatus.BUSY)) {
      if (now - existingPeer.lastHeartbeat < 15000) {
        logger.warn('INTERCOM:SESSION_CONFLICT', `Rejected stale registration attempt for agent '${agentId}'. Active session '${existingPeer.sessionId}' is healthy (last heartbeat ${now - existingPeer.lastHeartbeat}ms ago)`, {
          agentId,
          activeSessionId: existingPeer.sessionId,
          rejectedSessionId: sessionId
        });
        throw new TaskSecurityError(
          `Session conflict: Agent '${agentId}' already has an active session '${existingPeer.sessionId}' (generation ${existingPeer.generation}). Stale or concurrent registration rejected.`,
          'ERR_SESSION_CONFLICT',
          {
            agentId,
            activeSessionId: existingPeer.sessionId,
            activeGeneration: existingPeer.generation,
            attemptedSessionId: sessionId
          }
        );
      }
    }

    // New authoritative session accepted: increment monotonic generation counter
    const nextGen = currentGen + 1;
    this.agentGenerations.set(agentId, nextGen);

    const peer = {
      agentId,
      sessionId,
      generation: nextGen,
      pid: pid || null,
      cliVersion: cliVersion || 'unknown',
      cwd: cwd ? path.resolve(cwd) : this.cwd,
      capabilities: Array.isArray(capabilities) ? capabilities : [],
      status: AgentStatus.ONLINE,
      registeredAt: now,
      lastHeartbeat: now
    };

    this.activePeers.set(agentId, peer);

    logger.info('INTERCOM:AGENT_REGISTERED', `Agent '${agentId}' registered (session: ${sessionId}, gen: ${nextGen}, PID: ${pid}, CWD: ${peer.cwd})`, {
      agentId,
      sessionId,
      generation: nextGen,
      pid,
      cwd: peer.cwd,
      capabilities: peer.capabilities
    });

    this._emitEvent({
      eventType: 'SESSION_REGISTERED',
      level: 'INFO',
      agentId,
      summary: `Agent '${agentId}' connected (session ${sessionId}, gen ${nextGen}, PID: ${pid || '-'})`,
      details: { peer }
    });

    if (this.broadcastEvent) {
      this.broadcastEvent('peer_status', this.getPeers());
    }

    return peer;
  }

  recordHeartbeat({ agentId, sessionId, status }) {
    const peer = this.activePeers.get(agentId);
    if (!peer || peer.sessionId !== sessionId) {
      return false;
    }

    peer.lastHeartbeat = Date.now();

    // Check if the agent is actively executing a task
    const hasRunningTask = Array.from(this.delegations.values()).some(
      t => t.toAgent === agentId && (t.state === DelegationState.CLAIMED || t.state === DelegationState.RUNNING)
    );

    // If status was UNREACHABLE or OFFLINE, heartbeat recovers it to appropriate active state
    if (peer.status === AgentStatus.UNREACHABLE || peer.status === AgentStatus.OFFLINE) {
      peer.status = hasRunningTask ? AgentStatus.BUSY : AgentStatus.ONLINE;
      logger.info('INTERCOM:AGENT_RECOVERED', `Agent '${agentId}' recovered from connectivity degradation (status: ${peer.status})`, {
        agentId,
        sessionId,
        status: peer.status
      });

      this._emitEvent({
        eventType: 'SESSION_RECOVERED',
        level: 'INFO',
        agentId,
        summary: `Agent '${agentId}' connectivity restored (ONLINE)`,
        details: { peer }
      });

      if (this.broadcastEvent) {
        this.broadcastEvent('peer_status', this.getPeers());
      }
    } else if (status && Object.values(AgentStatus).includes(status)) {
      peer.status = hasRunningTask ? AgentStatus.BUSY : (status === AgentStatus.BUSY ? AgentStatus.BUSY : AgentStatus.ONLINE);
    }

    return true;
  }

  disconnectAgent({ agentId, sessionId }) {
    const peer = this.activePeers.get(agentId);
    if (!peer || peer.sessionId !== sessionId) {
      return false;
    }

    peer.status = AgentStatus.OFFLINE;

    logger.info('INTERCOM:AGENT_DISCONNECTED', `Agent '${agentId}' disconnected (session: ${sessionId})`, {
      agentId,
      sessionId
    });

    this._emitEvent({
      eventType: 'SESSION_DISCONNECTED',
      level: 'WARN',
      agentId,
      summary: `Agent '${agentId}' disconnected (session: ${sessionId})`,
      details: { agentId, sessionId }
    });

    // Abort any pending tasks currently running on this agent that was confirmed disconnected
    for (const [corrId, task] of this.delegations.entries()) {
      if (task.toAgent === agentId && (task.state === DelegationState.CLAIMED || task.state === DelegationState.RUNNING)) {
        this.failTask({
          agentId,
          sessionId,
          correlationId: corrId,
          error: `Agent '${agentId}' disconnected during execution`
        });
      }
    }

    if (this.broadcastEvent) {
      this.broadcastEvent('peer_status', this.getPeers());
    }

    return true;
  }

  getPeers() {
    const list = [];
    for (const peer of this.activePeers.values()) {
      list.push({
        agentId: peer.agentId,
        sessionId: peer.sessionId,
        generation: peer.generation,
        status: peer.status,
        cwd: peer.cwd,
        capabilities: peer.capabilities,
        lastHeartbeat: peer.lastHeartbeat,
        registeredAt: peer.registeredAt
      });
    }
    return list;
  }

  _checkHeartbeats() {
    const now = Date.now();
    let changed = false;

    for (const peer of this.activePeers.values()) {
      if (peer.status === AgentStatus.OFFLINE) continue;

      const elapsed = now - peer.lastHeartbeat;

      if (elapsed >= 30000 && peer.status !== AgentStatus.OFFLINE) {
        const prev = peer.status;
        peer.status = AgentStatus.OFFLINE;
        changed = true;
        logger.error('INTERCOM:AGENT_HEARTBEAT_TIMEOUT', `Agent '${peer.agentId}' missed heartbeats for ${elapsed}ms; transitioned from ${prev} to OFFLINE`, {
          agentId: peer.agentId,
          sessionId: peer.sessionId,
          elapsed
        });

        this._emitEvent({
          eventType: 'SESSION_DISCONNECTED',
          level: 'WARN',
          agentId: peer.agentId,
          summary: `Agent '${peer.agentId}' disconnected (heartbeat timeout after ${elapsed}ms)`,
          details: { peer, elapsed }
        });
      } else if (elapsed >= 15000 && elapsed < 30000 && peer.status !== AgentStatus.UNREACHABLE) {
        const prev = peer.status;
        peer.status = AgentStatus.UNREACHABLE;
        changed = true;
        logger.warn('INTERCOM:AGENT_UNREACHABLE', `Agent '${peer.agentId}' missed heartbeats for ${elapsed}ms; transitioned from ${prev} to UNREACHABLE (grace period active)`, {
          agentId: peer.agentId,
          sessionId: peer.sessionId,
          elapsed
        });

        this._emitEvent({
          eventType: 'SESSION_DEGRADED',
          level: 'WARN',
          agentId: peer.agentId,
          summary: `Agent '${peer.agentId}' connectivity degraded (UNREACHABLE, missed heartbeats for ${elapsed}ms)`,
          details: { peer, elapsed }
        });
      }
    }

    if (changed && this.broadcastEvent) {
      this.broadcastEvent('peer_status', this.getPeers());
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Delegation Lifecycle, Human Approvals & Cancellation
  // ──────────────────────────────────────────────────────────────────────────

  createDelegation({
    fromAgent,
    toAgent,
    plan,
    instructions,
    expectedFiles = [],
    cwd = null,
    correlationId = null,
    requiresApproval = true,
    approvalTimeoutMs = null,
    claimTimeoutMs = null,
    executionTimeoutMs = null
  }) {
    if (!fromAgent || !toAgent || !instructions) {
      throw new TaskStateError('fromAgent, toAgent, and instructions are required', 'ERR_INVALID_PARAMETERS');
    }

    const corrId = correlationId || `CORR_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    if (this.delegations.has(corrId)) {
      throw new TaskDuplicateError(`Duplicate task rejected: Task with correlation ID '${corrId}' already exists`, { correlationId: corrId });
    }

    // Authorize task working directory against configured workspace roots
    const taskCwd = this.workspaceAuth.authorizeCwd(cwd || this.cwd, this.cwd);

    const fromPeer = this.activePeers.get(fromAgent);

    const initialState = requiresApproval
      ? DelegationState.APPROVAL_REQUESTED
      : DelegationState.QUEUED_FOR_CLAIM;

    const now = Date.now();
    const task = {
      correlationId: corrId,
      fromAgent,
      fromSessionId: fromPeer?.sessionId || null,
      toAgent,
      toSessionId: null,
      plan: plan || instructions,
      instructions,
      originalInstructions: instructions,
      cwd: taskCwd,
      expectedFiles: Array.isArray(expectedFiles) ? expectedFiles : [],
      potentialImpact: `Modifies workspace files in ${taskCwd}`,
      state: initialState,
      createdAt: now,
      approvalRequestedAt: requiresApproval ? now : null,
      approvalDeadline: requiresApproval ? (now + (approvalTimeoutMs || this.timeouts.approvalTimeoutMs)) : null,
      approvedAt: requiresApproval ? null : now,
      approvedBy: requiresApproval ? null : 'auto',
      claimDeadline: requiresApproval ? null : (now + (claimTimeoutMs || this.timeouts.claimTimeoutMs)),
      rejectedAt: null,
      rejectedBy: null,
      rejectionReason: null,
      claimTime: null,
      executionDeadline: null,
      claimedBySession: null,
      startedAt: null,
      completedAt: null,
      cancellationRequested: false,
      cancellationRequestedAt: null,
      cancellationReason: null,
      cancellationConfirmed: false,
      lateCompletion: null,
      result: null,
      error: null,
      modifiedFiles: [],
      testResults: null,
      approvalTimeoutMs: approvalTimeoutMs || this.timeouts.approvalTimeoutMs,
      claimTimeoutMs: claimTimeoutMs || this.timeouts.claimTimeoutMs,
      executionTimeoutMs: executionTimeoutMs || this.timeouts.executionTimeoutMs,
      stateHistory: [
        {
          from: null,
          to: initialState,
          timestamp: now,
          reason: requiresApproval ? 'Task delegation submitted; awaiting human approval' : 'Task directly queued',
          actor: fromAgent
        }
      ]
    };

    this.delegations.set(corrId, task);
    this._persist();

    logger.info('INTERCOM:DELEGATION_CREATED', `Delegation ${corrId} created (${initialState}) from ${fromAgent} to ${toAgent} in ${taskCwd}`, {
      correlationId: corrId,
      fromAgent,
      toAgent,
      cwd: taskCwd,
      state: initialState,
      expectedFiles: task.expectedFiles
    });

    const eventType = requiresApproval ? 'APPROVAL_REQUESTED' : 'TASK_CREATED';
    const summary = requiresApproval
      ? `Human approval requested for delegation ${corrId} from ${fromAgent} to ${toAgent}`
      : `Task ${corrId} created by ${fromAgent} for ${toAgent}`;

    this._emitEvent({
      eventType,
      level: 'INFO',
      correlationId: corrId,
      agentId: fromAgent,
      summary,
      details: { task }
    });

    if (this.broadcastEvent) {
      this.broadcastEvent('intercom_event', {
        eventType,
        task
      });
      if (requiresApproval) {
        this.broadcastEvent('approval_requested', {
          correlationId: corrId,
          task
        });
      }
    }

    return task;
  }

  approveDelegation({ correlationId, editedInstructions = null, approver = 'human-ui' }) {
    const task = this.delegations.get(correlationId);
    if (!task) {
      throw new TaskStateError(`Delegation task '${correlationId}' not found`, 'ERR_TASK_NOT_FOUND', { correlationId });
    }

    if (task.state !== DelegationState.APPROVAL_REQUESTED) {
      throw new TaskStateError(
        `Invalid state: Cannot approve task '${correlationId}' in state '${task.state}'`,
        'ERR_INVALID_TRANSITION',
        { correlationId, state: task.state }
      );
    }

    if (editedInstructions && typeof editedInstructions === 'string' && editedInstructions.trim() !== '') {
      task.originalInstructions = task.instructions;
      task.instructions = editedInstructions.trim();
      logger.info('INTERCOM:INSTRUCTIONS_EDITED', `Task ${correlationId} instructions edited before approval`, {
        correlationId,
        original: task.originalInstructions,
        updated: task.instructions
      });
    }

    task.approvedAt = Date.now();
    task.approvedBy = approver;
    task.claimDeadline = task.approvedAt + (task.claimTimeoutMs || this.timeouts.claimTimeoutMs);

    // Transition from APPROVAL_REQUESTED -> APPROVED -> QUEUED_FOR_CLAIM
    this._transitionTask(task, DelegationState.APPROVED, 'Approved by human user', approver);
    this._transitionTask(task, DelegationState.QUEUED_FOR_CLAIM, 'Task queued in target agent inbox', 'coordinator');

    if (this.broadcastEvent) {
      this.broadcastEvent('approval_decision', {
        correlationId,
        decision: 'APPROVED',
        approver,
        task
      });
    }

    return task;
  }

  rejectDelegation({ correlationId, reason = 'Rejected by human reviewer', rejecter = 'human-ui' }) {
    const task = this.delegations.get(correlationId);
    if (!task) {
      throw new TaskStateError(`Delegation task '${correlationId}' not found`, 'ERR_TASK_NOT_FOUND', { correlationId });
    }

    if (task.state !== DelegationState.APPROVAL_REQUESTED) {
      throw new TaskStateError(
        `Invalid state: Cannot reject task '${correlationId}' in state '${task.state}'`,
        'ERR_INVALID_TRANSITION',
        { correlationId, state: task.state }
      );
    }

    task.rejectedAt = Date.now();
    task.rejectedBy = rejecter;
    task.rejectionReason = reason;
    task.error = `Delegation rejected by user: ${reason}`;

    this._transitionTask(task, DelegationState.REJECTED, reason, rejecter);

    // Resolve Claude's pending delegation promise with clean rejection
    this._resolveWaiters(correlationId, {
      success: false,
      rejected: true,
      correlationId,
      error: task.error,
      rejectionReason: reason
    });

    if (this.broadcastEvent) {
      this.broadcastEvent('approval_decision', {
        correlationId,
        decision: 'REJECTED',
        rejecter,
        reason,
        task
      });
    }

    return task;
  }

  cancelDelegation(arg, reasonArg = 'Cancelled by user', actorArg = 'human-ui') {
    const correlationId = (typeof arg === 'object' && arg !== null) ? arg.correlationId : arg;
    const reason = (typeof arg === 'object' && arg !== null) ? (arg.reason || 'Cancelled by user') : reasonArg;
    const actor = (typeof arg === 'object' && arg !== null) ? (arg.actor || 'human-ui') : actorArg;

    const task = this.delegations.get(correlationId);
    if (!task) {
      throw new TaskStateError(`Delegation task '${correlationId}' not found`, 'ERR_TASK_NOT_FOUND', { correlationId });
    }

    if (TERMINAL_STATES.has(task.state)) {
      throw new TaskTerminalError(
        `Cannot cancel task '${correlationId}' already in terminal state '${task.state}'`,
        { correlationId, state: task.state }
      );
    }

    // Active tasks: Flag cancellation requested; do NOT lie that operation has stopped
    if (task.state === DelegationState.CLAIMED || task.state === DelegationState.RUNNING) {
      task.cancellationRequested = true;
      task.cancellationRequestedAt = Date.now();
      task.cancellationReason = reason;

      task.stateHistory = task.stateHistory || [];
      task.stateHistory.push({
        from: task.state,
        to: task.state,
        timestamp: Date.now(),
        reason: `Cancellation requested: ${reason}`,
        actor
      });

      this._persist();

      logger.warn('INTERCOM:CANCELLATION_REQUESTED', `Cancellation requested for active task ${correlationId}`, {
        correlationId,
        state: task.state
      });

      this._emitEvent({
        eventType: 'CANCELLATION_REQUESTED',
        level: 'WARN',
        correlationId,
        agentId: actor,
        summary: `Cancellation requested for active task ${correlationId}: ${reason}`,
        details: { task, reason, actor }
      });

      if (this.broadcastEvent) {
        this.broadcastEvent('task_cancellation_requested', { correlationId, reason, actor, task });
      }
      return { status: 'cancellation_requested', task };
    }

    // Unclaimed or unapproved tasks: Transition cleanly to CANCELLED
    task.completedAt = Date.now();
    task.error = reason;

    this._transitionTask(task, DelegationState.CANCELLED, reason, actor);

    const pending = this.pendingResolutions.get(correlationId);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingResolutions.delete(correlationId);
      pending.resolve({
        success: false,
        cancelled: true,
        correlationId,
        error: `Delegation cancelled: ${reason}`
      });
    }

    return { status: 'cancelled', task };
  }

  confirmCancellation({ agentId, sessionId, correlationId, reason = 'Worker confirmed cancellation' }) {
    const peer = this.activePeers.get(agentId);
    if (!peer || (sessionId && peer.sessionId !== sessionId)) {
      throw new TaskSecurityError(`Security violation: Stale or unauthenticated session ID for agent '${agentId}'`, 'ERR_SECURITY_VIOLATION');
    }

    const task = this.delegations.get(correlationId);
    if (!task) {
      throw new TaskStateError(`Delegation task '${correlationId}' not found`, 'ERR_TASK_NOT_FOUND', { correlationId });
    }

    if (task.toAgent !== agentId) {
      throw new TaskSecurityError(`Security violation: Task '${correlationId}' is assigned to '${task.toAgent}', not '${agentId}'`, 'ERR_SECURITY_VIOLATION');
    }

    if (task.toSessionId && sessionId && task.toSessionId !== sessionId) {
      throw new TaskSecurityError(`Security violation: Task '${correlationId}' was claimed by session '${task.toSessionId}', not '${sessionId}'`, 'ERR_SECURITY_VIOLATION');
    }

    if (TERMINAL_STATES.has(task.state)) {
      return { status: 'already_terminal', task };
    }

    task.completedAt = Date.now();
    task.cancellationConfirmed = true;
    task.error = reason;

    const hasOtherActiveTasks = Array.from(this.delegations.values()).some(
      t => t.correlationId !== correlationId && t.toAgent === agentId && (t.state === DelegationState.CLAIMED || t.state === DelegationState.RUNNING)
    );
    peer.status = hasOtherActiveTasks ? AgentStatus.BUSY : AgentStatus.ONLINE;

    this._transitionTask(task, DelegationState.CANCELLED, reason, agentId);

    this._resolveWaiters(correlationId, {
      success: false,
      cancelled: true,
      correlationId,
      error: `Worker confirmed cancellation: ${reason}`
    });

    return { status: 'cancelled', task };
  }

  claimTask({ agentId, sessionId, correlationId, cwd = null }) {
    const peer = this.activePeers.get(agentId);
    if (!peer || (sessionId && peer.sessionId !== sessionId)) {
      throw new TaskSecurityError(`Security violation: Stale or unauthenticated session ID for agent '${agentId}'`, 'ERR_SECURITY_VIOLATION');
    }

    if (peer.status === AgentStatus.OFFLINE || peer.status === AgentStatus.UNREACHABLE) {
      throw new TaskSecurityError(
        `Security violation: Agent '${agentId}' cannot claim task while session is in '${peer.status}' state`,
        'ERR_SECURITY_VIOLATION',
        { agentId, sessionId, status: peer.status }
      );
    }

    const task = this.delegations.get(correlationId);
    if (!task) {
      throw new TaskStateError(`Delegation task '${correlationId}' not found`, 'ERR_TASK_NOT_FOUND', { correlationId });
    }

    if (task.toAgent !== agentId) {
      throw new TaskSecurityError(`Security violation: Task '${correlationId}' is assigned to '${task.toAgent}', not '${agentId}'`, 'ERR_SECURITY_VIOLATION');
    }

    // Working-directory isolation check: Must match task requirement
    const agentCwd = cwd ? path.resolve(cwd) : peer.cwd;
    if (task.cwd && path.resolve(task.cwd).toLowerCase() !== path.resolve(agentCwd).toLowerCase()) {
      throw new TaskSecurityError(
        `Working directory mismatch: Task requires '${task.cwd}', but agent session '${agentId}' is in '${agentCwd}'`,
        'ERR_SECURITY_VIOLATION'
      );
    }

    // Revalidate task and agent CWD against authorized roots policy at claim time
    const authorizedTaskCwd = this.workspaceAuth.authorizeCwd(task.cwd, this.cwd);
    const authorizedAgentCwd = this.workspaceAuth.authorizeCwd(agentCwd, this.cwd);

    if (task.state !== DelegationState.QUEUED_FOR_CLAIM && task.state !== 'QUEUED') {
      throw new TaskStateError(
        `Duplicate claim rejected: Task '${correlationId}' is in state '${task.state}', must be 'QUEUED_FOR_CLAIM'`,
        'ERR_DUPLICATE_CLAIM',
        { correlationId, state: task.state }
      );
    }

    task.claimTime = Date.now();
    task.startedAt = Date.now();
    task.executionDeadline = task.startedAt + (task.executionTimeoutMs || this.timeouts.executionTimeoutMs);
    task.claimedBySession = peer.sessionId;
    task.toSessionId = peer.sessionId;

    peer.status = AgentStatus.BUSY;

    this._transitionTask(task, DelegationState.CLAIMED, `Claimed by ${agentId} session ${peer.sessionId}`, agentId);
    this._transitionTask(task, DelegationState.RUNNING, 'Execution started', agentId);

    if (this.broadcastEvent) {
      this.broadcastEvent('peer_status', this.getPeers());
    }

    return task;
  }

  completeTask({ agentId, sessionId, correlationId, summary, modifiedFiles = [], testResults = null }) {
    const peer = this.activePeers.get(agentId);
    if (!peer || (sessionId && peer.sessionId !== sessionId)) {
      throw new TaskSecurityError(`Security violation: Stale or unauthenticated session ID for agent '${agentId}'`, 'ERR_SECURITY_VIOLATION');
    }

    const task = this.delegations.get(correlationId);
    if (!task) {
      throw new TaskStateError(`Delegation task '${correlationId}' not found`, 'ERR_TASK_NOT_FOUND', { correlationId });
    }

    if (task.toAgent !== agentId) {
      throw new TaskSecurityError(`Security violation: Task '${correlationId}' was not claimed by '${agentId}'`, 'ERR_SECURITY_VIOLATION');
    }

    // Workstream E: Late completion after timeout
    if (task.state === DelegationState.TIMED_OUT) {
      task.lateCompletion = {
        summary: summary || 'Completed without summary',
        modifiedFiles: Array.isArray(modifiedFiles) ? modifiedFiles : [],
        testResults: testResults || null,
        agentId,
        sessionId,
        receivedAt: Date.now()
      };
      this._persist();

      logger.warn('INTERCOM:LATE_COMPLETION_AFTER_TIMEOUT', `Worker '${agentId}' reported completion after task '${correlationId}' timed out; archived in lateCompletion`, {
        correlationId,
        summary: task.lateCompletion.summary
      });

      this._emitEvent({
        eventType: 'TASK_LATE_COMPLETED',
        level: 'WARN',
        correlationId,
        agentId,
        summary: `Late completion recorded after timeout for task ${correlationId}`,
        details: { lateCompletion: task.lateCompletion, task }
      });

      return {
        success: false,
        timedOut: true,
        lateRecorded: true,
        summary: task.lateCompletion.summary,
        correlationId
      };
    }

    if (TERMINAL_STATES.has(task.state)) {
      throw new TaskTerminalError(`Invalid operation: Cannot complete task '${correlationId}' already in terminal state '${task.state}'`);
    }

    if (task.state !== DelegationState.CLAIMED && task.state !== DelegationState.RUNNING) {
      throw new TaskStateError(`Invalid state transition: Cannot complete task in state '${task.state}'`, 'ERR_INVALID_TRANSITION');
    }

    // Guard: If cancellation was requested, never silently overwrite with COMPLETED
    if (task.cancellationRequested) {
      task.completedAt = Date.now();
      task.lateCompletion = {
        summary: summary || 'Completed without summary',
        modifiedFiles: Array.isArray(modifiedFiles) ? modifiedFiles : [],
        testResults: testResults || null,
        agentId,
        sessionId,
        receivedAt: Date.now()
      };
      task.error = `Task was cancelled; late completion result was recorded for audit`;

      const hasOtherActiveTasks = Array.from(this.delegations.values()).some(
        t => t.correlationId !== correlationId && t.toAgent === agentId && (t.state === DelegationState.CLAIMED || t.state === DelegationState.RUNNING)
      );
      peer.status = hasOtherActiveTasks ? AgentStatus.BUSY : AgentStatus.ONLINE;

      this._transitionTask(
        task,
        DelegationState.CANCELLED,
        'Late completion arrived after cancellation was requested; task marked CANCELLED with work preserved',
        agentId
      );

      this._resolveWaiters(correlationId, {
        success: false,
        cancelled: true,
        correlationId,
        error: task.error,
        lateCompletion: task.lateCompletion
      });

      return task;
    }

    task.completedAt = Date.now();
    task.result = summary || 'Completed successfully without summary';
    task.modifiedFiles = Array.isArray(modifiedFiles) ? modifiedFiles : [];
    task.testResults = testResults || null;

    const hasOtherActiveTasks = Array.from(this.delegations.values()).some(
      t => t.correlationId !== correlationId && t.toAgent === agentId && (t.state === DelegationState.CLAIMED || t.state === DelegationState.RUNNING)
    );
    peer.status = hasOtherActiveTasks ? AgentStatus.BUSY : AgentStatus.ONLINE;

    this._transitionTask(task, DelegationState.COMPLETED, 'Implementation completed by worker', agentId);

    if (this.broadcastEvent) {
      this.broadcastEvent('peer_status', this.getPeers());
    }

    this._resolveWaiters(correlationId, {
      success: true,
      correlationId,
      agent: agentId,
      summary: task.result,
      modifiedFiles: task.modifiedFiles,
      testResults: task.testResults,
      durationMs: task.completedAt - (task.startedAt || task.createdAt)
    });

    return task;
  }

  failTask({ agentId, sessionId, correlationId, error }) {
    const peer = this.activePeers.get(agentId);
    if (!peer || (sessionId && peer.sessionId !== sessionId)) {
      throw new TaskSecurityError(`Security violation: Stale or unauthenticated session ID for agent '${agentId}'`, 'ERR_SECURITY_VIOLATION');
    }

    const task = this.delegations.get(correlationId);
    if (!task) return false;

    if (task.toAgent !== agentId) {
      throw new TaskSecurityError(`Security violation: Task '${correlationId}' is not assigned to '${agentId}'`, 'ERR_SECURITY_VIOLATION');
    }

    if (task.toSessionId && sessionId && task.toSessionId !== sessionId) {
      throw new TaskSecurityError(`Security violation: Task '${correlationId}' was claimed by session '${task.toSessionId}', not '${sessionId}'`, 'ERR_SECURITY_VIOLATION');
    }

    // Pre-check: If task is already in terminal state, ignore failure report and do not mutate properties
    if (TERMINAL_STATES.has(task.state)) {
      return false;
    }

    task.completedAt = Date.now();
    task.error = error || 'Task failed without specific error';

    if (peer) {
      const hasOtherActiveTasks = Array.from(this.delegations.values()).some(
        t => t.correlationId !== correlationId && t.toAgent === agentId && (t.state === DelegationState.CLAIMED || t.state === DelegationState.RUNNING)
      );
      peer.status = hasOtherActiveTasks ? AgentStatus.BUSY : AgentStatus.ONLINE;
    }

    this._transitionTask(task, DelegationState.FAILED, task.error, agentId);

    if (this.broadcastEvent) {
      this.broadcastEvent('peer_status', this.getPeers());
    }

    this._resolveWaiters(correlationId, {
      error: task.error
    });

    return true;
  }

  reportProgress({ agentId, sessionId, correlationId, step, message = '', details = {} }) {
    const peer = this.activePeers.get(agentId);
    if (!peer || (sessionId && peer.sessionId !== sessionId)) {
      throw new TaskSecurityError(`Security violation: Stale or unauthenticated session ID for agent '${agentId}'`, 'ERR_SECURITY_VIOLATION');
    }

    const task = this.delegations.get(correlationId);
    if (!task) {
      throw new TaskStateError(`Delegation task '${correlationId}' not found`, 'ERR_TASK_NOT_FOUND', { correlationId });
    }

    if (task.toAgent !== agentId) {
      throw new TaskSecurityError(`Security violation: Task '${correlationId}' is not assigned to '${agentId}'`, 'ERR_SECURITY_VIOLATION');
    }

    if (task.state !== DelegationState.CLAIMED && task.state !== DelegationState.RUNNING) {
      throw new TaskStateError(`Invalid state: Cannot report progress on task in state '${task.state}'`, 'ERR_INVALID_TRANSITION');
    }

    // Rate-limiting / Coalescing: Minimum 400ms between progress events per correlationId
    const now = Date.now();
    this.lastProgressTimes = this.lastProgressTimes || new Map();
    const lastTime = this.lastProgressTimes.get(correlationId) || 0;
    if (now - lastTime < 400) {
      return { throttled: true, correlationId };
    }
    this.lastProgressTimes.set(correlationId, now);

    // Record in task progress history without mutating lifecycle state
    task.progressHistory = task.progressHistory || [];
    const progressEntry = {
      timestamp: now,
      step: String(step || 'Working...').trim(),
      message: String(message || '').trim(),
      agentId,
      sessionId
    };
    task.progressHistory.push(progressEntry);

    const summary = `Task ${correlationId} progress: ${progressEntry.step}${progressEntry.message ? ` (${progressEntry.message})` : ''}`;

    this._emitEvent({
      eventType: 'TASK_PROGRESS',
      level: 'INFO',
      correlationId,
      agentId,
      summary,
      details: { step: progressEntry.step, message: progressEntry.message, task }
    });

    return { success: true, correlationId, progress: progressEntry };
  }

  _checkLifecycleTimeouts() {
    const now = Date.now();

    for (const task of this.delegations.values()) {
      if (TERMINAL_STATES.has(task.state)) continue;

      // 1. Approval timeout
      if (task.state === DelegationState.APPROVAL_REQUESTED) {
        const budget = task.approvalTimeoutMs || this.timeouts.approvalTimeoutMs;
        const elapsed = now - (task.approvalRequestedAt || task.createdAt);
        if (elapsed > budget) {
          task.completedAt = now;
          task.timeoutInfo = {
            code: 'ERR_APPROVAL_TIMEOUT',
            timeoutPhase: 'APPROVAL',
            budget,
            elapsed,
            timestamp: now,
            taskState: task.state
          };
          task.error = `ERR_APPROVAL_TIMEOUT: Delegation approval timed out after ${budget}ms awaiting human review (elapsed: ${elapsed}ms)`;
          this._transitionTask(task, DelegationState.TIMED_OUT, task.error, 'coordinator_timeout');
          this._resolveWaiters(task.correlationId, { error: task.error, timeoutInfo: task.timeoutInfo });
        }
      }
      // 2. Claim timeout
      else if (task.state === DelegationState.QUEUED_FOR_CLAIM || task.state === 'QUEUED') {
        const budget = task.claimTimeoutMs || this.timeouts.claimTimeoutMs;
        const elapsed = now - (task.approvedAt || task.createdAt);
        if (elapsed > budget) {
          task.completedAt = now;
          task.timeoutInfo = {
            code: 'ERR_CLAIM_TIMEOUT',
            timeoutPhase: 'CLAIM',
            budget,
            elapsed,
            timestamp: now,
            taskState: task.state
          };
          task.error = `ERR_CLAIM_TIMEOUT: Task claim timed out after ${budget}ms awaiting worker claim (elapsed: ${elapsed}ms)`;
          this._transitionTask(task, DelegationState.TIMED_OUT, task.error, 'coordinator_timeout');
          this._resolveWaiters(task.correlationId, { error: task.error, timeoutInfo: task.timeoutInfo });
        }
      }
      // 3. Execution timeout
      else if (task.state === DelegationState.CLAIMED || task.state === DelegationState.RUNNING) {
        const budget = task.executionTimeoutMs || this.timeouts.executionTimeoutMs;
        const elapsed = now - (task.startedAt || task.claimTime || task.createdAt);
        if (elapsed > budget) {
          task.completedAt = now;
          task.timeoutInfo = {
            code: 'ERR_EXECUTION_TIMEOUT',
            timeoutPhase: 'EXECUTION',
            budget,
            elapsed,
            timestamp: now,
            taskState: task.state
          };
          task.error = `ERR_EXECUTION_TIMEOUT: Task execution timed out after ${budget}ms during worker execution (elapsed: ${elapsed}ms)`;

          // ConPTY process preservation & peer status check
          const peer = this.activePeers.get(task.toAgent);
          if (peer) {
            const hasOtherActiveTasks = Array.from(this.delegations.values()).some(
              t => t.correlationId !== task.correlationId && t.toAgent === task.toAgent && (t.state === DelegationState.CLAIMED || t.state === DelegationState.RUNNING)
            );
            peer.status = hasOtherActiveTasks ? AgentStatus.BUSY : AgentStatus.ONLINE;
          }

          this._transitionTask(task, DelegationState.TIMED_OUT, task.error, 'coordinator_timeout');
          this._resolveWaiters(task.correlationId, { error: task.error, timeoutInfo: task.timeoutInfo });
        }
      }
    }
  }

  waitForCompletion(correlationId, pollTimeoutMs = null, onRegisterWaiter = null) {
    const task = this.delegations.get(correlationId);
    if (!task) {
      return Promise.reject(new TaskStateError(`Delegation task '${correlationId}' not found`, 'ERR_TASK_NOT_FOUND', { correlationId }));
    }

    if (task.state === DelegationState.COMPLETED) {
      return Promise.resolve({
        success: true,
        correlationId,
        agent: task.toAgent,
        summary: task.result,
        modifiedFiles: task.modifiedFiles,
        testResults: task.testResults,
        durationMs: (task.completedAt || Date.now()) - (task.startedAt || task.createdAt)
      });
    }

    if (task.state === DelegationState.REJECTED) {
      return Promise.resolve({
        success: false,
        rejected: true,
        correlationId,
        error: task.error,
        rejectionReason: task.rejectionReason
      });
    }

    if (TERMINAL_STATES.has(task.state)) {
      return Promise.reject(new Error(task.error || `Task ended in state ${task.state}`));
    }

    return new Promise((resolve, reject) => {
      let waiterRecord;
      let pollTimer = null;

      if (pollTimeoutMs && pollTimeoutMs > 0) {
        pollTimer = setTimeout(() => {
          this._removeWaiter(correlationId, waiterRecord);
          // Return valid contract for HTTP long-poll timeout
          resolve({
            status: 'still_running',
            correlationId,
            state: task.state
          });
        }, pollTimeoutMs);
      }

      waiterRecord = { resolve, reject, timer: pollTimer };

      if (!this.pendingResolutions.has(correlationId)) {
        this.pendingResolutions.set(correlationId, new Set());
      }
      this.pendingResolutions.get(correlationId).add(waiterRecord);

      if (typeof onRegisterWaiter === 'function') {
        onRegisterWaiter(waiterRecord);
      }
    });
  }

  _removeWaiter(correlationId, waiterRecord) {
    const set = this.pendingResolutions.get(correlationId);
    if (set && set instanceof Set) {
      if (waiterRecord && waiterRecord.timer) clearTimeout(waiterRecord.timer);
      set.delete(waiterRecord);
      if (set.size === 0) {
        this.pendingResolutions.delete(correlationId);
      }
    }
  }

  _resolveWaiters(correlationId, result) {
    const waiters = this.pendingResolutions.get(correlationId);
    if (!waiters) return;

    this.pendingResolutions.delete(correlationId);

    if (waiters instanceof Set) {
      for (const waiter of waiters) {
        if (waiter.timer) clearTimeout(waiter.timer);
        if (result.error && !result.rejected && !result.cancelled) {
          waiter.reject(new Error(result.error));
        } else {
          waiter.resolve(result);
        }
      }
    } else if (typeof waiters === 'object') {
      if (waiters.timer) clearTimeout(waiters.timer);
      if (result.error && !result.rejected && !result.cancelled) {
        waiters.reject(new Error(result.error));
      } else {
        waiters.resolve(result);
      }
    }
  }

  _handleTimeout(correlationId) {
    // Deprecated static handler; timeouts are now authoritatively driven by _checkLifecycleTimeouts()
    const task = this.delegations.get(correlationId);
    if (!task || TERMINAL_STATES.has(task.state)) return;
    this._checkLifecycleTimeouts();
  }

  getPendingApprovals() {
    const list = [];
    for (const task of this.delegations.values()) {
      if (task.state === DelegationState.APPROVAL_REQUESTED) {
        list.push(task);
      }
    }
    return list;
  }

  getInbox(agentId, cwd = null) {
    const claimable = [];
    const targetCwd = cwd ? path.resolve(cwd).toLowerCase() : null;

    for (const task of this.delegations.values()) {
      if (task.toAgent === agentId && (task.state === DelegationState.QUEUED_FOR_CLAIM || task.state === 'QUEUED')) {
        if (!targetCwd || path.resolve(task.cwd).toLowerCase() === targetCwd) {
          claimable.push(task);
        }
      }
    }
    return claimable;
  }

  getDelegation(correlationId) {
    return this.delegations.get(correlationId) || null;
  }

  getAllDelegations() {
    return Array.from(this.delegations.values());
  }

  async shutdown() {
    clearInterval(this.heartbeatTimer);
    for (const [corrId, waiters] of this.pendingResolutions.entries()) {
      if (waiters instanceof Set) {
        for (const pending of waiters) {
          if (pending.timer) clearTimeout(pending.timer);
          pending.reject(new Error('Intercom coordinator shutting down'));
        }
      } else if (waiters && waiters.timer) {
        clearTimeout(waiters.timer);
        waiters.reject(new Error('Intercom coordinator shutting down'));
      }
    }
    this.pendingResolutions.clear();
    this.activePeers.clear();

    // Flush any pending write in the persistence queue before exiting
    if (this.isPersisting || this.persistWaiters.length > 0) {
      try {
        await this._persist();
      } catch (e) {}
    }
  }
}
