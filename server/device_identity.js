import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

let cachedIdentity = null;

export function getDeviceIdentity() {
  if (cachedIdentity) {
    return cachedIdentity;
  }

  const dir = path.join(os.homedir(), '.workbench');
  const filePath = path.join(dir, 'device_identity.json');

  if (fs.existsSync(filePath)) {
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (data && data.id) {
        cachedIdentity = {
          id: data.id,
          hostname: data.hostname || os.hostname()
        };
        return cachedIdentity;
      }
    } catch (e) {
      // Fall through to recreate if corrupted
    }
  }

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const newIdentity = {
    id: crypto.randomUUID(),
    hostname: os.hostname(),
    createdAt: new Date().toISOString()
  };

  fs.writeFileSync(filePath, JSON.stringify(newIdentity, null, 2), 'utf8');

  cachedIdentity = {
    id: newIdentity.id,
    hostname: newIdentity.hostname
  };

  return cachedIdentity;
}
