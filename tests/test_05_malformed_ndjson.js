// D:\Ashish_P\AI-Tools\custom-OCT\tests\test_05_malformed_ndjson.js
// Reliability Test 5: Malformed or incomplete NDJSON output handling

import { GeminiAcpClient } from '../core/gemini_acp_client.js';

const CWD = 'D:\\Ashish_P\\AI-Tools\\custom-OCT';

async function run() {
  console.log('[TEST 5] Running: Malformed or incomplete NDJSON output resilience');
  const report = { name: 'test_05_malformed_ndjson', passed: false, checks: [] };

  const client = new GeminiAcpClient({ cwd: CWD, debug: false });

  // Simulate pending request registration
  const reqId = 999;
  let rpcResolved = false;
  let rpcResult = null;

  client.pendingRequests.set(reqId, {
    resolve: (res) => {
      rpcResolved = true;
      rpcResult = res;
    },
    reject: (err) => {},
    method: 'test_method',
    timeoutId: null
  });

  const testLines = [
    '', // empty line
    '   ', // whitespace line
    '{"truncated": true', // incomplete JSON
    '[DEBUG] Server log message leaking to stdout', // raw text
    '\x1b[31mANSI Color Escape Sequence\x1b[0m', // ANSI garbage
    '{"jsonrpc": "2.0", "id": 999, "result": {"status": "SUCCESS_AFTER_GARBAGE"}}' // valid response
  ];

  let unhandledExceptionOccurred = false;

  try {
    for (const line of testLines) {
      client._handleStdoutLine(line);
    }

    report.checks.push({
      check: 'No exception thrown processing malformed lines',
      passed: true
    });

    report.checks.push({
      check: 'Valid message following malformed lines parsed successfully',
      passed: rpcResolved && rpcResult?.status === 'SUCCESS_AFTER_GARBAGE',
      result: rpcResult
    });

    report.passed = rpcResolved && rpcResult?.status === 'SUCCESS_AFTER_GARBAGE';
    console.log(`[TEST 5] Result: ${report.passed ? 'PASSED' : 'FAILED'}`);
  } catch (e) {
    unhandledExceptionOccurred = true;
    console.error('[TEST 5] Exception:', e);
    report.passed = false;
  }

  return report;
}

run().then((res) => {
  if (!res.passed) process.exit(1);
});
