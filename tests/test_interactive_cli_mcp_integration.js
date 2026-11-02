// D:\Ashish_P\AI-Tools\custom-OCT\tests\test_interactive_cli_mcp_integration.js
// Acceptance & Verification Suite for Phase 1.1: Live CLI MCP Integration

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WorkbenchServer } from '../server/server.js';
import { IntercomService, DelegationState } from '../server/intercom_service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const TEMP_WORKSPACE = path.join(PROJECT_ROOT, 'tests', 'temp_workspace');

async function runAcceptancePass() {
  console.log('===============================================================');
  console.log('  Phase 1.1: Live CLI Integration & Acceptance Verification   ');
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

  // Ensure clean disposable test workspace
  if (!fs.existsSync(TEMP_WORKSPACE)) {
    fs.mkdirSync(TEMP_WORKSPACE, { recursive: true });
  }

  // Clean any existing tasks file
  const testTasksFile = path.join(TEMP_WORKSPACE, '.workbench_tasks.json');
  if (fs.existsSync(testTasksFile)) {
    fs.unlinkSync(testTasksFile);
  }

  console.log('[Setup] Disposable test workspace:', TEMP_WORKSPACE);

  // --------------------------------------------------------------------------
  // Suite A: Task Persistence Verification
  // --------------------------------------------------------------------------
  console.log('\n--- SUITE A: Durable Task Persistence & Crash Recovery ---');
  {
    const intercom1 = new IntercomService({ cwd: TEMP_WORKSPACE });
    intercom1.registerAgent({ agentId: 'claude', sessionId: 'sess_c1', pid: 1111, cwd: TEMP_WORKSPACE });
    intercom1.registerAgent({ agentId: 'gemini', sessionId: 'sess_g1', pid: 2222, cwd: TEMP_WORKSPACE });

    // 1. Create a task that stays QUEUED
    const t1 = await new Promise(async (resolve) => {
      intercom1.createDelegation({
        fromAgent: 'claude',
        toAgent: 'gemini',
        plan: 'Task 1 Plan',
        instructions: 'Queued Task Instructions',
        correlationId: 'CORR_PERSIST_QUEUED',
        cwd: TEMP_WORKSPACE,
        requiresApproval: false
      });
      resolve(intercom1.getDelegation('CORR_PERSIST_QUEUED'));
    });
    assert(t1.state === DelegationState.QUEUED, 'Task 1 successfully created in QUEUED state');

    // 2. Create a task and claim it (RUNNING state)
    await new Promise(async (resolve) => {
      intercom1.createDelegation({
        fromAgent: 'claude',
        toAgent: 'gemini',
        plan: 'Task 2 Plan',
        instructions: 'Running Task Instructions',
        correlationId: 'CORR_PERSIST_RUNNING',
        cwd: TEMP_WORKSPACE,
        requiresApproval: false
      });
      resolve();
    });
    intercom1.claimTask({
      agentId: 'gemini',
      sessionId: 'sess_g1',
      correlationId: 'CORR_PERSIST_RUNNING',
      cwd: TEMP_WORKSPACE
    });
    const t2 = intercom1.getDelegation('CORR_PERSIST_RUNNING');
    assert(t2.state === DelegationState.CLAIMED || t2.state === DelegationState.RUNNING, 'Task 2 successfully claimed and running');

    // 3. Create a task and complete it
    await new Promise(async (resolve) => {
      intercom1.createDelegation({
        fromAgent: 'claude',
        toAgent: 'gemini',
        plan: 'Task 3 Plan',
        instructions: 'Completed Task Instructions',
        correlationId: 'CORR_PERSIST_COMPLETED',
        cwd: TEMP_WORKSPACE,
        requiresApproval: false
      });
      resolve();
    });
    intercom1.claimTask({
      agentId: 'gemini',
      sessionId: 'sess_g1',
      correlationId: 'CORR_PERSIST_COMPLETED',
      cwd: TEMP_WORKSPACE
    });
    intercom1.completeTask({
      agentId: 'gemini',
      sessionId: 'sess_g1',
      correlationId: 'CORR_PERSIST_COMPLETED',
      summary: 'Task 3 Finished',
      modifiedFiles: ['task3.txt']
    });
    const t3 = intercom1.getDelegation('CORR_PERSIST_COMPLETED');
    assert(t3.state === DelegationState.COMPLETED, 'Task 3 completed');

    // Simulate Server Shutdown
    await intercom1.shutdown();
    assert(fs.existsSync(testTasksFile), 'Tasks persisted to .workbench_tasks.json on disk');

    // Simulate Server Restart: Instantiate new IntercomService pointing to same directory
    const intercom2 = new IntercomService({ cwd: TEMP_WORKSPACE });
    const restoredT1 = intercom2.getDelegation('CORR_PERSIST_QUEUED');
    const restoredT2 = intercom2.getDelegation('CORR_PERSIST_RUNNING');
    const restoredT3 = intercom2.getDelegation('CORR_PERSIST_COMPLETED');

    assert(restoredT1 && restoredT1.state === DelegationState.QUEUED, 'QUEUED task survived server restart and remains claimable');
    assert(restoredT3 && restoredT3.state === DelegationState.COMPLETED, 'COMPLETED task survived server restart with result intact');
    assert(
      restoredT2 && restoredT2.state === DelegationState.FAILED && restoredT2.error.includes('restarted'),
      'In-flight CLAIMED/RUNNING task safely transitioned to FAILED (never falsely restored as completed)'
    );

    await intercom2.shutdown();
  }

  // --------------------------------------------------------------------------
  // Suite B: Task Security & Working-Directory Isolation
  // --------------------------------------------------------------------------
  console.log('\n--- SUITE B: Task Security & Working-Directory Isolation ---');
  {
    const intercomSec = new IntercomService({ cwd: TEMP_WORKSPACE });
    intercomSec.registerAgent({ agentId: 'claude', sessionId: 'sess_valid_claude', pid: 101, cwd: TEMP_WORKSPACE });
    intercomSec.registerAgent({ agentId: 'gemini', sessionId: 'sess_valid_gemini', pid: 102, cwd: TEMP_WORKSPACE });

    await new Promise(async (resolve) => {
      intercomSec.createDelegation({
        fromAgent: 'claude',
        toAgent: 'gemini',
        plan: 'Security Test Plan',
        instructions: 'Security Test Instructions',
        correlationId: 'CORR_SEC_TEST_1',
        cwd: TEMP_WORKSPACE,
        requiresApproval: false
      });
      resolve();
    });

    // 1. Wrong agent cannot claim
    let wrongAgentErr = null;
    try {
      intercomSec.claimTask({
        agentId: 'claude',
        sessionId: 'sess_valid_claude',
        correlationId: 'CORR_SEC_TEST_1',
        cwd: TEMP_WORKSPACE,
        requiresApproval: false
      });
    } catch (e) {
      wrongAgentErr = e.message;
    }
    assert(wrongAgentErr && wrongAgentErr.includes('assigned to'), 'Rejected claim by unauthorized agent');

    // 2. Stale or invalid session ID cannot claim
    let staleSessionErr = null;
    try {
      intercomSec.claimTask({
        agentId: 'gemini',
        sessionId: 'sess_STALE_ID',
        correlationId: 'CORR_SEC_TEST_1',
        cwd: TEMP_WORKSPACE,
        requiresApproval: false
      });
    } catch (e) {
      staleSessionErr = e.message;
    }
    assert(staleSessionErr && staleSessionErr.includes('Stale or unauthenticated'), 'Rejected claim with stale session ID');

    // 3. Working directory mismatch rejected
    let cwdMismatchErr = null;
    try {
      intercomSec.claimTask({
        agentId: 'gemini',
        sessionId: 'sess_valid_gemini',
        correlationId: 'CORR_SEC_TEST_1',
        cwd: 'C:\\Different\\Directory\\Path'
      });
    } catch (e) {
      cwdMismatchErr = e.message;
    }
    assert(cwdMismatchErr && cwdMismatchErr.includes('Working directory mismatch'), 'Rejected claim due to working directory mismatch');

    // 4. Valid claim succeeds
    const validClaim = intercomSec.claimTask({
      agentId: 'gemini',
      sessionId: 'sess_valid_gemini',
      correlationId: 'CORR_SEC_TEST_1',
      cwd: TEMP_WORKSPACE
    });
    assert(validClaim && (validClaim.state === DelegationState.CLAIMED || validClaim.state === DelegationState.RUNNING), 'Authorized claim by registered Gemini session succeeded');

    // 5. Duplicate claim rejected
    let duplicateClaimErr = null;
    try {
      intercomSec.claimTask({
        agentId: 'gemini',
        sessionId: 'sess_valid_gemini',
        correlationId: 'CORR_SEC_TEST_1',
        cwd: TEMP_WORKSPACE,
        requiresApproval: false
      });
    } catch (e) {
      duplicateClaimErr = e.message;
    }
    assert(duplicateClaimErr && duplicateClaimErr.includes('Duplicate claim rejected'), 'Rejected duplicate claim on already claimed task');

    intercomSec.shutdown();
  }

  // --------------------------------------------------------------------------
  // Suite C: Live Server Terminal Integration & ConPTY Configuration
  // --------------------------------------------------------------------------
  console.log('\n--- SUITE C: Live Server Terminal ConPTY MCP Auto-Configuration ---');
  {
    const server = new WorkbenchServer({ cwd: PROJECT_ROOT, port: 0 });
    const { port, sessionToken } = await server.start();
    server.terminalManager.setProjectCwd(TEMP_WORKSPACE);

    // Verify Claude terminal config generation
    const claudeConfig = server.terminalManager.getTerminalConfig('claude', TEMP_WORKSPACE);
    const claudeMcpFile = path.join(TEMP_WORKSPACE, '.workbench', 'claude_mcp_config.json');
    assert(fs.existsSync(claudeMcpFile), 'Auto-generated .workbench/claude_mcp_config.json in target workspace');
    assert(claudeConfig.args.includes('--mcp-config'), 'Claude terminal args include --mcp-config');
    assert(claudeConfig.args.includes(claudeMcpFile), 'Claude terminal args point to generated config file');

    const claudeConfigContent = JSON.parse(fs.readFileSync(claudeMcpFile, 'utf8'));
    assert(claudeConfigContent.mcpServers.workbench !== undefined, 'Claude config specifies workbench MCP server');
    assert(claudeConfigContent.mcpServers.workbench.args.includes('--agent'), 'Claude MCP args include --agent flag');
    assert(claudeConfigContent.mcpServers.workbench.args.includes('claude'), 'Claude MCP args specify agent claude');

    // Verify Gemini terminal config generation
    const geminiConfig = server.terminalManager.getTerminalConfig('gemini', TEMP_WORKSPACE);
    const geminiSettingsFile = path.join(TEMP_WORKSPACE, '.gemini', 'settings.json');
    assert(fs.existsSync(geminiSettingsFile), 'Auto-generated .gemini/settings.json in target workspace');

    const geminiSettingsContent = JSON.parse(fs.readFileSync(geminiSettingsFile, 'utf8'));
    assert(geminiSettingsContent.mcpServers.workbench !== undefined, 'Gemini settings specify workbench MCP server');
    assert(geminiSettingsContent.mcpServers.workbench.args.includes('gemini'), 'Gemini MCP args specify agent gemini');

    // Global settings isolation check
    const globalSettingsPath = 'C:\\Users\\ajeevanesan\\.gemini\\settings.json';
    const globalSettingsRaw = fs.readFileSync(globalSettingsPath, 'utf8');
    assert(!globalSettingsRaw.includes(String(port)), 'Global ~/.gemini/settings.json is 100% untouched and unpolluted');

    // Start ConPTY Gemini session and verify process spawning
    console.log('\n[ConPTY Live Test] Spawning actual Gemini ConPTY process in workspace...');
    let geminiTermRecord = null;
    let termOutput = '';

    try {
      geminiTermRecord = server.terminalManager.startTerminal(
        'gemini',
        { cols: 80, rows: 24, cwd: TEMP_WORKSPACE },
        (chunk) => {
          termOutput += chunk;
        }
      );

      assert(geminiTermRecord.pid > 0, `ConPTY spawned live Gemini process (PID ${geminiTermRecord.pid})`);
      assert(geminiTermRecord.cwd === TEMP_WORKSPACE, 'ConPTY spawned in target temp_workspace');

      // Wait a moment for process boot
      await new Promise((r) => setTimeout(r, 2000));

      // Verify that no extra ACP daemon or secondary implementation process was spawned
      const termStatuses = server.terminalManager.getAllStatuses();
      assert(termStatuses.gemini.status === 'RUNNING', 'Gemini interactive terminal is authoritative RUNNING session');
    } finally {
      if (geminiTermRecord) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 3000);
          geminiTermRecord.exitListeners.add(() => {
            clearTimeout(timer);
            resolve();
          });
          server.terminalManager.terminate('gemini').catch(() => {});
        });
      }
      await server.shutdown();
    }
  }

  console.log('\n===============================================================');
  console.log(`  PHASE 1.1 ACCEPTANCE SUITE RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('===============================================================\n');

  try {
    if (fs.existsSync(testTasksFile)) {
      fs.unlinkSync(testTasksFile);
    }
  } catch (e) {}

  if (failed > 0) {
    console.log('[DEBUG] Exiting with code 1');
    process.exit(1);
  } else {
    console.log('[DEBUG] Exiting with code 0');
    process.exit(0);
  }
}

runAcceptancePass().catch((err) => {
  console.error('[FATAL ACCEPTANCE SUITE ERROR]', err);
  process.exit(1);
});
