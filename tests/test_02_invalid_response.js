// D:\Ashish_P\AI-Tools\custom-OCT\tests\test_02_invalid_response.js
// Reliability Test 2: An invalid or unexpected response handling

import { CoordinationCore } from '../core/coordination_core.js';
import { TaskState } from '../core/task.js';

const CWD = 'D:\\Ashish_P\\AI-Tools\\custom-OCT';

function strictJsonValidator(rawText, expectedCorrelationId, requiredKey) {
  const cleaned = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    throw new Error(`Response is not valid JSON: ${rawText}`);
  }

  if (parsed.correlationId !== expectedCorrelationId) {
    throw new Error(`Correlation ID mismatch: expected ${expectedCorrelationId}, got ${parsed.correlationId}`);
  }

  if (parsed[requiredKey] === undefined) {
    throw new Error(`Missing required key "${requiredKey}" in structured response`);
  }

  return parsed;
}

async function run() {
  console.log('[TEST 2] Running: Handling an invalid or unexpected response');
  const core = new CoordinationCore({ cwd: CWD });
  const report = { name: 'test_02_invalid_response', passed: false, checks: [] };

  try {
    await core.initialize();

    // 1. Task asking for free-form greeting, but configured with strict JSON validator requiring "authCode"
    const corrId = `CORR_INVALID_${Date.now()}`;
    const task = core.createTask({
      correlationId: corrId,
      targetAgent: 'gemini',
      prompt: 'Respond with a simple non-JSON greeting like: Hello Workbench!'
    });

    task.validator = (raw) => strictJsonValidator(raw, corrId, 'mandatoryStrictField');

    console.log(`[TEST 2] Executing task with prompt deliberately violating validator schema...`);
    let caughtError = null;

    try {
      await core.executeTask(task, 20000);
    } catch (err) {
      caughtError = err;
    }

    const taskFailedProperly = task.state === TaskState.FAILED;
    const errorIsValidation = caughtError && caughtError.message.includes('not valid JSON');

    report.checks.push({
      check: 'Validator caught non-conforming response and threw',
      passed: !!caughtError && errorIsValidation,
      errorMessage: caughtError?.message
    });

    report.checks.push({
      check: 'Task state cleanly transitioned to FAILED',
      passed: taskFailedProperly,
      finalState: task.state
    });

    // 2. Verify coordinator remains healthy and executes next task without issue
    const recoveryCorrId = `CORR_RECOVERY_${Date.now()}`;
    const recoveryTask = core.createTask({
      correlationId: recoveryCorrId,
      targetAgent: 'gemini',
      prompt: `Echo: RECOVERY_${recoveryCorrId}`
    });

    console.log(`[TEST 2] Executing recovery task (${recoveryCorrId})...`);
    await core.executeTask(recoveryTask, 20000);
    const recoveryPassed = recoveryTask.state === TaskState.COMPLETED && recoveryTask.result.includes(recoveryCorrId);

    report.checks.push({
      check: 'Coordinator successfully recovered and completed subsequent task',
      passed: recoveryPassed,
      recoveryState: recoveryTask.state
    });

    report.passed = taskFailedProperly && errorIsValidation && recoveryPassed;
    console.log(`[TEST 2] Result: ${report.passed ? 'PASSED' : 'FAILED'}`);
  } catch (err) {
    console.error('[TEST 2] Error:', err);
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
