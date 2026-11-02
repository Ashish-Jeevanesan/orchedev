// D:\Ashish_P\AI-Tools\custom-OCT\tests\smoke_conpty_test.js
// ConPTY Smoke Test for Windows Node 22

import pty from '@homebridge/node-pty-prebuilt-multiarch';

async function runSmokeTest() {
  console.log('[SMOKE TEST] Testing ConPTY dependency on Windows Node 22...');

  const marker = `CONPTY_VERIFIED_${Date.now()}`;
  let outputReceived = '';
  let markerFound = false;
  let exitEventFired = false;
  let resizeSucceeded = false;

  return new Promise((resolve, reject) => {
    let ptyProcess;
    try {
      ptyProcess = pty.spawn('cmd.exe', [], {
        name: 'xterm-color',
        cols: 80,
        rows: 24,
        cwd: process.cwd(),
        env: process.env
      });
      console.log(`[SMOKE TEST] Spawned ConPTY PID: ${ptyProcess.pid}`);
    } catch (spawnErr) {
      console.error('[SMOKE TEST] Spawn failed:', spawnErr);
      return reject(spawnErr);
    }

    const timeout = setTimeout(() => {
      console.error('[SMOKE TEST] Timeout after 8s');
      try { ptyProcess.kill(); } catch (e) {}
      reject(new Error('ConPTY smoke test timed out'));
    }, 8000);

    ptyProcess.onData((data) => {
      outputReceived += data;
      if (!markerFound && (data.includes(marker) || outputReceived.includes(marker))) {
        markerFound = true;
        console.log('[SMOKE TEST] Expected marker successfully observed in ConPTY output!');

        // Test resize
        try {
          ptyProcess.resize(120, 35);
          resizeSucceeded = true;
          console.log('[SMOKE TEST] Resize to 120x35 succeeded without error.');
        } catch (resizeErr) {
          console.error('[SMOKE TEST] Resize failed:', resizeErr);
        }

        // Test termination
        console.log('[SMOKE TEST] Sending exit to ConPTY...');
        ptyProcess.write('exit\r');
      }
    });

    ptyProcess.onExit(({ exitCode, signal }) => {
      clearTimeout(timeout);
      exitEventFired = true;
      console.log(`[SMOKE TEST] ConPTY exited with code=${exitCode}, signal=${signal}`);

      const passed = markerFound && resizeSucceeded && exitEventFired;
      console.log(`[SMOKE TEST] OVERALL STATUS: ${passed ? 'PASSED' : 'FAILED'}`);
      resolve({ passed, markerFound, resizeSucceeded, exitEventFired, exitCode });
    });

    // Write input after a brief delay for prompt ready
    setTimeout(() => {
      console.log(`[SMOKE TEST] Writing command to ConPTY with marker ${marker}...`);
      ptyProcess.write(`echo ${marker}\r`);
    }, 400);
  });
}

runSmokeTest()
  .then((res) => {
    if (!res.passed) process.exit(1);
    process.exit(0);
  })
  .catch((err) => {
    console.error('[SMOKE TEST FATAL]', err);
    process.exit(1);
  });
