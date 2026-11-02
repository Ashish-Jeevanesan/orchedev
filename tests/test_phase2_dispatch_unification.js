// D:\Ashish_P\AI-Tools\custom-OCT\tests\test_phase2_dispatch_unification.js
// Acceptance & Verification Suite for Phase 2.1: Dispatch Task Unification & Zero Headless Spawning

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { WorkbenchServer } from '../server/server.js';
import { DelegationState } from '../server/intercom_service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const TEMP_WORKSPACE = path.join(PROJECT_ROOT, 'tests', 'temp_workspace');
const BRIDGE_SCRIPT = path.join(PROJECT_ROOT, 'server', 'mcp', 'workbench_mcp_bridge.js');

class McpBridgeClient {
  constructor(agentId, port, token, cwd) {
    this.agentId = agentId;
    this.port = port;
    this.token = token;
    this.cwd = cwd;
    this.child = null;
    this.msgId = 1;
    this.pending = new Map();
    this.buffer = '';
  }

  async start() {
    this.child = spawn('node', [
      BRIDGE_SCRIPT,
      '--agent', this.agentId,
      '--port', String(this.port),
      '--token', this.token,
      '--cwd', this.cwd
    ], {
      cwd: PROJECT_ROOT,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    this.child.stderr.on('data', () => {});
    this.child.stdout.on('data', (chunk) => {
      this.buffer += chunk.toString();
      let newlineIdx;
      while ((newlineIdx = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, newlineIdx).trim();
        this.buffer = this.buffer.slice(newlineIdx + 1);
        if (line) {
          try {
            const msg = JSON.parse(line);
            if (msg.id !== undefined && this.pending.has(msg.id)) {
              const { resolve, reject } = this.pending.get(msg.id);
              this.pending.delete(msg.id);
              if (msg.error) {
                reject(new Error(msg.error.message || JSON.stringify(msg.error)));
              } else {
                resolve(msg.result);
              }
            }
          } catch (e) {}
        }
      }
    });

    await new Promise((r) => setTimeout(r, 400));
  }

  async sendRequest(method, params = {}) {
    const id = this.msgId++;
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      params
    }) + '\n';

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(payload);
    });
  }

  async stop() {
    if (this.child) {
      try { this.child.stdin.end(); } catch (e) {}
      await new Promise((r) => setTimeout(r, 200));
      try { this.child.kill(); } catch (e) {}
    }
  }
}

