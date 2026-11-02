// D:\Ashish_P\AI-Tools\custom-OCT\core\gemini_acp_client.js
// Hardened Gemini CLI ACP Client

import { ProcessManager } from './process_manager.js';
import { TaskState } from './task.js';

const GEMINI_BUNDLE_PATH = 'C:\\Users\\ajeevanesan\\AppData\\Local\\nvm\\v22.23.1\\node_modules\\@google\\gemini-cli\\bundle\\gemini.js';

export class GeminiAcpClient {
  constructor({ cwd, bundlePath = GEMINI_BUNDLE_PATH, debug = false }) {
    this.cwd = cwd;
    this.bundlePath = bundlePath;
    this.debug = debug;

    this.managed = null;
    this.sessionId = null;
    this.sessionsByCwd = new Map(); // cwd -> sessionId
    this.reqIdCounter = 1;
    this.pendingRequests = new Map(); // id -> { resolve, reject, method, timeoutId }
    this.activeTask = null; // Currently executing Task
    this.isClosing = false;
    this.exitCode = null;
    this.exitSignal = null;
    this.protocolInfo = null;
  }

  async start() {
    if (this.managed) {
      return;
    }

    return new Promise((resolve, reject) => {
      let isStarted = false;

      this.managed = ProcessManager.spawnManaged({
        command: process.execPath,
        args: [this.bundlePath, '--acp'],
        cwd: this.cwd,
        env: process.env,
        onStdoutLine: (line) => this._handleStdoutLine(line),
        onStderrLine: (line) => this._handleStderrLine(line),
        onClose: (code, signal) => this._handleClose(code, signal),
        onError: (err) => {
          if (!isStarted) reject(err);
          this._handleError(err);
        }
      });

      isStarted = true;
      resolve();
    });
  }

  _handleStdoutLine(line) {
    if (!line.trim()) return;

    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (e) {
      // Malformed or non-JSON line from agent stdio
      if (this.debug) {
        console.warn(`[GeminiAcp WARN] Malformed stdout line: ${line}`);
      }
      return;
    }

    // 1. Correlated RPC Response
    if (parsed.id !== undefined && this.pendingRequests.has(parsed.id)) {
      const { resolve, reject, method, timeoutId } = this.pendingRequests.get(parsed.id);
      this.pendingRequests.delete(parsed.id);
      if (timeoutId) clearTimeout(timeoutId);

      if (parsed.error) {
        const rpcErr = new Error(parsed.error.message || `RPC Error for ${method}`);
        rpcErr.code = parsed.error.code;
        rpcErr.data = parsed.error.data;
        reject(rpcErr);
      } else {
        resolve(parsed.result);
      }
      return;
    }

    // 2. ACP Notification
    if (parsed.method === 'session/update') {
      const update = parsed.params?.update;
      const updateType = update?.sessionUpdate;

      // Adaptive Inactivity Watchdog: Refresh timeout on any active stream event (thoughts, chunks, usage)
      for (const [id, req] of this.pendingRequests.entries()) {
        if (req.method === 'session/prompt' && req.resetTimeout) {
          req.resetTimeout(60000); // 60s inactivity threshold between stream chunks for thinking models
        }
      }

      if (updateType === 'agent_message_chunk' && this.activeTask) {
        const text = update?.content?.text || '';
        this.activeTask.addChunk(text);
      } else if (updateType === 'agent_thought_chunk' && this.activeTask) {
        if (!this.activeTask.thoughtChunksCount) this.activeTask.thoughtChunksCount = 0;
        this.activeTask.thoughtChunksCount++;
      }
    }
  }

  _handleStderrLine(line) {
    // Drained to prevent OS pipe buffer deadlocks
    if (this.debug) {
      console.error(`[GeminiAcp STDERR] ${line}`);
    }
  }

  _handleClose(code, signal) {
    this.exitCode = code;
    this.exitSignal = signal;
    this.managed = null;

    // Reject any pending requests that were awaiting a response
    const exitErr = new Error(`Gemini ACP process terminated with code=${code}, signal=${signal}`);
    exitErr.code = 'ERR_PROCESS_EXITED';

    for (const [id, req] of this.pendingRequests.entries()) {
      if (req.timeoutId) clearTimeout(req.timeoutId);
      req.reject(exitErr);
    }
    this.pendingRequests.clear();

    if (this.activeTask && !this.activeTask.isTerminal()) {
      this.activeTask.fail(exitErr);
    }
  }

  _handleError(err) {
    if (this.activeTask && !this.activeTask.isTerminal()) {
      this.activeTask.fail(err);
    }
  }

