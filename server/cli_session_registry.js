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
function claudeProjectDirName(cwd) {
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
      const dirPath = path.join(os.homedir(), '.claude', 'projects', claudeProjectDirName(this.cwd));
      if (!fs.existsSync(dirPath)) return [];

      return fs.readdirSync(dirPath)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => {
          const fullPath = path.join(dirPath, f);
          let stat;
          try {
            stat = fs.statSync(fullPath);
          } catch (e) {
            return null;
          }
          const id = f.replace(/\.jsonl$/, '');
          const title = extractClaudeTitle(fullPath) || `Claude session — ${stat.mtime.toLocaleString()}`;
          return {
            id,
            agent: 'claude',
            title,
            lastActiveAt: stat.mtime.toISOString()
          };
        })
        .filter(Boolean);
    } catch (e) {
      logger.warn('CLI_SESSIONS:CLAUDE_LIST_FAILED', `Failed to list Claude sessions: ${e.message}`);
      return [];
    }
  }

  _listGemini() {
    return new Promise((resolve) => {
      execFile('gemini', ['--list-sessions'], { cwd: this.cwd, timeout: 10000, windowsHide: true, shell: true }, (err, stdout) => {
        if (err || !stdout) {
          if (err) logger.warn('CLI_SESSIONS:GEMINI_LIST_FAILED', `Failed to list Gemini sessions: ${err.message}`);
          return resolve([]);
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
