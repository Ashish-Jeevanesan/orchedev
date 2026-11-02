// D:\Ashish_P\AI-Tools\custom-OCT\tests\acceptance\run_acceptance_audit.js
// Master Acceptance Audit Runner for Phase 4

import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';

const CWD = 'D:\\Ashish_P\\AI-Tools\\custom-OCT';

const acceptanceSuites = [
  '01_ui_control_inventory.js',
  '02_terminal_lifecycle_suite.js',
  '03_target_agents_suite.js',
  '04_lifecycle_edge_cases.js'
];

async function runSuiteFile(file) {
  const filePath = path.join(CWD, 'tests', 'acceptance', file);
  const startTime = Date.now();

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [filePath], {
      cwd: CWD,
      stdio: 'inherit'
    });

    child.on('close', (code) => {
      resolve({
        file,
        passed: code === 0,
        code,
        elapsedMs: Date.now() - startTime
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
  console.log('  Agent Workbench: Full UI Acceptance Audit Test Runner');
  console.log('===============================================================\n');

  const results = [];
  const start = Date.now();

  for (const suite of acceptanceSuites) {
    console.log(`\n>>> STARTING SUITE: ${suite}`);
    const r = await runSuiteFile(suite);
    results.push(r);
    console.log(`>>> FINISHED: ${suite} -> ${r.passed ? 'PASSED' : 'FAILED'} (${r.elapsedMs}ms)`);
    // Allow 1s cooldown between suites for Windows process handle cleanup
    await new Promise(r => setTimeout(r, 1000));
  }

  const totalElapsed = Date.now() - start;

  console.log('\n===============================================================');
  console.log('                 ACCEPTANCE AUDIT SUMMARY MATRIX');
  console.log('===============================================================');
  console.log('Index | Test Suite File                      | Status | Elapsed');
  console.log('---------------------------------------------------------------');
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const idx = String(i + 1).padStart(2, ' ');
    const name = r.file.padEnd(36, ' ');
    const status = (r.passed ? 'PASSED' : 'FAILED').padEnd(6, ' ');
    const elapsed = `${r.elapsedMs}ms`.padStart(8, ' ');
    console.log(` ${idx}   | ${name} | ${status} | ${elapsed}`);
  }
  console.log('---------------------------------------------------------------');
  const totalPassed = results.filter(r => r.passed).length;
  console.log(`Total: ${totalPassed} / ${results.length} SUITES PASSED in ${totalElapsed}ms`);
  console.log('===============================================================\n');

  if (totalPassed !== results.length) {
    process.exit(1);
  }
  process.exit(0);
}

main().catch(err => {
  console.error('[FATAL AUDIT ERROR]', err);
  process.exit(1);
});
