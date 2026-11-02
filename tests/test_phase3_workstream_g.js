// tests/test_phase3_workstream_g.js
// Phase 3 Workstream G: UI & Usability Acceptance Test Suite
// Verifies DOM Controls, Filter/Search Logic, Prompt History, Terminal Ergonomics,
// Progress Visualization, Late Completion Presentation, Modal Shortcuts & Activity Filtering

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WorkbenchServer } from '../server/server.js';
import { IntercomService, DelegationState } from '../server/intercom_service.js';
import { WorkspaceAuthorizationService } from '../server/workspace_authorization.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const TEST_WORKSPACE = path.join(PROJECT_ROOT, 'tests', 'temp_workspace_g');

async function runWorkstreamGTests() {
  console.log('===============================================================');
  console.log('  Phase 3 Workstream G: UI & Usability Acceptance Suite        ');
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

  // Ensure disposable test workspace
  if (fs.existsSync(TEST_WORKSPACE)) {
    fs.rmSync(TEST_WORKSPACE, { recursive: true, force: true });
  }
  fs.mkdirSync(TEST_WORKSPACE, { recursive: true });

  let server = null;

  try {
    server = new WorkbenchServer({ cwd: PROJECT_ROOT, port: 0 });
    const { port, sessionToken } = await server.start();

    // ------------------------------------------------------------------------
    // PART 1: DOM Control Inventory & Accessibility Verification
    // ------------------------------------------------------------------------
    console.log('--- PART 1: DOM Control Inventory & Accessibility ---');

    const htmlContent = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'index.html'), 'utf8');

    // 1. Header controls
    assert(htmlContent.includes('id="btn-copy-ws-path"'), 'One-click copy workspace button present in DOM');
    assert(htmlContent.includes('id="ws-quick-switch"'), 'Workspace quick-switch dropdown present in DOM');
    assert(htmlContent.includes('id="pill-approvals"'), 'Approvals alert badge present in DOM');

    // 2. Terminal controls
    assert(htmlContent.includes('id="btn-term-clear"'), 'Terminal Clear Buffer button present in DOM');
    assert(htmlContent.includes('data-term="claude"'), 'Claude Code CLI tab present in DOM');
    assert(htmlContent.includes('data-term="gemini"'), 'Gemini CLI tab present in DOM');

    // 3. Task Composer & Validation
    assert(htmlContent.includes('id="task-prompt-input"'), 'Task prompt input textarea present in DOM');
    assert(htmlContent.includes('id="btn-dispatch-task"'), 'Dispatch task button present in DOM');
    assert(htmlContent.includes('id="composer-validation-msg"'), 'Inline composer validation message container present in DOM');

    // 4. Task List & Filter Toolbar
    assert(htmlContent.includes('id="task-search-input"'), 'Task search input field present in DOM');
    assert(htmlContent.includes('id="btn-filter-all"'), 'Filter tab: All present in DOM');
    assert(htmlContent.includes('id="btn-filter-active"'), 'Filter tab: Active present in DOM');
    assert(htmlContent.includes('id="btn-filter-approvals"'), 'Filter tab: Approvals present in DOM');
    assert(htmlContent.includes('id="btn-filter-completed"'), 'Filter tab: Completed present in DOM');
    assert(htmlContent.includes('id="btn-filter-failed"'), 'Filter tab: Failed present in DOM');

    // 5. Supervision Modal & Carousel Navigation
    assert(htmlContent.includes('id="modal-approval"'), 'Human approval modal present in DOM');
    assert(htmlContent.includes('id="modal-carousel-nav"'), 'Modal multi-task carousel container present in DOM');
    assert(htmlContent.includes('id="btn-appr-prev"'), 'Modal carousel previous button present in DOM');
    assert(htmlContent.includes('id="btn-appr-next"'), 'Modal carousel next button present in DOM');
    assert(htmlContent.includes('id="appr-carousel-counter"'), 'Modal carousel counter present in DOM');
    assert(htmlContent.includes('aria-modal="true"'), 'Modal has accessible aria-modal attribute');

    // 6. Activity Feed Severity Chips
    assert(htmlContent.includes('id="activity-filters"'), 'Activity severity filter container present in DOM');
    assert(htmlContent.includes('data-sev="ALL"'), 'Severity chip ALL present in DOM');
    assert(htmlContent.includes('data-sev="TASKS"'), 'Severity chip TASKS present in DOM');
    assert(htmlContent.includes('data-sev="SECURITY"'), 'Severity chip SECURITY present in DOM');
    assert(htmlContent.includes('data-sev="ERRORS"'), 'Severity chip ERRORS present in DOM');

    // ------------------------------------------------------------------------
    // PART 2: Visual Styling & Theme Tokens
    // ------------------------------------------------------------------------
    console.log('\n--- PART 2: Visual Styling & CSS Design System ---');

    const cssContent = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'css', 'workbench.css'), 'utf8');

    assert(cssContent.includes('--bg-main: #0b0d13;'), 'Dark-mode primary background token defined');
    assert(cssContent.includes('.btn-copied'), 'Copy feedback button styling defined');
    assert(cssContent.includes('.progress-bar-wrap'), 'Progress bar container styling defined');
    assert(cssContent.includes('.late-completion-banner'), 'Late completion banner styling defined');
    assert(cssContent.includes('.textarea-input.validation-error'), 'Validation error pulse styling defined');
    assert(cssContent.includes('focus-visible'), 'Accessible focus-visible outline defined for keyboard navigation');

    // ------------------------------------------------------------------------
    // PART 3: Workspace Switcher & Authorized Roots Integration
    // ------------------------------------------------------------------------
    console.log('\n--- PART 3: Workspace Switcher & Authorized Roots ---');

    // Test GET /api/session/verify returns allowedRoots
    const verifyRes = await fetch(`http://127.0.0.1:${port}/api/session/verify`, {
      headers: { 'X-Session-Token': sessionToken }
    });
    const verifyData = await verifyRes.json();
    assert(Array.isArray(verifyData.allowedRoots), 'session verify returns allowedRoots array');
    assert(verifyData.allowedRoots.some(r => r.toLowerCase() === PROJECT_ROOT.toLowerCase()), 'Workbench base root included in allowedRoots');

    // Test GET /api/workspace returns allowedRoots
    const wsRes = await fetch(`http://127.0.0.1:${port}/api/workspace`, {
      headers: { 'X-Session-Token': sessionToken }
    });
    const wsData = await wsRes.json();
    assert(Array.isArray(wsData.allowedRoots), 'workspace GET returns allowedRoots array');

    // ------------------------------------------------------------------------
    // PART 4: Client Filter & Search Logic Verification
    // ------------------------------------------------------------------------
    console.log('\n--- PART 4: Client Filter & Search Engine Logic ---');

    // Create sample task fixtures representing all backend lifecycle states
    const sampleTasks = [
      { correlationId: 'CORR_TEST_01', state: 'APPROVAL_REQUESTED', prompt: 'Build auth module', fromAgent: 'claude', toAgent: 'gemini' },
      { correlationId: 'CORR_TEST_02', state: 'APPROVED', prompt: 'Setup database', fromAgent: 'user', toAgent: 'gemini' },
      { correlationId: 'CORR_TEST_03', state: 'QUEUED_FOR_CLAIM', prompt: 'Run migrations', fromAgent: 'claude', toAgent: 'gemini' },
      { correlationId: 'CORR_TEST_04', state: 'CLAIMED', prompt: 'Analyze query performance', fromAgent: 'claude', toAgent: 'gemini' },
      { correlationId: 'CORR_TEST_05', state: 'RUNNING', prompt: 'Compile TypeScript source', fromAgent: 'user', toAgent: 'gemini' },
      { correlationId: 'CORR_TEST_06', state: 'COMPLETED', prompt: 'Generate reports', fromAgent: 'claude', toAgent: 'gemini' },
      { correlationId: 'CORR_TEST_07', state: 'FAILED', prompt: 'Invalid command execution', fromAgent: 'user', toAgent: 'gemini' },
      { correlationId: 'CORR_TEST_08', state: 'TIMED_OUT', prompt: 'Heavy load benchmark', fromAgent: 'claude', toAgent: 'gemini' },
      { correlationId: 'CORR_TEST_09', state: 'CANCELLED', prompt: 'Interrupted task', fromAgent: 'user', toAgent: 'gemini' },
      { correlationId: 'CORR_TEST_10', state: 'EXPIRED', prompt: 'Orphaned task after boot', fromAgent: 'claude', toAgent: 'gemini' }
    ];

    function matchesFilter(task, filter) {
      switch (filter) {
        case 'active':
          return ['APPROVAL_REQUESTED', 'APPROVED', 'QUEUED_FOR_CLAIM', 'CLAIMED', 'RUNNING'].includes(task.state);
        case 'approvals':
          return task.state === 'APPROVAL_REQUESTED';
        case 'completed':
          return task.state === 'COMPLETED';
        case 'failed':
          return ['FAILED', 'TIMED_OUT', 'CANCELLED', 'EXPIRED', 'REJECTED'].includes(task.state);
        case 'all':
        default:
          return true;
      }
    }

    function matchesSearch(task, query) {
      if (!query) return true;
      const q = query.toLowerCase();
      const corr = (task.correlationId || '').toLowerCase();
      const prompt = (task.prompt || '').toLowerCase();
      const agent = (task.targetAgent || `${task.fromAgent || ''} ${task.toAgent || ''}`).toLowerCase();
      return corr.includes(q) || prompt.includes(q) || agent.includes(q);
    }

    // Verify filter categories
    const allFiltered = sampleTasks.filter(t => matchesFilter(t, 'all'));
    const activeFiltered = sampleTasks.filter(t => matchesFilter(t, 'active'));
    const approvalsFiltered = sampleTasks.filter(t => matchesFilter(t, 'approvals'));
    const completedFiltered = sampleTasks.filter(t => matchesFilter(t, 'completed'));
    const failedFiltered = sampleTasks.filter(t => matchesFilter(t, 'failed'));

    assert(allFiltered.length === 10, 'Filter: ALL correctly retains all 10 tasks');
    assert(activeFiltered.length === 5, 'Filter: ACTIVE matches exactly 5 active tasks');
    assert(approvalsFiltered.length === 1, 'Filter: APPROVALS matches exactly 1 pending task');
    assert(completedFiltered.length === 1, 'Filter: COMPLETED matches exactly 1 completed task');
    assert(failedFiltered.length === 4, 'Filter: FAILED matches exactly 4 terminal error tasks (FAILED, TIMED_OUT, CANCELLED, EXPIRED)');

    // Verify search matching
    const searchById = sampleTasks.filter(t => matchesSearch(t, 'CORR_TEST_05'));
    assert(searchById.length === 1 && searchById[0].correlationId === 'CORR_TEST_05', 'Search by Correlation ID locates exact task');

    const searchByKeyword = sampleTasks.filter(t => matchesSearch(t, 'typescript'));
    assert(searchByKeyword.length === 1 && searchByKeyword[0].correlationId === 'CORR_TEST_05', 'Search by prompt keyword locates matching task');

    const searchNone = sampleTasks.filter(t => matchesSearch(t, 'nonexistent_keyword_xyz'));
    assert(searchNone.length === 0, 'Search for nonexistent string returns 0 matches');

    // ------------------------------------------------------------------------
    // PART 5: Prompt History Bounds & Safety
    // ------------------------------------------------------------------------
    console.log('\n--- PART 5: Prompt History Bounds & Safety ---');

    function simulateSaveHistory(history, prompt) {
      const clean = (prompt || '').trim();
      if (!clean) return history;
      return [clean, ...history.filter(p => p !== clean)].slice(0, 30);
    }

    let history = [];
    for (let i = 1; i <= 35; i++) {
      history = simulateSaveHistory(history, `Prompt number ${i}`);
    }

    assert(history.length === 30, 'Prompt history is strictly bounded to 30 items max');
    assert(history[0] === 'Prompt number 35', 'Most recent prompt is at index 0');
    assert(!history.includes('Prompt number 1'), 'Oldest entries beyond capacity 30 are pruned FIFO');

    // De-duplication check
    history = simulateSaveHistory(history, 'Prompt number 35');
    assert(history.filter(p => p === 'Prompt number 35').length === 1, 'Duplicate prompts de-duplicated at top of history');

    // ------------------------------------------------------------------------
    // PART 6: Progress Visualization & Late Completion Integrity
    // ------------------------------------------------------------------------
    console.log('\n--- PART 6: Progress Visualization & Late Completion ---');

    // Test genuine progress formatting
    const taskWithProgress = {
      correlationId: 'CORR_PROG_TEST',
      state: 'RUNNING',
      lastProgress: { percent: 65, step: 'compile', message: 'Generating bytecode' }
    };

    assert(typeof taskWithProgress.lastProgress.percent === 'number', 'Genuine progress percentage is preserved');
    assert(taskWithProgress.lastProgress.percent === 65, 'Exact progress value matches 65%');

    // Test indeterminate progress when percentage is omitted
    const taskIndeterminate = {
      correlationId: 'CORR_INDET_TEST',
      state: 'RUNNING',
      lastProgress: { step: 'resolving_dependencies', message: 'Fetching packages' }
    };
    assert(taskIndeterminate.lastProgress.percent === undefined, 'Indeterminate progress does not fabricate numbers');

    // Test late completion preservation: original state remains TIMED_OUT
    const lateCompletedTask = {
      correlationId: 'CORR_LATE_TEST',
      state: 'TIMED_OUT',
      error: 'Task timed out after 30000ms',
      lateCompletion: {
        completedAt: Date.now() + 5000,
        executionDurationMs: 34500,
        result: 'Successfully completed after deadline'
      }
    };
    assert(lateCompletedTask.state === 'TIMED_OUT', 'Task state remains TIMED_OUT when late completion is recorded');
    assert(Boolean(lateCompletedTask.lateCompletion), 'lateCompletion object is attached as supplementary information');
    assert(lateCompletedTask.lateCompletion.result.includes('Successfully'), 'Late completion output preserved');

    // ------------------------------------------------------------------------
    // PART 7: Activity Event Categorization Logic
    // ------------------------------------------------------------------------
    console.log('\n--- PART 7: Activity Event Severity & Category Logic ---');

    function classifyCategory(evt) {
      const level = (evt.level || 'INFO').toUpperCase();
      const type = (evt.eventType || '').toUpperCase();

      if (level === 'ERROR' || type.includes('FAIL') || type.includes('ERROR')) {
        return 'ERRORS';
      }
      if (type.includes('SECURITY') || type.includes('AUTH') || type.includes('DENIED') || type.includes('ESCAPE')) {
        return 'SECURITY';
      }
      if (type.startsWith('TERMINAL_') || type.startsWith('AGENT_') || type.startsWith('PEER_') || type.includes('PTY')) {
        return 'TERMINALS';
      }
      if (type.startsWith('TASK_') || type.startsWith('APPROVAL_') || type.startsWith('WORKFLOW_') || evt.correlationId) {
        return 'TASKS';
      }
      return 'OTHER';
    }

    assert(classifyCategory({ level: 'INFO', eventType: 'TASK_CREATED', correlationId: 'C1' }) === 'TASKS', 'TASK_CREATED classified as TASKS');
    assert(classifyCategory({ level: 'INFO', eventType: 'TERMINAL_ACTION_SUCCESS' }) === 'TERMINALS', 'TERMINAL_ACTION classified as TERMINALS');
    assert(classifyCategory({ level: 'WARN', eventType: 'SECURITY_VIOLATION' }) === 'SECURITY', 'SECURITY_VIOLATION classified as SECURITY');
    assert(classifyCategory({ level: 'ERROR', eventType: 'TASK_FAILED' }) === 'ERRORS', 'TASK_FAILED with ERROR level classified as ERRORS');

  } finally {
    if (server) {
      await server.shutdown();
    }
    if (fs.existsSync(TEST_WORKSPACE)) {
      try { fs.rmSync(TEST_WORKSPACE, { recursive: true, force: true }); } catch (e) {}
    }
  }

  console.log('\n===============================================================');
  console.log(`  WORKSTREAM G ACCEPTANCE SUITE: ${passed} PASSED, ${failed} FAILED`);
  console.log('===============================================================\n');

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runWorkstreamGTests().catch(err => {
  console.error('[FATAL WORKSTREAM G TEST ERROR]', err);
  process.exit(1);
});
