// D:\Ashish_P\AI-Tools\custom-OCT\tests\test_phase3_workstreams_a_b.js
// Verification Suite for Phase 3 Workstreams A & B: State Machine Rigor & Persistence

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  IntercomService,
  DelegationState,
  TaskStateError,
  TaskTerminalError,
  TaskDuplicateError,
  TaskSecurityError
} from '../server/intercom_service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const TEMP_WORKSPACE = path.join(PROJECT_ROOT, 'tests', 'temp_workspace');

async function runWorkstreamABTests() {
  console.log('===============================================================');
  console.log('  Phase 3: Workstreams A & B Regression & Reliability Suite   ');
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

  if (!fs.existsSync(TEMP_WORKSPACE)) {
    fs.mkdirSync(TEMP_WORKSPACE, { recursive: true });
  }

  const testTasksFile = path.join(TEMP_WORKSPACE, '.workbench_tasks.json');
  if (fs.existsSync(testTasksFile)) {
    try { fs.unlinkSync(testTasksFile); } catch (e) {}
  }
  const testTasksDir = path.join(TEMP_WORKSPACE, '.workbench', 'tasks');
  if (fs.existsSync(testTasksDir)) {
    try { fs.rmSync(testTasksDir, { recursive: true, force: true }); } catch (e) {}
  }

  // --------------------------------------------------------------------------
  // WORKSTREAM A: Task Lifecycle & State Machine Rigor
  // --------------------------------------------------------------------------
  console.log('--- WORKSTREAM A: State Machine Rigor & Invariant Validation ---');
  {
    const intercom = new IntercomService({ cwd: TEMP_WORKSPACE });
    intercom.registerAgent({ agentId: 'claude', sessionId: 'sess_c', pid: 101, cwd: TEMP_WORKSPACE });
    const geminiPeer = intercom.registerAgent({ agentId: 'gemini', sessionId: 'sess_g', pid: 102, cwd: TEMP_WORKSPACE });

    // 1. Valid state transitions: APPROVAL_REQUESTED -> APPROVED -> QUEUED_FOR_CLAIM -> CLAIMED -> RUNNING -> COMPLETED
    console.log('[Test 1] Valid transitions append to state history...');
    const tValid = intercom.createDelegation({
      fromAgent: 'claude',
      toAgent: 'gemini',
      instructions: 'Valid task flow',
      cwd: TEMP_WORKSPACE,
      requiresApproval: true
    });
    assert(tValid.state === DelegationState.APPROVAL_REQUESTED, 'Initial state is APPROVAL_REQUESTED');

    intercom.approveDelegation({ correlationId: tValid.correlationId, approver: 'qa-tester' });
    assert(tValid.state === DelegationState.QUEUED_FOR_CLAIM, 'Approved task transitioned to QUEUED_FOR_CLAIM');

    intercom.claimTask({
      agentId: 'gemini',
      sessionId: geminiPeer.sessionId,
      correlationId: tValid.correlationId,
      cwd: TEMP_WORKSPACE
    });
    assert(tValid.state === DelegationState.RUNNING, 'Claimed task transitioned to RUNNING');

    intercom.completeTask({
      agentId: 'gemini',
      sessionId: geminiPeer.sessionId,
      correlationId: tValid.correlationId,
      summary: 'Task finished successfully'
    });
    assert(tValid.state === DelegationState.COMPLETED, 'Task reached terminal state COMPLETED');
    assert(tValid.stateHistory.length === 6, 'Full state transition history recorded (6 transitions)');

    // 2. Invalid state transitions rejected with TaskStateError (ERR_INVALID_TRANSITION)
    console.log('[Test 2] Invalid transitions rejected...');
    const tInvalid = intercom.createDelegation({
      fromAgent: 'claude',
      toAgent: 'gemini',
      instructions: 'Invalid transition test',
      cwd: TEMP_WORKSPACE,
      requiresApproval: true
    });

    let invalidErr = null;
    try {
      // Direct jump from APPROVAL_REQUESTED -> RUNNING is illegal
      intercom._transitionTask(tInvalid, DelegationState.RUNNING, 'Illegal bypass');
    } catch (e) {
      invalidErr = e;
    }
    assert(invalidErr instanceof TaskStateError, 'Throws instance of TaskStateError');
    assert(invalidErr?.code === 'ERR_INVALID_TRANSITION', 'Error code is ERR_INVALID_TRANSITION');
    assert(tInvalid.state === DelegationState.APPROVAL_REQUESTED, 'Task state preserved (not mutated) after rejection');

    // 3. Terminal state immutability
    console.log('[Test 3] Terminal state immutability...');
    let terminalErr = null;
    try {
      intercom._transitionTask(tValid, DelegationState.RUNNING, 'Illegal restart');
    } catch (e) {
      terminalErr = e;
    }
    assert(terminalErr instanceof TaskTerminalError, 'Throws instance of TaskTerminalError');
    assert(terminalErr?.code === 'ERR_TERMINAL_STATE', 'Error code is ERR_TERMINAL_STATE');
    assert(tValid.state === DelegationState.COMPLETED, 'Terminal state remained COMPLETED');

    // 4. Cancellation requested on active task vs confirmed
    console.log('[Test 4] In-flight cancellation request vs worker confirmation...');
    const tActive = intercom.createDelegation({
      fromAgent: 'claude',
      toAgent: 'gemini',
      instructions: 'Long running task',
      cwd: TEMP_WORKSPACE,
      requiresApproval: false
    });
    intercom.claimTask({
      agentId: 'gemini',
      sessionId: geminiPeer.sessionId,
      correlationId: tActive.correlationId,
      cwd: TEMP_WORKSPACE
    });
    assert(tActive.state === DelegationState.RUNNING, 'Task is RUNNING');

    const cancelReq = intercom.cancelDelegation(tActive.correlationId, 'User requested cancel');
    assert(cancelReq.status === 'cancellation_requested', 'Returns status cancellation_requested (does not lie that task stopped)');
    assert(tActive.state === DelegationState.RUNNING, 'Task state remains RUNNING until worker confirms');
    assert(tActive.cancellationRequested === true, 'cancellationRequested flag set to true');

    // Worker confirms cancellation
    const cancelConfirm = intercom.confirmCancellation({
      agentId: 'gemini',
      sessionId: geminiPeer.sessionId,
      correlationId: tActive.correlationId,
      reason: 'Gemini confirmed aborted operation'
    });
    assert(cancelConfirm.status === 'cancelled', 'confirmCancellation returns status cancelled');
    assert(tActive.state === DelegationState.CANCELLED, 'Task transitions cleanly to CANCELLED');
    assert(tActive.cancellationConfirmed === true, 'cancellationConfirmed flag set to true');

    // 5. Late completion after cancellation request
    console.log('[Test 5] Late completion arrives after cancellation request...');
    const tLate = intercom.createDelegation({
      fromAgent: 'claude',
      toAgent: 'gemini',
      instructions: 'Late completion test task',
      cwd: TEMP_WORKSPACE,
      requiresApproval: false
    });
    intercom.claimTask({
      agentId: 'gemini',
      sessionId: geminiPeer.sessionId,
      correlationId: tLate.correlationId,
      cwd: TEMP_WORKSPACE
    });

    intercom.cancelDelegation(tLate.correlationId, 'User cancelled while worker was computing');
    assert(tLate.cancellationRequested === true, 'Cancellation requested recorded');

    // Worker calls completeTask without seeing cancellation
    const lateCompleteResult = intercom.completeTask({
      agentId: 'gemini',
      sessionId: geminiPeer.sessionId,
      correlationId: tLate.correlationId,
      summary: 'Late computed output',
      modifiedFiles: ['late.js']
    });

    assert(tLate.state === DelegationState.CANCELLED, 'Task transitions to CANCELLED (never silently marked COMPLETED)');
    assert(tLate.lateCompletion !== null, 'Late completion work is preserved in lateCompletion field for audit');
    assert(tLate.lateCompletion.summary === 'Late computed output', 'Late summary preserved');

    // 6. Duplicate correlation ID rejection
    console.log('[Test 6] Duplicate correlation ID rejection...');
    let dupErr = null;
    try {
      intercom.createDelegation({
        fromAgent: 'claude',
        toAgent: 'gemini',
        instructions: 'Duplicate ID test',
        correlationId: tValid.correlationId
      });
    } catch (e) {
      dupErr = e;
    }
    assert(dupErr instanceof TaskDuplicateError, 'Throws TaskDuplicateError on existing correlationId');
    assert(dupErr?.code === 'ERR_DUPLICATE_TASK', 'Error code is ERR_DUPLICATE_TASK');

    // 7. Duplicate claim rejection
    console.log('[Test 7] Duplicate claim rejection...');
    let dupClaimErr = null;
    try {
      intercom.claimTask({
        agentId: 'gemini',
        sessionId: geminiPeer.sessionId,
        correlationId: tValid.correlationId,
        cwd: TEMP_WORKSPACE
      });
    } catch (e) {
      dupClaimErr = e;
    }
    assert(dupClaimErr instanceof TaskStateError, 'Duplicate claim throws TaskStateError');
    assert(dupClaimErr?.code === 'ERR_DUPLICATE_CLAIM', 'Error code is ERR_DUPLICATE_CLAIM');

    await intercom.shutdown();
  }

  // --------------------------------------------------------------------------
  // WORKSTREAM B: Serialized Persistence & Crash Recovery
  // --------------------------------------------------------------------------
  console.log('\n--- WORKSTREAM B: Serialized Persistence & Crash Recovery ---');
  {
    // Clean test tasks file and partitioned tasks
    if (fs.existsSync(testTasksFile)) {
      try { fs.unlinkSync(testTasksFile); } catch (e) {}
    }
    if (fs.existsSync(testTasksDir)) {
      try { fs.rmSync(testTasksDir, { recursive: true, force: true }); } catch (e) {}
    }

    const intercomB = new IntercomService({
      cwd: TEMP_WORKSPACE,
      approvalTimeoutMs: 2000, // 2s for testing boot expiry
      claimTimeoutMs: 2000     // 2s for testing boot expiry
    });
    intercomB.registerAgent({ agentId: 'claude', sessionId: 'sess_c_b', pid: 201, cwd: TEMP_WORKSPACE });
    const geminiB = intercomB.registerAgent({ agentId: 'gemini', sessionId: 'sess_g_b', pid: 202, cwd: TEMP_WORKSPACE });

    // 8. Concurrent rapid persistence writes (20 concurrent updates)
    console.log('[Test 8] Serialized persistence queue handles 20 concurrent updates...');
    const writePromises = [];
    for (let i = 0; i < 20; i++) {
      const task = intercomB.createDelegation({
        fromAgent: 'claude',
        toAgent: 'gemini',
        instructions: `Concurrent task #${i}`,
        correlationId: `CORR_CONCURRENT_${i}`,
        cwd: TEMP_WORKSPACE,
        requiresApproval: false
      });
      writePromises.push(intercomB._persist());
    }

    await Promise.all(writePromises);
    assert(fs.existsSync(testTasksFile), 'Tasks file written safely to disk');
    const diskContent = JSON.parse(fs.readFileSync(testTasksFile, 'utf8'));
    assert(diskContent.length === 20, 'All 20 concurrent tasks persisted without partial write or lock collision');

    // 9. Prepare states for restart crash recovery
    console.log('[Test 9] Preparing interrupted and expired tasks for boot recovery...');
    // A: Task in RUNNING state
    intercomB.claimTask({
      agentId: 'gemini',
      sessionId: geminiB.sessionId,
      correlationId: 'CORR_CONCURRENT_0',
      cwd: TEMP_WORKSPACE
    });
    // B: Task in QUEUED_FOR_CLAIM (claimable)
    // C: Create task with expired approval budget
    const expiredTask = intercomB.createDelegation({
      fromAgent: 'claude',
      toAgent: 'gemini',
      instructions: 'Expired approval task',
      correlationId: 'CORR_EXPIRED_BOOT',
      cwd: TEMP_WORKSPACE,
      requiresApproval: true,
      approvalTimeoutMs: 50 // 50ms budget
    });

    // Wait for 50ms budget to elapse
    await new Promise((r) => setTimeout(r, 80));

    // Simulate unexpected server crash/shutdown
    await intercomB.shutdown();

    // 10. Boot recovery on fresh coordinator instance
    console.log('[Test 10] Boot recovery verifies safe crash recovery and expiry catch-up...');
    const intercomRecovered = new IntercomService({
      cwd: TEMP_WORKSPACE,
      approvalTimeoutMs: 2000,
      claimTimeoutMs: 2000
    });

    // Verify Task A: Interrupted RUNNING task transitioned to FAILED
    const recoveredRunning = intercomRecovered.getDelegation('CORR_CONCURRENT_0');
    assert(recoveredRunning.state === DelegationState.FAILED, 'Interrupted RUNNING task safely recovered as FAILED');
    assert(recoveredRunning.error.includes('restarted'), 'Failure reason records restart');
    const recoveryHistory = recoveredRunning.stateHistory.find(h => h.actor === 'coordinator_recovery');
    assert(recoveryHistory !== undefined, 'Recovery action recorded in stateHistory by coordinator_recovery');

    // Verify Task B: Unclaimed QUEUED task remains QUEUED_FOR_CLAIM
    const recoveredQueued = intercomRecovered.getDelegation('CORR_CONCURRENT_1');
    assert(recoveredQueued.state === DelegationState.QUEUED_FOR_CLAIM, 'Queued task survived restart and remains QUEUED_FOR_CLAIM');
    const inbox = intercomRecovered.getInbox('gemini', TEMP_WORKSPACE);
    assert(inbox.some(t => t.correlationId === 'CORR_CONCURRENT_1'), 'Recovered queued task is immediately claimable in Gemini inbox');

    // Verify Task C: Expired unapproved task caught up to EXPIRED
    const recoveredExpired = intercomRecovered.getDelegation('CORR_EXPIRED_BOOT');
    assert(recoveredExpired.state === DelegationState.EXPIRED, 'Expired offline task caught up to EXPIRED state on boot');

    await intercomRecovered.shutdown();

    // 11. Orphaned temporary file cleanup
    console.log('[Test 11] Orphaned temporary files cleaned up on boot...');
    const orphanedTemp = path.join(TEMP_WORKSPACE, `.workbench_tasks.json.tmp_orphan_${Date.now()}`);
    fs.writeFileSync(orphanedTemp, 'orphaned temporary content', 'utf8');
    // Backdate mtime by 10 seconds to simulate a stale crash artifact
    const tenSecondsAgo = (Date.now() - 10000) / 1000;
    fs.utimesSync(orphanedTemp, tenSecondsAgo, tenSecondsAgo);
    assert(fs.existsSync(orphanedTemp), 'Simulated orphaned temp file created');

    const intercomCleanup = new IntercomService({ cwd: TEMP_WORKSPACE });
    assert(!fs.existsSync(orphanedTemp), 'Orphaned temp file automatically unlinked on coordinator startup');
    await intercomCleanup.shutdown();

    // 12. Corrupted JSON file emergency backup
    console.log('[Test 12] Corrupted JSON triggers emergency backup without server crash...');
    fs.writeFileSync(testTasksFile, '{ BROKEN_CORRUPTED_JSON_WITHOUT_CLOSING_BRACKET', 'utf8');

    const intercomCorrupt = new IntercomService({ cwd: TEMP_WORKSPACE });
    // Verify emergency backup was created
    const files = fs.readdirSync(TEMP_WORKSPACE);
    const backupFile = files.find(f => f.startsWith('.workbench_tasks.json.corrupt_'));
    assert(backupFile !== undefined, 'Emergency .corrupt_<timestamp> backup file created');
    const backupContent = fs.readFileSync(path.join(TEMP_WORKSPACE, backupFile), 'utf8');
    assert(backupContent.includes('BROKEN_CORRUPTED_JSON'), 'Original corrupted content preserved in backup');
    assert(intercomCorrupt.getAllDelegations().length === 0, 'Coordinator starts with clean empty map without crashing');

    await intercomCorrupt.shutdown();
  }

  // Clean test workspace artifacts
  if (fs.existsSync(testTasksFile)) {
    try { fs.unlinkSync(testTasksFile); } catch (e) {}
  }
  const leftoverFiles = fs.readdirSync(TEMP_WORKSPACE);
  for (const f of leftoverFiles) {
    if (f.startsWith('.workbench_tasks.json')) {
      try { fs.unlinkSync(path.join(TEMP_WORKSPACE, f)); } catch (e) {}
    }
  }

  console.log('\n===============================================================');
  console.log(`  PHASE 3 WORKSTREAMS A & B SUITE: ${passed} PASSED, ${failed} FAILED`);
  console.log('===============================================================\n');

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runWorkstreamABTests().catch((err) => {
  console.error('[FATAL WORKSTREAM A/B SUITE ERROR]', err);
  process.exit(1);
});
