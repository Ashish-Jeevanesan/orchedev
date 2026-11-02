// D:\Ashish_P\AI-Tools\custom-OCT\test_claude_stream.js
// Verification test for Authenticated Claude structured output

import { spawn } from 'child_process';
import readline from 'readline';
import fs from 'fs';
import path from 'path';

const CLAUDE_BIN = 'C:\\Users\\ajeevanesan\\.local\\bin\\claude.exe';
const CWD = 'D:\\Ashish_P\\AI-Tools\\custom-OCT';
const RANDOM_ID = `TEST-${Math.random().toString(36).substring(2, 9).toUpperCase()}`;
const EXPECTED_MARKER = `CLAUDE-ROUNDTRIP-${RANDOM_ID}`;

const logData = {
  startTime: new Date().toISOString(),
  randomId: RANDOM_ID,
  expectedMarker: EXPECTED_MARKER,
  events: [],
  resultEvent: null,
  stdoutLines: [],
  stderrLines: [],
  roundTripMarkerFound: false,
  elapsedMs: 0,
  exitCode: null,
  signal: null,
  cleanExit: false,
  error: null
};

const startTime = Date.now();

console.log(`[START] Testing Authenticated Claude Structured Output with marker: ${EXPECTED_MARKER}`);

const prompt = `Please respond with ONLY the exact string: ${EXPECTED_MARKER}`;

// Safe, plan-only permissions, non-interactive print mode with stream-json output
const args = [
  '--print',
  '--verbose',
  '--permission-mode', 'plan',
  '--permission-prompts', 'none',
  '--output-format', 'stream-json',
  prompt
];

console.log(`[SPAWN] ${CLAUDE_BIN} ${args.join(' ')}`);

const child = spawn(CLAUDE_BIN, args, {
  cwd: CWD,
  env: process.env, // Normal existing Claude sign-in
  stdio: ['ignore', 'pipe', 'pipe']
});

const rlStdout = readline.createInterface({ input: child.stdout, terminal: false });
const rlStderr = readline.createInterface({ input: child.stderr, terminal: false });

rlStderr.on('line', (line) => {
  logData.stderrLines.push(line);
  console.log(`[STDERR] ${line}`);
});

rlStdout.on('line', (line) => {
  logData.stdoutLines.push(line);
  if (!line.trim()) return;

  try {
    const event = JSON.parse(line);
    logData.events.push(event);
    console.log(`[EVENT type=${event.type}]`);

    if (event.type === 'result') {
      logData.resultEvent = event;
      console.log('[RESULT EVENT]', JSON.stringify(event));
      if (JSON.stringify(event).includes(EXPECTED_MARKER)) {
        logData.roundTripMarkerFound = true;
      }
    } else if (event.type === 'assistant' || event.type === 'message') {
      const text = JSON.stringify(event);
      if (text.includes(EXPECTED_MARKER)) {
        logData.roundTripMarkerFound = true;
      }
    }
  } catch (err) {
    console.log(`[RAW STDOUT] ${line}`);
    if (line.includes(EXPECTED_MARKER)) {
      logData.roundTripMarkerFound = true;
    }
  }
});

const timeoutTimer = setTimeout(() => {
  console.error('[TIMEOUT] 30s reached without completing Claude run');
  logData.error = 'Timeout (30s)';
  child.kill('SIGTERM');
}, 30000);

child.on('close', (code, signal) => {
  clearTimeout(timeoutTimer);
  logData.elapsedMs = Date.now() - startTime;
  logData.exitCode = code;
  logData.signal = signal;
  logData.cleanExit = (code === 0);
  console.log(`\n[EXIT] Process exited with code=${code}, signal=${signal}, elapsed=${logData.elapsedMs}ms`);

  fs.writeFileSync(
    path.join(CWD, 'claude_structured_result.json'),
    JSON.stringify(logData, null, 2),
    'utf-8'
  );
  console.log('[DONE] Results saved to D:\\Ashish_P\\AI-Tools\\custom-OCT\\claude_structured_result.json');
});
