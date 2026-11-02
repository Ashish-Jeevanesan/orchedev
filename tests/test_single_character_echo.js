// D:\Ashish_P\AI-Tools\custom-OCT\tests\test_single_character_echo.js
// Reproduction and verification test for terminal single-character echo (double typing bug)

import { WorkbenchServer } from '../server/server.js';
import { WebSocket } from 'ws';

const CWD = 'D:\\Ashish_P\\AI-Tools\\custom-OCT';

async function testEcho() {
  console.log('[ECHO TEST] Starting server...');
  const server = new WorkbenchServer({ cwd: CWD, port: 0 });
  const { port, sessionToken } = await server.start();

  console.log(`[ECHO TEST] Server started on port ${port}`);

  // Connect exactly as browser does (subprotocol + auth message)
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal?id=claude`, [`token.${sessionToken}`]);

  let outputMessagesCount = 0;
  const receivedOutputs = [];

  await new Promise((resolve, reject) => {
    ws.on('open', () => {
      // Browser sends auth message on open
      ws.send(JSON.stringify({ type: 'auth', token: sessionToken }));
      // Allow initial banner to settle
      setTimeout(resolve, 1500);
    });
    ws.on('error', reject);
  });

  // Now listen for output when we send a unique character 'Z'
  const targetChar = 'Q';
  let charEchoCount = 0;

  ws.on('message', (d) => {
    try {
      const msg = JSON.parse(d.toString());
      if (msg.type === 'output' && msg.data) {
        receivedOutputs.push(msg.data);
        if (msg.data.includes(targetChar)) {
          charEchoCount++;
          console.log(`[ECHO TEST] Received output packet #${charEchoCount} containing '${targetChar}': ${JSON.stringify(msg.data)}`);
        }
      }
    } catch (e) {}
  });

  console.log(`[ECHO TEST] Sending single character '${targetChar}'...`);
  ws.send(JSON.stringify({ type: 'input', data: targetChar }));

  // Wait 1.5s to capture all packets
  await new Promise(r => setTimeout(r, 1500));

  ws.close();
  await server.shutdown();

  console.log(`[ECHO TEST RESULT] Character '${targetChar}' was echoed ${charEchoCount} times over WebSocket.`);

  if (charEchoCount > 1) {
    console.log('[ECHO TEST BUG CONFIRMED] Character is being duplicated over WebSocket!');
    process.exit(1);
  } else if (charEchoCount === 1) {
    console.log('[ECHO TEST PASSED] Exactly one echo packet received.');
    process.exit(0);
  } else {
    console.log('[ECHO TEST INCONCLUSIVE] Echo count was 0.');
    process.exit(2);
  }
}

testEcho().catch(err => {
  console.error('[ECHO TEST FATAL]', err);
  process.exit(1);
});
