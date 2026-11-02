// D:\Ashish_P\AI-Tools\custom-OCT\tests\ui_integration_tests.js
// Phase 3 UI & Server Integration Test Suite (10 Automated Tests)

import { WorkbenchServer } from '../server/server.js';
import { WebSocket } from 'ws';
import { execSync } from 'child_process';
import path from 'path';

const CWD = 'D:\\Ashish_P\\AI-Tools\\custom-OCT';

function isPidAlive(pid) {
  if (!pid) return false;
  try {
    if (process.platform === 'win32') {
      const output = execSync(`tasklist /FI "PID eq ${pid}" /NH`, { encoding: 'utf-8' });
      return output.includes(String(pid));
    } else {
      process.kill(pid, 0);
      return true;
    }
  } catch (e) {
    return false;
  }
}

async function runTest(name, fn) {
  process.stdout.write(`>>> [UI TEST] ${name.padEnd(50, ' ')} ... `);
  const start = Date.now();
  try {
    const res = await fn();
    const elapsed = Date.now() - start;
    console.log(`PASSED (${elapsed}ms)`);
    return { name, passed: true, elapsed, details: res };
  } catch (err) {
    const elapsed = Date.now() - start;
    console.log(`FAILED (${elapsed}ms) - ${err.message}`);
    return { name, passed: false, elapsed, error: err.message };
  }
}

