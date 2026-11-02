// D:\Ashish_P\AI-Tools\custom-OCT\tests\test_07_duplicate_late_response.js
// Reliability Test 7: Duplicate or late response handling and idempotency

import { CoordinationCore } from '../core/coordination_core.js';
import { TaskState } from '../core/task.js';

const CWD = 'D:\\Ashish_P\\AI-Tools\\custom-OCT';

async function run() {
  console.log('[TEST 7] Running: Duplicate or late response protection');
  const core = new CoordinationCore({ cwd: CWD });
  const report = { name: 'test_07_duplicate_late_response', passed: false, checks: [] };

  try {
    // 1. Create and complete a task
    const corrId = `CORR_TASK_A_${Date.now()}`;
    const task = core.createTask({
      correlationId: corrId,
      targetAgent: 'gemini',
      prompt: 'Test task for idempotency'
    });

    task.transition(TaskState.SENT);
    task.transition(TaskState.RUNNING);
    task.complete('Original legitimate response result');

    report.checks.push({
      check: 'Task completed normally in terminal state',
      passed: task.state === TaskState.COMPLETED,
      state: task.state
    });

    // 2. Simulate duplicate/late response arriving for the same correlation ID
    const duplicatePayload = 'Late duplicate arrival';
    const dupResult = core.handleExternalResponse(corrId, duplicatePayload);

    report.checks.push({
      check: 'Duplicate/late response rejected',
      passed: dupResult.status === 'DUPLICATE_LATE_REJECTED',
      resultStatus: dupResult.status,
      loggedEntry: core.duplicateOrLateResponses.length === 1
    });

    // 3. Verify original task result was NOT overwritten
    report.checks.push({
      check: 'Original task result retained without corruption',
      passed: task.result === 'Original legitimate response result',
      taskResult: task.result
    });

    // 4. Simulate completely unknown/orphan correlation ID arrival
    const orphanCorrId = `CORR_UNKNOWN_${Date.now()}`;
    const orphanResult = core.handleExternalResponse(orphanCorrId, 'Some orphan payload');

    report.checks.push({
      check: 'Orphan response flagged and ignored without matching tasks',
      passed: orphanResult.status === 'ORPHAN_IGNORED' && core.orphanResponses.length === 1,
      orphanStatus: orphanResult.status
    });

    // 5. Verify direct invalid transition throws ERR_TERMINAL_STATE
    let errorThrownOnInvalidTransition = false;
    try {
      task.transition(TaskState.RUNNING);
    } catch (err) {
      if (err.code === 'ERR_TERMINAL_STATE') {
        errorThrownOnInvalidTransition = true;
      }
    }

    report.checks.push({
      check: 'Direct state mutation on terminal task throws ERR_TERMINAL_STATE',
      passed: errorThrownOnInvalidTransition
    });

    const allPassed = report.checks.every(c => c.passed);
    report.passed = allPassed;
    console.log(`[TEST 7] Result: ${report.passed ? 'PASSED' : 'FAILED'}`);
  } catch (err) {
    console.error('[TEST 7] Error:', err);
    report.error = err.message;
    report.passed = false;
  }

  return report;
}

run().then((res) => {
  if (!res.passed) process.exit(1);
});
