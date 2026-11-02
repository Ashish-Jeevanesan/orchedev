// D:\Ashish_P\AI-Tools\custom-OCT\tests\debug_workflow_issue.js
import { TaskCoordinatorService } from '../server/task_coordinator_service.js';
import { Task } from '../core/task.js';
import os from 'os';
import path from 'path';
import fs from 'fs';

const tempDir = path.join(os.tmpdir(), `test_wf_debug_${Date.now()}`);
fs.mkdirSync(tempDir, { recursive: true });

async function main() {
  console.log('[DEBUG WF] Starting coordinator service...');
  const service = new TaskCoordinatorService({
    cwd: tempDir,
    eventBroadcaster: (type, payload) => console.log(`[EVENT ${type}]`, payload.eventType || payload.step || '')
  });

  await service.initialize();
  service.setProjectCwd(tempDir);

  // Turn 1: Direct Gemini task (Target 2 equivalent)
  console.log('\n--- Running Task 1 (Target 2 equivalent) ---');
  const t1 = service.createTask({
    correlationId: 'TASK_1',
    targetAgent: 'gemini',
    prompt: 'Echo: TARGET_2_OK'
  });
  await service.dispatchTask(t1, 45000);
  console.log('Task 1 completed. Result:', t1.result.trim());

  // Turn 2: Workflow task (Target 3 equivalent)
  console.log('\n--- Running Task 2 (Workflow) ---');
  const t2 = service.createTask({
    correlationId: 'TASK_2_WF',
    targetAgent: 'claude_gemini_workflow',
    prompt: 'What balanced search tree data structure is widely used in relational database indexing?'
  });

  // Enable raw stdout debugging on Gemini ACP client
  const geminiClient = service.core.geminiClient;
  const origStdoutHandler = geminiClient._handleStdoutLine.bind(geminiClient);
  geminiClient._handleStdoutLine = (line) => {
    console.log('[GEMINI RAW STDOUT]', line.slice(0, 180));
    origStdoutHandler(line);
  };

  const origStderrHandler = geminiClient._handleStderrLine.bind(geminiClient);
  geminiClient._handleStderrLine = (line) => {
    console.log('[GEMINI RAW STDERR]', line);
    origStderrHandler(line);
  };

  const s = Date.now();
  try {
    await service.dispatchTask(t2, 120000);
    console.log(`Task 2 finished in ${Date.now() - s}ms. Result:`, t2.result);
  } catch (err) {
    console.error(`Task 2 failed in ${Date.now() - s}ms:`, err);
  }

  await service.shutdown();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}
}

main();
