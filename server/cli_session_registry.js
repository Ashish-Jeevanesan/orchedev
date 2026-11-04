// Lists past Claude/Gemini CLI conversation sessions for this project, so the UI can
// offer to resume one via the CLI's own native --resume flag.
//
// This queries each CLI's own persisted session store directly rather than keeping our
// own eager record of "every terminal we ever spawned" -- a terminal that was started
// and closed without any real exchange is never written to disk by either CLI, so an
// eager record would list "ghost" sessions that fail with "Invalid session identifier"
// the moment you try to resume them. Querying the CLI's own store means we only ever
// offer sessions that genuinely exist and are genuinely resumable.

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { logger } from './logger.js';

// Claude Code derives its per-project transcript folder name by replacing every
// `:`, `\`, `/` and space in the absolute cwd with `-` (confirmed against this very
// workbench's own project folder on disk).
export function claudeProjectDirName(cwd) {
  return cwd.replace(/[:\\/ ]/g, '-');
}

// Best-effort extraction of a human-readable title from a Claude transcript: the first
// genuine user-typed message, skipping injected context blocks (which this codebase's
// own transcripts show consistently start with a `<tag>`, e.g. <session_context>,
// <system-reminder>). Falls back to null if nothing recognizable is found -- callers
// should fall back to a timestamp-based title rather than guessing further, since the
// transcript schema is Claude Code's internal format and may change across versions.
function extractClaudeTitle(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').filter(Boolean).slice(0, 40);
    for (const line of lines) {
      let obj;
      try {
        obj = JSON.parse(line);
      } catch (e) {
        continue;
      }
      if (obj?.type !== 'user') continue;
      const msg = obj.message || obj;
      let text = null;
      if (typeof msg?.content === 'string') {
        text = msg.content;
      } else if (Array.isArray(msg?.content)) {
        const textPart = msg.content.find((p) => p?.type === 'text' && typeof p.text === 'string');
        if (textPart) text = textPart.text;
      }
      if (text && !text.trim().startsWith('<')) {
        return text.trim().slice(0, 120);
      }
    }
  } catch (e) {
    // Unreadable/corrupt transcript -- not fatal, just no title.
  }
  return null;
}

export class CliSessionRegistry {
  constructor({ cwd }) {
    this.cwd = cwd;
  }

  async list(agent = null) {
    const results = [];
    if (!agent || agent === 'claude') results.push(...this._listClaude());
    if (!agent || agent === 'gemini') results.push(...(await this._listGemini()));
    results.sort((a, b) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime());
    return results;
  }

  _listClaude() {
    try {
      const sessionsMap = new Map();

      const scanDir = (dirPath) => {
        if (!fs.existsSync(dirPath)) return;
        const files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.jsonl'));
        for (const f of files) {
          const fullPath = path.join(dirPath, f);
          let stat;
          try {
            stat = fs.statSync(fullPath);
          } catch (e) {
            continue;
          }
          const id = f.replace(/\.jsonl$/, '');
          const title = extractClaudeTitle(fullPath) || `Claude session — ${stat.mtime.toLocaleString()}`;
          const existing = sessionsMap.get(id);
          if (!existing || new Date(stat.mtime).getTime() > new Date(existing.lastActiveAt).getTime()) {
            sessionsMap.set(id, {
              id,
              agent: 'claude',
              title,
              lastActiveAt: stat.mtime.toISOString()
            });
          }
        }
      };

      // 1. Scan local home directory
      const localDirPath = path.join(os.homedir(), '.claude', 'projects', claudeProjectDirName(this.cwd));
      scanDir(localDirPath);

      // 2. Scan mirrored sessions directory
      const mirrorDirPath = path.join(this.cwd, '.workbench_cli_sessions', 'claude');
      scanDir(mirrorDirPath);

      return Array.from(sessionsMap.values());
    } catch (e) {
      logger.warn('CLI_SESSIONS:CLAUDE_LIST_FAILED', `Failed to list Claude sessions: ${e.message}`);
      return [];
    }
  }

