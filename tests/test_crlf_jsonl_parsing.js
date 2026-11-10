import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';
import { CliSessionRegistry } from '../server/cli_session_registry.js';

async function run() {
  console.log('===============================================================');
  console.log('  Testing CRLF (\\r\\n) JSONL Parsing Compatibility (Phase 7)');
  console.log('===============================================================\n');

  // Test 1: Native ECMA-262 JSON.parse tolerance for trailing \r
  console.log('[Test 1] Testing native JSON.parse tolerance for trailing \\r...');
  const testPayload = { id: 'test-crlf-1', message: 'Hello Windows & Mac', count: 42 };
  const rawWithCr = JSON.stringify(testPayload) + '\r';
  
  let parsedDirect;
  assert.doesNotThrow(() => {
    parsedDirect = JSON.parse(rawWithCr);
  }, 'JSON.parse must tolerate trailing \\r as valid whitespace');
  assert.strictEqual(parsedDirect.id, 'test-crlf-1');
  assert.strictEqual(parsedDirect.count, 42);
  console.log('  [PASS] JSON.parse parses strings with trailing \\r per JSON spec whitespace rules');

  // Test 2: Claude-format JSONL with \\r\\n line terminators
  console.log('\n[Test 2] Simulating Claude Code transcript parsing with CRLF...');
  const tempDir = path.join(os.tmpdir(), `crlf_test_${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  const claudeTranscriptPath = path.join(tempDir, 'claude-crlf-session.jsonl');
  const claudeLines = [
    JSON.stringify({ type: 'user', message: { content: '<session_context>Ignored header</session_context>' } }),
    JSON.stringify({ type: 'user', message: { content: 'Implement cross-device sync for OrcheDev' } }),
    JSON.stringify({ type: 'assistant', message: { content: 'I am on it.' } })
  ];
  // Join with CRLF
  fs.writeFileSync(claudeTranscriptPath, claudeLines.join('\r\n') + '\r\n', 'utf8');

  // Parse lines via split('\n') as done in CliSessionRegistry
  const rawClaude = fs.readFileSync(claudeTranscriptPath, 'utf8');
  const splitClaudeLines = rawClaude.split('\n').filter(Boolean);
  assert.strictEqual(splitClaudeLines.length, 3, 'Expected 3 lines');
  
  for (const line of splitClaudeLines) {
    assert(line.endsWith('\r'), 'Line should retain \\r when split on \\n');
    assert.doesNotThrow(() => {
      const obj = JSON.parse(line);
      assert(obj.type, 'Object must parse correctly despite \\r');
    });
  }
  console.log('  [PASS] Claude JSONL records with \\r\\n parse cleanly with split(\\n)');

  // Test 3: Gemini-format JSONL with \\r\\n line terminators
  console.log('\n[Test 3] Simulating Gemini CLI chat parsing with CRLF...');
  const geminiChatPath = path.join(tempDir, 'session-2026-11-05T00-00-geminicrlf.jsonl');
  const geminiLines = [
    JSON.stringify({ sessionId: 'gemini-crlf-session-id', startTime: '2026-11-05T00:00:00.000Z' }),
    JSON.stringify({ type: 'user', content: [{ text: '<session_context>Skip</session_context>' }] }),
    JSON.stringify({ type: 'user', content: [{ text: 'Add macOS support to launcher' }] }),
    JSON.stringify({ type: 'gemini', content: 'Understood.' })
  ];
  fs.writeFileSync(geminiChatPath, geminiLines.join('\r\n') + '\r\n', 'utf8');

  const rawGemini = fs.readFileSync(geminiChatPath, 'utf8');
  const splitGeminiLines = rawGemini.split('\n').filter(Boolean);
  assert.strictEqual(splitGeminiLines.length, 4, 'Expected 4 lines');

  for (const line of splitGeminiLines) {
    assert(line.endsWith('\r'), 'Line should retain \\r when split on \\n');
    assert.doesNotThrow(() => {
      const obj = JSON.parse(line);
      assert(obj.sessionId || obj.type, 'Gemini object parsed correctly');
    });
  }
  console.log('  [PASS] Gemini JSONL records with \\r\\n parse cleanly with split(\\n)');

  // Clean up
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch (e) {}

  console.log('\n===============================================================');
  console.log('  ALL CRLF JSONL PARSING TESTS PASSED (100% GREEN)');
  console.log('===============================================================\n');
}

run().catch((err) => {
  console.error('[FATAL CRLF TEST FAILURE]', err);
  process.exit(1);
});