async function runUnificationTests() {
  console.log('===============================================================');
  console.log('  Phase 2.1: Dispatch Task Unification & Zero Headless Spawn  ');
  console.log('===============================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, desc) {
    if (condition) {
      console.log(`  [PASS] ${desc}`);
      passed++;
    } else {
      console.error(`  [FAIL] ${desc}`);
      failed++;
    }
  }

  if (!fs.existsSync(TEMP_WORKSPACE)) {
    fs.mkdirSync(TEMP_WORKSPACE, { recursive: true });
  }

  // Clean persistent tasks file before test
  const testTasksFile = path.join(PROJECT_ROOT, '.workbench_tasks.json');
  if (fs.existsSync(testTasksFile)) {
    try { fs.unlinkSync(testTasksFile); } catch (e) {}
  }

  const server = new WorkbenchServer({ cwd: PROJECT_ROOT, port: 0 });
  const { port, sessionToken } = await server.start();
  server.terminalManager.setProjectCwd(TEMP_WORKSPACE);
  console.log(`[Setup] Workbench server running on 127.0.0.1:${port}`);

  const gemini = new McpBridgeClient('gemini', port, sessionToken, TEMP_WORKSPACE);
  await gemini.start();
  await gemini.sendRequest('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'gemini-interactive-test', version: '1.0' }
  });
  console.log('[Setup] Authoritative interactive Gemini session bridge registered.');

  try {
    // ------------------------------------------------------------------------
    // TEST 1: Dispatch Task submits as User Task in APPROVAL_REQUESTED state
    // ------------------------------------------------------------------------
    console.log('\n[Test 1] Verifying Dispatch Task routes to Intercom with approval gating...');
    const corrId1 = `CORR_DISPATCH_USER_${Date.now()}`;
    const submitRes = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': sessionToken },
      body: JSON.stringify({
        correlationId: corrId1,
        targetAgent: 'gemini',
        prompt: 'Build database connection helper in db.js',
        cwd: TEMP_WORKSPACE
      })
    });

    assert(submitRes.status === 201, 'POST /api/tasks returns HTTP 201 Created');
    const submitData = await submitRes.json();
    assert(submitData.task.correlationId === corrId1, 'Correlation ID preserved in response');
    assert(submitData.task.fromAgent === 'user', 'Task sender is correctly labeled as "user" (not falsely attributed to Claude)');
    assert(submitData.task.toAgent === 'gemini', 'Task target is gemini');
    assert(submitData.task.state === 'APPROVAL_REQUESTED', 'Task initialized in APPROVAL_REQUESTED state');
    assert(submitData.task.instructions === 'Build database connection helper in db.js', 'User instructions preserved');

    // ------------------------------------------------------------------------
    // TEST 2: Task withheld from Gemini inbox before approval
    // ------------------------------------------------------------------------
    console.log('\n[Test 2] Verifying task is withheld from Gemini inbox before human approval...');
    const inboxBefore = await gemini.sendRequest('tools/call', {
      name: 'get_inbox',
      arguments: {}
    });
    const inboxBeforeObj = JSON.parse(inboxBefore.content[0].text);
    assert((inboxBeforeObj.tasks || []).length === 0, 'Gemini inbox has 0 tasks before approval (unapproved task is strictly withheld)');

    // ------------------------------------------------------------------------
    // TEST 3: Human approves task -> Becomes claimable in Gemini inbox
    // ------------------------------------------------------------------------
    console.log('\n[Test 3] Approving user task and verifying claimability...');
    const approveRes = await fetch(`http://127.0.0.1:${port}/api/intercom/approvals/${corrId1}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': sessionToken },
      body: JSON.stringify({ approver: 'developer-approver' })
    });
    const approveData = await approveRes.json();
    assert(approveData.status === 'approved', 'Server confirmed approval');
    assert(approveData.task.state === 'QUEUED_FOR_CLAIM', 'Task transitioned to QUEUED_FOR_CLAIM');
    assert(approveData.task.approvedBy === 'developer-approver', 'Human approver recorded for audit');

    // Gemini inbox now sees the task
    const inboxAfter = await gemini.sendRequest('tools/call', {
      name: 'get_inbox',
      arguments: {}
    });
    const inboxAfterObj = JSON.parse(inboxAfter.content[0].text);
    assert(inboxAfterObj.tasks.length === 1, 'Gemini inbox now returns the approved task');
    assert(inboxAfterObj.tasks[0].correlationId === corrId1, 'Discovered task correlation ID matches approved task');

    // ------------------------------------------------------------------------
    // TEST 4: Gemini claims and executes task in visible session
    // ------------------------------------------------------------------------
    console.log('\n[Test 4] Gemini claiming and executing the approved task...');
    const claimRes = await gemini.sendRequest('tools/call', {
      name: 'claim_task',
      arguments: { correlationId: corrId1 }
    });
    assert(claimRes.content[0].text.includes('claimed successfully'), 'Gemini claim_task succeeded');

    const claimedTask = server.intercomService.getDelegation(corrId1);
    assert(claimedTask.state === 'RUNNING', 'Task transitioned to RUNNING');
    assert(claimedTask.claimedBySession === server.intercomService.activePeers.get('gemini').sessionId, 'Task claimed by authoritative Gemini session');

    // Gemini reports completion
    const completeRes = await gemini.sendRequest('tools/call', {
      name: 'report_task_completion',
      arguments: {
        correlationId: corrId1,
        summary: 'Created db.js with pooled connection helper',
        modifiedFiles: ['db.js'],
        testResults: 'db.test.js passed'
      }
    });
    assert(completeRes.content[0].text.includes('COMPLETED'), 'report_task_completion succeeded');

    const finishedTask = server.intercomService.getDelegation(corrId1);
    assert(finishedTask.state === 'COMPLETED', 'Final task state is COMPLETED');
    assert(finishedTask.result.includes('Created db.js'), 'Summary preserved');

    // ------------------------------------------------------------------------
    // TEST 5: Verify legacy headless workflow is completely removed
    // ------------------------------------------------------------------------
    console.log('\n[Test 5] Verifying legacy headless _executeWorkflow is removed and rejected...');
    let legacyWorkflowErr = null;
    try {
      const legacyTask = server.coordinatorService.createTask({
        correlationId: 'CORR_TEST_LEGACY',
        targetAgent: 'claude_gemini_workflow',
        prompt: 'Run headless workflow'
      });
      await server.coordinatorService.dispatchTask(legacyTask);
    } catch (e) {
      legacyWorkflowErr = e.message;
    }

    assert(
      legacyWorkflowErr && legacyWorkflowErr.includes('legacy headless claude_gemini_workflow has been removed'),
      'Legacy headless workflow invocation is strictly blocked and rejected with clear error'
    );

    // ------------------------------------------------------------------------
    // TEST 6: Rejected task cannot be claimed
    // ------------------------------------------------------------------------
    console.log('\n[Test 6] Verifying rejected task cannot be claimed...');
    const corrId2 = `CORR_REJECT_TEST_${Date.now()}`;
    await fetch(`http://127.0.0.1:${port}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': sessionToken },
      body: JSON.stringify({
        correlationId: corrId2,
        targetAgent: 'gemini',
        prompt: 'Unwanted task',
        cwd: TEMP_WORKSPACE
      })
    });

    // Reject it
    await fetch(`http://127.0.0.1:${port}/api/intercom/approvals/${corrId2}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': sessionToken },
      body: JSON.stringify({ reason: 'Not approved for execution' })
    });

    const rejectedTask = server.intercomService.getDelegation(corrId2);
    assert(rejectedTask.state === 'REJECTED', 'Task state is REJECTED');

    let claimRejectedErr = null;
    try {
      server.intercomService.claimTask({
        agentId: 'gemini',
        sessionId: server.intercomService.activePeers.get('gemini').sessionId,
        correlationId: corrId2,
        cwd: TEMP_WORKSPACE
      });
    } catch (e) {
      claimRejectedErr = e.message;
    }
    assert(claimRejectedErr && claimRejectedErr.includes('Duplicate claim rejected'), 'Claim on rejected task is strictly blocked');

    console.log('\n===============================================================');
    console.log(`  PHASE 2.1 ACCEPTANCE SUITE RESULTS: ${passed} PASSED, ${failed} FAILED`);
    console.log('===============================================================\n');

    if (failed > 0) {
      process.exit(1);
    }
  } finally {
    await gemini.stop();
    await server.shutdown();
  }
}

runUnificationTests().catch((err) => {
  console.error('[FATAL UNIFICATION ERROR]', err);
  process.exit(1);
});
