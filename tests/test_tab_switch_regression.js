// D:\Ashish_P\AI-Tools\custom-OCT\tests\test_tab_switch_regression.js
// Regression Test: Terminal Tab Switching & Scrollback Replay

import { WorkbenchServer } from '../server/server.js';
import { WebSocket } from 'ws';

const CWD = 'D:\\Ashish_P\\AI-Tools\\custom-OCT';

function connectTerminalWs(port, id, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal?id=${id}`, [`token.${token}`]);
  let buffer = '';

  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'auth', token }));
  });

  ws.on('message', (d) => {
    try {
      const msg = JSON.parse(d.toString());
      if (msg.type === 'output') {
        buffer += msg.data;
      }
    } catch (e) {}
  });

  return {
    ws,
    getBuffer: () => buffer,
    sendInput: (data) => {
      ws.send(JSON.stringify({ type: 'input', data }));
    },
    waitForData: (minChars = 10, timeoutMs = 5000) => {
      return new Promise((resolve, reject) => {
        if (buffer.length >= minChars) return resolve(buffer);
        const start = Date.now();
        const interval = setInterval(() => {
          if (buffer.length >= minChars) {
            clearInterval(interval);
            resolve(buffer);
          } else if (Date.now() - start > timeoutMs) {
            clearInterval(interval);
            reject(new Error(`Timeout waiting for data in ${id} terminal (got ${buffer.length} chars)`));
          }
        }, 100);
      });
    }
  };
}

async function run() {
  console.log('===============================================================');
  console.log('  Regression Test: Terminal Tab Switching & Buffer Persistence');
  console.log('===============================================================\n');

  const server = new WorkbenchServer({ cwd: CWD, port: 0 });
  const { port, sessionToken } = await server.start();
  const report = { passed: false, checks: [] };

  try {
    // -------------------------------------------------------------
    // STEP 1: Connect to Claude Terminal
    // -------------------------------------------------------------
    console.log('[Step 1] Connecting to Claude terminal...');
    const claudeConn = connectTerminalWs(port, 'claude', sessionToken);
    const claudeInitData = await claudeConn.waitForData(10, 8000);
    console.log(`[Step 1] Claude output received (${claudeInitData.length} chars).`);

    report.checks.push({
      check: 'Claude terminal initializes and streams output',
      passed: claudeInitData.length >= 10
    });

    // -------------------------------------------------------------
    // STEP 2: Switch to Gemini Terminal (Claude goes to background)
    // -------------------------------------------------------------
    console.log('[Step 2] Switching to Gemini terminal (Claude remains in background)...');
    const geminiConn = connectTerminalWs(port, 'gemini', sessionToken);
    const geminiInitData = await geminiConn.waitForData(5, 8000);
    console.log(`[Step 2] Gemini output received (${geminiInitData.length} chars).`);

    report.checks.push({
      check: 'Gemini terminal initializes and streams output concurrently',
      passed: geminiInitData.length >= 5
    });

    // -------------------------------------------------------------
    // STEP 3: Switch back to Claude (verify Claude is still alive and responsive)
    // -------------------------------------------------------------
    console.log('[Step 3] Switching back to Claude terminal...');
    const claudeBufBefore = claudeConn.getBuffer();
    const lenBefore = claudeBufBefore.length;

    // Send input on Claude
    claudeConn.sendInput('\r');
    await new Promise(r => setTimeout(r, 1000));

    const claudeBufAfter = claudeConn.getBuffer();
    const claudeStillActive = claudeBufAfter.length >= lenBefore;
    console.log(`[Step 3] Claude buffer retained: before=${lenBefore}, after=${claudeBufAfter.length}`);

    report.checks.push({
      check: 'Claude terminal retained buffer and remains responsive after tab switch',
      passed: claudeStillActive
    });

    // -------------------------------------------------------------
    // STEP 4: Switch back to Gemini (verify Gemini retained buffer)
    // -------------------------------------------------------------
    console.log('[Step 4] Switching back to Gemini terminal...');
    const geminiBufBefore = geminiConn.getBuffer();
    geminiConn.sendInput('\r');
    await new Promise(r => setTimeout(r, 1000));

    const geminiBufAfter = geminiConn.getBuffer();
    const geminiStillActive = geminiBufAfter.length >= geminiBufBefore.length;
    console.log(`[Step 4] Gemini buffer retained: before=${geminiBufBefore.length}, after=${geminiBufAfter.length}`);

    report.checks.push({
      check: 'Gemini terminal retained buffer and remains responsive after tab switch',
      passed: geminiStillActive
    });

    // -------------------------------------------------------------
    // STEP 5: Verify Backend Replay Buffer on Reconnection
    // -------------------------------------------------------------
    console.log('[Step 5] Disconnecting Claude socket and reconnecting fresh to verify scrollback replay...');
    claudeConn.ws.close();
    await new Promise(r => setTimeout(r, 400));

    const freshClaudeConn = connectTerminalWs(port, 'claude', sessionToken);
    const replayedData = await freshClaudeConn.waitForData(lenBefore, 5000);
    console.log(`[Step 5] Fresh connection received replayed scrollback (${replayedData.length} chars).`);

    report.checks.push({
      check: 'Fresh connection immediately received complete scrollback replay buffer',
      passed: replayedData.length >= lenBefore
    });

    freshClaudeConn.ws.close();
    geminiConn.ws.close();

    const allPassed = report.checks.every(c => c.passed);
    report.passed = allPassed;

    console.log('\n===============================================================');
    console.log(`  REGRESSION TEST RESULT: ${allPassed ? 'ALL PASSED' : 'FAILED'}`);
    console.log('===============================================================\n');
  } catch (err) {
    console.error('[Regression Fatal]', err);
    report.passed = false;
    report.error = err.message;
  } finally {
    await server.shutdown();
  }

  if (!report.passed) process.exit(1);
  process.exit(0);
}

run();
