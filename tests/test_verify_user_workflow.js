// D:\Ashish_P\AI-Tools\custom-OCT\tests\test_verify_user_workflow.js
// Verification of Unified Human-Approved Workflow

import { WorkbenchServer } from '../server/server.js';

const TARGET_DIR = 'C:\\pmt\\bit\\SpineIT-ERP';
const CWD = 'D:\\Ashish_P\\AI-Tools\\custom-OCT';

async function main() {
  console.log('===============================================================');
  console.log('  Testing Unified Human-Approved Workflow in C:\\pmt\\bit\\SpineIT-ERP');
  console.log('===============================================================\n');

  const server = new WorkbenchServer({ cwd: CWD, port: 0 });
  const { port, sessionToken } = await server.start();

  try {
    // 1. Select SpineIT-ERP as working folder
    console.log('[Step 1] Setting working folder to:', TARGET_DIR);
    const selRes = await fetch(`http://127.0.0.1:${port}/api/workspace/select`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': sessionToken },
      body: JSON.stringify({ path: TARGET_DIR })
    });
    const selData = await selRes.json();
    console.log('[Step 1] Server confirmed project working directory:', selData.projectCwd);

    // Register Gemini peer in SpineIT-ERP
    server.intercomService.registerAgent({
      agentId: 'gemini',
      sessionId: 'gemini_sess_spineit',
      pid: 45678,
      cwd: TARGET_DIR,
      capabilities: ['implementation', 'testing']
    });

    // 2. Submit user prompt through Dispatch Task API
    const corrId = `CORR_VERIFY_USER_${Date.now()}`;
    const userPrompt = `Audit tax calculation logic in database packages without modifying files.`;

    console.log('\n[Step 2] Submitting task via Unified Dispatch Task API...');
    const submitRes = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': sessionToken },
      body: JSON.stringify({
        correlationId: corrId,
        targetAgent: 'gemini',
        prompt: userPrompt,
        cwd: TARGET_DIR
      })
    });

    const submitData = await submitRes.json();
    console.log('[Step 2] Task submitted. Correlation ID:', corrId, 'Initial State:', submitData.task?.state);
    if (submitData.task?.state !== 'APPROVAL_REQUESTED') {
      throw new Error(`Expected state APPROVAL_REQUESTED, got ${submitData.task?.state}`);
    }

    // 3. Human reviews and approves plan
    console.log('\n[Step 3] Human reviewing and approving plan...');
    const approveRes = await fetch(`http://127.0.0.1:${port}/api/intercom/approvals/${corrId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': sessionToken },
      body: JSON.stringify({ approver: 'developer-reviewer' })
    });
    const approveData = await approveRes.json();
    console.log('[Step 3] Approved. State:', approveData.task?.state);

    // 4. Gemini claims task in target CWD
    console.log('\n[Step 4] Gemini claiming task in working directory...');
    const claimRes = await fetch(`http://127.0.0.1:${port}/api/intercom/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': sessionToken },
      body: JSON.stringify({
        agentId: 'gemini',
        sessionId: 'gemini_sess_spineit',
        correlationId: corrId,
        cwd: TARGET_DIR
      })
    });
    const claimData = await claimRes.json();
    console.log('[Step 4] Claimed. State:', claimData.state);

    // 5. Gemini completes task
    console.log('\n[Step 5] Gemini reporting completion...');
    const completeRes = await fetch(`http://127.0.0.1:${port}/api/intercom/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': sessionToken },
      body: JSON.stringify({
        agentId: 'gemini',
        sessionId: 'gemini_sess_spineit',
        correlationId: corrId,
        summary: 'Tax calculation audit complete. Verified VAT and GST rule tables.',
        modifiedFiles: []
      })
    });
    const completeData = await completeRes.json();
    console.log('[Step 5] Completed. Final State:', completeData.state);

    if (completeData.state === 'COMPLETED') {
      console.log('\n===============================================================');
      console.log('  EXACT USER WORKFLOW TEST: PASSED!');
      console.log('===============================================================\n');
    } else {
      console.log('\n===============================================================');
      console.log('  EXACT USER WORKFLOW TEST: FAILED!');
      console.log('===============================================================\n');
      process.exit(1);
    }
  } finally {
    await server.shutdown();
  }
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
