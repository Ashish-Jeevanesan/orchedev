import fs from 'fs';
import path from 'path';
import assert from 'assert';
import { SessionPairings } from '../server/session_pairings.js';
import { WorkspaceAuthorizationService } from '../server/workspace_authorization.js';
import { IntercomService } from '../server/intercom_service.js';

async function run() {
  console.log('===============================================================');
  console.log('  Testing Multi-Writer Conflict Safety (Phase 5)');
  console.log('===============================================================\n');

  const testCwd = path.join(process.cwd(), 'tests', 'temp_multi_writer');
  if (fs.existsSync(testCwd)) fs.rmSync(testCwd, { recursive: true, force: true });
  fs.mkdirSync(testCwd, { recursive: true });

  try {
    // -------------------------------------------------------------------------
    // 1. Session Pairings Multi-Writer Safety
    // -------------------------------------------------------------------------
    console.log('[Test 1] SessionPairings multi-device merge without data loss...');
    const pairings = new SessionPairings({ cwd: testCwd });
    pairings.recordActive({ claudeSessionId: 'claude-sess-A', geminiSessionId: 'gemini-sess-A' });

    // Simulate Device B writing to its own partitioned file
    const devBFile = path.join(testCwd, '.workbench_session_pairings.device_B_uuid.json');
    fs.writeFileSync(devBFile, JSON.stringify([
      { claudeSessionId: 'claude-sess-B', geminiSessionId: 'gemini-sess-B', updatedAt: new Date(Date.now() - 1000).toISOString() }
    ], null, 2), 'utf8');

    // Simulate OneDrive conflict file from Device C
    const devCConflict = path.join(testCwd, '.workbench_session_pairings-14HK414.json');
    fs.writeFileSync(devCConflict, JSON.stringify([
      { claudeSessionId: 'claude-sess-C', geminiSessionId: 'gemini-sess-C', updatedAt: new Date(Date.now() - 2000).toISOString() }
    ], null, 2), 'utf8');

    // Read list
    const combinedPairs = pairings.list();
    assert.strictEqual(combinedPairs.length, 3, `Expected 3 merged pairs, got ${combinedPairs.length}`);
    const foundA = combinedPairs.find(p => p.claudeSessionId === 'claude-sess-A');
    const foundB = combinedPairs.find(p => p.claudeSessionId === 'claude-sess-B');
    const foundC = combinedPairs.find(p => p.claudeSessionId === 'claude-sess-C');
    assert(foundA && foundB && foundC, 'All pairs from Device A, Device B, and OneDrive conflict copy were merged');
    console.log('  [PASS] Session pairings merged across partitioned device files and conflict copies');

    // -------------------------------------------------------------------------
    // 2. Workspace Authorization Multi-Writer Safety
    // -------------------------------------------------------------------------
    console.log('\n[Test 2] WorkspaceAuthorizationService multi-device root preservation...');
    const authServiceA = new WorkspaceAuthorizationService({ baseCwd: testCwd, persistRoots: true });
    
    // Create two test directories
    const rootDirA = path.join(testCwd, 'dirA');
    const rootDirB = path.join(testCwd, 'dirB');
    fs.mkdirSync(rootDirA, { recursive: true });
    fs.mkdirSync(rootDirB, { recursive: true });

    authServiceA.addAllowedRoot(rootDirA);

    // Simulate Device B adding rootDirB to .workbench_workspaces.json under its device key
    const workspacesFile = path.join(testCwd, '.workbench_workspaces.json');
    const workspacesContent = JSON.parse(fs.readFileSync(workspacesFile, 'utf8'));
    workspacesContent['device_B_uuid'] = [fs.realpathSync(rootDirB)];
    fs.writeFileSync(workspacesFile, JSON.stringify(workspacesContent, null, 2), 'utf8');

    // Re-instantiate service (simulating startup)
    const authServiceReloaded = new WorkspaceAuthorizationService({ baseCwd: testCwd, persistRoots: true });
    const allRoots = authServiceReloaded.getAllowedRoots().map(r => r.toLowerCase());
    
    assert(allRoots.includes(fs.realpathSync(rootDirA).toLowerCase()), 'Device A root preserved');
    assert(allRoots.includes(fs.realpathSync(rootDirB).toLowerCase()), 'Device B root merged and preserved');
    console.log('  [PASS] Workspace authorization merged roots across device keys without clobbering');

    // -------------------------------------------------------------------------
    // 3. IntercomService Task Partitioning & OneDrive Conflict Merge
    // -------------------------------------------------------------------------
    console.log('\n[Test 3] IntercomService task partitioning and conflict merge...');
    const intercom = new IntercomService({ cwd: testCwd });

    // Device A creates Task 1
    const task1 = intercom.createDelegation({
      fromAgent: 'claude',
      toAgent: 'gemini',
      instructions: 'Task 1 by Device A',
      requiresApproval: false
    });
    await intercom._persist();

    // Verify task 1 was written to partitioned file .workbench/tasks/<id>.json
    const task1File = path.join(testCwd, '.workbench', 'tasks', `${task1.correlationId}.json`);
    assert(fs.existsSync(task1File), 'Task 1 written to partitioned .workbench/tasks/<correlationId>.json');

    // Simulate Device B writing Task 2 directly to .workbench/tasks/task-2.json
    const task2 = {
      correlationId: 'CORR_DEVICE_B_TASK_2',
      fromAgent: 'claude',
      toAgent: 'gemini',
      instructions: 'Task 2 by Device B',
      state: 'COMPLETED',
      cwd: testCwd,
      createdAt: Date.now() - 5000,
      completedAt: Date.now() - 1000,
      stateHistory: [{ from: 'RUNNING', to: 'COMPLETED', timestamp: Date.now() - 1000 }]
    };
    fs.writeFileSync(
      path.join(testCwd, '.workbench', 'tasks', 'CORR_DEVICE_B_TASK_2.json'),
      JSON.stringify(task2, null, 2),
      'utf8'
    );

    // Simulate OneDrive conflict file with Task 3 (.workbench_tasks-DEVICE3.json)
    const task3 = {
      correlationId: 'CORR_DEVICE_C_TASK_3',
      fromAgent: 'claude',
      toAgent: 'gemini',
      instructions: 'Task 3 by Device C',
      state: 'COMPLETED',
      cwd: testCwd,
      createdAt: Date.now() - 6000,
      completedAt: Date.now() - 2000,
      stateHistory: [{ from: 'RUNNING', to: 'COMPLETED', timestamp: Date.now() - 2000 }]
    };
    fs.writeFileSync(
      path.join(testCwd, '.workbench_tasks-DEVICE3.json'),
      JSON.stringify([task3], null, 2),
      'utf8'
    );

    // Re-initialize IntercomService (simulating server restart/sync)
    await intercom.shutdown();
    const intercomReloaded = new IntercomService({ cwd: testCwd });

    const allTasks = intercomReloaded.getAllDelegations();
    const loadedTask1 = allTasks.find(t => t.correlationId === task1.correlationId);
    const loadedTask2 = allTasks.find(t => t.correlationId === 'CORR_DEVICE_B_TASK_2');
    const loadedTask3 = allTasks.find(t => t.correlationId === 'CORR_DEVICE_C_TASK_3');

    assert(loadedTask1, 'Loaded Task 1 from Device A');
    assert(loadedTask2, 'Loaded Task 2 from partitioned directory');
    assert(loadedTask3, 'Loaded Task 3 from OneDrive conflict copy file');
    await intercomReloaded.shutdown();

    console.log('  [PASS] IntercomService loaded and merged partitioned tasks and conflict copies');

    console.log('\n===============================================================');
    console.log('  ALL MULTI-WRITER SAFETY TESTS PASSED (100% GREEN)');
    console.log('===============================================================\n');
  } finally {
    try { fs.rmSync(testCwd, { recursive: true, force: true }); } catch (e) {}
  }
}

run().catch((err) => {
  console.error('[FATAL MULTI-WRITER TEST FAILURE]', err);
  process.exit(1);
});