  async sendRpc(method, params = {}, timeoutMs = 25000) {
    if (!this.managed) {
      throw new Error(`Cannot send RPC ${method}: Gemini ACP process is not running`);
    }

    const id = this.reqIdCounter++;
    const req = { jsonrpc: '2.0', id, method, params };

    return new Promise((resolve, reject) => {
      let timeoutId = null;

      const scheduleTimeout = (ms) => {
        if (timeoutId) clearTimeout(timeoutId);
        if (ms > 0) {
          timeoutId = setTimeout(() => {
            if (this.pendingRequests.has(id)) {
              this.pendingRequests.delete(id);
              const timeoutErr = new Error(`RPC ${method} timed out after ${ms}ms of inactivity`);
              timeoutErr.code = 'ERR_TIMEOUT';
              reject(timeoutErr);
            }
          }, ms);
        }
      };

      scheduleTimeout(timeoutMs);

      const resetTimeout = (inactivityMs = 60000) => {
        // Watchdog refresh never extends past caller-specified timeoutMs if timeoutMs is shorter
        const effectiveMs = Math.min(timeoutMs, inactivityMs);
        scheduleTimeout(effectiveMs);
      };

      this.pendingRequests.set(id, { resolve, reject, method, timeoutId, resetTimeout });

      try {
        this.managed.child.stdin.write(JSON.stringify(req) + '\n');
      } catch (writeErr) {
        this.pendingRequests.delete(id);
        if (timeoutId) clearTimeout(timeoutId);
        reject(writeErr);
      }
    });
  }

  async initialize(timeoutMs = 15000) {
    const res = await this.sendRpc('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false
      },
      clientInfo: { name: 'custom-oct-core', version: '1.0.0' }
    }, timeoutMs);
    this.protocolInfo = res;
    return res;
  }

  async getOrCreateSession(cwd = null, timeoutMs = 15000) {
    const targetCwd = cwd || this.cwd;
    if (this.sessionsByCwd.has(targetCwd)) {
      return this.sessionsByCwd.get(targetCwd);
    }
    const res = await this.sendRpc('session/new', {
      cwd: targetCwd,
      mcpServers: []
    }, timeoutMs);
    this.sessionId = res.sessionId;
    this.sessionsByCwd.set(targetCwd, res.sessionId);
    return res.sessionId;
  }

  async createSession(cwd = null, timeoutMs = 15000) {
    const sessionId = await this.getOrCreateSession(cwd || this.cwd, timeoutMs);
    return { sessionId };
  }

  /**
   * Executes a task on the active ACP session with full lifecycle state transitions.
   */
  async executeTask(task, timeoutMs = 45000) {
    const sessionStartTime = Date.now();
    const sessionId = await this.getOrCreateSession(task.cwd || this.cwd, 20000);
    const sessionSetupElapsedMs = Date.now() - sessionStartTime;

    if (!sessionId) {
      throw new Error('No active ACP session. Call createSession() first.');
    }
    if (this.activeTask && !this.activeTask.isTerminal()) {
      throw new Error(`Another task (${this.activeTask.correlationId}) is currently running`);
    }

    this.activeTask = task;
    task.transition(TaskState.SENT);
    const promptStartTime = Date.now();

    try {
      const res = await this.sendRpc('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: task.prompt }]
      }, timeoutMs);

      const promptElapsedMs = Date.now() - promptStartTime;
      const combinedText = task.chunks.join('');

      task.metadata = {
        ...task.metadata,
        stageDiagnostics: {
          sessionSetupElapsedMs,
          promptElapsedMs,
          chunksCount: task.chunks.length,
          streamedChars: combinedText.length,
          timedOut: false
        }
      };

      if (task.validator && typeof task.validator === 'function') {
        try {
          const validatedResult = task.validator(combinedText);
          task.complete(validatedResult, res?.usage);
        } catch (valErr) {
          task.fail(valErr);
          throw valErr;
        }
      } else {
        task.complete(combinedText, res?.usage);
      }

      return task;
    } catch (err) {
      const promptElapsedMs = Date.now() - promptStartTime;
      const combinedText = task.chunks.join('');

      task.metadata = {
        ...task.metadata,
        stageDiagnostics: {
          sessionSetupElapsedMs,
          promptElapsedMs,
          chunksCount: task.chunks.length,
          streamedChars: combinedText.length,
          timedOut: err.code === 'ERR_TIMEOUT',
          streamActiveAtTimeout: task.chunks.length > 0
        }
      };

      if (!task.isTerminal()) {
        if (err.code === 'ERR_TIMEOUT') {
          // Immediately send cancel to abort agent generation on server side
          this.cancelSessionPrompt(sessionId).catch(() => {});
          task.timeout(err.message);
        } else {
          task.fail(err);
        }
      }
      throw err;
    } finally {
      this.activeTask = null;
    }
  }

  async cancelSessionPrompt(targetSessionId = null) {
    const sId = targetSessionId || this.sessionId;
    if (sId && this.managed) {
      try {
        await this.sendRpc('session/cancel', { sessionId: sId }, 5000);
      } catch (e) {
        // May already be finished
      }
    }
  }

  async close() {
    this.isClosing = true;
    if (this.managed) {
      const managed = this.managed;
      this.managed = null;

      try {
        managed.child.stdin.end();
      } catch (e) {}

      // Allow 2000ms for graceful exit, then force kill tree
      await new Promise((resolve) => {
        let isDone = false;
        const cleanupTimer = setTimeout(async () => {
          if (!isDone) {
            isDone = true;
            await managed.kill();
            resolve();
          }
        }, 2000);

        managed.child.on('close', () => {
          if (!isDone) {
            isDone = true;
            clearTimeout(cleanupTimer);
            resolve();
          }
        });
      });
    }
  }
}
