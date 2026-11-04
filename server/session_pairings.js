// Tracks which Claude and Gemini CLI session ids were active together in this
// workbench, so a "session" in the UI is the unit the human actually thinks in --
// their Claude conversation, with whatever Gemini delegation happened inside it
// following along underneath -- rather than two unrelated-looking entries.
//
// Gemini only gets listed as its own separate entry when it was genuinely used
// standalone (no Claude session paired with it at all). The moment a Claude session
// delegates to Gemini, Gemini's session id is absorbed into that same pair and stops
// being shown on its own.

import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

export class SessionPairings {
  constructor({ cwd }) {
    this.filePath = path.join(cwd, '.workbench_session_pairings.json');
    this.pairs = this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
        if (Array.isArray(parsed)) return parsed;
      }
    } catch (e) {
      logger.warn('SESSION_PAIRINGS:LOAD_FAILED', `Failed to load session pairings: ${e.message}`);
    }
    return [];
  }

  _save() {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.pairs, null, 2), 'utf8');
    } catch (e) {
      logger.warn('SESSION_PAIRINGS:SAVE_FAILED', `Failed to persist session pairings: ${e.message}`);
    }
  }

  // Call with whatever session ids are currently known to be active (either may be
  // null). Finds an existing pair by either id and merges into it, or creates a new
  // one -- so "Claude starts, then delegates to a fresh Gemini" and "Gemini starts
  // standalone, then Claude joins later" both end up correctly merged into one pair.
  recordActive({ claudeSessionId = null, geminiSessionId = null }) {
    if (!claudeSessionId && !geminiSessionId) return;

    let pair = null;
    if (claudeSessionId) pair = this.pairs.find((p) => p.claudeSessionId === claudeSessionId);
    if (!pair && geminiSessionId) pair = this.pairs.find((p) => p.geminiSessionId === geminiSessionId);

    const now = new Date().toISOString();
    if (!pair) {
      pair = { claudeSessionId: claudeSessionId || null, geminiSessionId: geminiSessionId || null, updatedAt: now };
      this.pairs.push(pair);
    } else {
      if (claudeSessionId) pair.claudeSessionId = claudeSessionId;
      if (geminiSessionId) pair.geminiSessionId = geminiSessionId;
      pair.updatedAt = now;
    }
    this._save();
  }

  list() {
    return [...this.pairs];
  }
}
