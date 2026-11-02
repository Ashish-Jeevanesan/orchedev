// D:\Ashish_P\AI-Tools\custom-OCT\test_gemini_acp.js
// Verification test for Authenticated Gemini ACP

import { spawn } from 'child_process';
import readline from 'readline';
import fs from 'fs';
import path from 'path';

const GEMINI_BUNDLE_PATH = 'C:\\Users\\ajeevanesan\\AppData\\Local\\nvm\\v22.23.1\\node_modules\\@google\\gemini-cli\\bundle\\gemini.js';
const CWD = 'D:\\Ashish_P\\AI-Tools\\custom-OCT';
const RANDOM_ID = `TEST-${Math.random().toString(36).substring(2, 9).toUpperCase()}`;
const EXPECTED_MARKER = `GEMINI-ACP-ROUNDTRIP-${RANDOM_ID}`;

const logData = {
  startTime: new Date().toISOString(),
  randomId: RANDOM_ID,
  expectedMarker: EXPECTED_MARKER,
  steps: [],
  notifications: [],
  stdoutLines: [],
  stderrLines: [],
  roundTripMarkerFound: false,
  elapsedMs: 0,
  exitCode: null,
  cleanExit: false,
  error: null
};

const startTime = Date.now();

console.log(`[START] Testing Authenticated Gemini ACP with marker: ${EXPECTED_MARKER}`);

const child = spawn(process.execPath, [GEMINI_BUNDLE_PATH, '--acp'], {
  cwd: CWD,
  env: process.env, // Preserve existing user profile and environment
  stdio: ['pipe', 'pipe', 'pipe']
});

const rlStdout = readline.createInterface({ input: child.stdout, terminal: false });
const rlStderr = readline.createInterface({ input: child.stderr, terminal: false });

rlStderr.on('line', (line) => {
  logData.stderrLines.push(line);
  console.log(`[STDERR] ${line}`);
});

const pendingRequests = new Map();

function sendRpc(method, params, id) {
  const req = {
    jsonrpc: '2.0',
    id,
    method,
    params
  };
  const jsonStr = JSON.stringify(req);
  console.log(`[SEND id=${id}] method=${method}`);
  child.stdin.write(jsonStr + '\n');
  return new Promise((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject, method, req });
  });
}

rlStdout.on('line', (line) => {
  logData.stdoutLines.push(line);
  if (!line.trim()) return;

  try {
    const parsed = JSON.parse(line);
    if (parsed.id !== undefined && pendingRequests.has(parsed.id)) {
      const { resolve, reject, method } = pendingRequests.get(parsed.id);
      pendingRequests.delete(parsed.id);
      logData.steps.push({
        id: parsed.id,
        method,
        response: parsed
      });
      if (parsed.error) {
        console.error(`[RPC ERROR id=${parsed.id}]`, JSON.stringify(parsed.error));
        reject(parsed.error);
      } else {
        console.log(`[RPC OK id=${parsed.id}] received response for ${method}`);
        resolve(parsed.result);
      }
    } else if (parsed.method) {
      // Notification
      logData.notifications.push(parsed);
      if (parsed.method === 'session/update') {
        const update = parsed.params?.update;
        if (update?.sessionUpdate === 'agent_message_chunk') {
          const chunkText = update?.content?.text || '';
          if (chunkText.includes(EXPECTED_MARKER)) {
            logData.roundTripMarkerFound = true;
          }
          process.stdout.write(chunkText);
        }
      }
    }
  } catch (err) {
    console.log(`[RAW STDOUT] ${line}`);
  }
});

async function run() {
  const timeoutTimer = setTimeout(() => {
    console.error('[TIMEOUT] 45s reached without completing run');
    logData.error = 'Timeout (45s)';
    child.kill('SIGTERM');
  }, 45000);

  try {
    // Step 1: initialize
    console.log('[STEP 1] Sending initialize...');
    const initResult = await sendRpc('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false
      },
      clientInfo: {
        name: 'custom-oct-investigation',
        version: '1.0.0'
      }
    }, 1);

    console.log('[STEP 1 RESULT] Protocol Version:', initResult.protocolVersion);
    console.log('[STEP 1 RESULT] Agent Info:', JSON.stringify(initResult.agentInfo));
    console.log('[STEP 1 RESULT] Auth Methods:', initResult.authMethods?.map(m => m.id));

    // Step 2: session/new
    console.log('\n[STEP 2] Sending session/new...');
    const sessionResult = await sendRpc('session/new', {
      cwd: CWD,
      mcpServers: []
    }, 2);

    const sessionId = sessionResult?.sessionId;
    console.log('[STEP 2 RESULT] Session ID:', sessionId);
    console.log('[STEP 2 RESULT] Current Mode:', sessionResult?.modes?.currentModeId);
    console.log('[STEP 2 RESULT] Current Model:', sessionResult?.models?.currentModelId);

    if (!sessionId) {
      throw new Error('No sessionId returned from session/new');
    }

    // Step 3: session/prompt
    console.log(`\n[STEP 3] Sending session/prompt requesting marker ${EXPECTED_MARKER}...`);
    const promptResult = await sendRpc('session/prompt', {
      sessionId,
      prompt: [
        {
          type: 'text',
          text: `Respond with only the single token: ${EXPECTED_MARKER}`
        }
      ]
    }, 3);

    console.log('\n[STEP 3 RESULT] Prompt completed:', JSON.stringify(promptResult));

    clearTimeout(timeoutTimer);

    // Graceful close
    console.log('\n[CLEANUP] Closing child stdin and waiting for exit...');
    child.stdin.end();
  } catch (err) {
    clearTimeout(timeoutTimer);
    logData.error = err?.message || String(err);
    console.error('[FAILED]', err);
    child.kill('SIGTERM');
  }
}

child.on('close', (code, signal) => {
  logData.elapsedMs = Date.now() - startTime;
  logData.exitCode = code;
  logData.signal = signal;
  logData.cleanExit = (code === 0);
  console.log(`\n[EXIT] Process exited with code=${code}, signal=${signal}, elapsed=${logData.elapsedMs}ms`);

  // Write sanitized results
  fs.writeFileSync(
    path.join(CWD, 'gemini_acp_result.json'),
    JSON.stringify(logData, null, 2),
    'utf-8'
  );
  console.log('[DONE] Results saved to D:\\Ashish_P\\AI-Tools\\custom-OCT\\gemini_acp_result.json');
});

run();
