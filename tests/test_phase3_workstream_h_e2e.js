// tests/test_phase3_workstream_h_e2e.js
// Phase 3 Workstream H: Automated End-to-End Regression & Integration Suite
// Validates Full Cross-Workstream Contracts (H.1 - H.7) using Isolated Fixtures,
// Protocol-Level MCP Facades, WebSocket Collectors, and Zero Live Model Spawns.

import fs from 'fs';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';
import WebSocket from 'ws';
import { E2ETestHarness } from './helpers/e2e_test_harness.js';
import { DelegationState, TaskSecurityError, TaskStateError } from '../server/intercom_service.js';
import { WorkspaceAuthorizationService } from '../server/workspace_authorization.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

async function runWorkstreamHE2ETests() {
  console.log('===============================================================');
  console.log('  Phase 3 Workstream H: Master End-to-End Regression Suite     ');
  console.log('===============================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, desc) {
    if (condition) {
      console.log(`  [PASS] ${desc}`);
      passed++;
    } else {
      console.error(`  [FAIL] ${desc}`);
      failed++;
    }
  }

  const harness = new E2ETestHarness('suite_h');

  try {
    // ------------------------------------------------------------------------
    // PART 1: Scenarios H.1 & H.2 — Bi-directional Delegation & Dispatch Task
    // ------------------------------------------------------------------------
    console.log('--- PART 1: Scenarios H.1 & H.2 — Delegation & Dispatch Workflows ---');

    const fixtureA = harness.createFixtureDir('delegation_wf');
    const instA = await harness.startIsolatedServer({ fixtureDir: fixtureA });
    const eventsA = await harness.connectEventCollector(instA.port, instA.sessionToken);

    // Register protocol-level mock peers
    const claudePeer = await harness.createMockMcpBridgePeer({
      port: instA.port,
      sessionToken: instA.sessionToken,
      agentId: 'claude',
      cwd: fixtureA,
      capabilities: ['orchestration', 'delegation']
    });

    const geminiPeer = await harness.createMockMcpBridgePeer({
      port: instA.port,
      sessionToken: instA.sessionToken,
      agentId: 'gemini',
      cwd: fixtureA,
      capabilities: ['implementation', 'testing']
    });

    // 1. Claude delegates task to Gemini
    console.log('[Test 1] Claude delegates task to Gemini with human approval...');
    let claudeDelegationPromise = claudePeer.delegate({
      targetAgent: 'gemini',
      instructions: 'Create math utility with add()',
      plan: 'Add math utility to project',
      expectedFiles: ['math_utils.js'],
      requiresApproval: true
    });

    // Wait for task to enter APPROVAL_REQUESTED
    await new Promise(r => setTimeout(r, 100));
    const pendingTasksRes = await fetch(`http://127.0.0.1:${instA.port}/api/tasks`, {
      headers: { 'X-Session-Token': instA.sessionToken }
    });
    const pendingData = await pendingTasksRes.json();
    assert(pendingData.tasks.length === 1, 'Exactly one task created');
    const task1 = pendingData.tasks[0];
    assert(task1.state === DelegationState.APPROVAL_REQUESTED, 'Task created in APPROVAL_REQUESTED state');
    assert(task1.fromAgent === 'claude', 'Task sender is claude');

    // 2. Gemini inbox is empty before approval
    console.log('[Test 2] Gemini inbox strictly withholds unapproved task...');
    const preInbox = await geminiPeer.getInbox();
    assert(preInbox.length === 0, 'Gemini inbox has 0 tasks prior to human approval');

    // 3. Human edits instructions and approves task
    console.log('[Test 3] Human edits instructions and approves plan...');
    const approveRes = await fetch(`http://127.0.0.1:${instA.port}/api/intercom/approvals/${task1.correlationId}/approve`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': instA.sessionToken
      },
      body: JSON.stringify({
        editedInstructions: 'Create math utility with add() and multiply()',
        approver: 'human-reviewer'
      })
    });
    const approveData = await approveRes.json();
    assert(approveRes.ok && approveData.status === 'approved', 'Server confirmed human approval');
    assert(approveData.task.state === DelegationState.QUEUED_FOR_CLAIM, 'Task transitioned to QUEUED_FOR_CLAIM');
    assert(approveData.task.instructions.includes('multiply()'), 'Edited instructions preserved in active task');
    assert(approveData.task.originalInstructions.includes('add()'), 'Original instructions archived for audit');

    // 4. Gemini inbox discovers approved task and claims it
    console.log('[Test 4] Gemini discovers task in inbox and claims it...');
    const postInbox = await geminiPeer.getInbox();
    assert(postInbox.length === 1 && postInbox[0].correlationId === task1.correlationId, 'Approved task appears in Gemini inbox');

    const claimRes = await geminiPeer.claim(task1.correlationId);
    assert(claimRes.ok && claimRes.status === 200, 'Gemini claim succeeded');
    assert(claimRes.data.state === DelegationState.RUNNING, 'Task state transitioned to RUNNING upon claim');

    // 5. Gemini reports progress
    console.log('[Test 5] Gemini reports non-mutating execution progress...');
    const progRes = await geminiPeer.reportProgress(task1.correlationId, 'synthesize', 50, 'Writing math functions');
    assert(progRes.ok, 'Progress report accepted');

    // 6. Gemini reports completion
    console.log('[Test 6] Gemini completes task and unblocks waiting Claude caller...');
    const compRes = await geminiPeer.complete(task1.correlationId, 'Added add and multiply', ['math_utils.js'], '2 tests passed');
    assert(compRes.ok && compRes.data.state === DelegationState.COMPLETED, 'Completion accepted');

    const claudeResult = await claudeDelegationPromise;
    assert(claudeResult.ok, 'Claude delegation promise resolved successfully');
    assert(claudeResult.data.summary.includes('Added add and multiply'), 'Claude received Gemini completion summary');
    assert(claudeResult.data.modifiedFiles[0] === 'math_utils.js', 'Claude received modified files list');

    // 7. User Dispatch Task workflow via REST API
    console.log('[Test 7] User creates task via Dispatch Task API...');
    const dispatchRes = await fetch(`http://127.0.0.1:${instA.port}/api/tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': instA.sessionToken
      },
      body: JSON.stringify({
        targetAgent: 'gemini',
        prompt: 'Generate date utilities',
        cwd: fixtureA,
        requiresApproval: true
      })
    });
    const dispatchData = await dispatchRes.json();
    assert(dispatchRes.status === 201, 'Dispatch Task created with HTTP 201');
    const task2 = dispatchData.task;
    assert(task2.fromAgent === 'user', 'Task sender is correctly attributed to user');
    assert(task2.state === DelegationState.APPROVAL_REQUESTED, 'Dispatch task requires human approval');

    // ------------------------------------------------------------------------
    // PART 2: Scenario H.3 — State Machine Edge Cases & Cancellation Races
    // ------------------------------------------------------------------------
    console.log('\n--- PART 2: Scenario H.3 — Lifecycle Edge Cases & Cancellation Races ---');

    // 8. Human Rejection
    console.log('[Test 8] Human rejection transitions task to REJECTED and unblocks caller...');
    const rejTaskPromise = claudePeer.delegate({
      targetAgent: 'gemini',
      instructions: 'Delete production database',
      requiresApproval: true
    });
    await new Promise(r => setTimeout(r, 60));
    const allTasksRes = await fetch(`http://127.0.0.1:${instA.port}/api/tasks`, {
      headers: { 'X-Session-Token': instA.sessionToken }
    });
    const allTasksData = await allTasksRes.json();
    const dangerousTask = allTasksData.tasks.find(t => t.instructions.includes('Delete production'));

    const rejectRes = await fetch(`http://127.0.0.1:${instA.port}/api/intercom/approvals/${dangerousTask.correlationId}/reject`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': instA.sessionToken
      },
      body: JSON.stringify({ reason: 'Violates safety policy', rejecter: 'human' })
    });
    const rejectData = await rejectRes.json();
    assert(rejectRes.ok && rejectData.status === 'rejected', 'Server confirmed rejection');
    assert(rejectData.task.state === DelegationState.REJECTED, 'Task transitioned to REJECTED state');

    const rejCallerRes = await rejTaskPromise;
    assert(rejCallerRes.data.rejected === true, 'Caller delegation resolved with rejected: true');
    assert(rejCallerRes.data.rejectionReason.includes('safety policy'), 'Rejection reason returned to caller');

    // 9. In-Flight Cancellation vs Worker Confirmation
    console.log('[Test 9] In-flight cancellation request honesty and worker confirmation...');
    const cancelTaskRes = instA.intercom.createDelegation({
      fromAgent: 'claude',
      toAgent: 'gemini',
      instructions: 'Long simulation',
      cwd: fixtureA,
      requiresApproval: false
    });
    await geminiPeer.claim(cancelTaskRes.correlationId);

    // Cancel while running
    const cancelReq = instA.intercom.cancelDelegation(cancelTaskRes.correlationId, 'User stopped test', 'human');
    assert(cancelReq.status === 'cancellation_requested', 'Cancel reports cancellation_requested for active task');
    assert(cancelReq.task.state === DelegationState.RUNNING, 'Task state remains RUNNING until worker confirms');
    assert(cancelReq.task.cancellationRequested === true, 'cancellationRequested flag recorded');

    // Worker confirms clean stop
    const confirmRes = instA.intercom.confirmCancellation({
      agentId: 'gemini',
      sessionId: geminiPeer.sessionId,
      correlationId: cancelTaskRes.correlationId,
      reason: 'Worker acknowledged cancel'
    });
    assert(confirmRes.status === 'cancelled', 'Worker confirmed cancellation');
    const cancelledTask = instA.intercom.getDelegation(cancelTaskRes.correlationId);
    assert(cancelledTask.state === DelegationState.CANCELLED, 'Task transitioned to CANCELLED state');

    // 10. Worker completion arrives after cancellation was requested (Late Completion Race)
    console.log('[Test 10] Worker completion after cancellation requested preserves work in lateCompletion...');
    const lateCancelTask = instA.intercom.createDelegation({
      fromAgent: 'claude',
      toAgent: 'gemini',
      instructions: 'Late cancel task',
      cwd: fixtureA,
      requiresApproval: false
    });
    await geminiPeer.claim(lateCancelTask.correlationId);
    instA.intercom.cancelDelegation(lateCancelTask.correlationId, 'Cancel requested', 'human');

    // Worker finishes instead of confirming cancel
    const lateCompRes = await geminiPeer.complete(lateCancelTask.correlationId, 'Completed before seeing cancel', ['output.txt']);
    assert(lateCompRes.ok, 'Completion call acknowledged');
    const finalizedLateCancel = instA.intercom.getDelegation(lateCancelTask.correlationId);
    assert(finalizedLateCancel.state === DelegationState.CANCELLED, 'Task marked CANCELLED (never marked COMPLETED)');
    assert(Boolean(finalizedLateCancel.lateCompletion), 'Work preserved in lateCompletion archive');
    assert(finalizedLateCancel.lateCompletion.summary.includes('Completed before seeing cancel'), 'Late result output preserved');

    // 11. Worker completion arrives after task officially timed out
    console.log('[Test 11] Worker completion after TIMED_OUT archives work without mutating state...');
    const timeoutTask = instA.intercom.createDelegation({
      fromAgent: 'claude',
      toAgent: 'gemini',
      instructions: 'Timeout task',
      cwd: fixtureA,
      requiresApproval: false,
      executionTimeoutMs: 100
    });
    await geminiPeer.claim(timeoutTask.correlationId);
    await new Promise(r => setTimeout(r, 120)); // Allow timeout expiration
    instA.intercom._checkLifecycleTimeouts(); // Trigger deterministic timeout evaluation

    const timedOutTaskBefore = instA.intercom.getDelegation(timeoutTask.correlationId);
    assert(timedOutTaskBefore.state === DelegationState.TIMED_OUT, 'Task is TIMED_OUT');

    const lateTimeoutReport = await geminiPeer.complete(timeoutTask.correlationId, 'Late worker result', ['done.txt']);
    assert(lateTimeoutReport.data.lateRecorded === true, 'Late completion recognized');
    const timedOutTaskAfter = instA.intercom.getDelegation(timeoutTask.correlationId);
    assert(timedOutTaskAfter.state === DelegationState.TIMED_OUT, 'Task state remains TIMED_OUT (never corrupted to COMPLETED)');
    assert(timedOutTaskAfter.lateCompletion.summary.includes('Late worker result'), 'Late completion output safely archived');

    // 12. Duplicate Correlation ID & Claim Races
    console.log('[Test 12] Duplicate task correlation ID rejected...');
    let dupErr = null;
    try {
      instA.intercom.createDelegation({
        correlationId: task1.correlationId,
        fromAgent: 'claude',
        toAgent: 'gemini',
        instructions: 'Duplicate ID'
      });
    } catch (e) {
      dupErr = e;
    }
    assert(dupErr instanceof TaskStateError, 'Duplicate correlation ID rejected with TaskDuplicateError');

    // ------------------------------------------------------------------------
    // PART 3: Scenario H.4 — Cold Crash Recovery & Root Persistence Order
    // ------------------------------------------------------------------------
    console.log('\n--- PART 3: Scenario H.4 — Crash Recovery & Persistence Integrity ---');

    const fixtureB = harness.createFixtureDir('crash_recovery');
    const externalProjectDir = path.join(fixtureB, 'my_external_project');
    fs.mkdirSync(externalProjectDir, { recursive: true });

    // Step 1: Start initial coordinator, register external root, create queued task
    const instB1 = await harness.startIsolatedServer({ fixtureDir: fixtureB });
    instB1.auth.addAllowedRoot(externalProjectDir);

    const queuedTask = instB1.intercom.createDelegation({
      fromAgent: 'user',
      toAgent: 'gemini',
      instructions: 'Queued task in external project',
      cwd: externalProjectDir,
      requiresApproval: false
    });
    assert(queuedTask.state === DelegationState.QUEUED_FOR_CLAIM, 'Task queued in external project');

    // Create a running task to simulate crash during execution
    const runningTask = instB1.intercom.createDelegation({
      fromAgent: 'claude',
      toAgent: 'gemini',
      instructions: 'Interrupted running task',
      cwd: fixtureB,
      requiresApproval: false
    });
    const mockGeminiB = await harness.createMockMcpBridgePeer({
      port: instB1.port,
      sessionToken: instB1.sessionToken,
      agentId: 'gemini',
      cwd: fixtureB
    });
    await mockGeminiB.claim(runningTask.correlationId);

    // Step 2: Cold crash / restart server on same fixtureDir
    await instB1.server.shutdown();

    const instB2 = await harness.startIsolatedServer({ fixtureDir: fixtureB });

    // Verify root restoration order: external project was restored BEFORE task recovery
    assert(
      instB2.auth.getAllowedRoots().some(r => r.toLowerCase() === fs.realpathSync(externalProjectDir).toLowerCase()),
      'External workspace root restored before task recovery'
    );

    const recoveredQueued = instB2.intercom.getDelegation(queuedTask.correlationId);
    assert(recoveredQueued.state === DelegationState.QUEUED_FOR_CLAIM, 'Queued task in user workspace remains QUEUED_FOR_CLAIM (not falsely expired)');

    const recoveredRunning = instB2.intercom.getDelegation(runningTask.correlationId);
    assert(recoveredRunning.state === DelegationState.FAILED, 'Interrupted running task recovered as FAILED');
    assert(recoveredRunning.error.includes('Server or coordinator restarted'), 'Failure reason records coordinator restart');

    // Step 3: Delete external project and restart again
    fs.rmSync(externalProjectDir, { recursive: true, force: true });
    await instB2.server.shutdown();

    const instB3 = await harness.startIsolatedServer({ fixtureDir: fixtureB });
    const expiredTask = instB3.intercom.getDelegation(queuedTask.correlationId);
    assert(expiredTask.state === DelegationState.EXPIRED, 'Task referencing deleted root safely transitioned to EXPIRED');
    assert(expiredTask.error.includes('ERR_CWD_NOT_AUTHORIZED'), 'Error records CWD authorization failure on deleted root');
    await instB3.server.shutdown();

    // Step 4: Storage corruption recovery (corrupt file while server is offline)
    const tasksStorageFile = path.join(fixtureB, '.workbench_tasks.json');
    fs.writeFileSync(tasksStorageFile, '{ corrupted_json_syntax: [ invalid', 'utf8');

    const instB4 = await harness.startIsolatedServer({ fixtureDir: fixtureB });
    assert(instB4.intercom.delegations.size === 0, 'Coordinator started cleanly with empty map on corrupt file');
    const corruptBackups = fs.readdirSync(fixtureB).filter(f => f.startsWith('.workbench_tasks.json.corrupt_'));
    assert(corruptBackups.length > 0, 'Emergency .corrupt_<timestamp> backup file preserved on disk');

    // ------------------------------------------------------------------------
    // PART 4: Scenario H.5 — Session Health, Generations & Reconnection
    // ------------------------------------------------------------------------
    console.log('\n--- PART 4: Scenario H.5 — Session Health & Heartbeat Generations ---');

    const fixtureC = harness.createFixtureDir('session_health');
    const instC = await harness.startIsolatedServer({ fixtureDir: fixtureC });

    // Initial registration assigns generation 1
    const pHealth = await harness.createMockMcpBridgePeer({
      port: instC.port,
      sessionToken: instC.sessionToken,
      agentId: 'gemini',
      sessionId: 'sess_health_test',
      cwd: fixtureC
    });
    assert(pHealth.generation === 1, 'Initial registration assigned generation 1');

    // Disconnect old session cleanly to avoid active conflict
    await pHealth.disconnect();

    // Re-registration receives generation 2
    const reregRes = await fetch(`http://127.0.0.1:${instC.port}/api/intercom/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': instC.sessionToken
      },
      body: JSON.stringify({
        agentId: 'gemini',
        sessionId: 'sess_health_test_replacement',
        pid: process.pid,
        cwd: fixtureC,
        capabilities: ['implementation']
      })
    });
    const reregData = await reregRes.json();
    assert(reregData.generation === 2 || reregData.peer?.generation === 2, 'New registration generation incremented to 2');

    // Stale generation heartbeat rejected
    const staleHeartbeatRes = await fetch(`http://127.0.0.1:${instC.port}/api/intercom/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': instC.sessionToken
      },
      body: JSON.stringify({
        agentId: 'gemini',
        sessionId: 'sess_health_test', // Old session
        generation: 1
      })
    });
    const staleHbData = await staleHeartbeatRes.json();
    assert(staleHbData.status === 'unrecognized_peer', 'Stale session heartbeat rejected with unrecognized_peer');

    // ------------------------------------------------------------------------
    // PART 5: Scenario H.6 — Security Hardening, Timing-Safe & CWD Boundaries
    // ------------------------------------------------------------------------
    console.log('\n--- PART 5: Scenario H.6 — Security Hardening & CWD Boundaries ---');

    // 1. Loopback only binding
    assert(instC.server.server.address().address === '127.0.0.1', 'Server bound strictly to loopback 127.0.0.1');

    // 2. Token authentication
    const unauthReq = await fetch(`http://127.0.0.1:${instC.port}/api/tasks`, {
      headers: { 'X-Session-Token': 'invalid_token_of_different_length' }
    });
    assert(unauthReq.status === 401, 'Invalid session token rejected with HTTP 401');

    // 3. WebSocket origin validation
    let wsMissingOriginRejected = false;
    await new Promise((resolve) => {
      const badWs = new WebSocket(`ws://127.0.0.1:${instC.port}/ws/events`, {
        headers: {} // Missing Origin
      });
      badWs.on('unexpected-response', (req, res) => {
        if (res.statusCode === 403) wsMissingOriginRejected = true;
        resolve();
      });
      badWs.on('error', () => resolve());
      badWs.on('open', () => { badWs.close(); resolve(); });
    });
    assert(wsMissingOriginRejected === true, 'WebSocket missing Origin header rejected with HTTP 403 Forbidden');

    // 4. Static path traversal (tested via raw HTTP to bypass WHATWG URL pre-normalization)
    let dotDotStatus = 0;
    await new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port: instC.port, path: '/%2e%2e/package.json' }, (res) => {
        dotDotStatus = res.statusCode;
        res.resume();
        resolve();
      }).on('error', resolve);
    });
    assert(dotDotStatus === 403, 'Path traversal /%2e%2e/ returns HTTP 403 Forbidden');

    // 5. CWD boundary enforcement
    let siblingEscapeErr = null;
    try {
      instC.auth.authorizeCwd(PROJECT_ROOT); // Outside fixtureC
    } catch (e) {
      siblingEscapeErr = e;
    }
    assert(siblingEscapeErr instanceof TaskSecurityError && siblingEscapeErr.code === 'ERR_CWD_NOT_AUTHORIZED', 'Path outside authorized fixture root rejected');

    // 6. Bare root drive rejection
    assert(instC.auth.addAllowedRoot('C:\\') === false, 'Bare Windows drive C:\\ rejected from registration');

    // 7. 1MB payload cap
    const largeBody = 'A'.repeat(1024 * 1024 + 50);
    const largeRes = await fetch(`http://127.0.0.1:${instC.port}/api/tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': instC.sessionToken
      },
      body: JSON.stringify({ prompt: largeBody })
    });
    assert(largeRes.status === 413, 'Over-limit request body rejected with HTTP 413 Payload Too Large');

    // ------------------------------------------------------------------------
    // PART 6: Scenario H.7 — UI Component Integration & State Presentation
    // ------------------------------------------------------------------------
    console.log('\n--- PART 6: Scenario H.7 — UI & Operational Integration ---');

    const htmlContent = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'index.html'), 'utf8');
    const cssContent = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'css', 'workbench.css'), 'utf8');

    assert(htmlContent.includes('id="ws-quick-switch"'), 'UI: Workspace quick-switch dropdown verified');
    assert(htmlContent.includes('id="btn-term-clear"'), 'UI: Terminal buffer clear control verified');
    assert(htmlContent.includes('id="modal-carousel-nav"'), 'UI: Multi-task approval carousel verified');
    assert(htmlContent.includes('id="task-search-input"'), 'UI: Live task search input verified');
    assert(htmlContent.includes('id="activity-filters"'), 'UI: Activity severity filters verified');
    assert(cssContent.includes('.late-completion-banner'), 'UI: Late completion banner CSS verified');
    assert(cssContent.includes('.progress-bar-wrap'), 'UI: Execution progress bar CSS verified');

  } finally {
    // Teardown all servers, sockets, peers, and temporary directories
    await harness.cleanupAll();
  }

  console.log('\n===============================================================');
  console.log(`  WORKSTREAM H E2E SUITE: ${passed} PASSED, ${failed} FAILED`);
  console.log('===============================================================\n');

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runWorkstreamHE2ETests().catch(err => {
  console.error('[FATAL WORKSTREAM H E2E TEST ERROR]', err);
  process.exit(1);
});
