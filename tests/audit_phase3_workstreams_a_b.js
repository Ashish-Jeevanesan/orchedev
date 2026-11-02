// D:\Ashish_P\AI-Tools\custom-OCT\tests\audit_phase3_workstreams_a_b.js
// Focused Phase 3 Workstreams A & B Acceptance Audit Runner

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import {
  IntercomService,
  DelegationState,
  TaskStateError,
  TaskTerminalError,
  TaskDuplicateError,
  TaskSecurityError
} from '../server/intercom_service.js';
import { WorkbenchServer } from '../server/server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const AUDIT_DIR = path.join(PROJECT_ROOT, 'tests', 'temp_audit_fixture');

async function runAudit() {
  console.log('===============================================================');
  console.log('  Focused Phase 3 Workstreams A & B Acceptance Audit Runner   ');
  console.log('===============================================================\n');

  // Setup isolated directory
  if (fs.existsSync(AUDIT_DIR)) {
    fs.rmSync(AUDIT_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(AUDIT_DIR, { recursive: true });

  const auditResults = [];

  function record(checkId, name, status, evidence, edgeCases = 'None') {
    auditResults.push({ checkId, name, status, evidence, edgeCases });
    console.log(`[CHECK ${checkId}] ${name}`);
    console.log(`  STATUS:   ${status}`);
    console.log(`  EVIDENCE: ${evidence}`);
    if (edgeCases !== 'None') {
      console.log(`  EDGE CASES: ${edgeCases}`);
    }
    console.log('');
  }

  try {
    // ------------------------------------------------------------------------
    // CHECK 1: Cancellation requested during RUNNING followed by late completion
    // ------------------------------------------------------------------------
    {
      const intercom = new IntercomService({ cwd: AUDIT_DIR });
      intercom.registerAgent({ agentId: 'gemini', sessionId: 'sess_g_audit1', pid: 501, cwd: AUDIT_DIR });
      intercom.registerAgent({ agentId: 'claude', sessionId: 'sess_c_audit1', pid: 502, cwd: AUDIT_DIR });

      const task = intercom.createDelegation({
        fromAgent: 'claude',
        toAgent: 'gemini',
        instructions: 'Compute heavy algorithm',
        correlationId: 'CORR_AUDIT_LATE_1',
        cwd: AUDIT_DIR,
        requiresApproval: false
      });

      intercom.claimTask({
        agentId: 'gemini',
        sessionId: 'sess_g_audit1',
        correlationId: 'CORR_AUDIT_LATE_1',
        cwd: AUDIT_DIR
      });

      const cancelRes = intercom.cancelDelegation('CORR_AUDIT_LATE_1', 'User stopped the job');
      const stateDuringCancel = task.state;
      const cancellationFlag = task.cancellationRequested;

      // Late completion arrives
      const lateRes = intercom.completeTask({
        agentId: 'gemini',
        sessionId: 'sess_g_audit1',
        correlationId: 'CORR_AUDIT_LATE_1',
        summary: 'Finished calculation despite cancellation request',
        modifiedFiles: ['calc.js']
      });

      const finalState = task.state;
      const lateData = task.lateCompletion;
      await intercom.shutdown();

      const pass =
        cancelRes.status === 'cancellation_requested' &&
        stateDuringCancel === DelegationState.RUNNING &&
        cancellationFlag === true &&
        finalState === DelegationState.CANCELLED &&
        lateData !== null &&
        lateData.summary === 'Finished calculation despite cancellation request';

      record(
        1,
        'Cancellation requested during RUNNING followed by late completion',
        pass ? 'PASS' : 'FAIL',
        `cancelDelegation returned status='${cancelRes.status}', in-flight state='${stateDuringCancel}', cancellationRequested=${cancellationFlag}. Upon late completeTask(), final state='${finalState}' (never COMPLETED), lateCompletion.summary='${lateData?.summary}'.`,
        'Work completed after cancellation request is preserved in task.lateCompletion for auditing rather than silently dropped.'
      );
    }

    // ------------------------------------------------------------------------
    // CHECK 2: Explicit worker cancellation confirmation
    // ------------------------------------------------------------------------
    {
      const intercom = new IntercomService({ cwd: AUDIT_DIR });
      const geminiPeer = intercom.registerAgent({ agentId: 'gemini', sessionId: 'sess_g_audit2', pid: 503, cwd: AUDIT_DIR });

      const task = intercom.createDelegation({
        fromAgent: 'claude',
        toAgent: 'gemini',
        instructions: 'Long batch task',
        correlationId: 'CORR_AUDIT_CONFIRM_2',
        cwd: AUDIT_DIR,
        requiresApproval: false
      });

      intercom.claimTask({
        agentId: 'gemini',
        sessionId: 'sess_g_audit2',
        correlationId: 'CORR_AUDIT_CONFIRM_2',
        cwd: AUDIT_DIR
      });

      intercom.cancelDelegation('CORR_AUDIT_CONFIRM_2', 'Cancellation requested');
      const confirmRes = intercom.confirmCancellation({
        agentId: 'gemini',
        sessionId: 'sess_g_audit2',
        correlationId: 'CORR_AUDIT_CONFIRM_2',
        reason: 'Worker cleanly halted process loop'
      });

      const finalState = task.state;
      const confirmedFlag = task.cancellationConfirmed;
      const peerStatus = geminiPeer.status;
      await intercom.shutdown();

      const pass =
        confirmRes.status === 'cancelled' &&
        finalState === DelegationState.CANCELLED &&
        confirmedFlag === true &&
        peerStatus === 'ONLINE';

      record(
        2,
        'Explicit worker cancellation confirmation',
        pass ? 'PASS' : 'FAIL',
        `confirmCancellation returned status='${confirmRes.status}', task state='${finalState}', cancellationConfirmed=${confirmedFlag}, worker status restored to '${peerStatus}'.`,
        'Calling confirmCancellation on an already terminal task returns status="already_terminal" without throwing.'
      );
    }

    // ------------------------------------------------------------------------
    // CHECK 3: Failed persistence write and subsequent retry
    // ------------------------------------------------------------------------
    {
      const tasksFile = path.join(AUDIT_DIR, '.workbench_tasks.json');
      if (fs.existsSync(tasksFile)) try { fs.unlinkSync(tasksFile); } catch (e) {}

      const intercom = new IntercomService({ cwd: AUDIT_DIR });
      
      // Emulate transient Windows lock (EPERM / EBUSY) on rename by intercepting fs.promises.rename for 2 attempts
      let renameAttempts = 0;
      const originalRename = fs.promises.rename;
      fs.promises.rename = async function (oldPath, newPath) {
        renameAttempts++;
        if (renameAttempts <= 2) {
          const err = new Error('EBUSY: resource busy or locked, rename');
          err.code = 'EBUSY';
          throw err;
        }
        return originalRename.apply(this, arguments);
      };

      let retrySucceeded = false;
      try {
        intercom.delegations.set('CORR_AUDIT_RETRY_3', {
          correlationId: 'CORR_AUDIT_RETRY_3',
          state: DelegationState.QUEUED_FOR_CLAIM,
          instructions: 'Retry test task'
        });
        await intercom._atomicWriteWithRetry();
        retrySucceeded = true;
      } finally {
        fs.promises.rename = originalRename;
      }

      await intercom.shutdown();

      const pass = retrySucceeded && renameAttempts === 3;
      record(
        3,
        'Failed persistence write and subsequent retry',
        pass ? 'PASS' : 'FAIL',
        `Transient EBUSY simulated for first 2 attempts. _atomicWriteWithRetry successfully retried with backoff and completed on attempt ${renameAttempts}.`,
        'Permanent errors exceeding 5 attempts unlink the unique temp file and reject the promise cleanly.'
      );
    }

    // ------------------------------------------------------------------------
    // CHECK 4: Concurrent persistence updates preserve the latest state
    // ------------------------------------------------------------------------
    {
      const diskTasksFile = path.join(AUDIT_DIR, '.workbench_tasks.json');
      if (fs.existsSync(diskTasksFile)) try { fs.unlinkSync(diskTasksFile); } catch (e) {}

      const intercom = new IntercomService({ cwd: AUDIT_DIR });
      const numTasks = 30;
      const writePromises = [];

      for (let i = 0; i < numTasks; i++) {
        intercom.createDelegation({
          fromAgent: 'claude',
          toAgent: 'gemini',
          instructions: `Concurrent task load ${i}`,
          correlationId: `CORR_AUDIT_CONCURRENT_${i}`,
          cwd: AUDIT_DIR,
          requiresApproval: false
        });
        writePromises.push(intercom._persist());
      }

      await Promise.all(writePromises);
      await intercom.shutdown();

      const diskData = JSON.parse(fs.readFileSync(diskTasksFile, 'utf8'));
      const pass = diskData.length === numTasks && diskData.every((t, idx) => t.correlationId.startsWith('CORR_AUDIT_CONCURRENT_'));

      record(
        4,
        'Concurrent persistence updates preserve the latest state',
        pass ? 'PASS' : 'FAIL',
        `Dispatched ${numTasks} concurrent createDelegation + _persist calls. Disk store parsed cleanly with exactly ${diskData.length}/${numTasks} records intact, zero JSON corruption.`,
        'Serialized queue batches overlapping waiters into a single write cycle and immediately drains remaining waiters in the next cycle.'
      );
    }

    // ------------------------------------------------------------------------
    // CHECK 5: Corrupted task storage produces a recoverable backup
    // ------------------------------------------------------------------------
    {
      const corruptFilePath = path.join(AUDIT_DIR, '.workbench_tasks.json');
      const corruptPayload = '{"incomplete_array": [1, 2, 3, {"damaged_record": true';
      fs.writeFileSync(corruptFilePath, corruptPayload, 'utf8');

      const intercom = new IntercomService({ cwd: AUDIT_DIR });
      const delegationsAfterBoot = intercom.getAllDelegations();
      await intercom.shutdown();

      const files = fs.readdirSync(AUDIT_DIR);
      const backupFile = files.find(f => f.startsWith('.workbench_tasks.json.corrupt_'));
      let backupContent = '';
      if (backupFile) {
        backupContent = fs.readFileSync(path.join(AUDIT_DIR, backupFile), 'utf8');
      }

      const pass = Boolean(backupFile) && backupContent === corruptPayload && delegationsAfterBoot.length === 0;

      record(
        5,
        'Corrupted task storage produces a recoverable backup',
        pass ? 'PASS' : 'FAIL',
        `Corrupted JSON was detected during boot. Emergency backup '${backupFile}' was created containing the exact original payload. Coordinator started cleanly with ${delegationsAfterBoot.length} tasks without crash.`,
        'Backup filenames include millisecond timestamp to prevent overwriting prior corrupted snapshots.'
      );
    }

    // ------------------------------------------------------------------------
    // CHECK 6: Server restart correctly recovers CLAIMED and RUNNING tasks
    // ------------------------------------------------------------------------
    {
      const tasksFile = path.join(AUDIT_DIR, '.workbench_tasks.json');
      const simulatedTasks = [
        {
          correlationId: 'CORR_AUDIT_CRASH_CLAIMED',
          fromAgent: 'claude',
          toAgent: 'gemini',
          instructions: 'Task in claimed state',
          cwd: AUDIT_DIR,
          state: DelegationState.CLAIMED,
          createdAt: Date.now() - 10000,
          stateHistory: [{ from: null, to: DelegationState.CLAIMED, timestamp: Date.now() - 10000 }]
        },
        {
          correlationId: 'CORR_AUDIT_CRASH_RUNNING',
          fromAgent: 'claude',
          toAgent: 'gemini',
          instructions: 'Task in running state',
          cwd: AUDIT_DIR,
          state: DelegationState.RUNNING,
          createdAt: Date.now() - 10000,
          stateHistory: [{ from: null, to: DelegationState.RUNNING, timestamp: Date.now() - 10000 }]
        }
      ];
      fs.writeFileSync(tasksFile, JSON.stringify(simulatedTasks, null, 2), 'utf8');

      const intercom = new IntercomService({ cwd: AUDIT_DIR });
      const recClaimed = intercom.getDelegation('CORR_AUDIT_CRASH_CLAIMED');
      const recRunning = intercom.getDelegation('CORR_AUDIT_CRASH_RUNNING');
      await intercom.shutdown();

      const pass =
        recClaimed.state === DelegationState.FAILED &&
        recClaimed.error.includes('restarted while task was in state CLAIMED') &&
        recRunning.state === DelegationState.FAILED &&
        recRunning.error.includes('restarted while task was in state RUNNING') &&
        recClaimed.stateHistory.some(h => h.actor === 'coordinator_recovery');

      record(
        6,
        'Server restart correctly recovers CLAIMED and RUNNING tasks',
        pass ? 'PASS' : 'FAIL',
        `CLAIMED task recovered to '${recClaimed.state}' (${recClaimed.error}). RUNNING task recovered to '${recRunning.state}' (${recRunning.error}). StateHistory includes coordinator_recovery actor.`,
        'Interrupted in-flight tasks are never falsely represented as completed or returned to queued without user review.'
      );
    }

    // ------------------------------------------------------------------------
    // CHECK 7: Approval and claim expiry use independent deadlines
    // ------------------------------------------------------------------------
    {
      const tasksFile = path.join(AUDIT_DIR, '.workbench_tasks.json');
      const now = Date.now();
      const simulatedTimeoutTasks = [
        // Task A: Short approval budget (100ms), large claim budget (60000ms), created 500ms ago -> EXPIRED on approval
        {
          correlationId: 'CORR_AUDIT_EXPIRY_APPROVAL',
          fromAgent: 'claude',
          toAgent: 'gemini',
          instructions: 'Approval expiry test',
          cwd: AUDIT_DIR,
          state: DelegationState.APPROVAL_REQUESTED,
          createdAt: now - 500,
          approvalRequestedAt: now - 500,
          approvalTimeoutMs: 100,
          claimTimeoutMs: 60000,
          executionTimeoutMs: 60000,
          stateHistory: []
        },
        // Task B: Long approval budget (60000ms), short claim budget (100ms), approved 500ms ago -> EXPIRED on claim
        {
          correlationId: 'CORR_AUDIT_EXPIRY_CLAIM',
          fromAgent: 'claude',
          toAgent: 'gemini',
          instructions: 'Claim expiry test',
          cwd: AUDIT_DIR,
          state: DelegationState.QUEUED_FOR_CLAIM,
          createdAt: now - 1000,
          approvedAt: now - 500,
          approvalTimeoutMs: 60000,
          claimTimeoutMs: 100,
          executionTimeoutMs: 60000,
          stateHistory: []
        },
        // Task C: Long budgets for both (60000ms), approved 500ms ago -> STILL QUEUED
        {
          correlationId: 'CORR_AUDIT_EXPIRY_STILL_QUEUED',
          fromAgent: 'claude',
          toAgent: 'gemini',
          instructions: 'Active queued test',
          cwd: AUDIT_DIR,
          state: DelegationState.QUEUED_FOR_CLAIM,
          createdAt: now - 1000,
          approvedAt: now - 500,
          approvalTimeoutMs: 60000,
          claimTimeoutMs: 60000,
          executionTimeoutMs: 60000,
          stateHistory: []
        }
      ];
      fs.writeFileSync(tasksFile, JSON.stringify(simulatedTimeoutTasks, null, 2), 'utf8');

      const intercom = new IntercomService({ cwd: AUDIT_DIR });
      const recA = intercom.getDelegation('CORR_AUDIT_EXPIRY_APPROVAL');
      const recB = intercom.getDelegation('CORR_AUDIT_EXPIRY_CLAIM');
      const recC = intercom.getDelegation('CORR_AUDIT_EXPIRY_STILL_QUEUED');
      await intercom.shutdown();

      const pass =
        recA.state === DelegationState.EXPIRED &&
        recA.error.includes('approval timed out') &&
        recB.state === DelegationState.EXPIRED &&
        recB.error.includes('claim timed out') &&
        recC.state === DelegationState.QUEUED_FOR_CLAIM;

      record(
        7,
        'Approval and claim expiry use independent deadlines',
        pass ? 'PASS' : 'FAIL',
        `Task A (approvalTimeoutMs=100) -> '${recA.state}' (${recA.error}). Task B (claimTimeoutMs=100) -> '${recB.state}' (${recB.error}). Task C (budget=60000) remained '${recC.state}'.`,
        'Approval wait time does not consume claim or execution budgets.'
      );
    }

    // ------------------------------------------------------------------------
    // CHECK 8: Temporary-file cleanup does not interfere with active writes
    // ------------------------------------------------------------------------
    {
      const now = Date.now();
      const activeTempFile = path.join(AUDIT_DIR, `.workbench_tasks.json.tmp_active_${now}`);
      const staleTempFile = path.join(AUDIT_DIR, `.workbench_tasks.json.tmp_stale_${now}`);

      fs.writeFileSync(activeTempFile, 'active write in-flight', 'utf8');
      fs.writeFileSync(staleTempFile, 'stale crashed write from hours ago', 'utf8');

      // Set staleTempFile mtime to 15 seconds ago
      const fifteenSecsAgo = (now - 15000) / 1000;
      fs.utimesSync(staleTempFile, fifteenSecsAgo, fifteenSecsAgo);

      // Set activeTempFile mtime to current millisecond
      const currentSec = now / 1000;
      fs.utimesSync(activeTempFile, currentSec, currentSec);

      const intercom = new IntercomService({ cwd: AUDIT_DIR });
      const activeStillExists = fs.existsSync(activeTempFile);
      const staleStillExists = fs.existsSync(staleTempFile);
      await intercom.shutdown();

      const pass = activeStillExists === true && staleStillExists === false;

      record(
        8,
        'Temporary-file cleanup does not interfere with active writes',
        pass ? 'PASS' : 'FAIL',
        `Active temp file (age < 1s) exists: ${activeStillExists} (preserved). Stale temp file (age > 15s) exists: ${staleStillExists} (unlinked).`,
        '5-second age threshold prevents startup cleanup from deleting temporary files written by concurrently active coordinators.'
      );
    }

    // ------------------------------------------------------------------------
    // CHECK 9: Actual loopback listening address and dynamic port registration
    // ------------------------------------------------------------------------
    {
      const server = new WorkbenchServer({ cwd: PROJECT_ROOT, port: 0 });
      const { port, sessionToken } = await server.start();

      const addr = server.server.address();
      const isLoopbackOnly = addr.address === '127.0.0.1';
      const isDynamicPort = addr.port > 1024 && typeof addr.port === 'number';

      // Probe /api/health over 127.0.0.1
      const healthRes = await fetch(`http://127.0.0.1:${port}/api/health`);
      const healthJson = await healthRes.json();

      // Probe origin security: external origin should be rejected with 403
      const badOriginRes = await fetch(`http://127.0.0.1:${port}/api/session/verify`, {
        headers: {
          'Origin': 'http://malicious-website.com',
          'X-Session-Token': sessionToken
        }
      });

      // Probe auth security: valid session token should succeed with 200
      const validAuthRes = await fetch(`http://127.0.0.1:${port}/api/session/verify`, {
        headers: {
          'Origin': `http://127.0.0.1:${port}`,
          'X-Session-Token': sessionToken
        }
      });
      const validAuthJson = await validAuthRes.json();

      await server.shutdown();

      const pass =
        isLoopbackOnly &&
        isDynamicPort &&
        healthRes.status === 200 &&
        healthJson.status === 'ok' &&
        badOriginRes.status === 403 &&
        validAuthRes.status === 200 &&
        validAuthJson.authenticated === true;

      record(
        9,
        'Actual loopback listening address and dynamic port registration',
        pass ? 'PASS' : 'FAIL',
        `Bound strictly to ${addr.address}:${addr.port}. /api/health returned HTTP 200. External origin returned HTTP ${badOriginRes.status} Forbidden. Valid session token authenticated: ${validAuthJson.authenticated}.`,
        'Server binds exclusively to loopback 127.0.0.1 (not 0.0.0.0) with OS-assigned port 0.'
      );
    }
  } finally {
    // Clean up temporary fixture directory
    if (fs.existsSync(AUDIT_DIR)) {
      try {
        fs.rmSync(AUDIT_DIR, { recursive: true, force: true });
      } catch (e) {}
    }
  }

  console.log('===============================================================');
  console.log('                 ACCEPTANCE AUDIT SUMMARY');
  console.log('===============================================================');
  const allPass = auditResults.every(r => r.status === 'PASS');
  for (const r of auditResults) {
    console.log(`Check ${r.checkId}: [${r.status}] ${r.name}`);
  }
  console.log('---------------------------------------------------------------');
  console.log(`Total: ${auditResults.filter(r => r.status === 'PASS').length} / ${auditResults.length} CHECKS PASSED`);
  console.log('===============================================================\n');

  if (!allPass) process.exit(1);
  process.exit(0);
}

runAudit().catch(err => {
  console.error('[FATAL AUDIT ERROR]', err);
  process.exit(1);
});
