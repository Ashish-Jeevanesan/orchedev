import assert from 'assert';
import { CliSessionRegistry } from '../server/cli_session_registry.js';
import { WorkbenchServer } from '../server/server.js';
import { SessionPairings } from '../server/session_pairings.js';

async function run() {
  console.log('Testing CliSessionRegistry & Session Persistence...');
  const cwd = process.cwd();
  const registry = new CliSessionRegistry({ cwd });

  const t0 = Date.now();
  const sessions = await registry.list();
  const elapsed = Date.now() - t0;

  console.log(`Retrieved ${sessions.length} sessions in ${elapsed}ms`);
  assert(elapsed < 1000, `Expected registry listing to complete in under 1000ms, took ${elapsed}ms`);

  for (const s of sessions) {
    assert(s.id, 'Session must have an id');
    assert(s.agent === 'claude' || s.agent === 'gemini', 'Session agent must be claude or gemini');
    assert(s.title, 'Session must have a title');
    assert(s.lastActiveAt, 'Session must have lastActiveAt ISO timestamp');
  }

  // Verify WorkbenchServer merged session list does not drop standalone sessions
  const server = new WorkbenchServer({ cwd, port: 0 });
  const merged = await server._buildMergedSessionList();
  console.log(`Merged sessions count: ${merged.length}`);
  assert(Array.isArray(merged), 'Merged sessions must be an array');
  assert(merged.length >= sessions.length, 'Merged list must retain all valid sessions');

  // Verify that any session from disk appears in merged
  for (const s of sessions) {
    const found = merged.some((m) => m.geminiSessionId === s.id || m.claudeSessionId === s.id);
    assert(found, `Session ${s.id} (${s.agent}) must be present in merged session list`);
  }

  console.log('PASS: All CliSessionRegistry & Session Persistence tests passed successfully!');
}

run().catch((err) => {
  console.error('FAIL:', err);
  process.exit(1);
});
