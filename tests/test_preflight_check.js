import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';
import { TranscriptMirror, isFileDehydrated } from '../server/transcript_mirror.js';
import { claudeProjectDirName } from '../server/cli_session_registry.js';
import { WorkbenchServer } from '../server/server.js';

async function run() {
  console.log('===============================================================');
  console.log('  Testing Pre-Flight Check & Hydration Detection (Phase 6)');
  console.log('===============================================================\n');

  const cwd = process.cwd();
  const mirror = new TranscriptMirror({ cwd });

  // 1. Missing session test
  console.log('[Test 1] Preflight for nonexistent session returns MISSING...');
  const resMissing = await mirror.checkPreflight({
    sessionId: 'nonexistent-session-' + Date.now(),
    agent: 'claude'
  });
  assert.strictEqual(resMissing.status, 'MISSING', 'Expected status to be MISSING');
  assert.strictEqual(resMissing.canResume, false, 'Expected canResume to be false');
  assert(resMissing.message.includes('not synced'), 'Expected informative failure message');
  console.log('  [PASS] Nonexistent session correctly returned MISSING');

  // 2. Ready session test (mirrored or local)
  console.log('\n[Test 2] Preflight for fully available local session returns READY...');
  const testId = 'preflight-test-session-' + Date.now();
  const localClaudeDir = path.join(os.homedir(), '.claude', 'projects', claudeProjectDirName(cwd));
  if (!fs.existsSync(localClaudeDir)) fs.mkdirSync(localClaudeDir, { recursive: true });
  const localClaudeFile = path.join(localClaudeDir, `${testId}.jsonl`);
  fs.writeFileSync(localClaudeFile, JSON.stringify({ type: 'user', sessionId: testId, text: 'Hello' }) + '\n', 'utf8');

  try {
    const resReady = await mirror.checkPreflight({
      sessionId: testId,
      agent: 'claude'
    });
    assert.strictEqual(resReady.status, 'READY', 'Expected status to be READY');
    assert.strictEqual(resReady.canResume, true, 'Expected canResume to be true');
    assert.strictEqual(resReady.unhydratedFiles.length, 0, 'No unhydrated files');
    console.log('  [PASS] Local session verified READY with canResume: true');

    // 3. Dehydration attribute detection unit test
    console.log('\n[Test 3] Attribute detection for local file...');
    const dehydrated = isFileDehydrated(localClaudeFile);
    assert.strictEqual(dehydrated, false, 'Local freshly written file is hydrated (not offline)');
    console.log('  [PASS] File dehydration attribute checked without blocking');

    // 4. REST endpoint test via WorkbenchServer
    console.log('\n[Test 4] REST API POST /api/sessions/preflight verification...');
    const server = new WorkbenchServer({ cwd });
    const { port, sessionToken } = await server.start();

    // Call preflight endpoint with fetch
    const response = await fetch(`http://127.0.0.1:${port}/api/sessions/preflight`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': sessionToken
      },
      body: JSON.stringify({ sessionId: testId, agent: 'claude' })
    });

    assert.strictEqual(response.status, 200, 'HTTP status 200');
    const data = await response.json();
    assert.strictEqual(data.status, 'READY', 'Preflight API returned READY');
    assert.strictEqual(data.canResume, true, 'canResume is true');

    await server.shutdown();
    console.log('  [PASS] REST API endpoint /api/sessions/preflight responded accurately');
  } finally {
    try { fs.unlinkSync(localClaudeFile); } catch (e) {}
  }

  console.log('\n===============================================================');
  console.log('  PHASE 6 PRE-FLIGHT TESTS PASSED (100% GREEN)');
  console.log('===============================================================\n');
}

run().catch((err) => {
  console.error('[FATAL PREFLIGHT TEST FAILURE]', err);
  process.exit(1);
});
