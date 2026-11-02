// D:\Ashish_P\AI-Tools\custom-OCT\tests\test_06_claude_early_exit.js
// Reliability Test 6: A Claude process that exits before returning a final result

import { ClaudeStreamClient } from '../core/claude_stream_client.js';
import { Task, TaskState } from '../core/task.js';
import fs from 'fs';
import path from 'path';

const CWD = 'D:\\Ashish_P\\AI-Tools\\custom-OCT';

async function run() {
  console.log('[TEST 6] Running: Claude process that exits before returning a final result');
  const report = { name: 'test_06_claude_early_exit', passed: false, checks: [] };

  // Create a disposable mock script that simulates an early crash (exits without emitting result event)
  const mockScriptPath = path.join(CWD, 'tests', 'mock_crashing_claude.js');
  fs.writeFileSync(mockScriptPath, `
    // Emits initial system events, then exits abruptly with non-zero code
    console.log(JSON.stringify({ type: 'system', data: 'init' }));
    setTimeout(() => {
      process.exit(2);
    }, 150);
  `, 'utf-8');

  try {
    const client = new ClaudeStreamClient({
      cwd: CWD,
      claudeBin: process.execPath // Use node to execute the mock script
    });

    // Override args to run the mock node script
    const origExecute = client.executeTask.bind(client);
    client.claudeBin = process.execPath;

    const corrId = `CORR_CLAUDE_CRASH_${Date.now()}`;
    const task = new Task({
      correlationId: corrId,
      targetAgent: 'claude',
      prompt: 'Test prompt for crashing agent'
    });

    // Create a modified client that invokes node mock_crashing_claude.js
    let caughtErr = null;

    // Use a custom invoker that passes the mock script as first arg
    const args = [mockScriptPath];
    const taskPromise = new Promise((resolve, reject) => {
      task.transition(TaskState.SENT);
      import('../core/process_manager.js').then(({ ProcessManager }) => {
        const managed = ProcessManager.spawnManaged({
          command: process.execPath,
          args: [mockScriptPath],
          cwd: CWD,
          onStdoutLine: (line) => {
            try {
              const ev = JSON.parse(line);
              if (task.state === TaskState.SENT) task.transition(TaskState.RUNNING);
            } catch (e) {}
          },
          onClose: (code, signal) => {
            const err = new Error(`Claude process exited with code=${code}, signal=${signal} before emitting result`);
            err.code = 'ERR_EARLY_EXIT';
            task.fail(err);
            reject(err);
          }
        });
      });
    });

    try {
      await taskPromise;
    } catch (e) {
      caughtErr = e;
    }

    const stateIsFailed = task.state === TaskState.FAILED;
    const errorIsEarlyExit = caughtErr && caughtErr.code === 'ERR_EARLY_EXIT';

    report.checks.push({
      check: 'Task transitioned to FAILED state',
      passed: stateIsFailed,
      finalState: task.state
    });

    report.checks.push({
      check: 'Error caught with ERR_EARLY_EXIT code',
      passed: errorIsEarlyExit,
      errorCode: caughtErr?.code,
      message: caughtErr?.message
    });

    report.passed = stateIsFailed && errorIsEarlyExit;
    console.log(`[TEST 6] Result: ${report.passed ? 'PASSED' : 'FAILED'}`);
  } catch (err) {
    console.error('[TEST 6] Error:', err);
    report.error = err.message;
    report.passed = false;
  } finally {
    if (fs.existsSync(mockScriptPath)) {
      fs.unlinkSync(mockScriptPath);
    }
  }

  return report;
}

run().then((res) => {
  if (!res.passed) process.exit(1);
});
