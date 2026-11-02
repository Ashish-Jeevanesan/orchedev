// tests/test_phase3_workstream_f_cwd_authorization.js
// Dedicated CWD Authorization & Security Remediation Suite
// Covers Positive Tests (1-7) and Negative Tests (8-20)

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WorkbenchServer } from '../server/server.js';
import { IntercomService, DelegationState, TaskSecurityError } from '../server/intercom_service.js';
import { WorkspaceAuthorizationService } from '../server/workspace_authorization.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const TEST_DIR = path.join(PROJECT_ROOT, 'tests', 'temp_workspace_cwd_auth');
const EXTERNAL_PROJECT_DIR = path.join(PROJECT_ROOT, 'tests', 'temp_external_project');

async function runCwdAuthorizationTests() {
  console.log('===============================================================');
  console.log('  Phase 3 Workstream F: CWD Authorization Remediation Suite   ');
  console.log('===============================================================\n');

  let passed = 0;
  let failed = 0;
  let skipped = 0;

  function assert(condition, desc) {
    if (condition) {
      console.log(`  [PASS] ${desc}`);
      passed++;
    } else {
      console.error(`  [FAIL] ${desc}`);
      failed++;
    }
  }

  function skip(reason, desc) {
    console.log(`  [SKIP] ${desc} (${reason})`);
    skipped++;
  }

  // Setup disposable directories
  for (const dir of [TEST_DIR, EXTERNAL_PROJECT_DIR]) {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  }

  const subDir = path.join(TEST_DIR, 'nested_folder');
  fs.mkdirSync(subDir, { recursive: true });

  const siblingDir = path.join(PROJECT_ROOT, 'tests', 'temp_sibling_unauth');
  if (fs.existsSync(siblingDir)) fs.rmSync(siblingDir, { recursive: true, force: true });
  fs.mkdirSync(siblingDir, { recursive: true });

  let server = null;

  try {
    const authService = new WorkspaceAuthorizationService({
      baseCwd: TEST_DIR,
      allowedRoots: [EXTERNAL_PROJECT_DIR]
    });

    // ------------------------------------------------------------------------
    // Part 1: Positive Authorization Tests (1 - 7)
    // ------------------------------------------------------------------------
    console.log('--- PART 1: Positive Authorization Tests (1 - 7) ---');

    // 1. Authorized Workbench root accepted
    console.log('[Test 1] Authorized base workspace root accepted...');
    const authBase = authService.authorizeCwd(TEST_DIR);
    assert(authBase.toLowerCase() === fs.realpathSync(TEST_DIR).toLowerCase(), 'Authorized Workbench root accepted');

    // 2. Authorized nested project directory accepted
    console.log('[Test 2] Authorized nested project directory accepted...');
    const authSub = authService.authorizeCwd(subDir);
    assert(authSub.toLowerCase() === fs.realpathSync(subDir).toLowerCase(), 'Authorized nested project directory accepted');

    // 3. Explicitly configured external project root accepted
    console.log('[Test 3] Explicitly configured external project root accepted...');
    const authExt = authService.authorizeCwd(EXTERNAL_PROJECT_DIR);
    assert(authExt.toLowerCase() === fs.realpathSync(EXTERNAL_PROJECT_DIR).toLowerCase(), 'Explicitly configured external project root accepted');

    // 4. Authorized symlinked project root accepted when its resolved target is also authorized
    console.log('[Test 4] Authorized symlinked directory within allowed root...');
    const symlinkInside = path.join(TEST_DIR, 'valid_symlink');
    let canCreateSymlink = false;
    try {
      if (fs.existsSync(symlinkInside)) fs.unlinkSync(symlinkInside);
      fs.symlinkSync(subDir, symlinkInside, 'junction');
      canCreateSymlink = true;
    } catch (e) {
      skip(`Filesystem link creation requires privileges: ${e.message}`, 'Symlinked project root within authorized target');
    }

    if (canCreateSymlink) {
      const authSym = authService.authorizeCwd(symlinkInside);
      assert(authSym.toLowerCase() === fs.realpathSync(subDir).toLowerCase(), 'Authorized symlinked project root accepted when resolved target is authorized');
    }

    // 5. Legitimate Dispatch Task creation succeeds
    console.log('[Test 5] Legitimate Dispatch Task creation succeeds...');
    const intercom = new IntercomService({
      cwd: TEST_DIR,
      workspaceAuth: authService
    });
    const taskUser = intercom.createDelegation({
      fromAgent: 'user',
      toAgent: 'gemini',
      instructions: 'Run build in nested directory',
      cwd: subDir,
      requiresApproval: true
    });
    assert(taskUser && taskUser.state === DelegationState.APPROVAL_REQUESTED, 'Legitimate Dispatch Task creation succeeds');
    assert(taskUser.cwd.toLowerCase() === fs.realpathSync(subDir).toLowerCase(), 'Task recorded canonical real CWD');

    // 6. Legitimate Claude MCP delegation succeeds
    console.log('[Test 6] Legitimate Claude MCP delegation succeeds...');
    intercom.registerAgent({ agentId: 'claude', sessionId: 'sess_c_auth', pid: 101, cwd: TEST_DIR });
    const taskClaude = intercom.createDelegation({
      fromAgent: 'claude',
      toAgent: 'gemini',
      instructions: 'Analyze external project',
      cwd: EXTERNAL_PROJECT_DIR,
      requiresApproval: false
    });
    assert(taskClaude && taskClaude.state === DelegationState.QUEUED_FOR_CLAIM, 'Legitimate Claude delegation queued for claim');

    // 7. Gemini claim succeeds when task and session CWD match and remain authorized
    console.log('[Test 7] Gemini claim succeeds when task and session CWD match...');
    const peerGemini = intercom.registerAgent({
      agentId: 'gemini',
      sessionId: 'sess_g_auth',
      pid: 102,
      cwd: EXTERNAL_PROJECT_DIR
    });
    const claimedTask = intercom.claimTask({
      agentId: 'gemini',
      sessionId: peerGemini.sessionId,
      correlationId: taskClaude.correlationId,
      cwd: EXTERNAL_PROJECT_DIR
    });
    assert(claimedTask && claimedTask.state === DelegationState.RUNNING, 'Gemini claim succeeds when task and session CWD match');

    // ------------------------------------------------------------------------
    // Part 2: Negative Tests & Attack Vectors (8 - 20)
    // ------------------------------------------------------------------------
    console.log('\n--- PART 2: Negative Tests & Attack Vectors (8 - 20) ---');

    // 8. Arbitrary existing directory rejected
    console.log('[Test 8] Arbitrary existing directory outside allowed roots rejected...');
    let unauthErr = null;
    try {
      authService.authorizeCwd(siblingDir);
    } catch (e) {
      unauthErr = e;
    }
    assert(unauthErr instanceof TaskSecurityError && unauthErr.code === 'ERR_CWD_NOT_AUTHORIZED', 'Arbitrary existing directory rejected with ERR_CWD_NOT_AUTHORIZED');

    // 9. C:\Windows\Temp rejected unless explicitly authorized
    console.log('[Test 9] C:\\Windows\\Temp rejected unless explicitly authorized...');
    const winTemp = 'C:\\Windows\\Temp';
    if (fs.existsSync(winTemp)) {
      let winTempErr = null;
      try {
        authService.authorizeCwd(winTemp);
      } catch (e) {
        winTempErr = e;
      }
      assert(winTempErr instanceof TaskSecurityError && winTempErr.code === 'ERR_CWD_NOT_AUTHORIZED', 'C:\\Windows\\Temp rejected as unauthorized root');
    } else {
      skip('C:\\Windows\\Temp does not exist on this environment', 'C:\\Windows\\Temp rejection');
    }

    // 10. Unauthorized sibling directory rejected
    console.log('[Test 10] Unauthorized sibling directory rejected...');
    let siblingErr = null;
    try {
      intercom.createDelegation({
        fromAgent: 'user',
        toAgent: 'gemini',
        instructions: 'Access sibling',
        cwd: siblingDir
      });
    } catch (e) {
      siblingErr = e;
    }
    assert(siblingErr instanceof TaskSecurityError && siblingErr.code === 'ERR_CWD_NOT_AUTHORIZED', 'Unauthorized sibling directory rejected at task creation');

    // 11. Parent-directory traversal rejected
    console.log('[Test 11] Parent-directory traversal rejected...');
    let traversalErr = null;
    try {
      authService.authorizeCwd(path.join(TEST_DIR, '..', '..', '..'));
    } catch (e) {
      traversalErr = e;
    }
    assert(traversalErr instanceof TaskSecurityError && traversalErr.code === 'ERR_CWD_NOT_AUTHORIZED', 'Parent-directory traversal rejected');

    // 12. Windows drive escape rejected
    console.log('[Test 12] Windows root drive rejected as allowed root...');
    const driveAdded = authService.addAllowedRoot('C:\\');
    assert(driveAdded === false, 'Bare Windows drive C:\\ rejected from allowed roots registration');

    // 13. Unauthorized UNC path rejected
    console.log('[Test 13] Unauthorized UNC path rejected...');
    let uncErr = null;
    try {
      authService.authorizeCwd('\\\\localhost\\c$\\Windows');
    } catch (e) {
      uncErr = e;
    }
    assert(uncErr instanceof TaskSecurityError && uncErr.code === 'ERR_CWD_NOT_AUTHORIZED', 'Unauthorized UNC path rejected');

    // 14. Symlink inside authorized root pointing outside rejected
    console.log('[Test 14] Symlink inside authorized root pointing outside rejected...');
    const escapeSymlink = path.join(TEST_DIR, 'escape_link');
    let escapeSymlinkCreated = false;
    try {
      if (fs.existsSync(escapeSymlink)) fs.unlinkSync(escapeSymlink);
      fs.symlinkSync(siblingDir, escapeSymlink, 'junction');
      escapeSymlinkCreated = true;
    } catch (e) {
      skip(`Filesystem link creation requires privileges: ${e.message}`, 'Symlink escape check');
    }

    if (escapeSymlinkCreated) {
      let symEscapeErr = null;
      try {
        authService.authorizeCwd(escapeSymlink);
      } catch (e) {
        symEscapeErr = e;
      }
      assert(symEscapeErr instanceof TaskSecurityError && symEscapeErr.code === 'ERR_CWD_NOT_AUTHORIZED', 'Symlink inside authorized root pointing outside rejected');
    }

    // 15. Junction/reparse-point escape rejected
    console.log('[Test 15] Junction escape outside allowed root rejected...');
    if (escapeSymlinkCreated) {
      let junctionDelegationErr = null;
      try {
        intercom.createDelegation({
          fromAgent: 'claude',
          toAgent: 'gemini',
          instructions: 'Try junction escape',
          cwd: escapeSymlink
        });
      } catch (e) {
        junctionDelegationErr = e;
      }
      assert(junctionDelegationErr instanceof TaskSecurityError, 'Junction escape rejected at createDelegation');
    } else {
      skip('Junction creation requires privileges', 'Junction escape at createDelegation');
    }

    // 16. Relative path resolved against the correct trusted base
    console.log('[Test 16] Relative path resolved against trusted base...');
    const relativeTarget = 'nested_folder';
    const authRelative = authService.authorizeCwd(relativeTarget, TEST_DIR);
    assert(authRelative.toLowerCase() === fs.realpathSync(subDir).toLowerCase(), 'Relative path resolved against trusted base');

    // 17. CWD changed to an unauthorized symlink target after task creation rejected at claim
    console.log('[Test 17] CWD changed to unauthorized target after task creation rejected at claim...');
    const dynamicLink = path.join(TEST_DIR, 'dynamic_target_dir');
    let dynamicLinkCreated = false;
    try {
      if (fs.existsSync(dynamicLink)) fs.unlinkSync(dynamicLink);
      fs.symlinkSync(subDir, dynamicLink, 'junction');
      dynamicLinkCreated = true;
    } catch (e) {
      skip(`Link creation requires privileges: ${e.message}`, 'Dynamic target mutation test');
    }

    if (dynamicLinkCreated) {
      const dynamicTask = intercom.createDelegation({
        fromAgent: 'user',
        toAgent: 'gemini',
        instructions: 'Test dynamic link claim',
        cwd: dynamicLink,
        requiresApproval: false
      });

      // Retarget link to unauthorized sibling directory
      fs.unlinkSync(dynamicLink);
      fs.symlinkSync(siblingDir, dynamicLink, 'junction');
      dynamicTask.cwd = dynamicLink;

      let dynamicClaimErr = null;
      try {
        intercom.claimTask({
          agentId: 'gemini',
          sessionId: peerGemini.sessionId,
          correlationId: dynamicTask.correlationId,
          cwd: dynamicLink
        });
      } catch (e) {
        dynamicClaimErr = e;
      }
      assert(dynamicClaimErr instanceof TaskSecurityError && dynamicClaimErr.code === 'ERR_CWD_NOT_AUTHORIZED', 'CWD changed to unauthorized target rejected at claim time');
    }

    // 18. Dispatch Task and Claude delegation cannot bypass the same policy
    console.log('[Test 18] Dispatch Task and Claude delegation enforce identical policy...');
    let userFail = null;
    let claudeFail = null;
    try {
      intercom.createDelegation({ fromAgent: 'user', toAgent: 'gemini', instructions: 'X', cwd: siblingDir });
    } catch (e) { userFail = e; }
    try {
      intercom.createDelegation({ fromAgent: 'claude', toAgent: 'gemini', instructions: 'X', cwd: siblingDir });
    } catch (e) { claudeFail = e; }
    assert(userFail?.code === 'ERR_CWD_NOT_AUTHORIZED' && claudeFail?.code === 'ERR_CWD_NOT_AUTHORIZED', 'Both user and Claude delegation reject unauthorized CWD with identical code');

    // 19. Invalid or unauthorized CWD during recovery cannot become claimable
    console.log('[Test 19] Unauthorized CWD during recovery marked EXPIRED...');
    const storageFile = path.join(TEST_DIR, '.workbench_tasks.json');
    const staleTasks = [
      {
        correlationId: 'CORR_STALE_UNAUTH_1',
        fromAgent: 'claude',
        toAgent: 'gemini',
        instructions: 'Stale task with unauthorized CWD',
        cwd: siblingDir,
        state: DelegationState.QUEUED_FOR_CLAIM,
        createdAt: Date.now(),
        approvedAt: Date.now(),
        stateHistory: []
      }
    ];
    fs.writeFileSync(storageFile, JSON.stringify(staleTasks, null, 2), 'utf8');

    const recoveredIntercom = new IntercomService({
      cwd: TEST_DIR,
      workspaceAuth: authService
    });
    const recoveredTask = recoveredIntercom.getDelegation('CORR_STALE_UNAUTH_1');
    assert(recoveredTask.state === DelegationState.EXPIRED, 'Unauthorized task recovered as EXPIRED');
    assert(recoveredTask.error.includes('ERR_CWD_NOT_AUTHORIZED'), 'Error indicates CWD authorization failure on recovery');

    // 20. Existing CWD/session mismatch and task ownership tests continue passing
    console.log('[Test 20] Existing CWD/session mismatch error still enforced...');
    const taskInSub = intercom.createDelegation({
      fromAgent: 'user',
      toAgent: 'gemini',
      instructions: 'Run in nested',
      cwd: subDir,
      requiresApproval: false
    });
    let mismatchErr = null;
    try {
      // Gemini registered in EXTERNAL_PROJECT_DIR claims task requiring subDir
      intercom.claimTask({
        agentId: 'gemini',
        sessionId: peerGemini.sessionId,
        correlationId: taskInSub.correlationId,
        cwd: EXTERNAL_PROJECT_DIR
      });
    } catch (e) {
      mismatchErr = e;
    }
    assert(mismatchErr instanceof TaskSecurityError && mismatchErr.message.includes('Working directory mismatch'), 'CWD/session mismatch enforced with TaskSecurityError');

    // ------------------------------------------------------------------------
    // Part 3: Authorized Roots Persistence & Restoration Order (21 - 24)
    // ------------------------------------------------------------------------
    console.log('\n--- PART 3: Authorized Roots Persistence & Recovery Order (21 - 24) ---');

    // 21. User-authorized root safely persisted to disk
    console.log('[Test 21] Authorized workspace root persisted to .workbench_workspaces.json...');
    const userWorkspaceDir = path.join(PROJECT_ROOT, 'tests', 'temp_persisted_user_ws');
    if (fs.existsSync(userWorkspaceDir)) fs.rmSync(userWorkspaceDir, { recursive: true, force: true });
    fs.mkdirSync(userWorkspaceDir, { recursive: true });

    authService.addAllowedRoot(userWorkspaceDir);
    const workspacesConfigFile = path.join(TEST_DIR, '.workbench_workspaces.json');
    assert(fs.existsSync(workspacesConfigFile), 'Workspaces configuration file created on disk');
    const savedConfig = JSON.parse(fs.readFileSync(workspacesConfigFile, 'utf8'));
    assert(savedConfig.roots.some(r => r.toLowerCase() === fs.realpathSync(userWorkspaceDir).toLowerCase()), 'User-authorized root recorded in persisted storage');

    // 22. Persisted root restored and validated before task recovery runs
    console.log('[Test 22] Persisted root restored before _loadPersistedTasks() so queued task is preserved...');
    const queuedPersistedTask = [
      {
        correlationId: 'CORR_PERSIST_ROOT_TASK',
        fromAgent: 'claude',
        toAgent: 'gemini',
        instructions: 'Work in user workspace',
        cwd: userWorkspaceDir,
        state: DelegationState.QUEUED_FOR_CLAIM,
        createdAt: Date.now(),
        approvedAt: Date.now(),
        stateHistory: []
      }
    ];
    fs.writeFileSync(storageFile, JSON.stringify(queuedPersistedTask, null, 2), 'utf8');

    // Fresh server restart: new WorkspaceAuthorizationService restored from disk
    const rebootAuthService = new WorkspaceAuthorizationService({ baseCwd: TEST_DIR });
    assert(
      rebootAuthService.getAllowedRoots().some(r => r.toLowerCase() === fs.realpathSync(userWorkspaceDir).toLowerCase()),
      'Persisted user root restored during WorkspaceAuthorizationService initialization'
    );

    // Boot recovery runs: task cwd is recognized as authorized and remains claimable
    const rebootIntercom = new IntercomService({
      cwd: TEST_DIR,
      workspaceAuth: rebootAuthService
    });
    const preservedTask = rebootIntercom.getDelegation('CORR_PERSIST_ROOT_TASK');
    assert(preservedTask.state === DelegationState.QUEUED_FOR_CLAIM, 'Task in restored user workspace preserved as QUEUED_FOR_CLAIM');
    assert(!preservedTask.error, 'No false EXPIRED error on preserved task');

    // 23. Missing/deleted persisted root pruned on restart and task safely expired
    console.log('[Test 23] Deleted persisted root directory pruned on restart and task safely EXPIRED...');
    fs.rmSync(userWorkspaceDir, { recursive: true, force: true }); // Delete user workspace while offline
    const prunedAuthService = new WorkspaceAuthorizationService({ baseCwd: TEST_DIR });
    assert(
      !prunedAuthService.getAllowedRoots().some(r => r.toLowerCase().includes('temp_persisted_user_ws')),
      'Nonexistent directory automatically pruned from authorized roots on reboot'
    );
    const prunedIntercom = new IntercomService({
      cwd: TEST_DIR,
      workspaceAuth: prunedAuthService
    });
    const expiredTask = prunedIntercom.getDelegation('CORR_PERSIST_ROOT_TASK');
    assert(expiredTask.state === DelegationState.EXPIRED, 'Task referencing deleted root correctly transitioned to EXPIRED');
    assert(expiredTask.error.includes('ERR_CWD_NOT_AUTHORIZED'), 'Error notes CWD authorization failure on deleted root');

    // 24. Tampered entry in storage file rejected and sanitized
    console.log('[Test 24] Tampered entry (bare drive C:\\ or invalid path) rejected on load...');
    const tamperedPayload = {
      version: 1,
      roots: [
        TEST_DIR,
        'C:\\', // Attempt bare root drive injection
        '\\\\malicious_host\\share', // Attempt UNC injection
        path.join(TEST_DIR, 'nonexistent_malicious_dir')
      ]
    };
    fs.writeFileSync(workspacesConfigFile, JSON.stringify(tamperedPayload, null, 2), 'utf8');

    const sanitizedAuthService = new WorkspaceAuthorizationService({ baseCwd: TEST_DIR });
    const loadedRoots = sanitizedAuthService.getAllowedRoots();
    assert(!loadedRoots.some(r => r.toLowerCase() === 'c:\\'), 'Bare root drive C:\\ rejected from tampered configuration');
    assert(!loadedRoots.some(r => r.startsWith('\\\\')), 'UNC share rejected from tampered configuration');
    assert(!loadedRoots.some(r => r.includes('nonexistent')), 'Nonexistent malicious directory rejected');

  } finally {
    // Cleanup disposable test directories
    const userWorkspaceDir = path.join(PROJECT_ROOT, 'tests', 'temp_persisted_user_ws');
    for (const d of [TEST_DIR, EXTERNAL_PROJECT_DIR, siblingDir, userWorkspaceDir]) {
      try {
        if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
      } catch (e) {}
    }
  }

  console.log('\n===============================================================');
  console.log(`  CWD AUTHORIZATION SUITE: ${passed} PASSED, ${failed} FAILED, ${skipped} SKIPPED`);
  console.log('===============================================================\n');

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runCwdAuthorizationTests().catch(err => {
  console.error('[FATAL SUITE ERROR]', err);
  process.exit(1);
});
