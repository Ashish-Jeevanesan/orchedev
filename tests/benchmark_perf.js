// D:\Ashish_P\AI-Tools\custom-OCT\tests\benchmark_perf.js
// Performance & Latency Benchmark for Agent Workbench

import { WorkbenchServer } from '../server/server.js';
import { WebSocket } from 'ws';

const CWD = 'D:\\Ashish_P\\AI-Tools\\custom-OCT';

async function benchmark() {
  console.log('===============================================================');
  console.log('  Agent Workbench Performance & Resource Benchmark');
  console.log('===============================================================\n');

  // 1. Cold Startup Measurement
  const t0 = performance.now();
  const server = new WorkbenchServer({ cwd: CWD, port: 0 });
  const { port, sessionToken } = await server.start();
  const coldStartupMs = (performance.now() - t0).toFixed(2);
  console.log(`[1] Cold Application Startup:      ${coldStartupMs} ms`);

  // 2. Idle Memory & Process Footprint
  const mem = process.memoryUsage();
  const rssMB = (mem.rss / (1024 * 1024)).toFixed(2);
  const heapMB = (mem.heapUsed / (1024 * 1024)).toFixed(2);
  console.log(`[2] Idle Node Process Footprint:   RSS = ${rssMB} MB, HeapUsed = ${heapMB} MB`);

  // 3. Time for UI to reflect task state change (WebSocket event propagation latency)
  const wsEvents = new WebSocket(`ws://127.0.0.1:${port}/ws/events`, [`token.${sessionToken}`]);
  await new Promise(r => wsEvents.on('open', r));
  wsEvents.send(JSON.stringify({ type: 'auth', token: sessionToken }));

  const corrId = `BENCH_CORR_${Date.now()}`;
  let sentTimestamp = 0;
  let eventReceivedLatencyMs = 0;

  const eventPromise = new Promise((resolve) => {
    wsEvents.on('message', (d) => {
      const msg = JSON.parse(d.toString());
      if (msg.type === 'task_event' && msg.payload.eventType === 'TASK_SENT') {
        eventReceivedLatencyMs = (performance.now() - sentTimestamp).toFixed(2);
        resolve();
      }
    });
  });

  sentTimestamp = performance.now();
  await fetch(`http://127.0.0.1:${port}/api/tasks`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Session-Token': sessionToken
    },
    body: JSON.stringify({
      correlationId: corrId,
      targetAgent: 'gemini',
      prompt: `Echo: BENCH_${corrId}`
    })
  });

  await eventPromise;
  console.log(`[3] Task State Change UI Latency:  ${eventReceivedLatencyMs} ms`);

  // 4. Terminal Input Responsiveness while task is executing in background
  const wsTerm = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal?id=claude`, [`token.${sessionToken}`]);
  await new Promise(r => wsTerm.on('open', r));
  wsTerm.send(JSON.stringify({ type: 'auth', token: sessionToken }));

  // Wait 1.5s for initial terminal render banner to settle
  await new Promise(r => setTimeout(r, 1500));

  const keySendTime = performance.now();
  let termEchoLatencyMs = 0;

  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      termEchoLatencyMs = (performance.now() - keySendTime).toFixed(2);
      resolve();
    }, 3000);

    wsTerm.on('message', (d) => {
      const msg = JSON.parse(d.toString());
      if (msg.type === 'output') {
        clearTimeout(timer);
        termEchoLatencyMs = (performance.now() - keySendTime).toFixed(2);
        resolve();
      }
    });
    // Send standard Enter key
    wsTerm.send(JSON.stringify({ type: 'input', data: '\r' }));
  });

  console.log(`[4] Terminal Keystroke Latency:    ${termEchoLatencyMs} ms (while task is active)`);

  wsEvents.close();
  wsTerm.close();

  // 5. Shutdown and Process Cleanup Duration
  const tShut = performance.now();
  await server.shutdown();
  const shutdownMs = (performance.now() - tShut).toFixed(2);
  console.log(`[5] Shutdown & Cleanup Duration:   ${shutdownMs} ms`);

  console.log('\n===============================================================');
  console.log('  Benchmark complete.');
  console.log('===============================================================\n');

  process.exit(0);
}

benchmark().catch(err => {
  console.error('[Benchmark Error]', err);
  process.exit(1);
});
