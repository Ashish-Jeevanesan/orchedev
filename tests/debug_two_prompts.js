// D:\Ashish_P\AI-Tools\custom-OCT\tests\debug_two_prompts.js
import { GeminiAcpClient } from '../core/gemini_acp_client.js';
import { Task } from '../core/task.js';
import os from 'os';
import path from 'path';
import fs from 'fs';

const tempDir = path.join(os.tmpdir(), `test_two_prompts_${Date.now()}`);
fs.mkdirSync(tempDir, { recursive: true });

async function main() {
  console.log('[DEBUG] Testing two consecutive prompts on same ACP session in tempDir...');
  console.log('tempDir:', tempDir);

  const client = new GeminiAcpClient({ cwd: tempDir, debug: true });
  await client.start();
  await client.initialize();
  const sessionId = await client.getOrCreateSession(tempDir);
  console.log('Session created:', sessionId);

  // Prompt 1
  console.log('--- Sending Prompt 1 ---');
  const t1 = new Task({ correlationId: 'P1', targetAgent: 'gemini', prompt: 'Echo: HELLO_1', cwd: tempDir });
  const s1 = Date.now();
  await client.executeTask(t1, 45000);
  console.log(`Prompt 1 finished in ${Date.now() - s1}ms. Result:`, t1.result.trim());

  // Prompt 2
  console.log('\n--- Sending Prompt 2 ---');
  const prompt2 = 'Task from Claude: "What balanced search tree data structure is widely used in relational database indexing?". Respond with ONLY valid JSON: { "answer": "B-Tree" }';
  const t2 = new Task({ correlationId: 'P2', targetAgent: 'gemini', prompt: prompt2, cwd: tempDir });
  const s2 = Date.now();
  try {
    await client.executeTask(t2, 45000);
    console.log(`Prompt 2 finished in ${Date.now() - s2}ms. Result:`, t2.result.trim());
  } catch (err) {
    console.log(`Prompt 2 failed after ${Date.now() - s2}ms:`, err);
  }

  await client.close();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}
}

main();
