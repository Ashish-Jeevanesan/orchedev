import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';
import { getDeviceIdentity } from '../server/device_identity.js';

async function run() {
  console.log('Testing device identity...');

  const expectedFilePath = path.join(os.homedir(), '.workbench', 'device_identity.json');

  // Call 1
  const id1 = getDeviceIdentity();
  assert(id1, 'Expected getDeviceIdentity() to return an identity object');
  assert(typeof id1.id === 'string' && id1.id.length > 0, 'Expected id string');
  assert(typeof id1.hostname === 'string', 'Expected hostname string');
  assert(fs.existsSync(expectedFilePath), `Expected ${expectedFilePath} to exist on disk`);

  const fileData = JSON.parse(fs.readFileSync(expectedFilePath, 'utf8'));
  assert.strictEqual(fileData.id, id1.id, 'File id matches returned id');
  assert.strictEqual(fileData.hostname, id1.hostname, 'File hostname matches returned hostname');

  // Call 2 (memory cached)
  const id2 = getDeviceIdentity();
  assert.strictEqual(id2.id, id1.id, 'Repeated call returned cached device id');
  assert.strictEqual(id2.hostname, id1.hostname, 'Repeated call returned cached hostname');

  console.log('PASS: getDeviceIdentity verified successfully', id1);
}

run().catch((err) => {
  console.error('FAIL:', err);
  process.exit(1);
});
