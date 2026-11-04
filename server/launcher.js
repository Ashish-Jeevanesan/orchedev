// D:\Ashish_P\AI-Tools\custom-OCT\server\launcher.js
// Main Application Launcher: Starts Workbench Server and opens native App Window

import { WorkbenchServer } from './server.js';
import { spawn, execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CWD = process.env.WORKBENCH_CWD || path.resolve(__dirname, '..');
const SESSION_FILE = path.join(os.tmpdir(), 'orchedev_session.json');
const USER_DATA_DIR = path.join(os.tmpdir(), 'workbench_edge_profile');

function findBrowserBinary() {
  const edgePaths = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft\\Edge\\Application\\msedge.exe')
  ];

  for (const p of edgePaths) {
    if (fs.existsSync(p)) return p;
  }

  const chromePaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe')
  ];

  for (const p of chromePaths) {
    if (fs.existsSync(p)) return p;
  }

  return null;
}

async function main() {
  console.log('===============================================================');
  console.log('  Starting Claude + Gemini Agent Workbench (Desktop App Mode)');
  console.log('===============================================================\n');

  const server = new WorkbenchServer({
    cwd: CWD,
    port: process.env.PORT ? Number(process.env.PORT) : 0
  });

  const { port, sessionToken } = await server.start();

  // Save session details securely
  const sessionInfo = {
    port,
    sessionToken,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    persistence: 'SESSION_ONLY'
  };

  fs.writeFileSync(SESSION_FILE, JSON.stringify(sessionInfo, null, 2), {
    encoding: 'utf-8',
    mode: 0o600
  });

  console.log(`[Launcher] Workbench running on loopback: http://127.0.0.1:${port}`);
  console.log(`[Launcher] Authentication: Per-launch session token generated`);
  console.log(`[Launcher] Task persistence: Explicitly Session-Only`);

  // Target URL passes token in hash fragment (never transmitted in HTTP headers or access logs)
  const appUrl = `http://127.0.0.1:${port}/#token=${sessionToken}`;

  const browserBin = findBrowserBinary();

  if (browserBin && !process.env.HEADLESS) {
    console.log(`[Launcher] Opening standalone window via: ${browserBin}`);
    const appWindow = spawn(browserBin, [
      `--app=${appUrl}`,
      `--user-data-dir=${USER_DATA_DIR}`,
      '--no-first-run',
      '--no-default-browser-check'
    ], {
      detached: true,
      stdio: 'ignore'
    });
    appWindow.unref();
  } else if (!process.env.HEADLESS) {
    console.log('[Launcher] Opening in default browser...');
    execSync(`start ${appUrl}`, { stdio: 'ignore' });
  } else {
    console.log('[Launcher] Running in HEADLESS mode (window spawn skipped)');
  }

  let cleaningUp = false;
  async function cleanup() {
    if (cleaningUp) return;
    cleaningUp = true;
    console.log('\n[Launcher] Shutting down...');
    if (fs.existsSync(SESSION_FILE)) {
      try { fs.unlinkSync(SESSION_FILE); } catch (e) {}
    }
    await server.shutdown();
    process.exit(0);
  }

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('exit', () => {
    if (fs.existsSync(SESSION_FILE)) {
      try { fs.unlinkSync(SESSION_FILE); } catch (e) {}
    }
  });
}

main().catch((err) => {
  console.error('[Launcher FATAL]', err);
  process.exit(1);
});
