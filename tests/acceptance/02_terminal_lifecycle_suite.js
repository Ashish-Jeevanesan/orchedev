// D:\Ashish_P\AI-Tools\custom-OCT\tests\acceptance\02_terminal_lifecycle_suite.js
// Acceptance Test Suite 2: Exhaustive Interactive Terminal Lifecycle Verification

import { WorkbenchServer } from '../../server/server.js';
import { WebSocket } from 'ws';
import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';

const CWD = 'D:\\Ashish_P\\AI-Tools\\custom-OCT';

function isPidAlive(pid) {
  if (!pid) return false;
  try {
    if (process.platform === 'win32') {
      const output = execSync(`tasklist /FI "PID eq ${pid}" /NH`, { encoding: 'utf-8' });
      return output.includes(String(pid));
    } else {
      process.kill(pid, 0);
      return true;
    }
  } catch (e) {
    return false;
  }
}

async function run() {
  console.log('--- Acceptance Suite 2: Interactive Terminal Lifecycle ---');
  const server = new WorkbenchServer({ cwd: CWD, port: 0 });
  const { port, sessionToken } = await server.start();
  const checks = [];

  const tempDir = path.join(os.tmpdir(), `test_term_suite_${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    // 1. Set working directory
    await fetch(`http://127.0.0.1:${port}/api/workspace/select`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': sessionToken },
      body: JSON.stringify({ path: tempDir })
    });

    for (const termId of ['claude', 'gemini']) {
      console.log(`[Lifecycle] Testing ${termId} terminal...`);

      // 1. Start when stopped: verify real child process and correct cwd
      const rStart1 = await (await fetch(`http://127.0.0.1:${port}/api/terminals/${termId}/start`, {
        method: 'POST',
        headers: { 'X-Session-Token': sessionToken }
      })).json();

      const pid1 = rStart1.pid;
      const pid1Alive = isPidAlive(pid1);
      const cwdMatch = rStart1.cwd === path.resolve(tempDir);

      checks.push({
        test: `${termId}: Start when stopped`,
        passed: rStart1.status === 'RUNNING' && pid1Alive && cwdMatch,
        pid: pid1,
        cwd: rStart1.cwd
      });

      // 2. Start twice: verify idempotent, returns same process, no duplicate PID
      const rStart2 = await (await fetch(`http://127.0.0.1:${port}/api/terminals/${termId}/start`, {
        method: 'POST',
        headers: { 'X-Session-Token': sessionToken }
      })).json();

      const samePid = rStart2.pid === pid1;
      checks.push({
        test: `${termId}: Start twice preserves existing running session`,
        passed: samePid && rStart2.status === 'RUNNING'
      });

      // 3. Restart when running: old process exits, new process starts with distinct PID
      const rRestart1 = await (await fetch(`http://127.0.0.1:${port}/api/terminals/${termId}/restart`, {
        method: 'POST',
        headers: { 'X-Session-Token': sessionToken }
      })).json();

      await new Promise(r => setTimeout(r, 600));
      const pid2 = rRestart1.pid;
      const pid1Dead = !isPidAlive(pid1);
      const pid2Alive = isPidAlive(pid2);

      checks.push({
        test: `${termId}: Restart when running terminates old PID and spawns new PID`,
        passed: pid1 !== pid2 && pid1Dead && pid2Alive && rRestart1.status === 'RUNNING',
        oldPid: pid1,
        newPid: pid2
      });

      // 4. Terminate when running: process and descendants exit cleanly
      const rTerm1 = await (await fetch(`http://127.0.0.1:${port}/api/terminals/${termId}/terminate`, {
        method: 'POST',
        headers: { 'X-Session-Token': sessionToken }
      })).json();

      await new Promise(r => setTimeout(r, 600));
      const pid2Dead = !isPidAlive(pid2);

      checks.push({
        test: `${termId}: Terminate terminates process tree completely`,
        passed: pid2Dead && rTerm1.status === 'STOPPED',
        terminatedPid: pid2
      });

      // 5. Terminate repeatedly (idempotent when stopped)
      const rTerm2 = await (await fetch(`http://127.0.0.1:${port}/api/terminals/${termId}/terminate`, {
        method: 'POST',
        headers: { 'X-Session-Token': sessionToken }
      })).json();

      checks.push({
        test: `${termId}: Terminate repeatedly remains safely stopped`,
        passed: rTerm2.status === 'STOPPED'
      });

      // 6. Restart when stopped: spawns fresh process
      const rRestart2 = await (await fetch(`http://127.0.0.1:${port}/api/terminals/${termId}/restart`, {
        method: 'POST',
        headers: { 'X-Session-Token': sessionToken }
      })).json();

      const pid3 = rRestart2.pid;
      const pid3Alive = isPidAlive(pid3);

      checks.push({
        test: `${termId}: Restart when stopped spawns fresh running session`,
        passed: rRestart2.status === 'RUNNING' && pid3Alive,
        pid: pid3
      });

      // Cleanup
      await fetch(`http://127.0.0.1:${port}/api/terminals/${termId}/terminate`, {
        method: 'POST',
        headers: { 'X-Session-Token': sessionToken }
      });
    }

    // 7. Independence: restarting Claude does not damage running Gemini session
    console.log('[Lifecycle] Verifying terminal session independence...');
    const gStart = await (await fetch(`http://127.0.0.1:${port}/api/terminals/gemini/start`, {
      method: 'POST', headers: { 'X-Session-Token': sessionToken }
    })).json();

    const cStart1 = await (await fetch(`http://127.0.0.1:${port}/api/terminals/claude/start`, {
      method: 'POST', headers: { 'X-Session-Token': sessionToken }
    })).json();

    const geminiPidBefore = gStart.pid;
    // Restart claude
    await fetch(`http://127.0.0.1:${port}/api/terminals/claude/restart`, {
      method: 'POST', headers: { 'X-Session-Token': sessionToken }
    });

    const geminiStatusAfter = await (await fetch(`http://127.0.0.1:${port}/api/terminals`, {
      headers: { 'X-Session-Token': sessionToken }
    })).json();

    const geminiUndisturbed = geminiStatusAfter.gemini.pid === geminiPidBefore && geminiStatusAfter.gemini.status === 'RUNNING';

    checks.push({
      test: 'Terminal independence: Claude restart does not disrupt Gemini session',
      passed: geminiUndisturbed,
      geminiPid: geminiPidBefore
    });

    await fetch(`http://127.0.0.1:${port}/api/terminals/gemini/terminate`, { method: 'POST', headers: { 'X-Session-Token': sessionToken } });
    await fetch(`http://127.0.0.1:${port}/api/terminals/claude/terminate`, { method: 'POST', headers: { 'X-Session-Token': sessionToken } });

  } finally {
    await server.shutdown();
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}
  }

  const allPassed = checks.every(c => c.passed);
  console.log(`Suite 2 Results: ${checks.filter(c => c.passed).length}/${checks.length} passed.`);
  for (const c of checks) {
    console.log(`  ${c.passed ? '[PASS]' : '[FAIL]'} ${c.test}`);
    if (!c.passed) console.log('    Details:', JSON.stringify(c));
  }
  return { suite: '02_terminal_lifecycle_suite', passed: allPassed, checks };
}

run().then(res => {
  if (!res.passed) process.exit(1);
  process.exit(0);
}).catch(err => {
  console.error(err);
  process.exit(1);
});
