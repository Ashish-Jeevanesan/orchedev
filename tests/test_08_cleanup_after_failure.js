// D:\Ashish_P\AI-Tools\custom-OCT\tests\test_08_cleanup_after_failure.js
// Reliability Test 8: Resource and process cleanup after failure

import { CoordinationCore } from '../core/coordination_core.js';
import { execSync } from 'child_process';

const CWD = 'D:\\Ashish_P\\AI-Tools\\custom-OCT';

function isPidAlive(pid) {
  if (!pid) return false;
  try {
    if (process.platform === 'win32') {
      const output = execSync(`tasklist /FI "PID eq ${pid}" /NH`, { encoding: 'utf-8' });
      return output.includes(String(pid));
    } else {
      process.kill(pid, 0);
      return true;
    }
  } catch (e) {
    return false;
  }
}

async function run() {
  console.log('[TEST 8] Running: Resource and process cleanup after failure');
  const core = new CoordinationCore({ cwd: CWD });
  const report = { name: 'test_08_cleanup_after_failure', passed: false, checks: [] };

  try {
    await core.initialize();

    const geminiPid = core.geminiClient.managed?.pid;
    console.log(`[TEST 8] Initialized Gemini ACP with PID: ${geminiPid}`);

    const pidInitiallyAlive = isPidAlive(geminiPid);
    report.checks.push({
      check: 'Gemini process active after initialization',
      passed: pidInitiallyAlive,
      pid: geminiPid
    });

    // Induce failure / shutdown
    console.log('[TEST 8] Initiating coordinator shutdown after failure...');
    await core.shutdown();

    // Verify process is completely terminated
    // Allow brief grace period for OS process table update
    await new Promise((r) => setTimeout(r, 800));

    const pidDeadAfterShutdown = !isPidAlive(geminiPid);
    report.checks.push({
      check: 'Gemini process completely terminated after shutdown',
      passed: pidDeadAfterShutdown,
      pid: geminiPid
    });

    report.passed = pidInitiallyAlive && pidDeadAfterShutdown;
    console.log(`[TEST 8] Result: ${report.passed ? 'PASSED' : 'FAILED'}`);
  } catch (err) {
    console.error('[TEST 8] Error:', err);
    report.error = err.message;
    report.passed = false;
  }

  return report;
}

run().then((res) => {
  if (!res.passed) process.exit(1);
});
