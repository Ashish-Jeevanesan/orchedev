// D:\Ashish_P\AI-Tools\custom-OCT\tests\acceptance\03_target_agents_suite.js
// Acceptance Test Suite 3: Comprehensive Target Agent & Correlated Workflow Verification

import { WorkbenchServer } from '../../server/server.js';
import path from 'path';
import fs from 'fs';
import os from 'os';

const CWD = 'D:\\Ashish_P\\AI-Tools\\custom-OCT';

async function run() {
  console.log('--- Acceptance Suite 3: Target Agents & Correlated Workflow ---');
  const server = new WorkbenchServer({ cwd: CWD, port: 0 });
  const { port, sessionToken } = await server.start();
  const checks = [];

  const tempDir = path.join(os.tmpdir(), `test_agents_suite_${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    // 1. Set working directory to isolated temp directory
    await fetch(`http://127.0.0.1:${port}/api/workspace/select`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': sessionToken },
      body: JSON.stringify({ path: tempDir })
    });

    // -------------------------------------------------------------
    // Target 1: Claude Code (Structured Stream)
    // -------------------------------------------------------------
    console.log('[Target 1] Testing Claude Code target...');
    const claudeCorrId = `CORR_TARGET_CLAUDE_${Date.now()}`;
    const claudeMarker = `TOKEN_CLAUDE_${Date.now().toString(36).toUpperCase()}`;

    const resClaude = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': sessionToken },
      body: JSON.stringify({
        correlationId: claudeCorrId,
        targetAgent: 'claude',
        requiresApproval: false,
        prompt: `Respond with only the token: ${claudeMarker}`
      })
    });

    let claudeTask = null;
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 500));
      const res = await fetch(`http://127.0.0.1:${port}/api/tasks/${claudeCorrId}`, {
        headers: { 'X-Session-Token': sessionToken }
      });
      if (res.status === 200) {
        const t = await res.json();
        if (t.state === 'COMPLETED' || t.state === 'FAILED') {
          claudeTask = t;
          break;
        }
      }
    }

    const claudePass = claudeTask && claudeTask.state === 'COMPLETED' && claudeTask.result.includes(claudeMarker);
    checks.push({
      test: 'Target Agent: Claude Code (Structured Stream)',
      passed: claudePass,
      correlationId: claudeCorrId,
      state: claudeTask?.state,
      durationMs: claudeTask?.durationMs,
      cwd: claudeTask?.cwd
    });
    console.log(`[Target 1] Claude Code Target: ${claudePass ? 'PASSED' : 'FAILED'} (${claudeTask?.durationMs}ms)`);

    // -------------------------------------------------------------
    // Target 2: Gemini CLI (ACP stdio)
    // -------------------------------------------------------------
    console.log('[Target 2] Testing Gemini CLI (ACP) target...');
    const geminiCorrId = `CORR_TARGET_GEMINI_${Date.now()}`;
    const geminiMarker = `TOKEN_GEMINI_${Date.now().toString(36).toUpperCase()}`;

    const resGemini = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': sessionToken },
      body: JSON.stringify({
        correlationId: geminiCorrId,
        targetAgent: 'gemini',
        requiresApproval: false,
        prompt: `Respond with only the token: ${geminiMarker}`
      })
    });

    let geminiTask = null;
    for (let i = 0; i < 50; i++) {
      await new Promise(r => setTimeout(r, 500));
      const res = await fetch(`http://127.0.0.1:${port}/api/tasks/${geminiCorrId}`, {
        headers: { 'X-Session-Token': sessionToken }
      });
      if (res.status === 200) {
        const t = await res.json();
        if (t.state === 'COMPLETED' || t.state === 'FAILED') {
          geminiTask = t;
          break;
        }
      }
    }

    const geminiPass = geminiTask && geminiTask.state === 'COMPLETED' && geminiTask.result.includes(geminiMarker);
    checks.push({
      test: 'Target Agent: Gemini CLI (ACP stdio)',
      passed: geminiPass,
      correlationId: geminiCorrId,
      state: geminiTask?.state,
      durationMs: geminiTask?.durationMs,
      cwd: geminiTask?.cwd
    });
    console.log(`[Target 2] Gemini CLI Target: ${geminiPass ? 'PASSED' : 'FAILED'} (${geminiTask?.durationMs}ms)`);

    // -------------------------------------------------------------
    // Target 3: Unified Claude <-> Gemini Workflow Pipeline
    // -------------------------------------------------------------
    console.log('[Target 3] Testing Unified Workflow target...');
    server.intercomService.registerAgent({
      agentId: 'gemini',
      sessionId: 'gemini_test_session_target3',
      pid: 99112,
      cwd: tempDir,
      capabilities: ['implementation', 'testing']
    });

    const wfCorrId = `CORR_TARGET_WF_${Date.now()}`;
    const resWf = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': sessionToken },
      body: JSON.stringify({
        correlationId: wfCorrId,
        targetAgent: 'claude_gemini_workflow',
        prompt: 'What balanced search tree data structure is widely used in relational database indexing?'
      })
    });

    const wfData = await resWf.json();
    const wfApprovalRequested = wfData.task?.state === 'APPROVAL_REQUESTED';

    // Human approves the plan
    await fetch(`http://127.0.0.1:${port}/api/intercom/approvals/${wfCorrId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': sessionToken },
      body: JSON.stringify({ approver: 'qa-tester' })
    });

    // Gemini claims task
    await fetch(`http://127.0.0.1:${port}/api/intercom/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': sessionToken },
      body: JSON.stringify({
        agentId: 'gemini',
        sessionId: 'gemini_test_session_target3',
        correlationId: wfCorrId,
        cwd: tempDir
      })
    });

    // Gemini completes task
    await fetch(`http://127.0.0.1:${port}/api/intercom/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': sessionToken },
      body: JSON.stringify({
        agentId: 'gemini',
        sessionId: 'gemini_test_session_target3',
        correlationId: wfCorrId,
        summary: 'B-tree and B+ tree data structures are widely used in relational database indexing.',
        modifiedFiles: []
      })
    });

    const resCheck = await fetch(`http://127.0.0.1:${port}/api/tasks/${wfCorrId}`, {
      headers: { 'X-Session-Token': sessionToken }
    });
    const wfTask = await resCheck.json();
    const wfPass = wfApprovalRequested && wfTask.state === 'COMPLETED' && wfTask.result.includes('B+ tree');

    checks.push({
      test: 'Target Agent: Claude <-> Gemini Correlated Workflow',
      passed: wfPass,
      correlationId: wfCorrId,
      state: wfTask?.state,
      durationMs: wfTask?.durationMs
    });
    console.log(`[Target 3] Correlated Workflow: ${wfPass ? 'PASSED' : 'FAILED'}`);

    // -------------------------------------------------------------
    // Target Input Edge Cases (Empty, Whitespace, Oversized)
    // -------------------------------------------------------------
    console.log('[Edge Cases] Testing prompt validation edge cases...');

    // Empty prompt
    const resEmpty = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': sessionToken },
      body: JSON.stringify({ targetAgent: 'claude', prompt: '' })
    });
    checks.push({
      test: 'Validation: Empty prompt rejected with HTTP 400',
      passed: resEmpty.status === 400
    });

    // Whitespace only prompt
    const resWhitespace = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': sessionToken },
      body: JSON.stringify({ targetAgent: 'claude', prompt: '   \n  \t  ' })
    });
    checks.push({
      test: 'Validation: Whitespace-only prompt rejected with HTTP 400',
      passed: resWhitespace.status === 400
    });

    // Unknown agent target
    const resBadAgent = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': sessionToken },
      body: JSON.stringify({ targetAgent: 'unknown_agent', prompt: 'Valid prompt', requiresApproval: false })
    });
    // Task created then fails in coordinator with unknown target agent
    const badAgentData = await resBadAgent.json();
    const badTaskId = badAgentData.task?.correlationId;
    await new Promise(r => setTimeout(r, 600));
    const badTaskRes = await fetch(`http://127.0.0.1:${port}/api/tasks/${badTaskId}`, {
      headers: { 'X-Session-Token': sessionToken }
    });
    const badTask = await badTaskRes.json();
    checks.push({
      test: 'Validation: Unknown target agent transitions task to FAILED',
      passed: badTask.state === 'FAILED',
      error: badTask.error
    });

  } finally {
    await server.shutdown();
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}
  }

  const allPassed = checks.every(c => c.passed);
  console.log(`\nSuite 3 Results: ${checks.filter(c => c.passed).length}/${checks.length} passed.`);
  for (const c of checks) {
    console.log(`  ${c.passed ? '[PASS]' : '[FAIL]'} ${c.test}`);
    if (!c.passed) console.log('    Details:', JSON.stringify(c));
  }
  return { suite: '03_target_agents_suite', passed: allPassed, checks };
}

run().then(res => {
  if (!res.passed) process.exit(1);
  process.exit(0);
}).catch(err => {
  console.error(err);
  process.exit(1);
});
