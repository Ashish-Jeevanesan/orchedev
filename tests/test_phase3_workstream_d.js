// D:\Ashish_P\AI-Tools\custom-OCT\tests\test_phase3_workstream_d.js
// Focused Regression Suite for Phase 3 Workstream D: Observability & Diagnostics

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  IntercomService,
  AgentStatus,
  DelegationState,
  TaskSecurityError,
  TaskStateError
} from '../server/intercom_service.js';
import { Logger, redactSecrets, sanitizeString } from '../server/logger.js';
import { ActivityViewController } from '../public/js/activity_view.js';
import { TaskViewController } from '../public/js/task_view.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const TEMP_WORKSPACE = path.join(PROJECT_ROOT, 'tests', 'temp_workspace_d');

async function runWorkstreamDTests() {
  console.log('===============================================================');
  console.log('  Phase 3: Workstream D Observability & Diagnostics Suite     ');
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

  if (fs.existsSync(TEMP_WORKSPACE)) {
    fs.rmSync(TEMP_WORKSPACE, { recursive: true, force: true });
  }
  fs.mkdirSync(TEMP_WORKSPACE, { recursive: true });

  try {
    // ------------------------------------------------------------------------
    // Part 1: Unified Event Architecture & Event Taxonomy
    // ------------------------------------------------------------------------
    console.log('--- PART 1: Unified WorkbenchEvent Architecture & Taxonomy ---');
    const emittedEvents = [];
    const intercom = new IntercomService({
      cwd: TEMP_WORKSPACE,
      eventBroadcaster: (type, payload) => {
        if (type === 'workbench_event') {
          emittedEvents.push(payload);
        }
      }
    });

    const claudePeer = intercom.registerAgent({
      agentId: 'claude',
      sessionId: 'sess_c_d1',
      pid: 601,
      cwd: TEMP_WORKSPACE
    });
    const geminiPeer = intercom.registerAgent({
      agentId: 'gemini',
      sessionId: 'sess_g_d1',
      pid: 602,
      cwd: TEMP_WORKSPACE
    });

    // 1. Unified event schema
    console.log('[Test 1] Unified event schema verification...');
    const regEvt = emittedEvents.find(e => e.eventType === 'SESSION_REGISTERED');
    assert(Boolean(regEvt), 'SESSION_REGISTERED event emitted');
    assert(typeof regEvt.eventId === 'string' && regEvt.eventId.startsWith('EVT_'), 'Event contains collision-safe eventId');
    assert(typeof regEvt.timestamp === 'number', 'Event contains timestamp');
    assert(['INFO', 'WARN', 'ERROR'].includes(regEvt.level), 'Event contains valid severity level');
    assert(typeof regEvt.summary === 'string' && regEvt.summary.length > 5, 'Event contains human-readable summary');

    // 2. Unique event IDs
    console.log('[Test 2] Unique event IDs across events...');
    const eventIds = new Set(emittedEvents.map(e => e.eventId));
    assert(eventIds.size === emittedEvents.length, 'All emitted event IDs are unique');

    // 3. Task Creation & Approval Events
    console.log('[Test 3] Task creation and approval event sequence...');
    emittedEvents.length = 0;
    const task = intercom.createDelegation({
      fromAgent: 'claude',
      toAgent: 'gemini',
      instructions: 'Observability test task',
      correlationId: 'CORR_OBS_001',
      cwd: TEMP_WORKSPACE,
      requiresApproval: true
    });

    assert(emittedEvents.length === 1, 'Exactly one event emitted for creation (de-duplicated)');
    assert(emittedEvents[0].eventType === 'APPROVAL_REQUESTED', 'Initial event is APPROVAL_REQUESTED');
    assert(emittedEvents[0].correlationId === 'CORR_OBS_001', 'Correlation ID preserved in event');
    assert(emittedEvents[0].level === 'INFO', 'Approval request classified as INFO');

    // 4. Approval Granted & Task Queued
    console.log('[Test 4] Approval granted event...');
    emittedEvents.length = 0;
    intercom.approveDelegation({ correlationId: 'CORR_OBS_001', approver: 'qa-lead' });
    const apprEvt = emittedEvents.find(e => e.eventType === 'APPROVAL_GRANTED');
    const queueEvt = emittedEvents.find(e => e.eventType === 'TASK_QUEUED');
    assert(Boolean(apprEvt), 'APPROVAL_GRANTED event emitted');
    assert(Boolean(queueEvt), 'TASK_QUEUED event emitted');
    assert(apprEvt.summary.includes('approved by qa-lead'), 'Summary records approver');

    // 5. Claimed and Execution Started
    console.log('[Test 5] Claim and execution started events...');
    emittedEvents.length = 0;
    intercom.claimTask({
      agentId: 'gemini',
      sessionId: 'sess_g_d1',
      correlationId: 'CORR_OBS_001',
      cwd: TEMP_WORKSPACE
    });
    const claimEvt = emittedEvents.find(e => e.eventType === 'TASK_CLAIMED');
    const execEvt = emittedEvents.find(e => e.eventType === 'EXECUTION_STARTED');
    assert(Boolean(claimEvt), 'TASK_CLAIMED event emitted');
    assert(Boolean(execEvt), 'EXECUTION_STARTED event emitted');
    assert(claimEvt.correlationId === 'CORR_OBS_001', 'Claim event contains correlation ID');

    // 6. Genuine Progress Reporting & Rate-Limiting
    console.log('[Test 6] Genuine TASK_PROGRESS reporting and rate-limiting...');
    emittedEvents.length = 0;
    const prog1 = intercom.reportProgress({
      agentId: 'gemini',
      sessionId: 'sess_g_d1',
      correlationId: 'CORR_OBS_001',
      step: 'Step 1: Compiling schemas',
      message: 'Found 4 type definitions'
    });
    assert(prog1.success === true, 'First progress report accepted');
    assert(task.progressHistory.length === 1, 'Progress recorded in task.progressHistory');
    assert(task.state === DelegationState.RUNNING, 'Progress report did NOT mutate task state (still RUNNING)');

    const progEvt = emittedEvents.find(e => e.eventType === 'TASK_PROGRESS');
    assert(Boolean(progEvt), 'TASK_PROGRESS event emitted');
    assert(progEvt.summary.includes('Step 1: Compiling schemas'), 'Summary includes step label');

    // Rapid second progress report throttled (rate-limited <400ms)
    const prog2 = intercom.reportProgress({
      agentId: 'gemini',
      sessionId: 'sess_g_d1',
      correlationId: 'CORR_OBS_001',
      step: 'Step 2: Rapid update'
    });
    assert(prog2.throttled === true, 'Rapid progress report (<400ms) rate-limited');

    // Progress report by unauthenticated session rejected
    let progErr = null;
    try {
      intercom.reportProgress({
        agentId: 'gemini',
        sessionId: 'sess_wrong',
        correlationId: 'CORR_OBS_001',
        step: 'Illegal progress'
      });
    } catch (e) {
      progErr = e;
    }
    assert(progErr instanceof TaskSecurityError, 'Unauthenticated progress report rejected with TaskSecurityError');

    // 7. Completion Event
    console.log('[Test 7] Completion event...');
    emittedEvents.length = 0;
    intercom.completeTask({
      agentId: 'gemini',
      sessionId: 'sess_g_d1',
      correlationId: 'CORR_OBS_001',
      summary: 'Schema compilation finished successfully'
    });
    const compEvt = emittedEvents.find(e => e.eventType === 'TASK_COMPLETED');
    assert(Boolean(compEvt), 'TASK_COMPLETED event emitted');
    assert(compEvt.level === 'INFO', 'Completion level is INFO');
    assert(compEvt.summary.includes('Schema compilation finished'), 'Completion summary includes summary text');

    // 8. Error / Timeout / Cancellation Severity Classification
    console.log('[Test 8] Error and warning severity classification...');
    emittedEvents.length = 0;
    const taskFail = intercom.createDelegation({
      fromAgent: 'claude',
      toAgent: 'gemini',
      instructions: 'Task that will fail',
      correlationId: 'CORR_OBS_FAIL',
      cwd: TEMP_WORKSPACE,
      requiresApproval: false
    });
    intercom.claimTask({
      agentId: 'gemini',
      sessionId: 'sess_g_d1',
      correlationId: 'CORR_OBS_FAIL',
      cwd: TEMP_WORKSPACE
    });
    intercom.failTask({
      agentId: 'gemini',
      sessionId: 'sess_g_d1',
      correlationId: 'CORR_OBS_FAIL',
      error: 'Disk out of space'
    });
    const failEvt = emittedEvents.find(e => e.eventType === 'TASK_FAILED');
    assert(Boolean(failEvt), 'TASK_FAILED event emitted');
    assert(failEvt.level === 'ERROR', 'Task failure classified with level ERROR');
    assert(failEvt.summary.includes('Disk out of space'), 'Failure summary includes error detail');

    // 9. Session Degradation & Recovery Events
    console.log('[Test 9] Session degradation and recovery events...');
    emittedEvents.length = 0;
    geminiPeer.lastHeartbeat = Date.now() - 17000;
    intercom._checkHeartbeats();
    const degEvt = emittedEvents.find(e => e.eventType === 'SESSION_DEGRADED');
    assert(Boolean(degEvt), 'SESSION_DEGRADED event emitted at 17s missed heartbeat');
    assert(degEvt.level === 'WARN', 'Degradation level is WARN');

    intercom.recordHeartbeat({ agentId: 'gemini', sessionId: 'sess_g_d1', status: 'ONLINE' });
    const recEvt = emittedEvents.find(e => e.eventType === 'SESSION_RECOVERED');
    assert(Boolean(recEvt), 'SESSION_RECOVERED event emitted on heartbeat');
    assert(recEvt.level === 'INFO', 'Recovery level is INFO');

    await intercom.shutdown();

    // ------------------------------------------------------------------------
    // Part 2: Task State Duration Timeline Calculation
    // ------------------------------------------------------------------------
    console.log('\n--- PART 2: Task State Duration Timeline Calculations ---');
    const mockTask = {
      correlationId: 'CORR_DURATION_TEST',
      state: 'COMPLETED',
      createdAt: 100000,
      startedAt: 120000,
      completedAt: 150000,
      stateHistory: [
        { from: null, to: 'APPROVAL_REQUESTED', timestamp: 100000, reason: 'Submitted', actor: 'claude' },
        { from: 'APPROVAL_REQUESTED', to: 'APPROVED', timestamp: 110000, reason: 'Approved', actor: 'qa-user' },
        { from: 'APPROVED', to: 'QUEUED_FOR_CLAIM', timestamp: 110100, reason: 'Queued', actor: 'coordinator' },
        { from: 'QUEUED_FOR_CLAIM', to: 'CLAIMED', timestamp: 120000, reason: 'Claimed', actor: 'gemini' },
        { from: 'CLAIMED', to: 'RUNNING', timestamp: 120200, reason: 'Started', actor: 'gemini' },
        { from: 'RUNNING', to: 'COMPLETED', timestamp: 150000, reason: 'Finished', actor: 'gemini' }
      ]
    };

    const taskViewController = Object.create(TaskViewController.prototype);

    // 10. State duration calculations
    console.log('[Test 10] State duration calculation accuracy...');
    const timelineHtml = taskViewController._renderStateHistoryTimeline(mockTask);
    assert(timelineHtml.includes('APPROVAL_REQUESTED'), 'Timeline includes APPROVAL_REQUESTED');
    assert(timelineHtml.includes('10.0s') || timelineHtml.includes('10000ms'), 'Duration for APPROVAL_REQUESTED calculated accurately (10.0s)');
    assert(timelineHtml.includes('29.8s') || timelineHtml.includes('29800ms'), 'Duration for RUNNING calculated accurately (29.8s)');

    // 11. Active-state live elapsed duration
    console.log('[Test 11] Active-state live elapsed duration...');
    const activeTask = {
      correlationId: 'CORR_ACTIVE_TEST',
      state: 'RUNNING',
      createdAt: Date.now() - 5000,
      stateHistory: [
        { from: null, to: 'RUNNING', timestamp: Date.now() - 5000, reason: 'Started', actor: 'gemini' }
      ]
    };
    const activeTimeline = taskViewController._renderStateHistoryTimeline(activeTask);
    assert(activeTimeline.includes('active'), 'Active state timeline labeled as active');

    // ------------------------------------------------------------------------
    // Part 3: Bounded Activity Feed & Safe Rendering
    // ------------------------------------------------------------------------
    console.log('\n--- PART 3: Bounded Activity Feed & Safe Rendering ---');
    // Mock minimal DOM structure for ActivityViewController
    const fakeDrawer = { classList: { toggle: () => {}, contains: () => false }, querySelector: () => null };
    const fakeChildren = [];
    const fakeFeed = {
      children: fakeChildren,
      appendChild: (el) => fakeChildren.push(el),
      firstElementChild: null,
      scrollTop: 0,
      scrollHeight: 100,
      addEventListener: () => {}
    };
    Object.defineProperty(fakeFeed, 'firstElementChild', {
      get: () => fakeChildren[0] || null
    });
    const fakeCountEl = { textContent: '0' };
    const fakeToggleBtn = { addEventListener: () => {} };
    const fakeClearBtn = { addEventListener: () => {}, contains: () => false };
    const fakeToastContainer = { children: [], appendChild: () => {} };

    // Set global document mock for createElement
    const origDoc = global.document;
    global.document = {
      createElement: () => {
        const el = {
          className: '',
          innerHTML: '',
          style: {},
          remove: function () {
            const idx = fakeChildren.indexOf(el);
            if (idx !== -1) fakeChildren.splice(idx, 1);
          }
        };
        return el;
      }
    };

    // Instantiate with mock DOM elements
    const activityView = Object.create(ActivityViewController.prototype);
    activityView.drawer = fakeDrawer;
    activityView.feed = fakeFeed;
    activityView.countEl = fakeCountEl;
    activityView.toggleBtn = fakeToggleBtn;
    activityView.clearBtn = fakeClearBtn;
    activityView.toastContainer = fakeToastContainer;
    activityView.count = 0;
    activityView.MAX_FEED_ENTRIES = 200;
    activityView.MAX_TOASTS = 5;
    activityView.seenEventIds = new Set();
    activityView._bindEvents = () => {};

    // 12. Bounded FIFO feed (capped at 200)
    console.log('[Test 12] Bounded FIFO feed capping at 200 items...');
    for (let i = 0; i < 250; i++) {
      activityView.logWorkbenchEvent({
        eventId: `EVT_FEED_TEST_${i}`,
        eventType: 'TASK_PROGRESS',
        level: 'INFO',
        timestamp: Date.now(),
        summary: `Feed item #${i}`
      });
    }
    assert(fakeFeed.children.length === 200, 'Feed length strictly capped at MAX_FEED_ENTRIES (200)');

    // 13. Duplicate event ID suppression
    console.log('[Test 13] Duplicate event ID suppression...');
    const prevCount = activityView.count;
    activityView.logWorkbenchEvent({
      eventId: 'EVT_FEED_TEST_100', // Already seen
      eventType: 'TASK_PROGRESS',
      level: 'INFO',
      timestamp: Date.now(),
      summary: 'Duplicate event'
    });
    assert(activityView.count === prevCount, 'Duplicate eventId suppressed from rendering');

    // 14. Safe text rendering (escaping untrusted strings)
    console.log('[Test 14] Safe escaping of malicious HTML injections...');
    const maliciousSummary = '<script>alert("hack")</script><img src=x onerror=alert(1)>';
    const escaped = activityView._escape(maliciousSummary);
    assert(!escaped.includes('<script>'), 'Script tag escaped');
    assert(escaped.includes('&lt;script&gt;'), 'Angle brackets safely converted to HTML entities');

    // ------------------------------------------------------------------------
    // Part 4: Secret Redaction & Structured Logging
    // ------------------------------------------------------------------------
    console.log('\n--- PART 4: Secret Redaction & Structured Logging ---');
    const testLogFile = path.join(TEMP_WORKSPACE, 'test_redact.log');
    const customLogger = new Logger({ cwd: TEMP_WORKSPACE, logFile: testLogFile });

    // 15. Recursive token redaction in nested objects
    console.log('[Test 15] Recursive token redaction in structured objects...');
    const sensitivePayload = {
      agent: 'claude',
      auth: {
        token: 'abcd1234ef567890abcd1234ef567890',
        apiKey: 'sk-ant-api03-1234567890abcdef',
        secretKey: 'top_secret_xyz'
      },
      headers: {
        'X-Session-Token': '3a88448f729f12d8a3915bc828114fa3',
        cookie: 'session_token=99887766554433221100aabbccddeeff; other=val'
      },
      safeField: 'normal_data'
    };
    const cleaned = redactSecrets(sensitivePayload);
    assert(cleaned.auth.token === '[REDACTED]', 'Nested auth.token redacted');
    assert(cleaned.auth.apiKey === '[REDACTED]', 'Nested auth.apiKey redacted');
    assert(cleaned.auth.secretKey === '[REDACTED]', 'Nested auth.secretKey redacted');
    assert(cleaned.safeField === 'normal_data', 'Safe field preserved');

    // 16. Authorization / Bearer header string redaction
    console.log('[Test 16] Authorization and Bearer header string redaction...');
    const authHeaderString = 'Request with Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.xyz and details';
    const cleanAuth = sanitizeString(authHeaderString);
    assert(!cleanAuth.includes('eyJhbGci'), 'JWT bearer token redacted from string');
    assert(cleanAuth.includes('Bearer [REDACTED]'), 'Bearer token safely sanitized');

    // 17. X-Session-Token and WebSocket token subprotocol redaction
    console.log('[Test 17] X-Session-Token and WebSocket protocol redaction...');
    const wsProtoStr = 'Connecting to ws://127.0.0.1:5000/ws/events with protocol token.45a90d81f2b6e8a0914c';
    const cleanWs = sanitizeString(wsProtoStr);
    assert(!cleanWs.includes('45a90d81f2b6e8a0914c'), 'WebSocket token subprotocol redacted');
    assert(cleanWs.includes('token.[REDACTED]'), 'Replaced with token.[REDACTED]');

    // 18. URL query parameter token redaction
    console.log('[Test 18] Query parameter token redaction...');
    const urlStr = 'http://127.0.0.1:8080/api/check?token=a1b2c3d4e5f6789012345678&id=12';
    const cleanUrl = sanitizeString(urlStr);
    assert(!cleanUrl.includes('a1b2c3d4e5f6789012345678'), 'Query parameter token value redacted');
    assert(cleanUrl.includes('token=[REDACTED]'), 'Clean parameter placeholder preserved');

    // 19. Error message token redaction
    console.log('[Test 19] Error message token redaction...');
    const errWithSecret = new Error('Connection failed to http://127.0.0.1:4000?auth=super_secret_token_123456');
    const cleanedErr = redactSecrets(errWithSecret);
    assert(!cleanedErr.message.includes('super_secret_token_123456'), 'Error message secret redacted');
    assert(cleanedErr.message.includes('auth=[REDACTED]'), 'Replaced with [REDACTED]');

    // 20. Logging failure isolation (logger never crashes caller)
    console.log('[Test 20] Logging failure isolation...');
    customLogger.stream = {
      writable: true,
      write: () => { throw new Error('Simulated disk full failure'); }
    };
    let threw = false;
    try {
      customLogger.info('TEST_ACTION', 'Message that encounters broken stream');
    } catch (e) {
      threw = true;
    }
    assert(threw === false, 'Logger silently catches and isolates stream write failures');

    customLogger.close();
  } finally {
    if (fs.existsSync(TEMP_WORKSPACE)) {
      try { fs.rmSync(TEMP_WORKSPACE, { recursive: true, force: true }); } catch (e) {}
    }
  }

  console.log('\n===============================================================');
  console.log(`  PHASE 3 WORKSTREAM D SUITE: ${passed} PASSED, ${failed} FAILED`);
  console.log('===============================================================\n');

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runWorkstreamDTests().catch(err => {
  console.error('[FATAL WORKSTREAM D SUITE ERROR]', err);
  process.exit(1);
});
