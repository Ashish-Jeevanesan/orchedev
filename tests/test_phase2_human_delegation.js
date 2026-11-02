// D:\Ashish_P\AI-Tools\custom-OCT\tests\test_phase2_human_delegation.js
// Acceptance & Verification Suite for Phase 2: Human-Supervised Delegation

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

    this.child.stderr.on('data', (d) => {
      // Drain stderr to prevent pipe blocking
    });

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

    await new Promise((r) => setTimeout(r, 500));
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

async function runPhase2Tests() {
  console.log('===============================================================');
  console.log('  Phase 2: Human-Supervised Delegation Acceptance Suite       ');
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

  // Clean test task file
  const testTasksFile = path.join(PROJECT_ROOT, '.workbench_tasks.json');
  if (fs.existsSync(testTasksFile)) {
    try { fs.unlinkSync(testTasksFile); } catch (e) {}
  }

  const server = new WorkbenchServer({ cwd: PROJECT_ROOT, port: 0 });
  const { port, sessionToken } = await server.start();
  server.terminalManager.setProjectCwd(TEMP_WORKSPACE);
  console.log(`[Setup] Workbench server running on 127.0.0.1:${port}`);

  const claude = new McpBridgeClient('claude', port, sessionToken, TEMP_WORKSPACE);
  const gemini = new McpBridgeClient('gemini', port, sessionToken, TEMP_WORKSPACE);

  await claude.start();
  await gemini.start();
  console.log('[Setup] Claude and Gemini MCP bridge clients connected and registered.');

  await claude.sendRequest('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'claude-test', version: '1.0' }
  });
  await gemini.sendRequest('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'gemini-test', version: '1.0' }
  });

  try {
    // ------------------------------------------------------------------------
    // SCENARIO A: Successful Human-Supervised Delegation Flow
    // ------------------------------------------------------------------------
    console.log('\n--- SCENARIO A: Successful Human-Supervised Delegation ---');
    {
      let claudeCallResolved = false;
      let claudeCallResult = null;

      // 1. Claude calls delegate_to_gemini
      const delegationPromise = claude.sendRequest('tools/call', {
        name: 'delegate_to_gemini',
        arguments: {
          plan: 'Create user authentication validator',
          instructions: 'Implement validateUser(email, password) in auth.js',
          expectedFiles: ['auth.js'],
          timeoutSeconds: 30
        }
      }).then((res) => {
        claudeCallResolved = true;
        claudeCallResult = res;
      });

      await new Promise((r) => setTimeout(r, 400));
      assert(!claudeCallResolved, 'Claude delegation call remains pending awaiting human approval');

      // 2. Verify task is in APPROVAL_REQUESTED state
      const pendingRes = await fetch(`http://127.0.0.1:${port}/api/intercom/approvals/pending`, {
        headers: { 'X-Session-Token': sessionToken }
      });
      const pendingTasks = await pendingRes.json();
      assert(pendingTasks.length === 1, 'Exactly 1 delegation task awaiting approval');
      const apprTask = pendingTasks[0];
      assert(apprTask.state === 'APPROVAL_REQUESTED', 'Task state is APPROVAL_REQUESTED');
      assert(apprTask.fromAgent === 'claude', 'Task fromAgent is claude');

      // 3. Verify Gemini inbox does NOT show the unapproved task
      const inboxBefore = await gemini.sendRequest('tools/call', {
        name: 'get_inbox',
        arguments: {}
      });
      const inboxBeforeObj = JSON.parse(inboxBefore.content[0].text);
      assert((inboxBeforeObj.tasks || []).length === 0, 'Gemini inbox is empty before human approval (unapproved task is withheld)');

      // 4. Human approves the plan via UI API
      const approveRes = await fetch(`http://127.0.0.1:${port}/api/intercom/approvals/${apprTask.correlationId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Session-Token': sessionToken },
        body: JSON.stringify({ approver: 'developer-reviewer' })
      });
      const approveData = await approveRes.json();
      assert(approveData.status === 'approved', 'Server confirmed task approval');
      assert(approveData.task.state === 'QUEUED_FOR_CLAIM', 'Task transitioned to QUEUED_FOR_CLAIM');
      assert(approveData.task.approvedBy === 'developer-reviewer', 'Approver recorded for audit history');

      // 5. Gemini calls get_inbox and now discovers the approved task
      const inboxAfter = await gemini.sendRequest('tools/call', {
        name: 'get_inbox',
        arguments: {}
      });
      const inboxAfterObj = JSON.parse(inboxAfter.content[0].text);
      assert((inboxAfterObj.tasks || []).length === 1, 'Gemini discovers the approved task in its inbox');
      const claimableTask = inboxAfterObj.tasks[0];
      assert(claimableTask.correlationId === apprTask.correlationId, 'Correlation ID matches approved task');

      // 6. Gemini claims the task
      const claimRes = await gemini.sendRequest('tools/call', {
        name: 'claim_task',
        arguments: { correlationId: claimableTask.correlationId }
      });
      assert(claimRes.content[0].text.includes('claimed successfully'), 'Gemini claim_task succeeded');

      // 7. Verify task state is RUNNING
      const runningTask = server.intercomService.getDelegation(claimableTask.correlationId);
      assert(runningTask.state === 'RUNNING', 'Task state transitioned to RUNNING');

      // 8. Gemini implements and reports completion with testResults
      // Write mock file in temp_workspace
      fs.writeFileSync(path.join(TEMP_WORKSPACE, 'auth.js'), 'export function validateUser() { return true; }\n');

      const completeRes = await gemini.sendRequest('tools/call', {
        name: 'report_task_completion',
        arguments: {
          correlationId: claimableTask.correlationId,
          summary: 'Implemented validateUser function with regex validation in auth.js',
          modifiedFiles: ['auth.js'],
          testResults: 'Unit tests passed: 4 passed, 0 failed'
        }
      });
      assert(completeRes.content[0].text.includes('COMPLETED'), 'Gemini report_task_completion acknowledged');

      // 9. Claude's pending MCP tool call resolves with Gemini's completion
      await delegationPromise;
      assert(claudeCallResolved, 'Claude delegation call resolved upon Gemini completion');
      const claudeText = claudeCallResult.content[0].text;
      assert(claudeText.includes('Gemini implementation completed successfully!'), 'Claude received success status');
      assert(claudeText.includes('auth.js'), 'Claude received modified files list');
      assert(claudeText.includes('Unit tests passed'), 'Claude received test results');
      assert(claudeText.includes('Please review these changes'), 'Claude instructed to review implementation');

      // 10. Audit state history
      const finalTask = server.intercomService.getDelegation(claimableTask.correlationId);
      assert(finalTask.state === 'COMPLETED', 'Final task state is COMPLETED');
      const historyTransitions = finalTask.stateHistory.map(h => `${h.from}->${h.to}`);
      assert(historyTransitions.includes('null->APPROVAL_REQUESTED'), 'History records creation in APPROVAL_REQUESTED');
      assert(historyTransitions.includes('APPROVAL_REQUESTED->APPROVED'), 'History records APPROVAL_REQUESTED->APPROVED');
      assert(historyTransitions.includes('APPROVED->QUEUED_FOR_CLAIM'), 'History records APPROVED->QUEUED_FOR_CLAIM');
      assert(historyTransitions.includes('QUEUED_FOR_CLAIM->CLAIMED'), 'History records QUEUED_FOR_CLAIM->CLAIMED');
      assert(historyTransitions.includes('CLAIMED->RUNNING'), 'History records CLAIMED->RUNNING');
      assert(historyTransitions.includes('RUNNING->COMPLETED'), 'History records RUNNING->COMPLETED');
    }

    // ------------------------------------------------------------------------
    // SCENARIO B: Rejected Delegation Flow
    // ------------------------------------------------------------------------
    console.log('\n--- SCENARIO B: Rejected Delegation ---');
    {
      let rejectPromiseResolved = false;
      let rejectPromiseResult = null;

      const rejectPromise = claude.sendRequest('tools/call', {
        name: 'delegate_to_gemini',
        arguments: {
          plan: 'Delete all test files',
          instructions: 'Remove tests directory to speed up build',
          expectedFiles: ['tests/']
        }
      }).then((res) => {
        rejectPromiseResolved = true;
        rejectPromiseResult = res;
      });

      await new Promise((r) => setTimeout(r, 400));
      const pendingTasks = server.intercomService.getPendingApprovals();
      const dangerousTask = pendingTasks.find(t => t.instructions.includes('Remove tests'));
      assert(dangerousTask !== undefined, 'Dangerous plan caught in APPROVAL_REQUESTED state');

      // Human rejects the plan with reason
      const rejectRes = await fetch(`http://127.0.0.1:${port}/api/intercom/approvals/${dangerousTask.correlationId}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Session-Token': sessionToken },
        body: JSON.stringify({ reason: 'Deleting test files violates engineering standards', rejecter: 'qa-lead' })
      });
      const rejectData = await rejectRes.json();
      assert(rejectData.status === 'rejected', 'Server confirmed rejection');
      assert(rejectData.task.state === 'REJECTED', 'Task transitioned to REJECTED');
      assert(rejectData.task.rejectionReason.includes('violates engineering standards'), 'Rejection reason preserved in task record');

      // Verify Gemini inbox never sees rejected task
      const geminiInbox = await gemini.sendRequest('tools/call', {
        name: 'get_inbox',
        arguments: {}
      });
      const geminiInboxObj = JSON.parse(geminiInbox.content[0].text);
      assert(!geminiInboxObj.tasks.some(t => t.correlationId === dangerousTask.correlationId), 'Rejected task was never exposed to Gemini inbox');

      // Claude receives rejection text
      await rejectPromise;
      assert(rejectPromiseResolved, 'Claude delegation call unblocked on rejection');
      const rejectText = rejectPromiseResult.content[0].text;
      assert(rejectText.includes('[DELEGATION REJECTED BY USER]'), 'Claude received structured rejection header');
      assert(rejectText.includes('violates engineering standards'), 'Claude received human rejection reason');
      assert(rejectText.includes('formulate an alternative plan'), 'Claude prompted to formulate alternative');
    }

    // ------------------------------------------------------------------------
    // SCENARIO C: Edited Plan Flow
    // ------------------------------------------------------------------------
    console.log('\n--- SCENARIO C: Edited Instructions Before Approval ---');
    {
      const editTask = server.intercomService.createDelegation({
        fromAgent: 'claude',
        toAgent: 'gemini',
        plan: 'Build payment gateway',
        instructions: 'Use deprecated v1 API endpoint',
        expectedFiles: ['payment.js'],
        cwd: TEMP_WORKSPACE,
        requiresApproval: true
      });

      assert(editTask.instructions === 'Use deprecated v1 API endpoint', 'Original instructions recorded');

      // Human edits instructions and approves
      const editedInstructions = 'Use modern v2 REST API endpoint with webhook signature verification';
      const approveEditRes = await fetch(`http://127.0.0.1:${port}/api/intercom/approvals/${editTask.correlationId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Session-Token': sessionToken },
        body: JSON.stringify({
          editedInstructions,
          approver: 'tech-lead'
        })
      });

      const editData = await approveEditRes.json();
      assert(editData.task.instructions === editedInstructions, 'Active instructions updated to human-edited version');
      assert(editData.task.originalInstructions === 'Use deprecated v1 API endpoint', 'Original instructions preserved for audit trail');

      // Gemini claims task and verifies it gets the edited instructions
      const geminiClaim = await gemini.sendRequest('tools/call', {
        name: 'claim_task',
        arguments: { correlationId: editTask.correlationId }
      });
      assert(geminiClaim.content[0].text.includes('Use modern v2 REST API endpoint'), 'Gemini received human-edited instructions upon claim');
    }

    // ------------------------------------------------------------------------
    // SCENARIO D: Cancellation at Different Lifecycle Stages
    // ------------------------------------------------------------------------
    console.log('\n--- SCENARIO D: Task Cancellation Across Lifecycle ---');
    {
      // 1. Cancel while in APPROVAL_REQUESTED
      const tA = server.intercomService.createDelegation({
        fromAgent: 'claude',
        toAgent: 'gemini',
        plan: 'Cancel in approval test',
        instructions: 'Do nothing',
        cwd: TEMP_WORKSPACE,
        requiresApproval: true
      });
      const cancelResA = server.intercomService.cancelDelegation(tA.correlationId, 'User changed mind before approval');
      assert(cancelResA.status === 'cancelled' && cancelResA.task.state === 'CANCELLED', 'Cancelled task in APPROVAL_REQUESTED state');

      // 2. Cancel while in QUEUED_FOR_CLAIM (approved but unclaimed)
      const tB = server.intercomService.createDelegation({
        fromAgent: 'claude',
        toAgent: 'gemini',
        plan: 'Cancel in queue test',
        instructions: 'Do nothing',
        cwd: TEMP_WORKSPACE,
        requiresApproval: false
      });
      assert(tB.state === 'QUEUED_FOR_CLAIM', 'Task is in QUEUED_FOR_CLAIM state');
      const cancelResB = server.intercomService.cancelDelegation(tB.correlationId, 'User cancelled unclaimed task');
      assert(cancelResB.status === 'cancelled' && cancelResB.task.state === 'CANCELLED', 'Cancelled approved unclaimed task');

      // 3. Cancel while RUNNING (claimed and in execution)
      const tC = server.intercomService.createDelegation({
        fromAgent: 'claude',
        toAgent: 'gemini',
        plan: 'Cancel while running test',
        instructions: 'Long running task',
        cwd: TEMP_WORKSPACE,
        requiresApproval: false
      });
      server.intercomService.claimTask({
        agentId: 'gemini',
        sessionId: server.intercomService.activePeers.get('gemini').sessionId,
        correlationId: tC.correlationId,
        cwd: TEMP_WORKSPACE
      });
      const cancelResC = server.intercomService.cancelDelegation(tC.correlationId, 'User requested stop during execution');
      assert(cancelResC.status === 'cancellation_requested', 'Coordinator reports cancellation_requested for active task (honest reporting)');
      assert(cancelResC.task.cancellationRequested === true, 'cancellationRequested flag recorded on active task');
    }

    // ------------------------------------------------------------------------
    // SCENARIO E: Multi-Turn Correction Loop Flow
    // ------------------------------------------------------------------------
    console.log('\n--- SCENARIO E: Multi-Turn Correction Loop ---');
    {
      // Turn 1: Initial implementation
      const turn1Task = server.intercomService.createDelegation({
        fromAgent: 'claude',
        toAgent: 'gemini',
        plan: 'Implement tax calculator',
        instructions: 'Calculate tax with 5% rate',
        expectedFiles: ['tax.js'],
        cwd: TEMP_WORKSPACE,
        requiresApproval: true
      });
      server.intercomService.approveDelegation({ correlationId: turn1Task.correlationId, approver: 'user' });
      server.intercomService.claimTask({
        agentId: 'gemini',
        sessionId: server.intercomService.activePeers.get('gemini').sessionId,
        correlationId: turn1Task.correlationId,
        cwd: TEMP_WORKSPACE
      });
      server.intercomService.completeTask({
        agentId: 'gemini',
        sessionId: server.intercomService.activePeers.get('gemini').sessionId,
        correlationId: turn1Task.correlationId,
        summary: 'Implemented calculateTax returning amount * 0.05',
        modifiedFiles: ['tax.js']
      });

      // Claude reviews and finds bug: rate should be 18% GST, not 5%
      // Claude initiates Turn 2: Correction Delegation
      const turn2Task = server.intercomService.createDelegation({
        fromAgent: 'claude',
        toAgent: 'gemini',
        plan: 'Correction: Update tax rate to 18% GST',
        instructions: 'Fix rate in tax.js to amount * 0.18',
        expectedFiles: ['tax.js'],
        cwd: TEMP_WORKSPACE,
        requiresApproval: true
      });

      assert(turn2Task.state === 'APPROVAL_REQUESTED', 'Correction delegation requires separate human approval (no unbounded loop)');

      // Human reviews and approves correction
      server.intercomService.approveDelegation({ correlationId: turn2Task.correlationId, approver: 'user' });
      assert(turn2Task.state === 'QUEUED_FOR_CLAIM', 'Approved correction is ready in Gemini inbox');

      // Gemini implements correction
      server.intercomService.claimTask({
        agentId: 'gemini',
        sessionId: server.intercomService.activePeers.get('gemini').sessionId,
        correlationId: turn2Task.correlationId,
        cwd: TEMP_WORKSPACE
      });
      const turn2Complete = server.intercomService.completeTask({
        agentId: 'gemini',
        sessionId: server.intercomService.activePeers.get('gemini').sessionId,
        correlationId: turn2Task.correlationId,
        summary: 'Fixed tax rate to 18% in tax.js',
        modifiedFiles: ['tax.js'],
        testResults: 'All 8 tax tests passed'
      });

      assert(turn2Complete.state === 'COMPLETED', 'Correction completed successfully');
      assert(turn2Complete.testResults.includes('All 8 tax tests passed'), 'Correction test results verified');
    }

    // ------------------------------------------------------------------------
    // SCENARIO F: Security & Invariant Enforcement
    // ------------------------------------------------------------------------
    console.log('\n--- SCENARIO F: Security & Invariant Enforcement ---');
    {
      // 1. Terminal state immutability
      const termTask = server.intercomService.getAllDelegations().find(t => t.state === 'COMPLETED');
      let termError = null;
      try {
        server.intercomService._transitionTask(termTask, 'RUNNING', 'Illegal transition');
      } catch (e) {
        termError = e.message;
      }
      assert(termError && termError.includes('Cannot transition task') && termError.includes('terminal state'), 'Terminal state immutability strictly enforced');

      // 2. Duplicate approval rejected
      const dupTask = server.intercomService.createDelegation({
        fromAgent: 'claude',
        toAgent: 'gemini',
        plan: 'Dup approve plan',
        instructions: 'Dup approve instructions',
        cwd: TEMP_WORKSPACE,
        requiresApproval: true
      });
      server.intercomService.approveDelegation({ correlationId: dupTask.correlationId });

      let dupApproveErr = null;
      try {
        server.intercomService.approveDelegation({ correlationId: dupTask.correlationId });
      } catch (e) {
        dupApproveErr = e.message;
      }
      assert(dupApproveErr && dupApproveErr.includes('Cannot approve task') && dupApproveErr.includes('state'), 'Duplicate approval rejected');

      // 3. Stale session ID cannot complete task
      const staleTestTask = server.intercomService.createDelegation({
        fromAgent: 'claude',
        toAgent: 'gemini',
        plan: 'Stale test plan',
        instructions: 'Stale test instructions',
        cwd: TEMP_WORKSPACE,
        requiresApproval: false
      });
      const geminiPeerRecord = server.intercomService.activePeers.get('gemini');
      server.intercomService.claimTask({
        agentId: 'gemini',
        sessionId: geminiPeerRecord.sessionId,
        correlationId: staleTestTask.correlationId,
        cwd: TEMP_WORKSPACE
      });

      let staleCompleteErr = null;
      try {
        server.intercomService.completeTask({
          agentId: 'gemini',
          sessionId: 'STALE_SESSION_HEX_9999',
          correlationId: staleTestTask.correlationId,
          summary: 'Hacked'
        });
      } catch (e) {
        staleCompleteErr = e.message;
      }
      assert(staleCompleteErr && staleCompleteErr.includes('Stale or unauthenticated session ID'), 'Stale session rejected from completing task');

      // 4. Persistence verification: await async queue flush to disk
      await server.intercomService._persist();
      assert(fs.existsSync(testTasksFile), 'Tasks persisted to .workbench_tasks.json');
      const diskContent = JSON.parse(fs.readFileSync(testTasksFile, 'utf8'));
      assert(diskContent.length >= 5, `Persistent storage contains ${diskContent.length} auditable task records`);
      const diskTask = diskContent.find(t => t.correlationId === staleTestTask.correlationId);
      assert(diskTask && diskTask.stateHistory.length > 0, 'State history persisted to disk with timestamps and actors');
    }

    console.log('\n===============================================================');
    console.log(`  PHASE 2 ACCEPTANCE SUITE RESULTS: ${passed} PASSED, ${failed} FAILED`);
    console.log('===============================================================\n');

    if (failed > 0) {
      process.exit(1);
    }
  } finally {
    await claude.stop();
    await gemini.stop();
    await server.shutdown();
  }
}

runPhase2Tests().catch((err) => {
  console.error('[FATAL PHASE 2 SUITE ERROR]', err);
  process.exit(1);
});
