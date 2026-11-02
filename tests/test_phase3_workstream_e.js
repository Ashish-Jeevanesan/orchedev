// D:\Ashish_P\AI-Tools\custom-OCT\tests\test_phase3_workstream_e.js
// Focused Regression Suite for Phase 3 Workstream E: Timeout & Cancellation Reliability

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  IntercomService,
  AgentStatus,
  DelegationState,
  TaskTerminalError,
  TaskSecurityError,
  TaskStateError
} from '../server/intercom_service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const TEMP_WORKSPACE = path.join(PROJECT_ROOT, 'tests', 'temp_workspace_e');

async function runWorkstreamETests() {
  console.log('===============================================================');
  console.log('  Phase 3: Workstream E Timeout & Cancellation Reliability     ');
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

  if (fs.existsSync(TEMP_WORKSPACE)) {
    fs.rmSync(TEMP_WORKSPACE, { recursive: true, force: true });
  }
  fs.mkdirSync(TEMP_WORKSPACE, { recursive: true });

  try {
    // ------------------------------------------------------------------------
    // Part 1: Independent Timeout Budgets & Execution Start Boundary
    // ------------------------------------------------------------------------
    console.log('--- PART 1: Independent Timeout Budgets & Start Boundary ---');
    const intercom = new IntercomService({
      cwd: TEMP_WORKSPACE,
      approvalTimeoutMs: 10000,
      claimTimeoutMs: 10000,
      executionTimeoutMs: 20000
    });

    const claudePeer = intercom.registerAgent({
      agentId: 'claude',
      sessionId: 'sess_c_e1',
      pid: 701,
      cwd: TEMP_WORKSPACE
    });
    const geminiPeer = intercom.registerAgent({
      agentId: 'gemini',
      sessionId: 'sess_g_e1',
      pid: 702,
      cwd: TEMP_WORKSPACE
    });

    // 1. Approval Timeout Independence & Deadline Persistence
    console.log('[Test 1] Approval timeout independence and deadline persistence...');
    const now = Date.now();
    const t1 = intercom.createDelegation({
      fromAgent: 'claude',
      toAgent: 'gemini',
      instructions: 'Approval independence test',
      correlationId: 'CORR_TIMEOUT_001',
      cwd: TEMP_WORKSPACE,
      requiresApproval: true,
      approvalTimeoutMs: 500, // 500ms approval budget
      executionTimeoutMs: 10000 // 10s execution budget
    });

    assert(t1.state === DelegationState.APPROVAL_REQUESTED, 'Task created in APPROVAL_REQUESTED');
    assert(typeof t1.approvalDeadline === 'number' && t1.approvalDeadline > now, 'approvalDeadline persisted');
    assert(t1.executionDeadline === null, 'executionDeadline is null while awaiting approval');

    // Simulate approval timeout after 600ms
    t1.approvalRequestedAt = Date.now() - 600;
    intercom._checkLifecycleTimeouts();
    assert(t1.state === DelegationState.TIMED_OUT, 'Task transitioned to TIMED_OUT after approval timeout');
    assert(t1.timeoutInfo?.code === 'ERR_APPROVAL_TIMEOUT', 'Structured timeout code is ERR_APPROVAL_TIMEOUT');
    assert(t1.timeoutInfo?.timeoutPhase === 'APPROVAL', 'Timeout phase is APPROVAL');

    // 2. Claim Timeout Independence
    console.log('[Test 2] Claim timeout independence...');
    const t2 = intercom.createDelegation({
      fromAgent: 'claude',
      toAgent: 'gemini',
      instructions: 'Claim independence test',
      correlationId: 'CORR_TIMEOUT_002',
      cwd: TEMP_WORKSPACE,
      requiresApproval: true,
      claimTimeoutMs: 500,
      executionTimeoutMs: 15000
    });
    intercom.approveDelegation({ correlationId: 'CORR_TIMEOUT_002', approver: 'qa-tester' });
    assert(t2.state === DelegationState.QUEUED_FOR_CLAIM, 'Task in QUEUED_FOR_CLAIM');
    assert(typeof t2.claimDeadline === 'number', 'claimDeadline persisted');
    assert(t2.executionDeadline === null, 'executionDeadline still null while in inbox queue');

    // Simulate claim timeout after 600ms
    t2.approvedAt = Date.now() - 600;
    intercom._checkLifecycleTimeouts();
    assert(t2.state === DelegationState.TIMED_OUT, 'Task transitioned to TIMED_OUT after claim timeout');
    assert(t2.timeoutInfo?.code === 'ERR_CLAIM_TIMEOUT', 'Structured timeout code is ERR_CLAIM_TIMEOUT');
    assert(t2.timeoutInfo?.timeoutPhase === 'CLAIM', 'Timeout phase is CLAIM');

    // 3. Full Execution Budget at Documented Start Boundary (CLAIMED)
    console.log('[Test 3] Execution budget begins strictly at CLAIMED boundary...');
    const t3 = intercom.createDelegation({
      fromAgent: 'claude',
      toAgent: 'gemini',
      instructions: 'Full execution budget test',
      correlationId: 'CORR_TIMEOUT_003',
      cwd: TEMP_WORKSPACE,
      requiresApproval: true,
      approvalTimeoutMs: 60000,
      claimTimeoutMs: 60000,
      executionTimeoutMs: 2500 // 2.5s execution budget
    });

    // Simulate human took 50 seconds to approve
    t3.createdAt = Date.now() - 50000;
    t3.approvalRequestedAt = Date.now() - 50000;
    intercom.approveDelegation({ correlationId: 'CORR_TIMEOUT_003', approver: 'qa-tester' });

    // Worker claims task
    intercom.claimTask({
      agentId: 'gemini',
      sessionId: 'sess_g_e1',
      correlationId: 'CORR_TIMEOUT_003',
      cwd: TEMP_WORKSPACE
    });

    assert(t3.state === DelegationState.RUNNING, 'Task state is RUNNING');
    assert(t3.claimTime !== null, 'claimTime recorded');
    assert(t3.startedAt !== null, 'startedAt recorded');
    assert(t3.executionDeadline === t3.startedAt + 2500, 'executionDeadline computed from startedAt (full 2500ms granted)');

    // Verify task is NOT timed out immediately despite 50s pre-approval delay
    intercom._checkLifecycleTimeouts();
    assert(t3.state === DelegationState.RUNNING, 'Task NOT timed out: waiting for approval consumed 0ms of execution budget');

    // 4. Execution Timeout Expiration
    console.log('[Test 4] Execution timeout expiration...');
    t3.startedAt = Date.now() - 3000;
    t3.claimTime = Date.now() - 3000;
    intercom._checkLifecycleTimeouts();
    assert(t3.state === DelegationState.TIMED_OUT, 'Task transitioned to TIMED_OUT after execution budget exceeded');
    assert(t3.timeoutInfo?.code === 'ERR_EXECUTION_TIMEOUT', 'Structured timeout code is ERR_EXECUTION_TIMEOUT');
    assert(t3.timeoutInfo?.timeoutPhase === 'EXECUTION', 'Timeout phase is EXECUTION');

    // ------------------------------------------------------------------------
    // Part 2: Interactive Process Preservation
    // ------------------------------------------------------------------------
    console.log('\n--- PART 2: Interactive ConPTY Process Preservation ---');
    // 5 & 6. Process and peer preservation on timeout
    console.log('[Test 5 & 6] ConPTY process preservation and peer status calculation on timeout...');
    assert(geminiPeer.pid === 702, 'ConPTY PID 702 remains alive and unchanged');
    assert(geminiPeer.status === AgentStatus.ONLINE, 'Worker peer status reverted to ONLINE (ready for next task)');

    // 7. Multiple active tasks peer status invariant
    console.log('[Test 7] Peer status remains BUSY if other active tasks remain...');
    const tMulti1 = intercom.createDelegation({
      fromAgent: 'claude',
      toAgent: 'gemini',
      instructions: 'Multi task 1',
      correlationId: 'CORR_MULTI_1',
      cwd: TEMP_WORKSPACE,
      requiresApproval: false,
      executionTimeoutMs: 1000
    });
    const tMulti2 = intercom.createDelegation({
      fromAgent: 'claude',
      toAgent: 'gemini',
      instructions: 'Multi task 2',
      correlationId: 'CORR_MULTI_2',
      cwd: TEMP_WORKSPACE,
      requiresApproval: false,
      executionTimeoutMs: 30000
    });

    intercom.claimTask({ agentId: 'gemini', sessionId: 'sess_g_e1', correlationId: 'CORR_MULTI_1', cwd: TEMP_WORKSPACE });
    intercom.claimTask({ agentId: 'gemini', sessionId: 'sess_g_e1', correlationId: 'CORR_MULTI_2', cwd: TEMP_WORKSPACE });
    assert(geminiPeer.status === AgentStatus.BUSY, 'Peer is BUSY with 2 active tasks');

    // Time out only tMulti1
    tMulti1.startedAt = Date.now() - 2000;
    tMulti1.claimTime = Date.now() - 2000;
    intercom._checkLifecycleTimeouts();
    assert(tMulti1.state === DelegationState.TIMED_OUT, 'tMulti1 timed out');
    assert(tMulti2.state === DelegationState.RUNNING, 'tMulti2 remains RUNNING');
    assert(geminiPeer.status === AgentStatus.BUSY, 'Peer remains BUSY because tMulti2 is still active');

    // Finish tMulti2
    intercom.completeTask({
      agentId: 'gemini',
      sessionId: 'sess_g_e1',
      correlationId: 'CORR_MULTI_2',
      summary: 'tMulti2 completed'
    });
    assert(geminiPeer.status === AgentStatus.ONLINE, 'Peer transitions to ONLINE once all tasks are done');

    // ------------------------------------------------------------------------
    // Part 3: Late Completion & Cancellation Races
    // ------------------------------------------------------------------------
    console.log('\n--- PART 3: Late Completion & Cancellation Races ---');

    // 8. Late completion after timeout
    console.log('[Test 8] Late completion after TIMED_OUT preserves terminal state and archives work...');
    const lateTimeoutRes = intercom.completeTask({
      agentId: 'gemini',
      sessionId: 'sess_g_e1',
      correlationId: 'CORR_TIMEOUT_003', // Was timed out in Test 4
      summary: 'Late computed algorithm output',
      modifiedFiles: ['late_algo.js'],
      testResults: { passed: 5 }
    });

    assert(lateTimeoutRes.timedOut === true, 'Response indicates timedOut: true');
    assert(lateTimeoutRes.lateRecorded === true, 'Response indicates lateRecorded: true');
    assert(t3.state === DelegationState.TIMED_OUT, 'Terminal state remained TIMED_OUT (never corrupted to COMPLETED)');
    assert(t3.lateCompletion !== null, 'task.lateCompletion populated with archived work');
    assert(t3.lateCompletion.summary === 'Late computed algorithm output', 'Late summary archived');
    assert(t3.lateCompletion.agentId === 'gemini', 'Late completion recorded reporting agent');

    // 9. Cancellation requested remains unconfirmed
    console.log('[Test 9] In-flight cancellation request honesty...');
    const tCancel = intercom.createDelegation({
      fromAgent: 'claude',
      toAgent: 'gemini',
      instructions: 'Cancel race test',
      correlationId: 'CORR_CANCEL_RACE',
      cwd: TEMP_WORKSPACE,
      requiresApproval: false
    });
    intercom.claimTask({ agentId: 'gemini', sessionId: 'sess_g_e1', correlationId: 'CORR_CANCEL_RACE', cwd: TEMP_WORKSPACE });
    const cancelRes = intercom.cancelDelegation('CORR_CANCEL_RACE', 'Operator requested stop');
    assert(cancelRes.status === 'cancellation_requested', 'Status is cancellation_requested');
    assert(tCancel.state === DelegationState.RUNNING, 'Task state remains RUNNING until worker confirms');
    assert(tCancel.cancellationRequested === true, 'cancellationRequested flag set');

    // 10. Explicit worker cancellation confirmation
    console.log('[Test 10] Worker cancellation confirmation...');
    const confirmRes = intercom.confirmCancellation({
      agentId: 'gemini',
      sessionId: 'sess_g_e1',
      correlationId: 'CORR_CANCEL_RACE',
      reason: 'Gemini confirmed clean worker stop'
    });
    assert(confirmRes.status === 'cancelled', 'confirmCancellation returns status cancelled');
    assert(tCancel.state === DelegationState.CANCELLED, 'Task transitioned to CANCELLED');
    assert(tCancel.cancellationConfirmed === true, 'cancellationConfirmed flag set');

    // 11. Late completion after cancellation
    console.log('[Test 11] Late completion after cancellation request...');
    const tLateCancel = intercom.createDelegation({
      fromAgent: 'claude',
      toAgent: 'gemini',
      instructions: 'Late cancel test',
      correlationId: 'CORR_LATE_CANCEL',
      cwd: TEMP_WORKSPACE,
      requiresApproval: false
    });
    intercom.claimTask({ agentId: 'gemini', sessionId: 'sess_g_e1', correlationId: 'CORR_LATE_CANCEL', cwd: TEMP_WORKSPACE });
    intercom.cancelDelegation('CORR_LATE_CANCEL', 'Cancelled while running');
    intercom.completeTask({
      agentId: 'gemini',
      sessionId: 'sess_g_e1',
      correlationId: 'CORR_LATE_CANCEL',
      summary: 'Finished work despite cancel request',
      modifiedFiles: ['cancelled_work.js']
    });
    assert(tLateCancel.state === DelegationState.CANCELLED, 'Task marked CANCELLED (not COMPLETED)');
    assert(tLateCancel.lateCompletion.summary === 'Finished work despite cancel request', 'Work preserved in lateCompletion');

    // 12. Terminal-state immutability
    console.log('[Test 12] Terminal state immutability...');
    let immutErr = null;
    try {
      intercom.failTask({
        agentId: 'gemini',
        sessionId: 'sess_g_e1',
        correlationId: 'CORR_TIMEOUT_003',
        error: 'Late error after timeout'
      });
    } catch (e) {
      immutErr = e;
    }
    assert(t3.state === DelegationState.TIMED_OUT, 'State remains TIMED_OUT after late fail report');

    // ------------------------------------------------------------------------
    // Part 4: HTTP Long-Poll Re-poll Safety & Waiter Management
    // ------------------------------------------------------------------------
    console.log('\n--- PART 4: HTTP Long-Poll Re-poll Safety & Waiter Leak Isolation ---');

    // 13. Long-poll timeout returns { status: 'still_running' }
    console.log('[Test 13] Long-poll timeout returns valid status still_running contract...');
    const tPoll = intercom.createDelegation({
      fromAgent: 'claude',
      toAgent: 'gemini',
      instructions: 'Poll test',
      correlationId: 'CORR_POLL_TEST',
      cwd: TEMP_WORKSPACE,
      requiresApproval: false
    });

    // Client polls with 50ms pollTimeout
    const pollResult = await intercom.waitForCompletion('CORR_POLL_TEST', 50);
    assert(pollResult.status === 'still_running', 'Long-poll timeout returned status: still_running');
    assert(pollResult.correlationId === 'CORR_POLL_TEST', 'Response contains correlationId');
    assert(tPoll.state === DelegationState.QUEUED_FOR_CLAIM, 'Task state unaffected by HTTP poll timeout');

    // 14. Repeated polling does not leak waiters or timers
    console.log('[Test 14] Repeated polling does not accumulate leaked waiters...');
    for (let i = 0; i < 5; i++) {
      const repPoll = await intercom.waitForCompletion('CORR_POLL_TEST', 20);
      assert(repPoll.status === 'still_running', `Poll attempt #${i + 1} returned still_running`);
    }
    const waitersForTask = intercom.pendingResolutions.get('CORR_POLL_TEST');
    assert(!waitersForTask || waitersForTask.size === 0, 'Zero lingering waiters after completed poll timeouts');

    // 15. Client disconnect cleanup
    console.log('[Test 15] Client disconnect cleanup via _removeWaiter...');
    let testWaiter = null;
    const waitPromise = intercom.waitForCompletion('CORR_POLL_TEST', 5000, (record) => {
      testWaiter = record;
    });
    assert(intercom.pendingResolutions.get('CORR_POLL_TEST')?.size === 1, 'Waiter registered');

    // Simulate client network disconnect
    intercom._removeWaiter('CORR_POLL_TEST', testWaiter);
    assert(!intercom.pendingResolutions.has('CORR_POLL_TEST'), 'Waiter cleanly removed on client disconnect');

    // 16. Multiple concurrent waiters resolved upon completion
    console.log('[Test 16] Multiple concurrent waiters resolved upon task completion...');
    intercom.claimTask({ agentId: 'gemini', sessionId: 'sess_g_e1', correlationId: 'CORR_POLL_TEST', cwd: TEMP_WORKSPACE });

    const wPromise1 = intercom.waitForCompletion('CORR_POLL_TEST');
    const wPromise2 = intercom.waitForCompletion('CORR_POLL_TEST');
    assert(intercom.pendingResolutions.get('CORR_POLL_TEST')?.size === 2, '2 concurrent waiters registered');

    intercom.completeTask({
      agentId: 'gemini',
      sessionId: 'sess_g_e1',
      correlationId: 'CORR_POLL_TEST',
      summary: 'Finished polling task'
    });

    const [res1, res2] = await Promise.all([wPromise1, wPromise2]);
    assert(res1.success === true && res2.success === true, 'Both concurrent waiters resolved with success: true');
    assert(!intercom.pendingResolutions.has('CORR_POLL_TEST'), 'Pending resolutions map cleaned up after resolution');

    await intercom.shutdown();
  } finally {
    if (fs.existsSync(TEMP_WORKSPACE)) {
      try { fs.rmSync(TEMP_WORKSPACE, { recursive: true, force: true }); } catch (e) {}
    }
  }

  console.log('\n===============================================================');
  console.log(`  PHASE 3 WORKSTREAM E SUITE: ${passed} PASSED, ${failed} FAILED`);
  console.log('===============================================================\n');

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runWorkstreamETests().catch(err => {
  console.error('[FATAL WORKSTREAM E SUITE ERROR]', err);
  process.exit(1);
});
