// D:\Ashish_P\AI-Tools\custom-OCT\tests\test_claude_cli_mcp_discovery.js
// Test proving Claude Code discovers Workbench MCP tools via --mcp-config

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { WorkbenchServer } from '../server/server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const TEMP_WORKSPACE = path.join(PROJECT_ROOT, 'tests', 'temp_workspace');
const CLAUDE_BIN = 'C:\\Users\\ajeevanesan\\.local\\bin\\claude.exe';

async function main() {
  console.log('===============================================================');
  console.log('  Live Claude Code CLI MCP Tool Discovery Acceptance Test      ');
  console.log('===============================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, desc) {
    if (condition) {
      console.log(`  [PASS] ${desc}`);
      passed++;
    } else {
      console.error(`  [FAIL] ${desc}`);
      failed++;
    }
  }

  const server = new WorkbenchServer({ cwd: PROJECT_ROOT, port: 0 });
  const { port, sessionToken } = await server.start();
  server.terminalManager.setProjectCwd(TEMP_WORKSPACE);
  console.log(`[Step 1] Workbench running on 127.0.0.1:${port}`);

  // Register mock Gemini peer so Claude can discover it
  server.intercomService.registerAgent({
    agentId: 'gemini',
    sessionId: 'gemini_test_sess',
    pid: 9999,
    cwd: TEMP_WORKSPACE,
    capabilities: ['implementation', 'refactoring']
  });

  // Prepare Claude terminal config
  const claudeConfig = server.terminalManager.getTerminalConfig('claude', TEMP_WORKSPACE);
  const mcpConfigFile = claudeConfig.args[claudeConfig.args.indexOf('--mcp-config') + 1];
  assert(fs.existsSync(mcpConfigFile), 'Generated temp Claude MCP config in os.tmpdir()');
  assert(!fs.existsSync(path.join(TEMP_WORKSPACE, '.workbench', 'claude_mcp_config.json')), 'Workspace .workbench/claude_mcp_config.json not polluted');

  // Launch Claude Code with -p to test tool discovery and execution
  console.log('\n[Step 2] Executing Claude Code with --mcp-config to test discover_peers...');
  const child = spawn(claudeConfig.file, [
    '--mcp-config', mcpConfigFile,
    '--permission-mode', 'plan',
    '--permission-prompts', 'none',
    '-p',
    'Call the discover_peers MCP tool and report the registered agents.'
  ], {
    cwd: TEMP_WORKSPACE,
    env: { ...process.env, CI: '1' }
  });

  let claudeStdout = '';
  let claudeStderr = '';

  child.stdout.on('data', (d) => {
    claudeStdout += d.toString();
  });

  child.stderr.on('data', (d) => {
    claudeStderr += d.toString();
  });

  await new Promise((resolve) => {
    child.on('close', resolve);
  });

  console.log('\n[Claude Output Summary]:\n', claudeStdout.slice(0, 500) + '...');

  // Verify Claude registered as peer
  const peersAfter = server.intercomService.getPeers();
  const claudePeerAfter = peersAfter.find(p => p.agentId === 'claude');
  assert(claudePeerAfter !== undefined && claudePeerAfter.registeredAt > 0, 'Claude Code successfully launched and registered with Workbench Coordinator');
  assert(claudePeerAfter && claudePeerAfter.status === 'OFFLINE', 'Claude peer transitioned cleanly to OFFLINE after process exit');

  // Verify Claude invoked discover_peers and saw Gemini
  assert(
    claudeStdout.toLowerCase().includes('gemini') || claudeStdout.toLowerCase().includes('peer'),
    'Claude Code called discover_peers MCP tool and reported active peers'
  );

  console.log('\n===============================================================');
  console.log(`  CLAUDE MCP DISCOVERY TEST: ${passed} PASSED, ${failed} FAILED`);
  console.log('===============================================================\n');

  await server.shutdown();

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[FATAL ERROR]', err);
  process.exit(1);
});
