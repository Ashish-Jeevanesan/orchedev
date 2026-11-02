// D:\Ashish_P\AI-Tools\custom-OCT\tests\test_04_request_timeout.js
// Reliability Test 4: A request timeout

import { CoordinationCore } from '../core/coordination_core.js';
import { TaskState } from '../core/task.js';

const CWD = 'D:\\Ashish_P\\AI-Tools\\custom-OCT';

async function run() {
  console.log('[TEST 4] Running: Request timeout handling');
  const core = new CoordinationCore({ cwd: CWD });
  const report = { name: 'test_04_request_timeout', passed: false, checks: [] };

  try {
    await core.initialize();

    const corrId = `CORR_TIMEOUT_${Date.now()}`;
    const task = core.createTask({
      correlationId: corrId,
      targetAgent: 'gemini',
      prompt: 'Write an extremely detailed analysis comparing PostgreSQL MVCC to Oracle multiversioning with 10 code examples.'
    });

    console.log(`[TEST 4] Executing task with 1500ms timeout...`);
    let caughtTimeout = null;

    try {
      await core.executeTask(task, 1500); // 1.5s timeout on heavy query
    } catch (err) {
      caughtTimeout = err;
    }

    const timedOut = task.state === TaskState.TIMED_OUT;
    const errorIsTimeout = caughtTimeout && caughtTimeout.code === 'ERR_TIMEOUT';

    report.checks.push({
      check: 'Task state is TIMED_OUT',
      passed: timedOut,
      taskState: task.state
    });

    report.checks.push({
      check: 'Caught error has ERR_TIMEOUT code',
      passed: errorIsTimeout,
      errorCode: caughtTimeout?.code,
      message: caughtTimeout?.message
    });

    report.passed = timedOut && errorIsTimeout;
    console.log(`[TEST 4] Result: ${report.passed ? 'PASSED' : 'FAILED'}`);
  } catch (err) {
    console.error('[TEST 4] Error:', err);
    report.error = err.message;
    report.passed = false;
  } finally {
    await core.shutdown();
  }

  return report;
}

run().then((res) => {
  if (!res.passed) process.exit(1);
});