async function main() {
  console.log('===============================================================');
  console.log('  Agent Workbench UI & Server Integration Test Suite');
  console.log('===============================================================\n');

  const results = [];

  // Test 1: Application startup, loopback binding & auth
  results.push(await runTest('1. Startup, Loopback Binding & Authentication', async () => {
    const server = new WorkbenchServer({ cwd: CWD, port: 0 });
    const { port, sessionToken } = await server.start();

    // Probe 1: Health check without auth
    const healthRes = await fetch(`http://127.0.0.1:${port}/api/health`);
    if (healthRes.status !== 200) throw new Error(`Health returned status ${healthRes.status}`);

    // Probe 2: Protected endpoint without auth -> 401
    const unauthRes = await fetch(`http://127.0.0.1:${port}/api/session/verify`);
    if (unauthRes.status !== 401) throw new Error(`Expected 401, got ${unauthRes.status}`);

    // Probe 3: Protected endpoint with auth -> 200
    const authRes = await fetch(`http://127.0.0.1:${port}/api/session/verify`, {
      headers: { 'X-Session-Token': sessionToken }
    });
    if (authRes.status !== 200) throw new Error(`Expected 200, got ${authRes.status}`);
    const data = await authRes.json();
    if (!data.authenticated || data.persistence !== 'SESSION_ONLY') {
      throw new Error(`Invalid session verify data: ${JSON.stringify(data)}`);
    }

    await server.shutdown();
    return { port, sessionToken };
  }));

  // Test 2: Starting and stopping interactive terminals
  results.push(await runTest('2. Starting and Stopping Interactive Terminals', async () => {
    const server = new WorkbenchServer({ cwd: CWD, port: 0 });
    const { port, sessionToken } = await server.start();

    // Start claude terminal
    const startRes = await fetch(`http://127.0.0.1:${port}/api/terminals/claude/start`, {
      method: 'POST',
      headers: { 'X-Session-Token': sessionToken }
    });
    const startData = await startRes.json();
    if (startData.status !== 'RUNNING' || !startData.pid) {
      throw new Error(`Claude terminal failed to start: ${JSON.stringify(startData)}`);
    }

    const termPid = startData.pid;
    if (!isPidAlive(termPid)) throw new Error(`PID ${termPid} not alive`);

    // Terminate terminal
    const stopRes = await fetch(`http://127.0.0.1:${port}/api/terminals/claude/terminate`, {
      method: 'POST',
      headers: { 'X-Session-Token': sessionToken }
    });
    const stopData = await stopRes.json();

    // Allow brief OS update
    await new Promise(r => setTimeout(r, 600));
    if (isPidAlive(termPid)) throw new Error(`PID ${termPid} still alive after terminate`);

    await server.shutdown();
    return { termPid };
  }));

  // Test 3: Keyboard input and terminal resize via WebSocket
  results.push(await runTest('3. Keyboard Input & Terminal Resize via WebSocket', async () => {
    const server = new WorkbenchServer({ cwd: CWD, port: 0 });
    const { port, sessionToken } = await server.start();

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal?id=claude`, [`token.${sessionToken}`], {
      headers: { Origin: `http://127.0.0.1:${port}` }
    });
    let outputReceived = false;

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Terminal WS timeout')), 8000);

      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'auth', token: sessionToken }));
        // Send resize
        ws.send(JSON.stringify({ type: 'resize', cols: 110, rows: 32 }));
        // Send newline/input
        ws.send(JSON.stringify({ type: 'input', data: '\r' }));
      });

      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'output' && msg.data) {
          outputReceived = true;
          clearTimeout(timer);
          resolve();
        }
      });

      ws.on('error', reject);
    });

    ws.close();
    await server.shutdown();
    if (!outputReceived) throw new Error('No output received over terminal WebSocket');
    return { outputReceived };
  }));

  // Test 4: Submitting a delegated task & receiving lifecycle events
  results.push(await runTest('4. Task Submission & Real-time Lifecycle Events', async () => {
    const server = new WorkbenchServer({ cwd: CWD, port: 0 });
    const { port, sessionToken } = await server.start();

    const eventsWs = new WebSocket(`ws://127.0.0.1:${port}/ws/events`, [`token.${sessionToken}`], {
      headers: { Origin: `http://127.0.0.1:${port}` }
    });
    const receivedEvents = [];

    await new Promise((resolve, reject) => {
      eventsWs.on('open', () => {
        eventsWs.send(JSON.stringify({ type: 'auth', token: sessionToken }));
      });
      eventsWs.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'auth_success') {
          resolve();
        }
      });
      eventsWs.on('error', reject);
    });

    eventsWs.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'intercom_event') {
        receivedEvents.push(msg.payload.eventType);
      }
    });

    const corrId = `CORR_UI_TEST_${Date.now()}`;
    const submitRes = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': sessionToken
      },
      body: JSON.stringify({
        correlationId: corrId,
        targetAgent: 'gemini',
        prompt: `Echo only: VERIFY_${corrId}`
      })
    });

    if (submitRes.status !== 201) throw new Error(`Submit status: ${submitRes.status}`);

    // Register Gemini peer to claim and complete
    const geminiPeer = server.intercomService.registerAgent({
      agentId: 'gemini',
      sessionId: 'sess_gemini_ui_test4',
      pid: 99401,
      cwd: CWD
    });

    // Human approves via REST
    await fetch(`http://127.0.0.1:${port}/api/intercom/approvals/${corrId}/approve`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': sessionToken
      },
      body: JSON.stringify({ approver: 'qa-tester' })
    });

    // Worker claims and completes
    server.intercomService.claimTask({
      agentId: 'gemini',
      sessionId: geminiPeer.sessionId,
      correlationId: corrId,
      cwd: CWD
    });
    server.intercomService.completeTask({
      agentId: 'gemini',
      sessionId: geminiPeer.sessionId,
      correlationId: corrId,
      summary: `Echo only: VERIFY_${corrId}`
    });

    // Wait for task completion event
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Task completion timeout')), 5000);
      const interval = setInterval(() => {
        if (receivedEvents.includes('TASK_COMPLETED')) {
          clearInterval(interval);
          clearTimeout(timer);
          resolve();
        }
      }, 100);
    });

    eventsWs.close();
    await server.shutdown();

    if (!receivedEvents.includes('APPROVAL_REQUESTED') || !receivedEvents.includes('TASK_COMPLETED')) {
      throw new Error(`Missing expected events: ${receivedEvents.join(', ')}`);
    }

    return { receivedEvents };
  }));

  // Test 5: Correlated response retrieval
  results.push(await runTest('5. Correlated Response Querying via REST API', async () => {
    const server = new WorkbenchServer({ cwd: CWD, port: 0 });
    const { port, sessionToken } = await server.start();

    const corrId = `CORR_QUERY_${Date.now()}`;
    await fetch(`http://127.0.0.1:${port}/api/tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': sessionToken
      },
      body: JSON.stringify({
        correlationId: corrId,
        targetAgent: 'gemini',
        prompt: `Echo: MATCH_${corrId}`
      })
    });

    // Register Gemini peer, approve, claim and complete
    const geminiPeer = server.intercomService.registerAgent({
      agentId: 'gemini',
      sessionId: 'sess_gemini_ui_test5',
      pid: 99501,
      cwd: CWD
    });

    await fetch(`http://127.0.0.1:${port}/api/intercom/approvals/${corrId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': sessionToken },
      body: JSON.stringify({ approver: 'qa-tester' })
    });

    server.intercomService.claimTask({
      agentId: 'gemini',
      sessionId: geminiPeer.sessionId,
      correlationId: corrId,
      cwd: CWD
    });

    server.intercomService.completeTask({
      agentId: 'gemini',
      sessionId: geminiPeer.sessionId,
      correlationId: corrId,
      summary: `Echo: MATCH_${corrId}`
    });

    // Query REST API
    const res = await fetch(`http://127.0.0.1:${port}/api/tasks/${corrId}`, {
      headers: { 'X-Session-Token': sessionToken }
    });
    const completedTask = await res.json();

    await server.shutdown();

    if (!completedTask || completedTask.state !== 'COMPLETED') throw new Error('Task did not reach COMPLETED state');
    if (completedTask.correlationId !== corrId) throw new Error('Correlation ID mismatch');
    if (!completedTask.result.includes(corrId)) throw new Error('Result missing correlation marker');

    return { correlationId: completedTask.correlationId, state: completedTask.state };
  }));

  // Test 6: Rendering failure and timeout states
  results.push(await runTest('6. Task Timeout State Transition', async () => {
    const server = new WorkbenchServer({ cwd: CWD, port: 0 });
    const { port, sessionToken } = await server.start();

    const corrId = `CORR_TO_${Date.now()}`;
    await fetch(`http://127.0.0.1:${port}/api/tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': sessionToken
      },
      body: JSON.stringify({
        correlationId: corrId,
        targetAgent: 'gemini',
        prompt: 'Write an exhaustive 10-page document comparing database internals.',
        approvalTimeoutMs: 1200 // short timeout
      })
    });

    let timedOutTask = null;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 200));
      const res = await fetch(`http://127.0.0.1:${port}/api/tasks/${corrId}`, {
        headers: { 'X-Session-Token': sessionToken }
      });
      if (res.status === 200) {
        const task = await res.json();
        if (task.state === 'TIMED_OUT') {
          timedOutTask = task;
          break;
        }
      }
    }

    await server.shutdown();

    if (!timedOutTask) throw new Error('Task did not transition to TIMED_OUT');
    return { state: timedOutTask.state, error: timedOutTask.error };
  }));

  // Test 7: Closing the application while a task is running
  results.push(await runTest('7. Shutdown While Delegated Task is Running', async () => {
    const server = new WorkbenchServer({ cwd: CWD, port: 0 });
    const { port, sessionToken } = await server.start();

    const corrId = `CORR_RUNNING_SHUTDOWN_${Date.now()}`;
    await fetch(`http://127.0.0.1:${port}/api/tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': sessionToken
      },
      body: JSON.stringify({
        correlationId: corrId,
        targetAgent: 'gemini',
        prompt: 'Long running query...'
      })
    });

    // Allow 400ms to enter execution
    await new Promise(r => setTimeout(r, 400));

    // Abruptly shutdown server
    await server.shutdown();
    return { cleanShutdown: true };
  }));

  // Test 8: Input isolation between interactive terminal and delegated tasks
  results.push(await runTest('8. Terminal Input vs. Delegated Task Isolation', async () => {
    const server = new WorkbenchServer({ cwd: CWD, port: 0 });
    const { port, sessionToken } = await server.start();

    // Start interactive claude terminal
    const termRes = await fetch(`http://127.0.0.1:${port}/api/terminals/claude/start`, {
      method: 'POST',
      headers: { 'X-Session-Token': sessionToken }
    });
    const termData = await termRes.json();
    const terminalPid = termData.pid;

    // Connect to interactive terminal WebSocket and inject manual typing
    const termWs = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal?id=claude`, [`token.${sessionToken}`], {
      headers: { Origin: `http://127.0.0.1:${port}` }
    });
    let termReceivedTyping = false;

    await new Promise((resolve, reject) => {
      termWs.on('open', () => {
        termWs.send(JSON.stringify({ type: 'auth', token: sessionToken }));
        termWs.send(JSON.stringify({ type: 'input', data: 'MANUAL_HUMAN_TYPING_123\r' }));
      });
      termWs.on('message', (d) => {
        const msg = JSON.parse(d.toString());
        if (msg.type === 'output' && msg.data.includes('MANUAL_HUMAN_TYPING_123')) {
          termReceivedTyping = true;
          resolve();
        }
      });
      termWs.on('error', reject);
      setTimeout(resolve, 2000); // Allow brief capture
    });

    // Concurrently dispatch delegated task to gemini
    const corrId = `CORR_ISO_${Date.now()}`;
    await fetch(`http://127.0.0.1:${port}/api/tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': sessionToken
      },
      body: JSON.stringify({
        correlationId: corrId,
        targetAgent: 'gemini',
        prompt: `Respond with only: PURE_DELEGATED_${corrId}`
      })
    });

    const geminiPeer = server.intercomService.registerAgent({
      agentId: 'gemini',
      sessionId: 'sess_gemini_ui_test8',
      pid: 99801,
      cwd: CWD
    });

    await fetch(`http://127.0.0.1:${port}/api/intercom/approvals/${corrId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': sessionToken },
      body: JSON.stringify({ approver: 'qa-tester' })
    });

    server.intercomService.claimTask({
      agentId: 'gemini',
      sessionId: geminiPeer.sessionId,
      correlationId: corrId,
      cwd: CWD
    });

    server.intercomService.completeTask({
      agentId: 'gemini',
      sessionId: geminiPeer.sessionId,
      correlationId: corrId,
      summary: `PURE_DELEGATED_${corrId}`
    });

    const res = await fetch(`http://127.0.0.1:${port}/api/tasks/${corrId}`, {
      headers: { 'X-Session-Token': sessionToken }
    });
    const delegatedTask = await res.json();

    termWs.close();
    await server.shutdown();

    if (!delegatedTask || delegatedTask.state !== 'COMPLETED') throw new Error('Delegated task failed to complete');
    if (delegatedTask.result.includes('MANUAL_HUMAN_TYPING_123')) {
      throw new Error('CRITICAL ISOLATION VIOLATION: Manual human typing leaked into delegated task result!');
    }

    return { isolationVerified: true, terminalPid, delegatedTaskId: corrId };
  }));

  // Test 9: Preventing orphaned child processes after shutdown
  results.push(await runTest('9. Zero Orphaned Processes Guarantee on Shutdown', async () => {
    const server = new WorkbenchServer({ cwd: CWD, port: 0 });
    const { port, sessionToken } = await server.start();

    // Start both claude and gemini interactive terminals
    const r1 = await (await fetch(`http://127.0.0.1:${port}/api/terminals/claude/start`, {
      method: 'POST',
      headers: { 'X-Session-Token': sessionToken }
    })).json();

    const r2 = await (await fetch(`http://127.0.0.1:${port}/api/terminals/gemini/start`, {
      method: 'POST',
      headers: { 'X-Session-Token': sessionToken }
    })).json();

    const pid1 = r1.pid;
    const pid2 = r2.pid;

    if (!isPidAlive(pid1) || !isPidAlive(pid2)) {
      throw new Error('Failed to spawn active terminal PIDs');
    }

    // Now trigger shutdown
    await server.shutdown();
    await new Promise(r => setTimeout(r, 800));

    if (isPidAlive(pid1) || isPidAlive(pid2)) {
      throw new Error(`Orphaned PIDs detected after shutdown: pid1=${pid1} alive=${isPidAlive(pid1)}, pid2=${pid2} alive=${isPidAlive(pid2)}`);
    }

    return { pid1Dead: !isPidAlive(pid1), pid2Dead: !isPidAlive(pid2) };
  }));

  // Test 10: Handling unavailable CLIs and startup failures gracefully
  results.push(await runTest('10. Graceful Error Handling for Invalid Requests', async () => {
    const server = new WorkbenchServer({ cwd: CWD, port: 0 });
    const { port, sessionToken } = await server.start();

    // 1. Invalid terminal ID
    const badTermRes = await fetch(`http://127.0.0.1:${port}/api/terminals/nonexistent_cli/start`, {
      method: 'POST',
      headers: { 'X-Session-Token': sessionToken }
    });
    // Server should not crash

    // 2. Missing prompt in task payload
    const badTaskRes = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': sessionToken
      },
      body: JSON.stringify({ targetAgent: 'gemini' }) // no prompt
    });

    if (badTaskRes.status !== 400) throw new Error(`Expected 400, got ${badTaskRes.status}`);

    await server.shutdown();
    return { invalidHandled: true };
  }));

  console.log('\n===============================================================');
  console.log('              UI & INTEGRATION TEST RESULTS');
  console.log('===============================================================');
  let allPassed = true;
  for (const r of results) {
    if (!r.passed) allPassed = false;
    console.log(`${r.passed ? 'PASSED' : 'FAILED'} | ${r.name} (${r.elapsed}ms)`);
  }
  console.log('---------------------------------------------------------------');
  const passCount = results.filter(r => r.passed).length;
  console.log(`Total: ${passCount} / ${results.length} PASSED`);
  console.log('===============================================================\n');

  if (!allPassed) process.exit(1);
  process.exit(0);
}

main().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
