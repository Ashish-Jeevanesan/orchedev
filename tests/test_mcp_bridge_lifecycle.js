// D:\Ashish_P\AI-Tools\custom-OCT\tests\test_mcp_bridge_lifecycle.js
// Test suite for Phase 1: Local MCP Bridge & Agent Registration

import { WorkbenchServer } from '../server/server.js';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const BRIDGE_SCRIPT = path.join(PROJECT_ROOT, 'server', 'mcp', 'workbench_mcp_bridge.js');

// Helper to interact with an MCP stdio server using JSON-RPC
class McpClientHelper {
  constructor(agentId, port, token) {
    this.agentId = agentId;
    this.port = port;
    this.token = token;
    this.child = null;
    this.msgId = 1;
    this.pending = new Map();
    this.buffer = '';
  }

  async start() {
    this.child = spawn('node', [BRIDGE_SCRIPT, '--agent', this.agentId, '--port', String(this.port), '--token', this.token], {
      cwd: PROJECT_ROOT,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    this.child.stderr.on('data', (d) => {
      // Diagnostic stderr logs from MCP bridge
      // console.log(`[STDERR ${this.agentId}]`, d.toString().trim());
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

    // Wait a brief moment for process and transport boot
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
      try {
        this.child.stdin.end();
      } catch (e) {}
      await new Promise((r) => setTimeout(r, 300));
      this.child.kill();
    }
  }
}

async function runTests() {
  console.log('===============================================================');
  console.log('  Running Phase 1 MCP Bridge & Agent Registration Test Suite  ');
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

  // Clean persistent task file before test
  const testTasksFile = path.join(PROJECT_ROOT, '.workbench_tasks.json');
  if (fs.existsSync(testTasksFile)) {
    try { fs.unlinkSync(testTasksFile); } catch (e) {}
  }

  const server = new WorkbenchServer({ cwd: PROJECT_ROOT, port: 0 });
  const { port, sessionToken } = await server.start();
  console.log(`[Setup] Workbench server running on 127.0.0.1:${port}`);

  const claudeClient = new McpClientHelper('claude', port, sessionToken);
  const geminiClient = new McpClientHelper('gemini', port, sessionToken);

  try {
    // -------------------------------------------------------------
    // Test 1: Start Claude MCP Bridge and verify registration
    // -------------------------------------------------------------
    console.log('\n[Test 1] Launching Claude MCP stdio bridge...');
    await claudeClient.start();
    await new Promise((r) => setTimeout(r, 500));

    // Initialize MCP
    const initClaude = await claudeClient.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'claude-code-test', version: '2.1' }
    });
    assert(initClaude.serverInfo.name === 'workbench-claude-bridge', 'Claude MCP bridge initialized with correct server name');

    // Query peers from coordinator API
    const resPeers1 = await fetch(`http://127.0.0.1:${port}/api/intercom/peers`, {
      headers: { 'X-Session-Token': sessionToken }
    });
    const peers1 = await resPeers1.json();
    assert(peers1.some(p => p.agentId === 'claude' && p.status === 'ONLINE'), 'Claude registered as ONLINE peer in Coordinator');

    // -------------------------------------------------------------
    // Test 2: Start Gemini MCP Bridge and verify registration
    // -------------------------------------------------------------
    console.log('\n[Test 2] Launching Gemini MCP stdio bridge...');
    await geminiClient.start();
    await new Promise((r) => setTimeout(r, 500));

    const initGemini = await geminiClient.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'gemini-cli-test', version: '0.66' }
    });
    assert(initGemini.serverInfo.name === 'workbench-gemini-bridge', 'Gemini MCP bridge initialized with correct server name');

    const resPeers2 = await fetch(`http://127.0.0.1:${port}/api/intercom/peers`, {
      headers: { 'X-Session-Token': sessionToken }
    });
    const peers2 = await resPeers2.json();
    assert(peers2.some(p => p.agentId === 'gemini' && p.status === 'ONLINE'), 'Gemini registered as ONLINE peer in Coordinator');
    assert(peers2.length >= 2, 'Both Claude and Gemini are registered simultaneously');

    // -------------------------------------------------------------
    // Test 3: Tool Discovery on both Bridges
    // -------------------------------------------------------------
    console.log('\n[Test 3] Verifying tool lists on both independent bridges...');
    const claudeToolsRes = await claudeClient.sendRequest('tools/list');
    const claudeToolNames = claudeToolsRes.tools.map(t => t.name);
    assert(claudeToolNames.includes('discover_peers'), 'Claude has discover_peers tool');
    assert(claudeToolNames.includes('delegate_to_gemini'), 'Claude has delegate_to_gemini tool');
    assert(claudeToolNames.includes('get_delegation_status'), 'Claude has get_delegation_status tool');
    assert(!claudeToolNames.includes('claim_task'), 'Claude does NOT have worker claim_task tool');

    const geminiToolsRes = await geminiClient.sendRequest('tools/list');
    const geminiToolNames = geminiToolsRes.tools.map(t => t.name);
    assert(geminiToolNames.includes('discover_peers'), 'Gemini has discover_peers tool');
    assert(geminiToolNames.includes('get_inbox'), 'Gemini has get_inbox tool');
    assert(geminiToolNames.includes('claim_task'), 'Gemini has claim_task tool');
    assert(geminiToolNames.includes('report_task_completion'), 'Gemini has report_task_completion tool');
    assert(!geminiToolNames.includes('delegate_to_gemini'), 'Gemini does NOT have delegate_to_gemini tool');

    // Call discover_peers from Claude MCP
    const claudeDiscover = await claudeClient.sendRequest('tools/call', {
      name: 'discover_peers',
      arguments: {}
    });
    const discoveredObj = JSON.parse(claudeDiscover.content[0].text);
    const discoveredList = discoveredObj.peers || [];
    assert(discoveredList.some(p => p.agentId === 'gemini'), 'Claude discover_peers call found Gemini peer');

    // -------------------------------------------------------------
    // Test 4: End-to-End Correlated Delegation Pipeline
    // -------------------------------------------------------------
    console.log('\n[Test 4] Testing correlated delegation pipeline (Claude -> Gemini -> Claude)...');

    // Claude delegates to Gemini (runs asynchronously and waits)
    let delegationPromiseResolved = false;
    let delegationResult = null;

    const delegationPromise = claudeClient.sendRequest('tools/call', {
      name: 'delegate_to_gemini',
      arguments: {
        plan: 'Refactor calculateTotal function',
        instructions: 'Add 10% tax calculation to subtotal',
        expectedFiles: ['src/pricing.js'],
        timeoutSeconds: 30
      }
    }).then((res) => {
      delegationPromiseResolved = true;
      delegationResult = res;
    });

    // Wait a moment for Coordinator to register delegation
    await new Promise((r) => setTimeout(r, 400));
    assert(!delegationPromiseResolved, 'Claude delegation tool call remains pending waiting for Gemini completion');

    // Human approves the delegation in the coordinator
    const pendingApprovals = server.intercomService.getPendingApprovals();
    assert(pendingApprovals.length === 1, 'Delegation is in APPROVAL_REQUESTED state awaiting approval');
    server.intercomService.approveDelegation({ correlationId: pendingApprovals[0].correlationId });

    // Gemini checks inbox
    const inboxRes = await geminiClient.sendRequest('tools/call', {
      name: 'get_inbox',
      arguments: {}
    });
    const inboxObj = JSON.parse(inboxRes.content[0].text);
    const inbox = inboxObj.tasks || [];
    assert(inbox.length === 1, 'Gemini get_inbox found exactly 1 queued task');
    const task = inbox[0];
    assert(task.fromAgent === 'claude', 'Task sender is claude');
    assert(task.expectedFiles.includes('src/pricing.js'), 'Expected files matched in delegation task');

    // Gemini claims task
    const claimRes = await geminiClient.sendRequest('tools/call', {
      name: 'claim_task',
      arguments: { correlationId: task.correlationId }
    });
    assert(claimRes.content[0].text.includes('claimed successfully'), 'Gemini claim_task succeeded');

    // Check that Gemini peer status changed to BUSY
    const resPeersBusy = await fetch(`http://127.0.0.1:${port}/api/intercom/peers`, {
      headers: { 'X-Session-Token': sessionToken }
    });
    const peersBusy = await resPeersBusy.json();
    assert(peersBusy.some(p => p.agentId === 'gemini' && p.status === 'BUSY'), 'Gemini peer transitioned to BUSY state while executing');

    // Gemini reports completion
    const completeRes = await geminiClient.sendRequest('tools/call', {
      name: 'report_task_completion',
      arguments: {
        correlationId: task.correlationId,
        summary: 'Added 10% tax logic to src/pricing.js and ran unit tests',
        modifiedFiles: ['src/pricing.js']
      }
    });
    assert(completeRes.content[0].text.includes('COMPLETED'), 'Gemini report_task_completion succeeded');

    // Wait for Claude's pending promise to resolve
    await delegationPromise;
    assert(delegationPromiseResolved, 'Claude delegation tool call resolved upon Gemini completion');
    assert(delegationResult.content[0].text.includes('Gemini implementation completed successfully!'), 'Claude received success message');
    assert(delegationResult.content[0].text.includes('Added 10% tax logic'), 'Claude received Gemini completion summary');
    assert(delegationResult.content[0].text.includes('src/pricing.js'), 'Claude received modifiedFiles');

    // -------------------------------------------------------------
    // Test 5: Clean Disconnect and Offline Reporting
    // -------------------------------------------------------------
    console.log('\n[Test 5] Testing graceful disconnect and peer status updates...');
    await geminiClient.stop();
    await new Promise((r) => setTimeout(r, 400));

    const resPeersOffline = await fetch(`http://127.0.0.1:${port}/api/intercom/peers`, {
      headers: { 'X-Session-Token': sessionToken }
    });
    const peersOffline = await resPeersOffline.json();
    assert(peersOffline.some(p => p.agentId === 'gemini' && p.status === 'OFFLINE'), 'Gemini peer transitioned to OFFLINE after disconnect');

    // Claude checks peers again and sees Gemini offline
    const claudeDiscoverOffline = await claudeClient.sendRequest('tools/call', {
      name: 'discover_peers',
      arguments: {}
    });
    const discoveredObjOffline = JSON.parse(claudeDiscoverOffline.content[0].text);
    const discoveredListOffline = discoveredObjOffline.peers || [];
    const geminiPeer = discoveredListOffline.find(p => p.agentId === 'gemini');
    assert(geminiPeer.status === 'OFFLINE', 'Claude discover_peers reports Gemini is OFFLINE');

    console.log('\n===============================================================');
    console.log(`  PHASE 1 TEST SUITE RESULTS: ${passed} PASSED, ${failed} FAILED`);
    console.log('===============================================================\n');

    if (failed > 0) {
      process.exit(1);
    }
  } finally {
    await claudeClient.stop();
    await geminiClient.stop();
    await server.shutdown();
  }
}

runTests().catch((err) => {
  console.error('[FATAL TEST ERROR]', err);
  process.exit(1);
});
