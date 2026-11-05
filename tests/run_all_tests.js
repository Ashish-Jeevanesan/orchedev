// D:\Ashish_P\AI-Tools\custom-OCT\tests\run_all_tests.js
// Master test runner for the 8 workbench reliability scenarios

import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';

const CWD = process.cwd();

const testFiles = [
  'test_01_sequential.js',
  'test_02_invalid_response.js',
  'test_03_gemini_early_exit.js',
  'test_04_request_timeout.js',
  'test_05_malformed_ndjson.js',
  'test_06_claude_early_exit.js',
  'test_07_duplicate_late_response.js',
  'test_08_cleanup_after_failure.js'
];

async function runTestFile(file) {
  const filePath = path.join(CWD, 'tests', file);
  const startTime = Date.now();

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [filePath], {
      cwd: CWD,
      stdio: 'inherit'
    });

    child.on('close', (code) => {
      const elapsedMs = Date.now() - startTime;
      resolve({
        file,
        passed: code === 0,
        code,
        elapsedMs
      });
    });

    child.on('error', (err) => {
      resolve({
        file,
        passed: false,
        code: -1,
        error: err.message,
        elapsedMs: Date.now() - startTime
      });
    });
  });
}

async function main() {
  console.log('===============================================================');
  console.log('  Claude + Gemini Workbench: Reliability Test Suite Runner');
  console.log('===============================================================\n');

  const results = [];
  const suiteStart = Date.now();

  for (const testFile of testFiles) {
    console.log(`\n>>> RUNNING: ${testFile}`);
    const res = await runTestFile(testFile);
    results.push(res);
    console.log(`>>> FINISHED: ${testFile} -> ${res.passed ? 'PASSED' : 'FAILED'} (${res.elapsedMs}ms)`);
  }

  const suiteElapsed = Date.now() - suiteStart;

  console.log('\n===============================================================');
  console.log('                   RELIABILITY TEST MATRIX');
  console.log('===============================================================');
  console.log('Index | Test File                         | Status | Elapsed');
  console.log('---------------------------------------------------------------');
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const idx = String(i + 1).padStart(2, ' ');
    const name = r.file.padEnd(33, ' ');
    const status = (r.passed ? 'PASSED' : 'FAILED').padEnd(6, ' ');
    const elapsed = `${r.elapsedMs}ms`.padStart(7, ' ');
    console.log(` ${idx}   | ${name} | ${status} | ${elapsed}`);
  }
  console.log('---------------------------------------------------------------');

  const totalPassed = results.filter(r => r.passed).length;
  console.log(`Total: ${totalPassed} / ${results.length} PASSED in ${suiteElapsed}ms`);
  console.log('===============================================================\n');

  // Save report
  fs.writeFileSync(
    path.join(CWD, 'tests', 'reliability_test_results.json'),
    JSON.stringify({ suiteElapsedMs: suiteElapsed, totalPassed, totalTests: results.length, results }, null, 2),
    'utf-8'
  );

  if (totalPassed !== results.length) {
    process.exit(1);
  }
}

main();
