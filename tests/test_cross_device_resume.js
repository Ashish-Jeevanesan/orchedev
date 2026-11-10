import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';
import { TranscriptMirror } from '../server/transcript_mirror.js';
import { CliSessionRegistry, claudeProjectDirName } from '../server/cli_session_registry.js';

async function run() {
  console.log('===============================================================');
  console.log('  Testing Cross-Device Session Mirroring & Restoration (Phases 3+4)');
  console.log('===============================================================\n');

  const cwd = process.cwd();
  const transcriptMirror = new TranscriptMirror({ cwd });
  const registry = new CliSessionRegistry({ cwd });

  // -------------------------------------------------------------------------
  // 1. Claude Cross-Device Mirror & Restore Simulation
  // -------------------------------------------------------------------------
  console.log('[Test 1] Claude Code transcript mirror and restore across devices...');
  const testClaudeId = 'simulated-claude-cross-device-' + Date.now();
  const claudeLocalDir = path.join(os.homedir(), '.claude', 'projects', claudeProjectDirName(cwd));
  if (!fs.existsSync(claudeLocalDir)) fs.mkdirSync(claudeLocalDir, { recursive: true });
  const claudeLocalFile = path.join(claudeLocalDir, `${testClaudeId}.jsonl`);

  const claudeContent = JSON.stringify({ type: 'user', sessionId: testClaudeId, text: 'Hello from device A' }) + '\n';
  fs.writeFileSync(claudeLocalFile, claudeContent, 'utf8');

  // Mirror from Device A
  const mirroredClaude = transcriptMirror.mirrorClaude(testClaudeId);
  assert(mirroredClaude, 'Expected Claude transcript to be mirrored successfully');

  const claudeMirrorFile = path.join(transcriptMirror.getClaudeMirrorDir(), `${testClaudeId}.jsonl`);
  assert(fs.existsSync(claudeMirrorFile), 'Mirrored Claude file exists in .workbench_cli_sessions/claude');
  assert.strictEqual(fs.readFileSync(claudeMirrorFile, 'utf8'), claudeContent, 'Mirrored content matches source');

  // Simulate Device B: delete local copy
  fs.unlinkSync(claudeLocalFile);
  assert(!fs.existsSync(claudeLocalFile), 'Simulated Device B: local transcript absent');

  // Restore on Device B
  const restoreResClaude = transcriptMirror.restoreClaude(testClaudeId);
  assert(restoreResClaude.exists, 'Expected restored Claude session to exist');
  assert(restoreResClaude.restored, 'Expected Claude session to be marked restored: true');
  assert(fs.existsSync(claudeLocalFile), 'Local transcript restored on Device B');
  assert.strictEqual(fs.readFileSync(claudeLocalFile, 'utf8'), claudeContent, 'Restored content matches mirror');
  console.log('  [PASS] Claude transcript mirrored, simulated remote loss, and cleanly restored');

  // -------------------------------------------------------------------------
  // 2. Gemini Cross-Device Mirror & Restore Simulation (with .project_root)
  // -------------------------------------------------------------------------
  console.log('\n[Test 2] Gemini CLI chat mirror and restore across devices...');
  const testGeminiId = 'simulated-gemini-cross-device-' + Date.now();
  const geminiTmp = path.join(os.homedir(), '.gemini', 'tmp');
  if (!fs.existsSync(geminiTmp)) fs.mkdirSync(geminiTmp, { recursive: true });

  // Locate or create local slug
  let testSlugDir = path.join(geminiTmp, 'orchedev-test-slug');
  if (!fs.existsSync(testSlugDir)) fs.mkdirSync(testSlugDir, { recursive: true });
  fs.writeFileSync(path.join(testSlugDir, '.project_root'), path.resolve(cwd), 'utf8');

  const testChatsDir = path.join(testSlugDir, 'chats');
  if (!fs.existsSync(testChatsDir)) fs.mkdirSync(testChatsDir, { recursive: true });

  const geminiFileName = `session-2026-11-04T12-00-${testGeminiId.slice(0, 8)}.jsonl`;
  const geminiLocalFile = path.join(testChatsDir, geminiFileName);
  const geminiContent = JSON.stringify({ sessionId: testGeminiId, projectHash: 'dummyhash', startTime: new Date().toISOString() }) + '\n' +
    JSON.stringify({ type: 'user', content: [{ text: 'Gemini task on device A' }] }) + '\n';
  fs.writeFileSync(geminiLocalFile, geminiContent, 'utf8');

  // Mirror from Device A
  const mirroredGemini = transcriptMirror.mirrorGemini(testGeminiId);
  assert(mirroredGemini, 'Expected Gemini chat to be mirrored successfully');

  const geminiMirrorFile = path.join(transcriptMirror.getGeminiMirrorDir(), geminiFileName);
  assert(fs.existsSync(geminiMirrorFile), 'Mirrored Gemini file exists in .workbench_cli_sessions/gemini');

  // Simulate Device B: delete local slug directory completely
  fs.rmSync(testSlugDir, { recursive: true, force: true });
  assert(!fs.existsSync(geminiLocalFile), 'Simulated Device B: local Gemini slug and chat absent');

  // Restore on Device B
  const restoreResGemini = transcriptMirror.restoreGemini(testGeminiId);
  assert(restoreResGemini.exists, 'Expected restored Gemini session to exist');
  assert(restoreResGemini.restored, 'Expected Gemini session to be marked restored: true');
  assert(fs.existsSync(restoreResGemini.path), 'Local Gemini chat file restored on Device B');

  // Verify that Device B's .project_root was created and matches local cwd
  const restoredSlugDir = path.dirname(path.dirname(restoreResGemini.path));
  const rootFile = path.join(restoredSlugDir, '.project_root');
  assert(fs.existsSync(rootFile), 'Expected .project_root marker to be created');
  assert.strictEqual(
    path.resolve(fs.readFileSync(rootFile, 'utf8').trim()).toLowerCase(),
    path.resolve(cwd).toLowerCase(),
    'Restored .project_root matches Device B normalized CWD'
  );
  console.log('  [PASS] Gemini chat mirrored, local slug recreated with valid .project_root, and chat restored');

  // -------------------------------------------------------------------------
  // 3. Registry Visibility
  // -------------------------------------------------------------------------
  console.log('\n[Test 3] Verifying registry lists mirrored and restored sessions...');
  const sessions = await registry.list();
  const foundClaude = sessions.find(s => s.id === testClaudeId);
  const foundGemini = sessions.find(s => s.id === testGeminiId);
  assert(foundClaude, 'Registry found restored Claude session');
  assert(foundGemini, 'Registry found restored Gemini session');
  console.log('  [PASS] Both sessions visible in registry list');

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------
  try { fs.unlinkSync(claudeLocalFile); } catch (e) {}
  try { fs.unlinkSync(claudeMirrorFile); } catch (e) {}
  try { fs.unlinkSync(restoreResGemini.path); } catch (e) {}
  try { fs.unlinkSync(geminiMirrorFile); } catch (e) {}
  try { fs.rmSync(restoredSlugDir, { recursive: true, force: true }); } catch (e) {}

  console.log('\n===============================================================');
  console.log('  ALL CROSS-DEVICE RESUME TESTS PASSED (100% GREEN)');
  console.log('===============================================================\n');
}

run().catch((err) => {
  console.error('[FATAL TEST FAILURE]', err);
  process.exit(1);
});
