// D:\Ashish_P\AI-Tools\custom-OCT\tests\repro_tab_switch_test.js
// Reproduction script for terminal tab switching / reconnect output loss

import { WorkbenchServer } from '../server/server.js';
import { WebSocket } from 'ws';

const CWD = 'D:\\Ashish_P\\AI-Tools\\custom-OCT';

async function reproduce() {
  console.log('[REPRO] Starting WorkbenchServer for Tab Switch / Reconnect Test...');
  const server = new WorkbenchServer({ cwd: CWD, port: 0 });
  const { port, sessionToken } = await server.start();

  console.log(`[REPRO] Server running on port ${port}`);

  // Step 1: Open first WebSocket connection for claude terminal
  console.log('[REPRO] Step 1: Connecting WebSocket 1 for claude terminal...');
  const ws1 = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal?id=claude`, [`token.${sessionToken}`]);
  let ws1Output = '';

  await new Promise((resolve, reject) => {
    ws1.on('open', () => {
      ws1.send(JSON.stringify({ type: 'auth', token: sessionToken }));
      ws1.send(JSON.stringify({ type: 'input', data: 'echo FIRST_CONNECTION_OK\r' }));
    });
    ws1.on('message', (d) => {
      const msg = JSON.parse(d.toString());
      if (msg.type === 'output') {
        ws1Output += msg.data;
        if (ws1Output.includes('FIRST_CONNECTION_OK')) {
          resolve();
        }
      }
    });
    ws1.on('error', reject);
    setTimeout(() => resolve(), 3000);
  });

  console.log('[REPRO] WebSocket 1 successfully received output from initial connection.');

  // Step 2: Simulate tab switch: close ws1 (or let it sit) and open ws2 for claude
  console.log('[REPRO] Step 2: Closing WebSocket 1 (simulating switching tabs / reconnecting)...');
  ws1.close();
  await new Promise(r => setTimeout(r, 500));

  console.log('[REPRO] Step 3: Connecting WebSocket 2 for claude (simulating switching back)...');
  const ws2 = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal?id=claude`, [`token.${sessionToken}`]);
  let ws2Output = '';
  let ws2ReceivedAnyData = false;

  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      console.log('[REPRO] Timeout reached for WebSocket 2 output.');
      resolve();
    }, 4000);

    ws2.on('open', () => {
      ws2.send(JSON.stringify({ type: 'auth', token: sessionToken }));
      // Send input on ws2
      setTimeout(() => {
        console.log('[REPRO] Sending input via WebSocket 2: echo SECOND_CONNECTION_PING');
        ws2.send(JSON.stringify({ type: 'input', data: 'echo SECOND_CONNECTION_PING\r' }));
      }, 500);
    });

    ws2.on('message', (d) => {
      const msg = JSON.parse(d.toString());
      if (msg.type === 'output') {
        ws2ReceivedAnyData = true;
        ws2Output += msg.data;
        if (ws2Output.includes('SECOND_CONNECTION_PING')) {
          console.log('[REPRO] WebSocket 2 received expected echo!');
          clearTimeout(timer);
          resolve();
        }
      }
    });
  });

  ws2.close();
  await server.shutdown();

  console.log('\n[REPRO RESULT]');
  console.log(`WebSocket 2 received any data: ${ws2ReceivedAnyData}`);
  console.log(`WebSocket 2 received expected echo: ${ws2Output.includes('SECOND_CONNECTION_PING')}`);

  if (!ws2ReceivedAnyData || !ws2Output.includes('SECOND_CONNECTION_PING')) {
    console.log('[REPRO CONFIRMED BUG]: Terminal output stream was completely broken upon reconnection/tab switch!');
    process.exit(1);
  } else {
    console.log('[REPRO]: Reconnection succeeded.');
    process.exit(0);
  }
}

reproduce().catch((err) => {
  console.error('[REPRO FATAL]', err);
  process.exit(1);
});
