// server/transcript_mirror.js
// Cross-device transcript mirroring & restoration for Claude Code and Gemini CLI

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
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

  // --- Preflight & Dehydration Detection ---

  async checkPreflight({ sessionId, agent = null, expectedFiles = [], hydrate = false, projectCwd = null }) {
    const targetCwd = projectCwd || this.cwd;
    let transcriptPath = null;

    if (agent === 'claude' || !agent) {
      const localDir = path.join(os.homedir(), '.claude', 'projects', claudeProjectDirName(targetCwd));
      const localFile = path.join(localDir, `${sessionId}.jsonl`);
      if (fs.existsSync(localFile)) {
        transcriptPath = localFile;
      } else {
        const mirroredFile = path.join(this.getClaudeMirrorDir(), `${sessionId}.jsonl`);
        if (fs.existsSync(mirroredFile)) {
          transcriptPath = mirroredFile;
        }
      }
    }

    if (!transcriptPath && (agent === 'gemini' || !agent)) {
      const geminiTmp = path.join(os.homedir(), '.gemini', 'tmp');
      if (fs.existsSync(geminiTmp)) {
        const normCwd = path.resolve(targetCwd).toLowerCase();
        try {
          const dirs = fs.readdirSync(geminiTmp);
          for (const d of dirs) {
            const full = path.join(geminiTmp, d);
            const rf = path.join(full, '.project_root');
            if (fs.existsSync(rf)) {
              try {
                if (path.resolve(fs.readFileSync(rf, 'utf8').trim()).toLowerCase() === normCwd) {
                  const chatsDir = path.join(full, 'chats');
                  if (fs.existsSync(chatsDir)) {
                    const files = fs.readdirSync(chatsDir).filter((f) => f.endsWith('.jsonl'));
                    for (const f of files) {
                      if (f.includes(sessionId.slice(0, 8))) {
                        transcriptPath = path.join(chatsDir, f);
                        break;
                      }
                    }
                  }
                }
              } catch (e) {}
            }
            if (transcriptPath) break;
          }
        } catch (e) {}
      }

      if (!transcriptPath) {
        const mirrorDir = this.getGeminiMirrorDir();
        if (fs.existsSync(mirrorDir)) {
          try {
            const files = fs.readdirSync(mirrorDir).filter((f) => f.endsWith('.jsonl'));
            for (const f of files) {
              if (f.includes(sessionId.slice(0, 8))) {
                transcriptPath = path.join(mirrorDir, f);
                break;
              }
            }
          } catch (e) {}
        }
      }
    }

    if (!transcriptPath) {
      return {
        status: 'MISSING',
        canResume: false,
        unhydratedFiles: [],
        message: 'This session cannot be opened yet because its conversation history has not synced to this device from OneDrive. Please check your OneDrive connection and try again.'
      };
    }

    const unhydrated = [];
    if (isFileDehydrated(transcriptPath)) {
      let size = 0;
      try { size = fs.statSync(transcriptPath).size; } catch (e) {}
      unhydrated.push({ path: transcriptPath, size });
    }

    for (const ef of expectedFiles) {
      const fullEf = path.resolve(targetCwd, ef);
      if (fs.existsSync(fullEf) && isFileDehydrated(fullEf)) {
        let size = 0;
        try { size = fs.statSync(fullEf).size; } catch (e) {}
        unhydrated.push({ path: fullEf, size });
      }
    }

    if (unhydrated.length > 0) {
      if (hydrate) {
        try {
          for (const item of unhydrated) {
            await hydrateFile(item.path);
          }
          return {
            status: 'READY',
            canResume: true,
            unhydratedFiles: [],
            message: 'All files successfully downloaded. Ready to resume.'
          };
        } catch (err) {
          return {
            status: 'DEHYDRATED',
            canResume: false,
            unhydratedFiles: unhydrated,
            message: 'This session cannot be opened yet because its conversation history has not synced to this device from OneDrive. Please check your OneDrive connection and try again.'
          };
        }
      }

      return {
        status: 'DEHYDRATED',
        canResume: true,
        unhydratedFiles: unhydrated,
        message: 'Session transcript is a cloud placeholder and needs to be downloaded.'
      };
    }

    return {
      status: 'READY',
      canResume: true,
      unhydratedFiles: [],
      message: 'Session is ready to resume.'
    };
  }
}

export function isFileDehydrated(filePath) {
  try {
    if (!fs.existsSync(filePath)) return false;
    if (process.platform === 'win32') {
      const out = execSync(`attrib "${filePath}"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const attribs = out.slice(0, out.lastIndexOf(filePath)).trim();
      return attribs.split(/\s+/).includes('O') || attribs.includes('O');
    } else if (process.platform === 'darwin') {
      const stat = fs.statSync(filePath);
      return Boolean(Number(stat.flags || 0) & 0x40000000);
    }
  } catch (e) {}
  return false;
}

export async function hydrateFile(filePath, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        reject(new Error(`Hydration timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    const stream = fs.createReadStream(filePath);
    stream.on('data', () => {});
    stream.on('end', () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve(true);
      }
    });
    stream.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        reject(err);
      }
    });
  });
}
