// D:\Ashish_P\AI-Tools\custom-OCT\tests\acceptance\04_lifecycle_edge_cases.js
// Acceptance Test Suite 4: Task Dispatch, Concurrency & Lifecycle Edge Cases

import { WorkbenchServer } from '../../server/server.js';
import path from 'path';
import fs from 'fs';
import os from 'os';

const CWD = 'D:\\Ashish_P\\AI-Tools\\custom-OCT';

async function run() {
  console.log('--- Acceptance Suite 4: Lifecycle Edge Cases & Concurrency ---');
  const server = new WorkbenchServer({ cwd: CWD, port: 0 });
  const { port, sessionToken } = await server.start();
  const checks = [];

  const tempDir = path.join(os.tmpdir(), `test_edge_suite_${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    // -------------------------------------------------------------
    // Case 1: Rapid Double-Dispatch (Same Correlation ID Rejection)
    // -------------------------------------------------------------
    console.log('[Case 1] Testing rapid double-submission with same correlation ID...');
    const duplicateCorrId = `CORR_RAPID_DOUBLE_${Date.now()}`;

    const req1 = fetch(`http://127.0.0.1:${port}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': sessionToken },
      body: JSON.stringify({
        correlationId: duplicateCorrId,
        targetAgent: 'claude',
        prompt: 'Echo: FAST_1'
      })
    });

    const req2 = fetch(`http://127.0.0.1:${port}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': sessionToken },
      body: JSON.stringify({
        correlationId: duplicateCorrId,
        targetAgent: 'claude',
        prompt: 'Echo: FAST_2'
      })
    });

    const [res1, res2] = await Promise.all([req1, req2]);
    const statuses = [res1.status, res2.status].sort();

    // One must succeed (201), the duplicate must be rejected (400)
    const doubleDispatchPass = statuses[0] === 201 && statuses[1] === 400;
    checks.push({
      test: 'Rapid double-dispatch: Duplicate correlation ID rejected with HTTP 400',
      passed: doubleDispatchPass,
      statuses
    });

    // Await Case 1 task completion before next case
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 400));
      const r = await fetch(`http://127.0.0.1:${port}/api/tasks/${duplicateCorrId}`, {
        headers: { 'X-Session-Token': sessionToken }
      });
      if (r.status === 200) {
        const t = await r.json();
        if (t.state === 'COMPLETED' || t.state === 'FAILED') break;
      }
    }

    // -------------------------------------------------------------
    // Case 2: Cancellation during generation
    // -------------------------------------------------------------
    console.log('[Case 2] Testing explicit task cancellation...');
    const cancelCorrId = `CORR_CANCEL_TEST_${Date.now()}`;

    await fetch(`http://127.0.0.1:${port}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': sessionToken },
      body: JSON.stringify({
        correlationId: cancelCorrId,
        targetAgent: 'gemini',
        prompt: 'Write an exhaustive essay on distributed hash tables.'
      })
    });

    // Wait 500ms to allow task to transition to SENT/RUNNING
    await new Promise(r => setTimeout(r, 500));

    // Cancel task
    const cancelRes = await fetch(`http://127.0.0.1:${port}/api/tasks/${cancelCorrId}/cancel`, {
      method: 'POST',
      headers: { 'X-Session-Token': sessionToken }
    });
    const cancelData = await cancelRes.json();

    // Wait 1.5s for ACP cancel to complete and agent to be idle
    await new Promise(r => setTimeout(r, 1500));

    // Query task state
    const taskStatusRes = await fetch(`http://127.0.0.1:${port}/api/tasks/${cancelCorrId}`, {
      headers: { 'X-Session-Token': sessionToken }
    });
    const taskData = await taskStatusRes.json();
    const cancelPass = cancelData.cancelled === true && taskData.state === 'CANCELLED';

    checks.push({
      test: 'Explicit task cancellation: Task transitions to CANCELLED state',
      passed: cancelPass,
      state: taskData.state
    });

    // -------------------------------------------------------------
    // Case 3: Late Response / Terminal State Immutability
    // -------------------------------------------------------------
    console.log('[Case 3] Testing that late responses cannot mutate cancelled/completed tasks...');
    const cancelledTask = server.intercomService.getDelegation(cancelCorrId) || server.coordinatorService?.core?.getTask(cancelCorrId);

    let stateMutationPrevented = false;
    try {
      if (cancelledTask.complete) {
        cancelledTask.complete('Late illegitimate completion');
      } else {
        server.intercomService._transitionTask(cancelledTask, 'COMPLETED', 'Late illegitimate completion');
      }
    } catch (e) {
      if (e.code === 'ERR_TERMINAL_STATE' || e.message.includes('terminal state')) {
        stateMutationPrevented = true;
      }
    }

    checks.push({
      test: 'Terminal State Immutability: Late response rejected with ERR_TERMINAL_STATE',
      passed: stateMutationPrevented && cancelledTask.state === 'CANCELLED'
    });

    // -------------------------------------------------------------
    // Case 4: Consecutive Dispatches to Different Agents
    // -------------------------------------------------------------
    console.log('[Case 4] Testing consecutive dispatches across agents...');
    const cId1 = `CORR_CONSEC_1_${Date.now()}`;
    const cId2 = `CORR_CONSEC_2_${Date.now()}`;

    // Dispatch 1 to Claude
    const rC = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': sessionToken },
      body: JSON.stringify({ correlationId: cId1, targetAgent: 'claude', prompt: 'Echo: CONSEC_CLAUDE', requiresApproval: false })
    });

    // Dispatch 2 to Gemini
    const rG = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': sessionToken },
      body: JSON.stringify({ correlationId: cId2, targetAgent: 'gemini', prompt: 'Echo: CONSEC_GEMINI', requiresApproval: false })
    });

    checks.push({
      test: 'Consecutive dispatches accepted and scheduled concurrently',
      passed: rC.status === 201 && rG.status === 201
    });

    // -------------------------------------------------------------
    // Case 5: Stage Diagnostics Recording
    // -------------------------------------------------------------
    console.log('[Case 5] Verifying stage-specific diagnostics on completed tasks...');
    let geminiDiagTask = null;
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 500));
      const res = await fetch(`http://127.0.0.1:${port}/api/tasks/${cId2}`, {
        headers: { 'X-Session-Token': sessionToken }
      });
      if (res.status === 200) {
        const t = await res.json();
        if (t.state === 'COMPLETED') {
          geminiDiagTask = t;
          break;
        }
      }
    }

    const hasDuration = typeof geminiDiagTask?.durationMs === 'number' && geminiDiagTask.durationMs > 0;
    checks.push({
      test: 'Stage Diagnostics: Task records durationMs, timestamps, and stateHistory',
      passed: hasDuration && Array.isArray(geminiDiagTask?.stateHistory),
      durationMs: geminiDiagTask?.durationMs
    });

  } finally {
    await server.shutdown();
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}
  }

  const allPassed = checks.every(c => c.passed);
  console.log(`\nSuite 4 Results: ${checks.filter(c => c.passed).length}/${checks.length} passed.`);
  for (const c of checks) {
    console.log(`  ${c.passed ? '[PASS]' : '[FAIL]'} ${c.test}`);
    if (!c.passed) console.log('    Details:', JSON.stringify(c));
  }
  return { suite: '04_lifecycle_edge_cases', passed: allPassed, checks };
}

run().then(res => {
  if (!res.passed) process.exit(1);
  process.exit(0);
}).catch(err => {
  console.error(err);
  process.exit(1);
});
