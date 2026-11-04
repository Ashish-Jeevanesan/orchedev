// D:\Ashish_P\AI-Tools\custom-OCT\server\terminal_manager.js
// ConPTY Interactive Terminal Manager with Persistent Listeners & Scrollback Replay

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import pty from '@homebridge/node-pty-prebuilt-multiarch';
import { ProcessManager } from '../core/process_manager.js';
import { logger } from './logger.js';
import { fileURLToPath as __toPath } from 'url';
const __serverDir = path.dirname(__toPath(import.meta.url));

function resolveClaudeBin() {
  const candidates = [
    process.env.CLAUDE_BIN,
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'claude', 'claude.exe'),
    path.join(process.env.USERPROFILE || '', '.local', 'bin', 'claude.exe'),
    'C:\\Users\\ajeevanesan\\.local\\bin\\claude.exe'
  ].filter(Boolean);

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return 'claude';
}

function resolveGeminiBundlePath() {
  const candidates = [
    process.env.GEMINI_BUNDLE_PATH,
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@google', 'gemini-cli', 'bundle', 'gemini.js'),
    'C:\\Users\\ajeevanesan\\AppData\\Local\\nvm\\v22.23.1\\node_modules\\@google\\gemini-cli\\bundle\\gemini.js'
  ].filter(Boolean);

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

const MAX_SCROLLBACK_BYTES = 1024 * 1024; // 1 MB bounded scrollback replay buffer

export class TerminalManager {
  constructor({ cwd }) {
    this.cwd = cwd;
    this.projectCwd = cwd;
    this.terminals = new Map(); // id -> terminalRecord
    this.workbenchPort = null;
    this.sessionToken = null;
    this.generatedFiles = new Set();
    this.preExistingConfigs = new Map(); // filePath -> originalStringContent
    this.activeInstanceIds = new Map(); // id -> instanceId

    // Debounced "output has gone quiet" tracking per terminal id, independent of
    // terminalRecord so listeners survive a restartTerminal() recreating the record.
    this._outputWatch = new Map(); // id -> { buffer: '', timer: null, lastDataAt: 0 }
    this._quietListeners = new Map(); // id -> Set<(bufferSnapshot: string) => void>
    this._globalExitListeners = new Set();
  }

  clearScrollback(id) {
    const term = this.terminals.get(id);
    if (term) {
      term.scrollbackBuffer = '';
    }
  }

  onGlobalExit(listener) {
    if (typeof listener === 'function') {
      this._globalExitListeners.add(listener);
    }
  }

  // Register a listener fired with a bounded snapshot of recent raw PTY output once
  // that terminal's output has gone quiet for ~500ms. Used for things that need to
  // read a fully-drawn prompt/screen rather than a single arbitrary data chunk.
  onQuietOutput(id, listener) {
    if (!this._quietListeners.has(id)) this._quietListeners.set(id, new Set());
    this._quietListeners.get(id).add(listener);
  }

  // True if no PTY output has been received for this terminal in the last quietMs.
  // Used to avoid injecting synthetic input while the agent is mid-output.
  isIdle(id, quietMs = 500) {
    const w = this._outputWatch.get(id);
    if (!w || !w.lastDataAt) return true;
    return (Date.now() - w.lastDataAt) >= quietMs;
  }

  _feedOutputWatch(id, chunk) {
    const listeners = this._quietListeners.get(id);
    if (!this._outputWatch.has(id)) {
      this._outputWatch.set(id, { buffer: '', timer: null, lastDataAt: 0 });
    }
    const w = this._outputWatch.get(id);
    w.lastDataAt = Date.now();

    if (!listeners || listeners.size === 0) return; // nothing to assemble a buffer for

    w.buffer += chunk;
    const MAX_WATCH_BYTES = 8192;
    if (w.buffer.length > MAX_WATCH_BYTES) {
      w.buffer = w.buffer.slice(-MAX_WATCH_BYTES);
    }

    if (w.timer) clearTimeout(w.timer);
    w.timer = setTimeout(() => {
      const snapshot = w.buffer;
      for (const fn of listeners) {
        try { fn(snapshot); } catch (e) {}
      }
    }, 500);
  }

  setWorkbenchConnection({ port, sessionToken }) {
    this.workbenchPort = port;
    this.sessionToken = sessionToken;
  }

  setProjectCwd(newCwd) {
    const oldCwd = this.projectCwd;
    this.projectCwd = newCwd;
    logger.info('TERMINAL:CWD_UPDATE', `Terminal default CWD updated from ${oldCwd} to ${newCwd}`, {
      oldCwd,
      newCwd
    });
  }

  // sessionOpts: { sessionId, resumeSessionId }. Both Claude Code and Gemini CLI accept
  // --session-id <uuid> to assign a known id to a brand-new conversation, and
  // --resume <id> to reopen a past one -- confirmed against both CLIs' own --help output
  // and (for Gemini) by live-resuming a real session in this workbench and getting an
  // accurate recollection of the original conversation back.
  getTerminalConfig(id, targetCwd = null, sessionOpts = {}) {
    const resolvedCwd = targetCwd || this.projectCwd || this.cwd;
    const bridgeScript = path.join(__serverDir, 'mcp', 'workbench_mcp_bridge.js');
    const { sessionId = null, resumeSessionId = null } = sessionOpts;

    if (id === 'claude') {
      const args = [];
      if (resumeSessionId) {
        args.push('--resume', resumeSessionId);
      } else if (sessionId) {
        args.push('--session-id', sessionId);
      }
      if (this.workbenchPort && this.sessionToken) {
        const mcpDir = path.join(resolvedCwd, '.workbench');
        try {
          if (!fs.existsSync(mcpDir)) fs.mkdirSync(mcpDir, { recursive: true });
          const mcpConfigPath = path.join(mcpDir, 'claude_mcp_config.json');
          if (fs.existsSync(mcpConfigPath)) {
            if (!this.preExistingConfigs.has(mcpConfigPath)) {
              this.preExistingConfigs.set(mcpConfigPath, fs.readFileSync(mcpConfigPath, 'utf8'));
            }
          } else {
            this.generatedFiles.add(mcpConfigPath);
          }
          const mcpConfig = {
            mcpServers: {
              workbench: {
                command: 'node',
                args: [
                  bridgeScript,
                  '--agent', 'claude',
                  '--port', String(this.workbenchPort),
                  '--token', this.sessionToken,
                  '--cwd', resolvedCwd
                ]
              }
            }
          };
          fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2), 'utf8');
          args.push('--mcp-config', mcpConfigPath);
          logger.info('TERMINAL:MCP_CONFIG_PREPARED', `Prepared Claude MCP configuration in ${mcpConfigPath}`, {
            mcpConfigPath,
            port: this.workbenchPort
          });
        } catch (err) {
          logger.error('TERMINAL:MCP_CONFIG_ERROR', `Failed to write Claude MCP config: ${err.message}`, { error: err.message });
        }
      }

      return {
        file: resolveClaudeBin(),
        args,
        name: 'claude-interactive'
      };
    } else if (id === 'gemini') {
      const bundlePath = resolveGeminiBundlePath();
      const args = bundlePath ? [bundlePath, '--skip-trust'] : ['--skip-trust'];
      if (resumeSessionId) {
        args.push('--resume', resumeSessionId);
      } else if (sessionId) {
        args.push('--session-id', sessionId);
      }
      if (this.workbenchPort && this.sessionToken) {
        const geminiDir = path.join(resolvedCwd, '.gemini');
        try {
          if (!fs.existsSync(geminiDir)) fs.mkdirSync(geminiDir, { recursive: true });
          const settingsPath = path.join(geminiDir, 'settings.json');
          let settings = {};
          if (fs.existsSync(settingsPath)) {
            if (!this.preExistingConfigs.has(settingsPath)) {
              this.preExistingConfigs.set(settingsPath, fs.readFileSync(settingsPath, 'utf8'));
            }
            try {
              settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
            } catch (e) {
              settings = {};
            }
          } else {
            this.generatedFiles.add(settingsPath);
          }
          settings.mcpServers = settings.mcpServers || {};
          settings.ui = settings.ui || {};
          settings.ui.useAlternateBuffer = true;
          settings.mcpServers.workbench = {
            command: 'node',
            args: [
              bridgeScript,
              '--agent', 'gemini',
              '--port', String(this.workbenchPort),
              '--token', this.sessionToken,
              '--cwd', resolvedCwd
            ],
            trust: true
          };
          fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
          args.push('--allowed-mcp-server-names', 'workbench');
          logger.info('TERMINAL:MCP_CONFIG_PREPARED', `Prepared Gemini workspace MCP configuration in ${settingsPath}`, {
            settingsPath,
            port: this.workbenchPort
          });
        } catch (err) {
          logger.error('TERMINAL:MCP_CONFIG_ERROR', `Failed to write Gemini MCP settings: ${err.message}`, { error: err.message });
        }
      }

      return {
        file: bundlePath ? process.execPath : 'gemini.cmd',
        args,
        name: 'gemini-interactive'
      };
    } else {
      throw new Error(`Unknown terminal ID: ${id}`);
    }
  }

  startTerminal(id, { cols = 80, rows = 24, cwd = null, resumeSessionId = null } = {}, onData, onExit) {
    let term = this.terminals.get(id);

    if (term && term.status === 'RUNNING') {
      // Re-attach listeners to existing running terminal and replay buffer
      if (onData && !term.dataListeners.has(onData)) {
        term.dataListeners.add(onData);
        if (term.scrollbackBuffer) {
          try {
            onData(term.scrollbackBuffer);
          } catch (e) {}
        }
      }
      if (onExit && !term.exitListeners.has(onExit)) {
        term.exitListeners.add(onExit);
      }
      logger.info('TERMINAL:ATTACH', `Re-attached listeners to existing running ${id} terminal (PID ${term.pid}) in ${term.cwd}`, {
        id,
        pid: term.pid,
        cwd: term.cwd
      });
      return term;
    }

    const targetCwd = cwd || this.projectCwd || this.cwd;
    // Only 'claude' and 'gemini' have a resumable CLI conversation concept; every fresh
    // launch of either still gets a known id assigned up front (rather than letting the
    // CLI pick one silently) so it can show up in the session list right away.
    const isCliAgent = id === 'claude' || id === 'gemini';
    const newSessionId = (!resumeSessionId && isCliAgent) ? crypto.randomUUID() : null;
    const config = this.getTerminalConfig(id, targetCwd, { sessionId: newSessionId, resumeSessionId });
    const cliSessionId = resumeSessionId || newSessionId;

    logger.info('TERMINAL:SPAWN', `Spawning ${id} ConPTY in directory: ${targetCwd}`, {
      id,
      file: config.file,
      cwd: targetCwd,
      cols,
      rows,
      cliSessionId,
      resumed: !!resumeSessionId
    });

    // Spawn ConPTY process with explicit target working directory. Strip any
    // CLAUDE_CODE_* env vars inherited from whatever process launched this workbench
    // (e.g. running `npm start` from inside a Claude Code session/terminal) -- without
    // this, a spawned 'claude' terminal can inherit CLAUDE_CODE_CHILD_SESSION /
    // CLAUDE_CODE_SESSION_ID and treat itself as a child of that outer session instead
    // of starting its own independent, --session-id/--resume-able conversation.
    const childEnv = { ...process.env };
    for (const key of Object.keys(childEnv)) {
      if (key.startsWith('CLAUDE_CODE_')) delete childEnv[key];
    }

    const ptyProcess = pty.spawn(config.file, config.args, {
      name: 'xterm-256color',
      cols: Math.max(20, cols),
      rows: Math.max(5, rows),
      cwd: targetCwd,
      env: childEnv
    });

    const terminalRecord = {
      id,
      ptyProcess,
      pid: ptyProcess.pid,
      cliSessionId,
      cwd: targetCwd,
      status: 'RUNNING',
      cols,
      rows,
      startTime: Date.now(),
      exitCode: null,
      scrollbackBuffer: '',
      dataListeners: new Set(),
      exitListeners: new Set()
    };

    if (onData) terminalRecord.dataListeners.add(onData);
    if (onExit) terminalRecord.exitListeners.add(onExit);

    ptyProcess.onData((data) => {
      // 1. Maintain bounded scrollback buffer for late/reconnecting clients
      terminalRecord.scrollbackBuffer += data;
      if (terminalRecord.scrollbackBuffer.length > MAX_SCROLLBACK_BYTES) {
        terminalRecord.scrollbackBuffer = terminalRecord.scrollbackBuffer.slice(-Math.floor(MAX_SCROLLBACK_BYTES / 2));
      }

      // 2. Broadcast to all active listeners
      for (const listener of terminalRecord.dataListeners) {
        try {
          listener(data);
        } catch (e) {}
      }

      // 3. Feed the debounced quiet-output watch (approval-prompt detection, idle checks)
      this._feedOutputWatch(id, data);
    });

    ptyProcess.onExit(({ exitCode, signal }) => {
      logger.info('TERMINAL:EXIT', `Terminal ${id} (PID ${terminalRecord.pid}) exited with code=${exitCode}, signal=${signal}`, {
        id,
        pid: terminalRecord.pid,
        exitCode,
        signal
      });

      if (terminalRecord.status !== 'STOPPED' && terminalRecord.status !== 'STOPPING') {
        terminalRecord.status = 'EXITED';
      } else {
        terminalRecord.status = 'STOPPED';
      }
      terminalRecord.exitCode = exitCode;

      for (const listener of terminalRecord.exitListeners) {
        try {
          listener(exitCode, signal);
        } catch (e) {}
      }

      for (const listener of this._globalExitListeners) {
        try {
          listener(id, exitCode, signal);
        } catch (e) {}
      }
    });

    this.terminals.set(id, terminalRecord);
    logger.info('TERMINAL:SPAWNED', `Successfully spawned ${id} ConPTY (PID ${ptyProcess.pid}) in ${targetCwd}`, {
      id,
      pid: ptyProcess.pid,
      cwd: targetCwd
    });

    return terminalRecord;
  }

  async restartTerminal(id, { cols = 80, rows = 24, cwd = null, resumeSessionId = null } = {}, onData, onExit) {
    const existing = this.terminals.get(id);
    const savedDataListeners = existing ? new Set(existing.dataListeners) : new Set();
    const savedExitListeners = existing ? new Set(existing.exitListeners) : new Set();

    if (onData) savedDataListeners.add(onData);
    if (onExit) savedExitListeners.add(onExit);

    logger.info('TERMINAL:RESTART_REQUEST', `Restarting terminal ${id}... (targetCwd: ${cwd || this.projectCwd || this.cwd})`, {
      id,
      oldPid: existing?.pid,
      oldCwd: existing?.cwd,
      targetCwd: cwd || this.projectCwd || this.cwd,
      resumeSessionId
    });

    await this.terminate(id);

    const targetCwd = cwd || this.projectCwd || this.cwd;
    const newTerm = this.startTerminal(id, { cols, rows, cwd: targetCwd, resumeSessionId });

    // Re-attach active listeners from previous session
    for (const l of savedDataListeners) {
      newTerm.dataListeners.add(l);
    }
    for (const l of savedExitListeners) {
      newTerm.exitListeners.add(l);
    }

    logger.info('TERMINAL:RESTART_SUCCESS', `Terminal ${id} successfully restarted with new PID ${newTerm.pid} in ${newTerm.cwd}`, {
      id,
      newPid: newTerm.pid,
      newCwd: newTerm.cwd
    });

    return newTerm;
  }

  detachListener(id, onData, onExit) {
    const term = this.terminals.get(id);
    if (!term) return;
    if (onData) term.dataListeners.delete(onData);
    if (onExit) term.exitListeners.delete(onExit);
  }

  write(id, data) {
    const term = this.terminals.get(id);
    if (!term || term.status !== 'RUNNING') {
      throw new Error(`Terminal ${id} is not running`);
    }
    term.ptyProcess.write(data);
  }

  resize(id, cols, rows) {
    const term = this.terminals.get(id);
    if (!term || term.status !== 'RUNNING') return;
    try {
      term.cols = cols;
      term.rows = rows;
      term.ptyProcess.resize(Math.max(10, cols), Math.max(5, rows));
    } catch (e) {
      // Terminal may have exited
    }
  }

  _cleanupTerminalConfig(id, instanceId = null, targetCwd = null) {
    if (instanceId && this.activeInstanceIds.get(id) !== instanceId) {
      // Newer instance has already started; do not touch active config
      return;
    }

    const resolvedCwd = path.resolve(targetCwd || this.projectCwd || this.cwd);
    const configFile = id === 'claude'
      ? path.join(resolvedCwd, '.workbench', 'claude_mcp_config.json')
      : path.join(resolvedCwd, '.gemini', 'settings.json');

    try {
      if (fs.existsSync(configFile)) {
        if (id === 'gemini') {
          try {
            const currentSettings = JSON.parse(fs.readFileSync(configFile, 'utf8'));
            if (currentSettings.mcpServers) {
              delete currentSettings.mcpServers.workbench;
              if (Object.keys(currentSettings.mcpServers).length === 0) {
                delete currentSettings.mcpServers;
              }
            }
            if (!this.preExistingConfigs.has(configFile) && Object.keys(currentSettings).length === 0) {
              fs.unlinkSync(configFile);
              logger.info('TERMINAL:CONFIG_UNLINKED', `Unlinked ephemeral workbench configuration: ${configFile}`);
            } else {
              fs.writeFileSync(configFile, JSON.stringify(currentSettings, null, 2), 'utf8');
              logger.info('TERMINAL:CONFIG_PRUNED', `Removed workbench MCP entry while preserving user settings: ${configFile}`);
            }
          } catch (e) {
            if (this.preExistingConfigs.has(configFile)) {
              fs.writeFileSync(configFile, this.preExistingConfigs.get(configFile), 'utf8');
            }
          }
        } else if (id === 'claude') {
          if (!this.preExistingConfigs.has(configFile)) {
            fs.unlinkSync(configFile);
            logger.info('TERMINAL:CONFIG_UNLINKED', `Unlinked ephemeral workbench configuration: ${configFile}`);
          } else {
            try {
              const currentConfig = JSON.parse(fs.readFileSync(configFile, 'utf8'));
              if (currentConfig.mcpServers) {
                delete currentConfig.mcpServers.workbench;
                if (Object.keys(currentConfig.mcpServers).length === 0) delete currentConfig.mcpServers;
              }
              fs.writeFileSync(configFile, JSON.stringify(currentConfig, null, 2), 'utf8');
            } catch (e) {
              fs.writeFileSync(configFile, this.preExistingConfigs.get(configFile), 'utf8');
            }
          }
        }
      }
      this.preExistingConfigs.delete(configFile);
      this.generatedFiles.delete(configFile);
    } catch (e) {
      logger.warn('TERMINAL:CONFIG_CLEANUP_WARN', `Could not clean config ${configFile}: ${e.message}`);
    }
  }

  async terminate(id) {
    const term = this.terminals.get(id);
    if (!term) return;

    const instanceId = this.activeInstanceIds.get(id);
    if (term.status === 'RUNNING' && term.pid) {
      term.status = 'STOPPING';
      logger.info('TERMINAL:TERMINATE', `Terminating ${id} terminal process tree (PID ${term.pid})`, {
        id,
        pid: term.pid,
        cwd: term.cwd
      });
      try {
        term.ptyProcess.kill();
      } catch (e) {}
      await ProcessManager.terminateProcessTree(term.pid);
      term.status = 'STOPPED';
      term.dataListeners.clear();
      term.exitListeners.clear();
      this._cleanupTerminalConfig(id, instanceId, term.cwd);
      logger.info('TERMINAL:TERMINATED', `Terminal ${id} (PID ${term.pid}) terminated successfully`, {
        id,
        pid: term.pid
      });
    }
  }

  getStatus(id) {
    const term = this.terminals.get(id);
    if (!term) return { id, status: 'NOT_STARTED', pid: null, cwd: this.projectCwd || this.cwd, cliSessionId: null };
    return {
      id: term.id,
      status: term.status,
      pid: term.pid,
      cwd: term.cwd || this.projectCwd || this.cwd,
      cols: term.cols,
      rows: term.rows,
      startTime: term.startTime,
      exitCode: term.exitCode,
      cliSessionId: term.cliSessionId || null
    };
  }

  getAllStatuses() {
    return {
      claude: this.getStatus('claude'),
      gemini: this.getStatus('gemini')
    };
  }

  async shutdownAll() {
    logger.info('TERMINAL:SHUTDOWN_ALL', 'Terminating all active terminal processes...');
    const promises = [];
    for (const [id, term] of this.terminals.entries()) {
      if (term.status === 'RUNNING' && term.pid) {
        promises.push(ProcessManager.terminateProcessTree(term.pid));
      }
    }
    await Promise.all(promises);
    this.terminals.clear();

    // 1. Restore pre-existing user configuration files
    for (const [file, original] of this.preExistingConfigs.entries()) {
      try {
        fs.writeFileSync(file, original, 'utf8');
      } catch (e) {}
    }
    this.preExistingConfigs.clear();

    // 2. Clean up temporary MCP configuration files generated for ephemeral ports
    for (const file of this.generatedFiles) {
      try {
        if (fs.existsSync(file)) {
          fs.unlinkSync(file);
        }
      } catch (e) {}
    }
    this.generatedFiles.clear();
    this.activeInstanceIds.clear();
  }
}
