// D:\Ashish_P\AI-Tools\custom-OCT\tests\test_working_directory.js
// Automated verification for Working Project Directory Selection & Explicit Propagation

import { WorkbenchServer } from '../server/server.js';
import path from 'path';
import fs from 'fs';
import os from 'os';

const CWD = 'D:\\Ashish_P\\AI-Tools\\custom-OCT';

async function run() {
  console.log('===============================================================');
  console.log('  Working Project Directory Selection Verification Suite');
  console.log('===============================================================\n');

  const server = new WorkbenchServer({ cwd: CWD, port: 0 });
  const { port, sessionToken } = await server.start();
  const report = { passed: false, checks: [] };

  // Create isolated disposable temporary directory (never touch SpineIT-ERP)
  const tempProjectDir1 = path.join(os.tmpdir(), `test_project_1_${Date.now()}`);
  const tempProjectDir2 = path.join(os.tmpdir(), `test_project_2_${Date.now()}`);
  fs.mkdirSync(tempProjectDir1, { recursive: true });
  fs.mkdirSync(tempProjectDir2, { recursive: true });

  const markerFile1 = path.join(tempProjectDir1, 'PROJECT_MARKER.txt');
  fs.writeFileSync(markerFile1, 'ALPHA_PROJECT_123', 'utf-8');

  try {
    // -------------------------------------------------------------
    // Check 1: Initial default working directory
    // -------------------------------------------------------------
    const initRes = await fetch(`http://127.0.0.1:${port}/api/workspace`, {
      headers: { 'X-Session-Token': sessionToken }
    });
    const initData = await initRes.json();
    const initPass = initData.projectCwd === CWD && initData.appDir === CWD;

    report.checks.push({
      check: 'Initial working directory defaults to workbench directory',
      passed: initPass,
      data: initData
    });
    console.log(`[Check 1] Initial default working directory: ${initPass ? 'PASSED' : 'FAILED'}`);

    // -------------------------------------------------------------
    // Check 2: Validation of invalid / non-existent directory
    // -------------------------------------------------------------
    const fakePath = 'Z:\\NonExistent_Folder_123456';
    const badRes = await fetch(`http://127.0.0.1:${port}/api/workspace/select`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': sessionToken
      },
      body: JSON.stringify({ path: fakePath })
    });

    const badData = await badRes.json();
    const badPass = badRes.status === 400 && badData.error && badData.error.includes('does not exist');

    report.checks.push({
      check: 'Reject non-existent directory with HTTP 400',
      passed: badPass,
      errorReturned: badData.error
    });
    console.log(`[Check 2] Rejection of invalid directory: ${badPass ? 'PASSED' : 'FAILED'}`);

    // -------------------------------------------------------------
    // Check 3: Select valid working project directory
    // -------------------------------------------------------------
    const selectRes = await fetch(`http://127.0.0.1:${port}/api/workspace/select`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': sessionToken
      },
      body: JSON.stringify({ path: tempProjectDir1 })
    });

    const selectData = await selectRes.json();
    const resolved1 = path.resolve(tempProjectDir1);
    const selectPass = selectRes.status === 200 && selectData.projectCwd === resolved1;

    report.checks.push({
      check: 'Switch working project directory to tempProjectDir1',
      passed: selectPass,
      projectCwd: selectData.projectCwd
    });
    console.log(`[Check 3] Switch working project directory: ${selectPass ? 'PASSED' : 'FAILED'}`);

    // -------------------------------------------------------------
    // Check 4: Newly launched interactive terminal starts in selected directory
    // -------------------------------------------------------------
    const termRes = await fetch(`http://127.0.0.1:${port}/api/terminals/claude/start`, {
      method: 'POST',
      headers: { 'X-Session-Token': sessionToken }
    });
    const termData = await termRes.json();
    const termCwdPass = termData.status === 'RUNNING' && termData.cwd === resolved1;

    report.checks.push({
      check: 'Interactive Claude terminal spawned with explicit selected cwd',
      passed: termCwdPass,
      terminalPid: termData.pid,
      terminalCwd: termData.cwd
    });
    console.log(`[Check 4] Terminal cwd propagation: ${termCwdPass ? 'PASSED' : 'FAILED'}`);

    // -------------------------------------------------------------
    // Check 5: Delegated tasks execute with explicit selected cwd
    // -------------------------------------------------------------
    const corrId = `CORR_DIR_TEST_${Date.now()}`;
    const taskSubmitRes = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': sessionToken
      },
      body: JSON.stringify({
        correlationId: corrId,
        targetAgent: 'gemini',
        prompt: `Echo: WORKING_DIR_TASK_${corrId}`
      })
    });

    const taskSubmitData = await taskSubmitRes.json();
    const taskCwdPass = taskSubmitData.task && taskSubmitData.task.cwd === resolved1;

    // Await completion of task before next check
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 400));
      const pollRes = await fetch(`http://127.0.0.1:${port}/api/tasks/${corrId}`, {
        headers: { 'X-Session-Token': sessionToken }
      });
      if (pollRes.status === 200) {
        const t = await pollRes.json();
        if (t.state === 'COMPLETED') break;
      }
    }

    report.checks.push({
      check: 'Delegated task explicitly inherits selected project working directory',
      passed: taskCwdPass,
      taskCwd: taskSubmitData.task?.cwd
    });
    console.log(`[Check 5] Delegated task cwd propagation: ${taskCwdPass ? 'PASSED' : 'FAILED'}`);

    // -------------------------------------------------------------
    // Check 6: Changing folder does NOT silently restart running sessions (Rule 6)
    // -------------------------------------------------------------
    const origClaudePid = termData.pid;
    const resolved2 = path.resolve(tempProjectDir2);

    const switch2Res = await fetch(`http://127.0.0.1:${port}/api/workspace/select`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': sessionToken
      },
      body: JSON.stringify({ path: tempProjectDir2 })
    });
    const switch2Data = await switch2Res.json();

    // Check Claude terminal status: PID must be unchanged!
    const claudeStatusRes = await fetch(`http://127.0.0.1:${port}/api/terminals`, {
      headers: { 'X-Session-Token': sessionToken }
    });
    const allStatuses = await claudeStatusRes.json();
    const claudeUnchanged = allStatuses.claude.pid === origClaudePid && allStatuses.claude.status === 'RUNNING';

    // Start Gemini terminal: must spawn in tempProjectDir2!
    const geminiStartRes = await fetch(`http://127.0.0.1:${port}/api/terminals/gemini/start`, {
      method: 'POST',
      headers: { 'X-Session-Token': sessionToken }
    });
    const geminiStartData = await geminiStartRes.json();
    const geminiInNewDir = geminiStartData.cwd === resolved2;

    const rule6Pass = claudeUnchanged && geminiInNewDir;
    report.checks.push({
      check: 'Existing running sessions undisturbed; new sessions use updated folder',
      passed: rule6Pass,
      origClaudePid,
      currentClaudePid: allStatuses.claude.pid,
      newGeminiCwd: geminiStartData.cwd
    });
    console.log(`[Check 6] Rule 6 undisturbed running sessions: ${rule6Pass ? 'PASSED' : 'FAILED'}`);

    // Terminate terminals
    await fetch(`http://127.0.0.1:${port}/api/terminals/claude/terminate`, { method: 'POST', headers: { 'X-Session-Token': sessionToken } });
    await fetch(`http://127.0.0.1:${port}/api/terminals/gemini/terminate`, { method: 'POST', headers: { 'X-Session-Token': sessionToken } });

    const allPassed = report.checks.every(c => c.passed);
    report.passed = allPassed;

    console.log('\n===============================================================');
    console.log(`  WORKING DIRECTORY TEST MATRIX: ${allPassed ? 'ALL PASSED' : 'FAILED'}`);
    console.log('===============================================================\n');

  } catch (err) {
    console.error('[Working Directory Test Fatal]', err);
    report.passed = false;
    report.error = err.message;
  } finally {
    await server.shutdown();
    // Cleanup temporary test directories
    try {
      fs.rmSync(tempProjectDir1, { recursive: true, force: true });
      fs.rmSync(tempProjectDir2, { recursive: true, force: true });
    } catch (e) {}
  }

  if (!report.passed) process.exit(1);
  process.exit(0);
}

run();