  _listGeminiFromDisk() {
    try {
      const sessionsMap = new Map();

      const parseGeminiChat = (fullPath, fileStat) => {
        let sessionId = null;
        let title = null;

        try {
          const content = fs.readFileSync(fullPath, 'utf8');
          const lines = content.split('\n').filter(Boolean);
          if (lines.length > 0) {
            try {
              const first = JSON.parse(lines[0]);
              sessionId = first.sessionId || null;
            } catch (e) {}
          }
          for (const line of lines) {
            let obj;
            try {
              obj = JSON.parse(line);
            } catch (e) {
              continue;
            }
            if (obj?.$set?.summary) {
              title = obj.$set.summary;
              break;
            }
            if (!title && obj?.type === 'user' && Array.isArray(obj.content)) {
              for (const part of obj.content) {
                const txt = part?.text;
                if (txt && typeof txt === 'string' && !txt.trim().startsWith('<')) {
                  title = txt.trim().slice(0, 120);
                  break;
                }
              }
            }
          }
        } catch (e) {}

        if (sessionId) {
          const existing = sessionsMap.get(sessionId);
          if (!existing || new Date(fileStat.mtime).getTime() > new Date(existing.lastActiveAt).getTime()) {
            sessionsMap.set(sessionId, {
              id: sessionId,
              agent: 'gemini',
              title: title || `Gemini session — ${fileStat.mtime.toLocaleString()}`,
              lastActiveAt: fileStat.mtime.toISOString()
            });
          }
        }
      };

      // 1. Scan local ~/.gemini/tmp directories matching this project's CWD
      const geminiTmp = path.join(os.homedir(), '.gemini', 'tmp');
      if (fs.existsSync(geminiTmp)) {
        const normCwd = path.resolve(this.cwd).toLowerCase();
        const dirs = fs.readdirSync(geminiTmp);
        for (const dir of dirs) {
          const fullDir = path.join(geminiTmp, dir);
          try {
            if (!fs.statSync(fullDir).isDirectory()) continue;
          } catch (e) { continue; }

          const rootFile = path.join(fullDir, '.project_root');
          if (!fs.existsSync(rootFile)) continue;

          let rootPath = '';
          try {
            rootPath = path.resolve(fs.readFileSync(rootFile, 'utf8').trim()).toLowerCase();
          } catch (e) { continue; }

          if (rootPath !== normCwd) continue;

          const chatsDir = path.join(fullDir, 'chats');
          if (!fs.existsSync(chatsDir)) continue;

          const files = fs.readdirSync(chatsDir).filter((f) => f.endsWith('.jsonl'));
          for (const f of files) {
            const fullPath = path.join(chatsDir, f);
            try {
              const fileStat = fs.statSync(fullPath);
              parseGeminiChat(fullPath, fileStat);
            } catch (e) {}
          }
        }
      }

      // 2. Scan mirrored sessions directory
      const mirrorGeminiDir = path.join(this.cwd, '.workbench_cli_sessions', 'gemini');
      if (fs.existsSync(mirrorGeminiDir)) {
        const files = fs.readdirSync(mirrorGeminiDir).filter((f) => f.endsWith('.jsonl'));
        for (const f of files) {
          const fullPath = path.join(mirrorGeminiDir, f);
          try {
            const fileStat = fs.statSync(fullPath);
            parseGeminiChat(fullPath, fileStat);
          } catch (e) {}
        }
      }

      return Array.from(sessionsMap.values());
    } catch (e) {
      logger.warn('CLI_SESSIONS:GEMINI_DISK_READ_FAILED', `Failed reading Gemini sessions from disk: ${e.message}`);
      return null;
    }
  }

  async _listGemini() {
    const diskSessions = this._listGeminiFromDisk();
    if (diskSessions && diskSessions.length > 0) {
      return diskSessions;
    }

    return new Promise((resolve) => {
      execFile('gemini', ['--list-sessions'], { cwd: this.cwd, timeout: 5000, windowsHide: true, shell: true }, (err, stdout) => {
        if (err || !stdout) {
          if (err) logger.warn('CLI_SESSIONS:GEMINI_LIST_FAILED', `Failed to list Gemini sessions: ${err.message}`);
          return resolve(diskSessions || []);
        }
        // Gemini's own output, e.g.: "  2. Compare slides (4 minutes ago) [uuid]"
        const re = /^\s*(\d+)\.\s+(.+?)\s+\(([^)]+)\)\s+\[([0-9a-fA-F-]{36})\]\s*$/;
        const sessions = [];
        for (const line of stdout.split(/\r?\n/)) {
          const m = line.match(re);
          if (!m) continue;
          const index = parseInt(m[1], 10);
          sessions.push({
            id: m[4],
            agent: 'gemini',
            title: m[2].trim(),
            lastActiveLabel: m[3].trim(),
            // Gemini lists most-recent first (index 1) but only gives a relative time
            // label, not a real timestamp. Synthesize a strictly-descending timestamp
            // from list order purely so this interleaves correctly with Claude's real
            // file mtimes once both lists are merged and sorted.
            lastActiveAt: new Date(Date.now() - (index - 1) * 1000).toISOString()
          });
        }
        resolve(sessions);
      });
    });
  }
}
