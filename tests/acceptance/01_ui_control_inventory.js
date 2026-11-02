// D:\Ashish_P\AI-Tools\custom-OCT\tests\acceptance\01_ui_control_inventory.js
// Acceptance Test Suite 1: Full UI Control & Endpoint Inventory Verification

import { WorkbenchServer } from '../../server/server.js';
import path from 'path';

const CWD = 'D:\\Ashish_P\\AI-Tools\\custom-OCT';

async function run() {
  console.log('--- Acceptance Suite 1: UI Control & Endpoint Inventory ---');
  const server = new WorkbenchServer({ cwd: CWD, port: 0 });
  const { port, sessionToken } = await server.start();
  const checks = [];

  try {
    // 1. App Launch & Health Probe
    const resHealth = await fetch(`http://127.0.0.1:${port}/api/health`);
    checks.push({
      control: 'App Launch & Health Indicator',
      route: 'GET /api/health',
      passed: resHealth.status === 200,
      details: await resHealth.json()
    });

    // 2. Session Authentication & Token Verification
    const resVerify = await fetch(`http://127.0.0.1:${port}/api/session/verify`, {
      headers: { 'X-Session-Token': sessionToken }
    });
    const dataVerify = await resVerify.json();
    checks.push({
      control: 'Authentication & Session Token Verification',
      route: 'GET /api/session/verify',
      passed: resVerify.status === 200 && dataVerify.authenticated === true,
      details: dataVerify
    });

    // 3. Unauthorized access rejection
    const resUnauth = await fetch(`http://127.0.0.1:${port}/api/session/verify`);
    checks.push({
      control: 'Security: Rejection of Missing Session Token',
      route: 'GET /api/session/verify (No Token)',
      passed: resUnauth.status === 401
    });

    // 4. Working Folder Selector Status
    const resWs = await fetch(`http://127.0.0.1:${port}/api/workspace`, {
      headers: { 'X-Session-Token': sessionToken }
    });
    const dataWs = await resWs.json();
    checks.push({
      control: 'Working Folder Selector Display',
      route: 'GET /api/workspace',
      passed: resWs.status === 200 && dataWs.projectCwd === CWD,
      details: dataWs
    });

    // 5. Terminal Status Query
    const resTermStatus = await fetch(`http://127.0.0.1:${port}/api/terminals`, {
      headers: { 'X-Session-Token': sessionToken }
    });
    const dataTermStatus = await resTermStatus.json();
    checks.push({
      control: 'Terminal Status Query (Claude & Gemini CLI)',
      route: 'GET /api/terminals',
      passed: resTermStatus.status === 200 && dataTermStatus.claude && dataTermStatus.gemini,
      details: dataTermStatus
    });

    // 6. Task List Query
    const resTasks = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
      headers: { 'X-Session-Token': sessionToken }
    });
    const dataTasks = await resTasks.json();
    checks.push({
      control: 'Task List & History Display',
      route: 'GET /api/tasks',
      passed: resTasks.status === 200 && Array.isArray(dataTasks.tasks) && (dataTasks.persistence === 'DURABLE' || dataTasks.persistence === 'SESSION_ONLY'),
      details: { taskCount: dataTasks.tasks.length, persistence: dataTasks.persistence }
    });

  } finally {
    await server.shutdown();
  }

  const allPassed = checks.every(c => c.passed);
  console.log(`Suite 1 Results: ${checks.filter(c => c.passed).length}/${checks.length} passed.`);
  return { suite: '01_ui_control_inventory', passed: allPassed, checks };
}

run().then(res => {
  if (!res.passed) process.exit(1);
  process.exit(0);
}).catch(err => {
  console.error(err);
  process.exit(1);
});
