// D:\Ashish_P\AI-Tools\custom-OCT\tests\test_terminal_restart_cwd.js
// Regression test verifying terminal restart updates working directory and re-attaches stream

import { WorkbenchServer } from '../server/server.js';
import { WebSocket } from 'ws';
import path from 'path';
import fs from 'fs';
import os from 'os';

const CWD = 'D:\\Ashish_P\\AI-Tools\\custom-OCT';

async function run() {
  console.log('===============================================================');
  console.log('  Testing Terminal Restart with Working Directory Change');
  console.log('===============================================================\n');

  const server = new WorkbenchServer({ cwd: CWD, port: 0 });
  const { port, sessionToken } = await server.start();
  const checks = [];

  const tempProjectDir = path.join(os.tmpdir(), `test_restart_project_${Date.now()}`);
  fs.mkdirSync(tempProjectDir, { recursive: true });

  try {
    // 1. Start claude terminal in initial directory
    console.log('[Step 1] Spawning Claude terminal in initial directory...');
    const startRes = await (await fetch(`http://127.0.0.1:${port}/api/terminals/claude/start`, {
      method: 'POST',
      headers: { 'X-Session-Token': sessionToken }
    })).json();

    const oldPid = startRes.pid;
    const oldCwd = startRes.cwd;
    console.log(`[Step 1] Initial Claude terminal PID: ${oldPid}, CWD: ${oldCwd}`);

    checks.push({
      test: 'Initial Claude terminal started with default CWD',
      passed: startRes.status === 'RUNNING' && oldCwd === CWD
    });

    // 2. Connect WebSocket to Claude terminal
    console.log('[Step 2] Connecting WebSocket to Claude terminal...');
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal?id=claude`, [`token.${sessionToken}`], {
      origin: `http://127.0.0.1:${port}`
    });
    let initialOutput = '';

    await new Promise((resolve, reject) => {
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'auth', token: sessionToken }));
      });
      ws.on('message', (d) => {
        const msg = JSON.parse(d.toString());
        if (msg.type === 'output') {
          initialOutput += msg.data;
          if (initialOutput.length > 20) resolve();
        }
      });
      setTimeout(resolve, 3000);
    });

    console.log(`[Step 2] Received initial output (${initialOutput.length} chars).`);

    // 3. Change working directory via /api/workspace/select
    console.log(`[Step 3] Updating working directory to: ${tempProjectDir}`);
    const selectRes = await (await fetch(`http://127.0.0.1:${port}/api/workspace/select`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': sessionToken },
      body: JSON.stringify({ path: tempProjectDir })
    })).json();

    const resolvedTemp = path.resolve(tempProjectDir);
    checks.push({
      test: 'Workspace directory updated',
      passed: selectRes.projectCwd === resolvedTemp
    });

    // 4. Restart Claude terminal
    console.log('[Step 4] Restarting Claude terminal...');
    let postRestartOutput = '';

    // Listen on the re-attached WebSocket for post-restart output
    ws.on('message', (d) => {
      const msg = JSON.parse(d.toString());
      if (msg.type === 'output') {
        postRestartOutput += msg.data;
      }
    });

    const restartRes = await (await fetch(`http://127.0.0.1:${port}/api/terminals/claude/restart`, {
      method: 'POST',
      headers: { 'X-Session-Token': sessionToken }
    })).json();

    const newPid = restartRes.pid;
    const newCwd = restartRes.cwd;
    console.log(`[Step 4] Restarted Claude terminal PID: ${newPid}, CWD: ${newCwd}`);

    // Wait 2s for post-restart output stream
    await new Promise(r => setTimeout(r, 2000));

    const pidChanged = newPid !== oldPid && typeof newPid === 'number';
    const cwdChanged = newCwd === resolvedTemp;
    const receivedNewOutput = postRestartOutput.length > 0;

    checks.push({
      test: 'Restart terminates old PID and spawns new PID in updated CWD',
      passed: pidChanged && cwdChanged,
      oldPid,
      newPid,
      newCwd
    });

    checks.push({
      test: 'Re-attached WebSocket receives fresh output stream from new CWD process',
      passed: receivedNewOutput,
      postRestartChars: postRestartOutput.length
    });

    // 5. Verify /logs/workbench.log exists and contains the actions
    const logFilePath = path.join(CWD, 'logs', 'workbench.log');
    const logExists = fs.existsSync(logFilePath);
    let logContent = '';
    if (logExists) {
      logContent = fs.readFileSync(logFilePath, 'utf-8');
    }

    const hasSpawnLog = logContent.includes('TERMINAL:SPAWN');
    const hasRestartLog = logContent.includes('TERMINAL:RESTART');
    const hasCwdUpdateLog = logContent.includes('TERMINAL:CWD_UPDATE');

    checks.push({
      test: 'Logger file logs/workbench.log recorded all lifecycle actions',
      passed: logExists && hasSpawnLog && hasRestartLog && hasCwdUpdateLog,
      logExists,
      hasSpawnLog,
      hasRestartLog,
      hasCwdUpdateLog
    });

    ws.close();
  } finally {
    await server.shutdown();
    try { fs.rmSync(tempProjectDir, { recursive: true, force: true }); } catch (e) {}
  }

  console.log('\n--- Test Results ---');
  let allPassed = true;
  for (const c of checks) {
    if (!c.passed) allPassed = false;
    console.log(`  ${c.passed ? '[PASS]' : '[FAIL]'} ${c.test}`);
    if (!c.passed) console.log('    Details:', JSON.stringify(c));
  }

  console.log('===============================================================');
  console.log(`Result: ${allPassed ? 'ALL PASSED' : 'FAILED'}`);
  console.log('===============================================================\n');

  if (!allPassed) process.exit(1);
  process.exit(0);
}

run().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
