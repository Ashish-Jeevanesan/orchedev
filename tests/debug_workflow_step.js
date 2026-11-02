// D:\Ashish_P\AI-Tools\custom-OCT\tests\debug_workflow_step.js
import { ClaudeStreamClient } from '../core/claude_stream_client.js';
import { GeminiAcpClient } from '../core/gemini_acp_client.js';
import { Task } from '../core/task.js';

const CWD = 'D:\\Ashish_P\\AI-Tools\\custom-OCT';

async function main() {
  const claude = new ClaudeStreamClient({ cwd: CWD, debug: true });
  const gemini = new GeminiAcpClient({ cwd: CWD, debug: true });
  await gemini.start();
  await gemini.initialize();
  await gemini.createSession();

  console.log('--- Step 1: Claude Turn 1 ---');
  const t1 = new Task({
    correlationId: 'WF_DBG_1',
    targetAgent: 'claude',
    prompt: `You are participating in an automated multi-agent workflow.
Prompt: What balanced search tree data structure is widely used in relational database indexing?
Return a valid JSON object strictly adhering to this format (no markdown backticks, just raw JSON):
{
  "correlationId": "WF_DBG_1",
  "question": "What balanced search tree data structure is widely used in relational database indexing?",
  "expectedKey": "B-TREE"
}`
  });

  await claude.executeTask(t1, 30000);
  console.log('Claude Turn 1 result:', t1.result);

  let claudeData;
  try {
    const cleaned = t1.result.replace(/```json/g, '').replace(/```/g, '').trim();
    claudeData = JSON.parse(cleaned);
  } catch (e) {
    console.error('Failed to parse Claude JSON:', e);
    claudeData = { question: 'What balanced search tree data structure is widely used in relational database indexing?' };
  }

  console.log('\n--- Step 2: Gemini Turn ---');
  const prompt2 = `Task from Claude: "${claudeData.question}".
You must respond with ONLY a valid JSON object (no markdown backticks):
{
  "correlationId": "WF_DBG_1",
  "answer": "<YOUR_ANSWER>",
  "agent": "gemini-cli-acp"
}`;

  const t2 = new Task({
    correlationId: 'WF_DBG_2',
    targetAgent: 'gemini',
    prompt: prompt2
  });

  const s2 = Date.now();
  try {
    await gemini.executeTask(t2, 60000);
    console.log(`Gemini completed in ${Date.now() - s2}ms. Result:`, t2.result);
  } catch (e) {
    console.error(`Gemini failed in ${Date.now() - s2}ms:`, e);
  }

  await gemini.close();
}

main();
