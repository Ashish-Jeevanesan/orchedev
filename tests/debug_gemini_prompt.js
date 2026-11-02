// D:\Ashish_P\AI-Tools\custom-OCT\tests\debug_gemini_prompt.js
import { GeminiAcpClient } from '../core/gemini_acp_client.js';
import { Task } from '../core/task.js';

const CWD = 'D:\\Ashish_P\\AI-Tools\\custom-OCT';

async function main() {
  console.log('[DEBUG] Starting GeminiAcpClient with debug logging...');
  const client = new GeminiAcpClient({ cwd: CWD, debug: true });
  await client.start();
  console.log('[DEBUG] Initializing...');
  await client.initialize();
  console.log('[DEBUG] Creating session...');
  await client.createSession();

  console.log('[DEBUG] Sending prompt...');
  const task = new Task({
    correlationId: 'DEBUG_PROMPT_1',
    targetAgent: 'gemini',
    prompt: 'What balanced search tree data structure is widely used in relational database indexing? Return only JSON: { "answer": "..." }'
  });

  task.addChunk = (chk) => {
    console.log('[DEBUG CHUNK]', JSON.stringify(chk));
  };

  const start = Date.now();
  try {
    await client.executeTask(task, 60000);
    console.log(`[DEBUG COMPLETED] in ${Date.now() - start}ms. Result:`, task.result);
  } catch (err) {
    console.log(`[DEBUG FAILED] in ${Date.now() - start}ms:`, err);
  } finally {
    await client.close();
  }
}

main();
