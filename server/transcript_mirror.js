// server/transcript_mirror.js
// Cross-device transcript mirroring & restoration for Claude Code and Gemini CLI

import fs from 'fs';
import path from 'path';
import os from 'os';
import { claudeProjectDirName } from './cli_session_registry.js';
import { logger } from './logger.js';

export class TranscriptMirror {
  constructor({ cwd }) {
    this.cwd = cwd; // Workspace root
  }

  getClaudeMirrorDir() {
    return path.join(this.cwd, '.workbench_cli_sessions', 'claude');
  }

  getGeminiMirrorDir() {
    return path.join(this.cwd, '.workbench_cli_sessions', 'gemini');
  }

  // --- Claude Mirroring ---

  mirrorClaude(cliSessionId, projectCwd = null) {
    if (!cliSessionId) return false;
    const targetCwd = projectCwd || this.cwd;
    const sourceDir = path.join(os.homedir(), '.claude', 'projects', claudeProjectDirName(targetCwd));
    const sourceFile = path.join(sourceDir, `${cliSessionId}.jsonl`);

    if (!fs.existsSync(sourceFile)) {
      return false;
    }

    try {
      const destDir = this.getClaudeMirrorDir();
      if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
      }
      const destFile = path.join(destDir, `${cliSessionId}.jsonl`);

      const sourceStat = fs.statSync(sourceFile);
      if (sourceStat.size === 0) return false;

      if (fs.existsSync(destFile)) {
        const destStat = fs.statSync(destFile);
        if (destStat.mtimeMs >= sourceStat.mtimeMs && destStat.size >= sourceStat.size) {
          return false; // Already up-to-date
        }
      }

      fs.copyFileSync(sourceFile, destFile);
      logger.info('MIRROR:CLAUDE_COPIED', `Mirrored Claude transcript ${cliSessionId}.jsonl (${sourceStat.size} bytes)`);
      return true;
    } catch (err) {
      logger.warn('MIRROR:CLAUDE_ERROR', `Failed to mirror Claude transcript ${cliSessionId}: ${err.message}`);
      return false;
    }
  }

  restoreClaude(cliSessionId, projectCwd = null) {
    if (!cliSessionId) return { exists: false, restored: false };
    const targetCwd = projectCwd || this.cwd;
    const localDir = path.join(os.homedir(), '.claude', 'projects', claudeProjectDirName(targetCwd));
    const localFile = path.join(localDir, `${cliSessionId}.jsonl`);

    // 1. Check if already present on this device
    if (fs.existsSync(localFile)) {
      try {
        const stat = fs.statSync(localFile);
        if (stat.size > 0) {
          return { exists: true, restored: false, path: localFile };
        }
      } catch (e) {}
    }

    // 2. Check mirrored transcript
    const mirroredFile = path.join(this.getClaudeMirrorDir(), `${cliSessionId}.jsonl`);
    if (!fs.existsSync(mirroredFile)) {
      return { exists: false, restored: false };
    }

    try {
      if (!fs.existsSync(localDir)) {
        fs.mkdirSync(localDir, { recursive: true });
      }
      fs.copyFileSync(mirroredFile, localFile);
      logger.info('RESTORE:CLAUDE_RESTORED', `Restored Claude transcript ${cliSessionId}.jsonl to local profile directory`);
      return { exists: true, restored: true, path: localFile };
    } catch (err) {
      logger.error('RESTORE:CLAUDE_ERROR', `Failed to restore Claude transcript ${cliSessionId}: ${err.message}`);
      return { exists: false, restored: false, error: err.message };
    }
  }

  // --- Gemini Mirroring ---

  mirrorGemini(cliSessionId, projectCwd = null) {
    if (!cliSessionId) return false;
    const targetCwd = projectCwd || this.cwd;
    const normCwd = path.resolve(targetCwd).toLowerCase();
    const geminiTmp = path.join(os.homedir(), '.gemini', 'tmp');

    if (!fs.existsSync(geminiTmp)) return false;

    // Find the chat file matching cliSessionId
    let sourceFile = null;
    let sourceFileName = null;

    try {
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

        const files = fs.readdirSync(chatsDir).filter(f => f.endsWith('.jsonl'));
        for (const f of files) {
          const fp = path.join(chatsDir, f);
          try {
            const fd = fs.openSync(fp, 'r');
            const buf = Buffer.alloc(2048);
            const bytesRead = fs.readSync(fd, buf, 0, 2048, 0);
            fs.closeSync(fd);
            const firstLine = buf.toString('utf8', 0, bytesRead).split('\n')[0];
            const parsed = JSON.parse(firstLine);
            if (parsed.sessionId === cliSessionId || f.includes(cliSessionId.slice(0, 8))) {
              sourceFile = fp;
              sourceFileName = f;
              break;
            }
          } catch (e) {}
        }
        if (sourceFile) break;
      }

      if (!sourceFile) return false;

      const destDir = this.getGeminiMirrorDir();
      if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
      }
      const destFile = path.join(destDir, sourceFileName);

      const sourceStat = fs.statSync(sourceFile);
      if (sourceStat.size === 0) return false;

      if (fs.existsSync(destFile)) {
        const destStat = fs.statSync(destFile);
        if (destStat.mtimeMs >= sourceStat.mtimeMs && destStat.size >= sourceStat.size) {
          return false;
        }
      }

      fs.copyFileSync(sourceFile, destFile);
      logger.info('MIRROR:GEMINI_COPIED', `Mirrored Gemini chat ${sourceFileName} (${sourceStat.size} bytes)`);
      return true;
    } catch (err) {
      logger.warn('MIRROR:GEMINI_ERROR', `Failed to mirror Gemini chat ${cliSessionId}: ${err.message}`);
      return false;
    }
  }

  restoreGemini(cliSessionId, projectCwd = null) {
    if (!cliSessionId) return { exists: false, restored: false };
    const targetCwd = projectCwd || this.cwd;
    const resolvedTarget = path.resolve(targetCwd);
    const normCwd = resolvedTarget.toLowerCase();
    const geminiTmp = path.join(os.homedir(), '.gemini', 'tmp');

    if (!fs.existsSync(geminiTmp)) {
      fs.mkdirSync(geminiTmp, { recursive: true });
    }

    // 1. Locate existing local slug folder whose .project_root matches local cwd
    let localSlugDir = null;
    try {
      const dirs = fs.readdirSync(geminiTmp);
      for (const d of dirs) {
        const full = path.join(geminiTmp, d);
        try {
          if (!fs.statSync(full).isDirectory()) continue;
        } catch (e) { continue; }
        const rf = path.join(full, '.project_root');
        if (fs.existsSync(rf)) {
          try {
            const owner = path.resolve(fs.readFileSync(rf, 'utf8').trim()).toLowerCase();
            if (owner === normCwd) {
              localSlugDir = full;
              break;
            }
          } catch (e) {}
        }
      }
    } catch (e) {}

    // If local slug exists, check if session is already present locally
    if (localSlugDir) {
      const chatsDir = path.join(localSlugDir, 'chats');
      if (fs.existsSync(chatsDir)) {
        const files = fs.readdirSync(chatsDir).filter(f => f.endsWith('.jsonl'));
        for (const f of files) {
          const fp = path.join(chatsDir, f);
          try {
            const fd = fs.openSync(fp, 'r');
            const buf = Buffer.alloc(2048);
            const bytesRead = fs.readSync(fd, buf, 0, 2048, 0);
            fs.closeSync(fd);
            const firstLine = buf.toString('utf8', 0, bytesRead).split('\n')[0];
            const parsed = JSON.parse(firstLine);
            if (parsed.sessionId === cliSessionId || f.includes(cliSessionId.slice(0, 8))) {
              return { exists: true, restored: false, path: fp };
            }
          } catch (e) {}
        }
      }
    }

    // 2. Locate mirrored Gemini file
    const mirrorDir = this.getGeminiMirrorDir();
    if (!fs.existsSync(mirrorDir)) {
      return { exists: false, restored: false };
    }

    let mirroredFile = null;
    let mirroredFileName = null;
    try {
      const mirrorFiles = fs.readdirSync(mirrorDir).filter(f => f.endsWith('.jsonl'));
      for (const f of mirrorFiles) {
        const fp = path.join(mirrorDir, f);
        try {
          const fd = fs.openSync(fp, 'r');
          const buf = Buffer.alloc(2048);
          const bytesRead = fs.readSync(fd, buf, 0, 2048, 0);
          fs.closeSync(fd);
          const firstLine = buf.toString('utf8', 0, bytesRead).split('\n')[0];
          const parsed = JSON.parse(firstLine);
          if (parsed.sessionId === cliSessionId || f.includes(cliSessionId.slice(0, 8))) {
            mirroredFile = fp;
            mirroredFileName = f;
            break;
          }
        } catch (e) {}
      }
    } catch (e) {}

    if (!mirroredFile) {
      return { exists: false, restored: false };
    }

    // 3. Ensure local slug folder exists with accurate .project_root
    try {
      if (!localSlugDir) {
        const baseSlug = path.basename(resolvedTarget).toLowerCase().replace(/[^a-z0-9_-]/g, '-');
        let candSlug = baseSlug;
        let suffix = 1;
        while (fs.existsSync(path.join(geminiTmp, candSlug))) {
          const rf = path.join(geminiTmp, candSlug, '.project_root');
          if (fs.existsSync(rf)) {
            try {
              if (path.resolve(fs.readFileSync(rf, 'utf8').trim()).toLowerCase() === normCwd) {
                break;
              }
            } catch (e) {}
          }
          candSlug = `${baseSlug}-${suffix++}`;
        }
        localSlugDir = path.join(geminiTmp, candSlug);
        fs.mkdirSync(localSlugDir, { recursive: true });
        fs.writeFileSync(path.join(localSlugDir, '.project_root'), resolvedTarget, 'utf8');
      }

      const chatsDir = path.join(localSlugDir, 'chats');
      if (!fs.existsSync(chatsDir)) {
        fs.mkdirSync(chatsDir, { recursive: true });
      }

      const targetChatPath = path.join(chatsDir, mirroredFileName);
      fs.copyFileSync(mirroredFile, targetChatPath);
      logger.info('RESTORE:GEMINI_RESTORED', `Restored Gemini chat ${mirroredFileName} to local slug ${path.basename(localSlugDir)}`);
      return { exists: true, restored: true, path: targetChatPath };
    } catch (err) {
      logger.error('RESTORE:GEMINI_ERROR', `Failed to restore Gemini chat ${cliSessionId}: ${err.message}`);
      return { exists: false, restored: false, error: err.message };
    }
  }
}
