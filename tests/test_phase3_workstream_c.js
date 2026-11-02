// D:\Ashish_P\AI-Tools\custom-OCT\tests\test_phase3_workstream_c.js
// Focused Regression Suite for Phase 3 Workstream C: Session Health & Reconnection

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  IntercomService,
  AgentStatus,
  DelegationState,
  TaskSecurityError,
  TaskStateError
} from '../server/intercom_service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const TEMP_WORKSPACE = path.join(PROJECT_ROOT, 'tests', 'temp_workspace_c');

async function runWorkstreamCTests() {
  console.log('===============================================================');
  console.log('  Phase 3: Workstream C Session Health & Reconnection Suite   ');
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

  if (fs.existsSync(TEMP_WORKSPACE)) {
    fs.rmSync(TEMP_WORKSPACE, { recursive: true, force: true });
  }
  fs.mkdirSync(TEMP_WORKSPACE, { recursive: true });

  try {
    // ------------------------------------------------------------------------
    // Test 1: Initial registration
    // ------------------------------------------------------------------------
    console.log('[Test 1] Initial registration assigns generation 1 and ONLINE status...');
    const intercom1 = new IntercomService({ cwd: TEMP_WORKSPACE });
    const p1 = intercom1.registerAgent({
      agentId: 'gemini',
      sessionId: 'sess_g_1',
      pid: 1001,
      cliVersion: '0.66.0',
      cwd: TEMP_WORKSPACE,
      capabilities: ['implementation']
    });
    assert(p1.agentId === 'gemini', 'Agent ID recorded as gemini');
    assert(p1.sessionId === 'sess_g_1', 'Session ID recorded');
    assert(p1.generation === 1, 'Coordinator assigned monotonic generation 1');
    assert(p1.status === AgentStatus.ONLINE, 'Initial peer status is ONLINE');
    assert(typeof p1.lastHeartbeat === 'number', 'Initial heartbeat recorded');

    // ------------------------------------------------------------------------
    // Test 2: Heartbeat timestamp refresh
    // ------------------------------------------------------------------------
    console.log('[Test 2] Heartbeat timestamp refresh...');
    const initialHeartbeat = p1.lastHeartbeat;
    // Advance time slightly
    await new Promise(r => setTimeout(r, 20));
    const hbOk = intercom1.recordHeartbeat({ agentId: 'gemini', sessionId: 'sess_g_1', status: 'ONLINE' });
    assert(hbOk === true, 'recordHeartbeat returned true for active session');
    assert(p1.lastHeartbeat > initialHeartbeat, 'lastHeartbeat timestamp refreshed');

    // ------------------------------------------------------------------------
    // Test 3: Stale session heartbeat rejection
    // ------------------------------------------------------------------------
    console.log('[Test 3] Stale session heartbeat rejection...');
    const staleHb = intercom1.recordHeartbeat({ agentId: 'gemini', sessionId: 'sess_g_OLD', status: 'ONLINE' });
    assert(staleHb === false, 'Stale session heartbeat rejected with false (unrecognized_peer)');

    // ------------------------------------------------------------------------
    // Test 4 & 5: Transition to UNREACHABLE (15s) and OFFLINE (30s)
    // ------------------------------------------------------------------------
    console.log('[Test 4 & 5] Transition to UNREACHABLE and OFFLINE based on elapsed heartbeat...');
    // Manually backdate lastHeartbeat to 16 seconds ago
    p1.lastHeartbeat = Date.now() - 16000;
    intercom1._checkHeartbeats();
    assert(p1.status === AgentStatus.UNREACHABLE, 'Peer transitioned to UNREACHABLE after 16s without heartbeat');

    // Manually backdate lastHeartbeat to 31 seconds ago
    p1.lastHeartbeat = Date.now() - 31000;
    intercom1._checkHeartbeats();
    assert(p1.status === AgentStatus.OFFLINE, 'Peer transitioned to OFFLINE after 31s without heartbeat');

    // ------------------------------------------------------------------------
    // Test 6: Recovery from UNREACHABLE / OFFLINE on valid heartbeat
    // ------------------------------------------------------------------------
    console.log('[Test 6] Recovery from OFFLINE/UNREACHABLE on valid heartbeat...');
    const recHb = intercom1.recordHeartbeat({ agentId: 'gemini', sessionId: 'sess_g_1', status: 'ONLINE' });
    assert(recHb === true, 'Heartbeat accepted from same session');
    assert(p1.status === AgentStatus.ONLINE, 'Peer recovered cleanly to ONLINE');
    assert(p1.generation === 1, 'Generation unchanged during reconnection of same session');

    // ------------------------------------------------------------------------
    // Test 7: Bridge re-registration after unrecognized_peer
    // ------------------------------------------------------------------------
    console.log('[Test 7] Bridge re-registration after coordinator drops session...');
    // Clear activePeers simulating restart of coordinator memory
    intercom1.activePeers.clear();
    const probeHb = intercom1.recordHeartbeat({ agentId: 'gemini', sessionId: 'sess_g_1', status: 'ONLINE' });
    assert(probeHb === false, 'Heartbeat returns false on cleared peer registry');

    // Bridge detects unrecognized_peer and calls registerAgent with same session ID
    const reRegPeer = intercom1.registerAgent({
      agentId: 'gemini',
      sessionId: 'sess_g_1',
      pid: 1001,
      cliVersion: '0.66.0',
      cwd: TEMP_WORKSPACE
    });
    assert(reRegPeer.status === AgentStatus.ONLINE, 'Session re-registered successfully');
    assert(reRegPeer.generation === 2, 'New registration generation incremented to 2');

    // ------------------------------------------------------------------------
    // Test 8: Reconnection after coordinator restart
    // ------------------------------------------------------------------------
    console.log('[Test 8] Reconnection after coordinator restart preserves queued tasks...');
    // Create queued task
    const tQueued = intercom1.createDelegation({
      fromAgent: 'claude',
      toAgent: 'gemini',
      instructions: 'Queued task surviving restart',
      correlationId: 'CORR_TEST_RECONNECT_Q',
      cwd: TEMP_WORKSPACE,
      requiresApproval: false
    });
    await intercom1._persist();
    await intercom1.shutdown();

    // Restart coordinator
    const intercomRestarted = new IntercomService({ cwd: TEMP_WORKSPACE });
    const tasksAfterRestart = intercomRestarted.getInbox('gemini', TEMP_WORKSPACE);
    assert(tasksAfterRestart.some(t => t.correlationId === 'CORR_TEST_RECONNECT_Q'), 'Queued task survived coordinator restart');

    // Reconnecting bridge registers
    const pRestart = intercomRestarted.registerAgent({
      agentId: 'gemini',
      sessionId: 'sess_g_restart',
      pid: 1002,
      cwd: TEMP_WORKSPACE
    });
    assert(pRestart.status === AgentStatus.ONLINE, 'Reconnected session is ONLINE');
    const claimableInbox = intercomRestarted.getInbox('gemini', TEMP_WORKSPACE);
    assert(claimableInbox.length >= 1, 'Queued task is immediately claimable by reconnected session');

    // ------------------------------------------------------------------------
    // Test 9: Queued task preservation through disconnect / reconnect
    // ------------------------------------------------------------------------
    console.log('[Test 9] Queued task preservation through explicit disconnect...');
    intercomRestarted.disconnectAgent({ agentId: 'gemini', sessionId: 'sess_g_restart' });
    assert(pRestart.status === AgentStatus.OFFLINE, 'Gemini disconnected and marked OFFLINE');

    const inboxWhileOffline = intercomRestarted.getInbox('gemini', TEMP_WORKSPACE);
    assert(inboxWhileOffline.some(t => t.correlationId === 'CORR_TEST_RECONNECT_Q'), 'Queued tasks strictly preserved while Gemini is OFFLINE');

    // ------------------------------------------------------------------------
    // Test 10: Offline and unreachable claim rejection
    // ------------------------------------------------------------------------
    console.log('[Test 10] Offline and unreachable session claim rejection...');
    let offlineClaimErr = null;
    try {
      intercomRestarted.claimTask({
        agentId: 'gemini',
        sessionId: 'sess_g_restart',
        correlationId: 'CORR_TEST_RECONNECT_Q',
        cwd: TEMP_WORKSPACE
      });
    } catch (e) {
      offlineClaimErr = e;
    }
    assert(offlineClaimErr instanceof TaskSecurityError, 'Offline claim rejected with TaskSecurityError');
    assert(offlineClaimErr?.code === 'ERR_SECURITY_VIOLATION', 'Error code is ERR_SECURITY_VIOLATION');
    assert(offlineClaimErr.message.includes('OFFLINE'), 'Error message cites OFFLINE status');

    // Test unreachable claim rejection
    pRestart.status = AgentStatus.UNREACHABLE;
    let unreachableClaimErr = null;
    try {
      intercomRestarted.claimTask({
        agentId: 'gemini',
        sessionId: 'sess_g_restart',
        correlationId: 'CORR_TEST_RECONNECT_Q',
        cwd: TEMP_WORKSPACE
      });
    } catch (e) {
      unreachableClaimErr = e;
    }
    assert(unreachableClaimErr instanceof TaskSecurityError, 'Unreachable claim rejected with TaskSecurityError');
    assert(unreachableClaimErr.message.includes('UNREACHABLE'), 'Error message cites UNREACHABLE status');

    // ------------------------------------------------------------------------
    // Test 11: Terminal restart and session replacement
    // ------------------------------------------------------------------------
    console.log('[Test 11] Terminal restart and session replacement updates session ID and generation...');
    const pNewTerm = intercomRestarted.registerAgent({
      agentId: 'gemini',
      sessionId: 'sess_g_term_replacement',
      pid: 2001,
      cwd: TEMP_WORKSPACE
    });
    assert(pNewTerm.sessionId === 'sess_g_term_replacement', 'New terminal session ID registered');
    assert(pNewTerm.generation > pRestart.generation, 'New generation is strictly greater than old terminal generation');
    assert(pNewTerm.status === AgentStatus.ONLINE, 'New terminal status is ONLINE');

    // Claim succeeds under new online session
    const claimedTask = intercomRestarted.claimTask({
      agentId: 'gemini',
      sessionId: 'sess_g_term_replacement',
      correlationId: 'CORR_TEST_RECONNECT_Q',
      cwd: TEMP_WORKSPACE
    });
    assert(claimedTask.state === DelegationState.RUNNING, 'Task successfully claimed by new terminal session');

    // ------------------------------------------------------------------------
    // Test 12: Delayed old-session registration rejection (Session Conflict)
    // ------------------------------------------------------------------------
    console.log('[Test 12] Delayed old-session registration rejection...');
    let staleRegErr = null;
    try {
      // Old zombie session attempts to register while new session is alive (<15s heartbeat)
      intercomRestarted.registerAgent({
        agentId: 'gemini',
        sessionId: 'sess_g_zombie_delayed',
        pid: 9999,
        cwd: TEMP_WORKSPACE
      });
    } catch (e) {
      staleRegErr = e;
    }
    assert(staleRegErr instanceof TaskSecurityError, 'Rejected stale registration with TaskSecurityError');
    assert(staleRegErr?.code === 'ERR_SESSION_CONFLICT', 'Error code is ERR_SESSION_CONFLICT');
    assert(intercomRestarted.activePeers.get('gemini').sessionId === 'sess_g_term_replacement', 'Active session preserved (not overwritten)');

    // ------------------------------------------------------------------------
    // Test 13: Delayed old-session disconnect rejection
    // ------------------------------------------------------------------------
    console.log('[Test 13] Delayed old-session disconnect rejection...');
    // Delayed disconnect packet arrives from the old session
    const oldDisconnectRes = intercomRestarted.disconnectAgent({
      agentId: 'gemini',
      sessionId: 'sess_g_restart' // old session
    });
    assert(oldDisconnectRes === false, 'Delayed old-session disconnect ignored (returned false)');
    assert(intercomRestarted.activePeers.get('gemini').status === AgentStatus.BUSY, 'Active session status preserved (not forced OFFLINE)');

    // ------------------------------------------------------------------------
    // Test 14: Duplicate same-session registration (Idempotent)
    // ------------------------------------------------------------------------
    console.log('[Test 14] Duplicate same-session registration is idempotent...');
    const currentActive = intercomRestarted.activePeers.get('gemini');
    const existingGen = currentActive.generation;
    const dupRes = intercomRestarted.registerAgent({
      agentId: 'gemini',
      sessionId: 'sess_g_term_replacement', // exact same active session
      pid: 2001,
      cwd: TEMP_WORKSPACE,
      capabilities: ['implementation', 'refactoring']
    });
    assert(dupRes.sessionId === 'sess_g_term_replacement', 'Returns same session');
    assert(dupRes.generation === existingGen, 'Generation counter NOT bumped on idempotent registration');
    assert(dupRes.capabilities.includes('refactoring'), 'Capabilities updated idempotently');

    // ------------------------------------------------------------------------
    // Test 15: Transient network failure vs authentication failure simulation
    // ------------------------------------------------------------------------
    console.log('[Test 15] Transient network failure vs auth failure handling...');
    // Coordinator heartbeat returns false on unknown agent
    const unknownAgentRes = intercomRestarted.recordHeartbeat({ agentId: 'unknown_agent', sessionId: 'x' });
    assert(unknownAgentRes === false, 'Unknown agent heartbeat returned false');

    // ------------------------------------------------------------------------
    // Test 16: Late task completion after heartbeat degradation
    // ------------------------------------------------------------------------
    console.log('[Test 16] Late task completion after heartbeat degradation to UNREACHABLE...');
    // Backdate heartbeat to 18 seconds (UNREACHABLE) while task is RUNNING
    currentActive.lastHeartbeat = Date.now() - 18000;
    intercomRestarted._checkHeartbeats();
    assert(currentActive.status === AgentStatus.UNREACHABLE, 'Peer entered UNREACHABLE during heavy task execution');
    assert(claimedTask.state === DelegationState.RUNNING, 'Running task NOT aborted by UNREACHABLE transition');

    // Worker completes task
    intercomRestarted.completeTask({
      agentId: 'gemini',
      sessionId: 'sess_g_term_replacement',
      correlationId: 'CORR_TEST_RECONNECT_Q',
      summary: 'Completed despite degraded heartbeat',
      modifiedFiles: ['output.js']
    });
    assert(claimedTask.state === DelegationState.COMPLETED, 'Task completed successfully');
    assert(currentActive.status === AgentStatus.ONLINE, 'Peer restored to ONLINE upon completion');

    await intercomRestarted.shutdown();
  } finally {
    if (fs.existsSync(TEMP_WORKSPACE)) {
      try { fs.rmSync(TEMP_WORKSPACE, { recursive: true, force: true }); } catch (e) {}
    }
  }

  console.log('\n===============================================================');
  console.log(`  PHASE 3 WORKSTREAM C SUITE: ${passed} PASSED, ${failed} FAILED`);
  console.log('===============================================================\n');

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runWorkstreamCTests().catch(err => {
  console.error('[FATAL WORKSTREAM C SUITE ERROR]', err);
  process.exit(1);
});
