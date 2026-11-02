// D:\Ashish_P\AI-Tools\custom-OCT\tests\test_01_sequential.js
// Reliability Test 1: Two sequential requests with different correlation IDs

import { CoordinationCore } from '../core/coordination_core.js';
import { TaskState } from '../core/task.js';

const CWD = 'D:\\Ashish_P\\AI-Tools\\custom-OCT';

async function run() {
  console.log('[TEST 1] Running: Two sequential requests with different correlation IDs');
  const core = new CoordinationCore({ cwd: CWD });
  const report = { name: 'test_01_sequential', passed: false, details: [] };

  try {
    await core.initialize();

    // Request 1
    const corrId1 = `CORR_SEQ_1_${Date.now()}`;
    const task1 = core.createTask({
      correlationId: corrId1,
      targetAgent: 'gemini',
      prompt: `Respond with only the text: MARKER_1_${corrId1}`
    });

    console.log(`[TEST 1] Executing task 1 (${corrId1})...`);
    await core.executeTask(task1, 20000);

    const pass1 = task1.state === TaskState.COMPLETED && task1.result.includes(corrId1);
    report.details.push({
      task: 1,
      correlationId: corrId1,
      state: task1.state,
      durationMs: task1.durationMs,
      passed: pass1
    });
    console.log(`[TEST 1] Task 1 completed. State: ${task1.state}, Result: ${task1.result.trim()}`);

    // Request 2
    const corrId2 = `CORR_SEQ_2_${Date.now()}`;
    const task2 = core.createTask({
      correlationId: corrId2,
      targetAgent: 'gemini',
      prompt: `Respond with only the text: MARKER_2_${corrId2}`
    });

    console.log(`[TEST 1] Executing task 2 (${corrId2})...`);
    await core.executeTask(task2, 20000);

    const pass2 = task2.state === TaskState.COMPLETED && task2.result.includes(corrId2);
    report.details.push({
      task: 2,
      correlationId: corrId2,
      state: task2.state,
      durationMs: task2.durationMs,
      passed: pass2
    });
    console.log(`[TEST 1] Task 2 completed. State: ${task2.state}, Result: ${task2.result.trim()}`);

    // Verification: Both passed and no response cross-contamination
    const noBleed = !task1.result.includes(corrId2) && !task2.result.includes(corrId1);
    report.passed = pass1 && pass2 && noBleed;

    console.log(`[TEST 1] Result: ${report.passed ? 'PASSED' : 'FAILED'}`);
  } catch (err) {
    console.error('[TEST 1] Error:', err);
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
