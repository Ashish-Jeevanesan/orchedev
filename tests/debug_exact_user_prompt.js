// D:\Ashish_P\AI-Tools\custom-OCT\tests\debug_exact_user_prompt.js
import { GeminiAcpClient } from '../core/gemini_acp_client.js';
import { Task } from '../core/task.js';

const TARGET_DIR = 'C:\\pmt\\bit\\SpineIT-ERP';

async function main() {
  const client = new GeminiAcpClient({ cwd: TARGET_DIR, debug: true });
  await client.start();
  await client.initialize();
  const sessionId = await client.getOrCreateSession(TARGET_DIR);

  const rawUserPrompt = `# Live End-to-End Correlated Workflow Test **Test ID:** 'E2E-CLAUDE-GEMINI-20261029-8472'

## Objective
- Do not modify, create, or delete project files.
- Do not execute shell commands for this test.
- Use the existing authenticated Claude and Gemini CLI sessions.
- Preserve the actual response and error details.
- Do not report success merely because the task reaches 'COMPLETED'.
- Do not report success if Gemini's response is missing or Claude's verification did not execute.
- If a stage times out, report the stage and timeout honestly.
- A successful test requires all three stages to complete: Claude delegation -> Gemini response -> Claude verification.

Run the complete workflow and return the actual result.`;

  const prompt2 = `Task from Claude: "${rawUserPrompt.replace(/"/g, '\\"')}".
You must respond with ONLY a valid JSON object (no markdown backticks):
{
  "correlationId": "CORR_EXACT_TEST",
  "answer": "<YOUR_ANSWER>",
  "agent": "gemini-cli-acp"
}`;

  const task = new Task({
    correlationId: 'CORR_EXACT_TEST',
    targetAgent: 'gemini',
    prompt: prompt2,
    cwd: TARGET_DIR
  });

  task.addChunk = (chk) => console.log('[CHUNK]', JSON.stringify(chk));

  const t0 = Date.now();
  console.log('[DEBUG] Sending exact prompt to Gemini in SpineIT-ERP...');
  try {
    await client.executeTask(task, 90000);
    console.log(`[DEBUG SUCCESS] in ${Date.now() - t0}ms:`, task.result);
  } catch (e) {
    console.error(`[DEBUG FAILED] in ${Date.now() - t0}ms:`, e);
  } finally {
    await client.close();
  }
}

main();
