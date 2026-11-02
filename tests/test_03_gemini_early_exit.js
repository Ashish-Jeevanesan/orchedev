// D:\Ashish_P\AI-Tools\custom-OCT\tests\test_03_gemini_early_exit.js
// Reliability Test 3: A Gemini process that exits before replying

import { GeminiAcpClient } from '../core/gemini_acp_client.js';
import { Task, TaskState } from '../core/task.js';
import { ProcessManager } from '../core/process_manager.js';

const CWD = 'D:\\Ashish_P\\AI-Tools\\custom-OCT';

async function run() {
  console.log('[TEST 3] Running: Gemini process that exits before replying');
  const client = new GeminiAcpClient({ cwd: CWD });
  const report = { name: 'test_03_gemini_early_exit', passed: false, checks: [] };

  try {
    await client.start();
    await client.initialize();
    await client.createSession();

    const corrId = `CORR_EARLY_EXIT_${Date.now()}`;
    const task = new Task({
      correlationId: corrId,
      targetAgent: 'gemini',
      prompt: 'Write a comprehensive 500-word essay about distributed database consensus algorithms.'
    });

    console.log(`[TEST 3] Dispatched long prompt (${corrId}), will simulate sudden process crash...`);

    // Start execution (un-awaited promise)
    const taskPromise = client.executeTask(task, 30000);

    // Wait 400ms for request to reach stdio, then kill child process tree abruptly
    await new Promise((r) => setTimeout(r, 400));
    const pidToKill = client.managed?.pid;
    console.log(`[TEST 3] Abruptly killing Gemini PID ${pidToKill}...`);
    await ProcessManager.terminateProcessTree(pidToKill);

    let caughtError = null;
    try {
      await taskPromise;
    } catch (err) {
      caughtError = err;
    }

    const errorMatched = caughtError && (caughtError.code === 'ERR_PROCESS_EXITED' || caughtError.message.includes('process terminated'));
    const taskStateFailed = task.state === TaskState.FAILED;

    report.checks.push({
      check: 'Promise rejected on early process exit',
      passed: !!caughtError,
      errorCode: caughtError?.code,
      errorMessage: caughtError?.message
    });

    report.checks.push({
      check: 'Task state transitioned to FAILED',
      passed: taskStateFailed,
      finalTaskState: task.state
    });

    report.checks.push({
      check: 'Process did not hang and client cleaned up',
      passed: client.managed === null && client.pendingRequests.size === 0
    });

    report.passed = errorMatched && taskStateFailed && client.pendingRequests.size === 0;
    console.log(`[TEST 3] Result: ${report.passed ? 'PASSED' : 'FAILED'}`);
  } catch (err) {
    console.error('[TEST 3] Error:', err);
    report.error = err.message;
    report.passed = false;
  } finally {
    await client.close();
  }

  return report;
}

run().then((res) => {
  if (!res.passed) process.exit(1);
});
