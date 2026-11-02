// D:\Ashish_P\AI-Tools\custom-OCT\test_claude_stream_stdin.js
// Verification of Claude Code with BOTH --input-format stream-json and --output-format stream-json

import { spawn } from 'child_process';
import readline from 'readline';

const CLAUDE_BIN = 'C:\\Users\\ajeevanesan\\.local\\bin\\claude.exe';
const CWD = 'D:\\Ashish_P\\AI-Tools\\custom-OCT';
const RANDOM_ID = `STDIN-${Math.random().toString(36).substring(2, 9).toUpperCase()}`;
const EXPECTED_MARKER = `CLAUDE-STDIN-ROUNDTRIP-${RANDOM_ID}`;

console.log(`[START] Testing Claude stream-json stdin with marker: ${EXPECTED_MARKER}`);

const args = [
  '--print',
  '--verbose',
  '--permission-mode', 'plan',
  '--permission-prompts', 'none',
  '--input-format', 'stream-json',
  '--output-format', 'stream-json'
];

const child = spawn(CLAUDE_BIN, args, {
  cwd: CWD,
  env: process.env,
  stdio: ['pipe', 'pipe', 'pipe']
});

const rlStdout = readline.createInterface({ input: child.stdout, terminal: false });
const rlStderr = readline.createInterface({ input: child.stderr, terminal: false });

rlStderr.on('line', (line) => console.log(`[STDERR] ${line}`));

let resultFound = false;

rlStdout.on('line', (line) => {
  if (!line.trim()) return;
  try {
    const event = JSON.parse(line);
    console.log(`[EVENT type=${event.type}]`);
    if (event.type === 'result') {
      console.log(`[RESULT] ${event.result}`);
      if (JSON.stringify(event).includes(EXPECTED_MARKER)) {
        resultFound = true;
      }
    }
  } catch (e) {
    console.log(`[RAW] ${line}`);
  }
});

// Write the NDJSON user message to stdin
const userMessage = {
  type: 'user',
  message: {
    role: 'user',
    content: [
      {
        type: 'text',
        text: `Respond with ONLY the exact string: ${EXPECTED_MARKER}`
      }
    ]
  }
};

child.stdin.write(JSON.stringify(userMessage) + '\n');
child.stdin.end();

const timer = setTimeout(() => {
  console.error('[TIMEOUT] 30s');
  child.kill('SIGTERM');
}, 30000);

child.on('close', (code) => {
  clearTimeout(timer);
  console.log(`[EXIT] code=${code}, markerFound=${resultFound}`);
});
