// server/session_pairings.js
// Tracks which Claude and Gemini CLI session ids were active together in this
// workbench, partitioned by device id to guarantee multi-writer conflict safety across OneDrive.

import fs from 'fs';
import path from 'path';
import { getDeviceIdentity } from './device_identity.js';
import { logger } from './logger.js';

export class SessionPairings {
  constructor({ cwd }) {
    this.cwd = path.resolve(cwd);
    this.deviceId = getDeviceIdentity().id;
    this.deviceFilePath = path.join(this.cwd, `.workbench_session_pairings.${this.deviceId}.json`);
    this.legacyFilePath = path.join(this.cwd, '.workbench_session_pairings.json');
    this.localPairs = this._loadLocalDevicePairs();
  }

  _loadLocalDevicePairs() {
    try {
      if (fs.existsSync(this.deviceFilePath)) {
        const parsed = JSON.parse(fs.readFileSync(this.deviceFilePath, 'utf8'));
        if (Array.isArray(parsed)) return parsed;
      }
    } catch (e) {
      logger.warn('SESSION_PAIRINGS:DEVICE_LOAD_FAILED', `Failed to load device session pairings: ${e.message}`);
    }
    return [];
  }

  _save() {
    try {
      fs.writeFileSync(this.deviceFilePath, JSON.stringify(this.localPairs, null, 2), 'utf8');
    } catch (e) {
      logger.warn('SESSION_PAIRINGS:SAVE_FAILED', `Failed to persist device session pairings: ${e.message}`);
    }
  }

  recordActive({ claudeSessionId = null, geminiSessionId = null }) {
    if (!claudeSessionId && !geminiSessionId) return;

    let pair = null;
    if (claudeSessionId) pair = this.localPairs.find((p) => p.claudeSessionId === claudeSessionId);
    if (!pair && geminiSessionId) pair = this.localPairs.find((p) => p.geminiSessionId === geminiSessionId);

    const now = new Date().toISOString();
    if (!pair) {
      pair = { claudeSessionId: claudeSessionId || null, geminiSessionId: geminiSessionId || null, updatedAt: now };
      this.localPairs.push(pair);
    } else {
      if (claudeSessionId) pair.claudeSessionId = claudeSessionId;
      if (geminiSessionId) pair.geminiSessionId = geminiSessionId;
      pair.updatedAt = now;
    }
    this._save();
  }

  // Merges across all devices: scans all .workbench_session_pairings*.json files
  // and unions them, deduplicating by session IDs and taking the newest updatedAt.
  list() {
    const unionMap = new Map(); // key -> pair

    const parseAndUnion = (filePath) => {
      try {
        if (!fs.existsSync(filePath)) return;
        const raw = fs.readFileSync(filePath, 'utf8');
        if (!raw.trim()) return;
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return;

        for (const p of parsed) {
          if (!p.claudeSessionId && !p.geminiSessionId) continue;
          const key = p.claudeSessionId ? `c:${p.claudeSessionId}` : `g:${p.geminiSessionId}`;
          const existing = unionMap.get(key);
          if (!existing || new Date(p.updatedAt || 0).getTime() > new Date(existing.updatedAt || 0).getTime()) {
            unionMap.set(key, p);
            // Also link the other side if paired
            if (p.claudeSessionId && p.geminiSessionId) {
              unionMap.set(`g:${p.geminiSessionId}`, p);
            }
          }
        }
      } catch (e) {}
    };

    try {
      const files = fs.readdirSync(this.cwd);
      for (const f of files) {
        if (f.startsWith('.workbench_session_pairings') && f.endsWith('.json')) {
          parseAndUnion(path.join(this.cwd, f));
        }
      }
    } catch (e) {
      // Fall back to in-memory local pairs
      for (const p of this.localPairs) {
        const key = p.claudeSessionId ? `c:${p.claudeSessionId}` : `g:${p.geminiSessionId}`;
        unionMap.set(key, p);
      }
    }

    const uniquePairs = Array.from(new Set(unionMap.values()));
    uniquePairs.sort((a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime());
    return uniquePairs;
  }
}
