// D:\Ashish_P\AI-Tools\custom-OCT\tests\test_spineit_gemini.js
import { GeminiAcpClient } from '../core/gemini_acp_client.js';
import { Task } from '../core/task.js';

const TARGET_DIR = 'C:\\pmt\\bit\\SpineIT-ERP';

async function main() {
  console.log('[DEBUG] Testing Gemini ACP with TARGET_DIR:', TARGET_DIR);
  const client = new GeminiAcpClient({ cwd: TARGET_DIR, debug: true });
  await client.start();
  console.log('[DEBUG] Initializing ACP...');
  await client.initialize();

  console.log('[DEBUG] Creating session for TARGET_DIR...');
  const t0 = Date.now();
  const sessionId = await client.getOrCreateSession(TARGET_DIR);
  console.log(`[DEBUG] Session created in ${Date.now() - t0}ms: ${sessionId}`);

  const task = new Task({
    correlationId: 'TEST_SPINEIT',
    targetAgent: 'gemini',
    prompt: 'Respond with only the text: GEMINI_SPINEIT_VERIFIED',
    cwd: TARGET_DIR
  });

  const origAddChunk = task.addChunk.bind(task);
  task.addChunk = (chunk) => {
    console.log('[DEBUG CHUNK]', JSON.stringify(chunk));
    return origAddChunk(chunk);
  };

  console.log('[DEBUG] Executing prompt on TARGET_DIR session...');
  const t1 = Date.now();
  try {
    await client.executeTask(task, 45000);
    console.log(`[DEBUG COMPLETED] in ${Date.now() - t1}ms. Result:`, task.result);
  } catch (err) {
    console.error(`[DEBUG FAILED] in ${Date.now() - t1}ms:`, err);
  } finally {
    await client.close();
  }
}

main();
