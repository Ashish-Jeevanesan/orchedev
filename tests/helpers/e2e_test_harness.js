// tests/helpers/e2e_test_harness.js
// Phase 3 Workstream H: End-to-End Regression Test Harness
// Provides fully isolated test environments, programmatic server lifecycles,
// protocol-level MCP fixtures, WebSocket event collectors, and safe teardown.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import WebSocket from 'ws';
import { WorkbenchServer } from '../../server/server.js';
import { DelegationState } from '../../server/intercom_service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

export class E2ETestHarness {
  constructor(suiteName = 'e2e_h') {
    this.suiteName = suiteName;
    this.fixtureRoot = path.join(PROJECT_ROOT, 'tests', 'temp_workspace_h_e2e');
    this.activeServers = [];
    this.activeSockets = [];
    this.activePeers = [];
    this.createdDirs = new Set();
  }

  createFixtureDir(subName = 'main') {
    const fixtureDir = path.join(this.fixtureRoot, `${this.suiteName}_${subName}_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`);
    if (fs.existsSync(fixtureDir)) {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
    fs.mkdirSync(fixtureDir, { recursive: true });
    this.createdDirs.add(fixtureDir);
    return fixtureDir;
  }

  async startIsolatedServer({ fixtureDir = null, port = 0, timeouts = {} } = {}) {
    const cwd = fixtureDir || this.createFixtureDir('server');
    const server = new WorkbenchServer({ cwd, port });
    const { port: allocatedPort, sessionToken } = await server.start();

    // Apply custom test timeouts if provided
    if (server.intercomService && Object.keys(timeouts).length > 0) {
      if (timeouts.approvalTimeoutMs) server.intercomService.timeouts.approvalTimeoutMs = timeouts.approvalTimeoutMs;
      if (timeouts.claimTimeoutMs) server.intercomService.timeouts.claimTimeoutMs = timeouts.claimTimeoutMs;
      if (timeouts.executionTimeoutMs) server.intercomService.timeouts.executionTimeoutMs = timeouts.executionTimeoutMs;
    }

    const instance = {
      server,
      port: allocatedPort,
      sessionToken,
      cwd,
      intercom: server.intercomService,
      auth: server.workspaceAuth
    };

    this.activeServers.push(instance);
    return instance;
  }

  async createMockMcpBridgePeer({ port, sessionToken, agentId, sessionId, cwd, capabilities = ['test'] }) {
    const resolvedCwd = path.resolve(cwd);
    const peerSessionId = sessionId || `mock_${agentId}_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;

    // Register with Intercom
    const regRes = await fetch(`http://127.0.0.1:${port}/api/intercom/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': sessionToken
      },
      body: JSON.stringify({
        agentId,
        sessionId: peerSessionId,
        pid: process.pid,
        cwd: resolvedCwd,
        capabilities
      })
    });

    const regData = await regRes.json();
    if (!regRes.ok) {
      throw new Error(regData.error || `Registration failed for ${agentId}`);
    }

    // Protocol client facade
    const peer = {
      agentId,
      sessionId: peerSessionId,
      generation: regData.generation || 1,
      cwd: resolvedCwd,
      heartbeatTimer: null,

      async delegate({ targetAgent, instructions, plan, expectedFiles, requiresApproval = true, timeoutMs = 30000 }) {
        const res = await fetch(`http://127.0.0.1:${port}/api/intercom/delegate`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Session-Token': sessionToken
          },
          body: JSON.stringify({
            fromAgent: agentId,
            toAgent: targetAgent,
            instructions,
            plan,
            expectedFiles,
            cwd: resolvedCwd,
            requiresApproval,
            timeoutMs
          })
        });
        const data = await res.json();
        return { ok: res.ok, status: res.status, data };
      },

      async getInbox() {
        const res = await fetch(`http://127.0.0.1:${port}/api/intercom/inbox?agentId=${agentId}&cwd=${encodeURIComponent(resolvedCwd)}`, {
          headers: { 'X-Session-Token': sessionToken }
        });
        return await res.json();
      },

      async claim(correlationId) {
        const res = await fetch(`http://127.0.0.1:${port}/api/intercom/claim`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Session-Token': sessionToken
          },
          body: JSON.stringify({
            agentId,
            sessionId: peerSessionId,
            correlationId,
            cwd: resolvedCwd
          })
        });
        const data = await res.json();
        return { ok: res.ok, status: res.status, data };
      },

      async reportProgress(correlationId, step, percent, message) {
        const res = await fetch(`http://127.0.0.1:${port}/api/intercom/progress`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Session-Token': sessionToken
          },
          body: JSON.stringify({
            agentId,
            sessionId: peerSessionId,
            correlationId,
            step,
            percent,
            message
          })
        });
        const data = await res.json();
        return { ok: res.ok, status: res.status, data };
      },

      async complete(correlationId, summary = 'Completed', modifiedFiles = [], testResults = 'PASS') {
        const res = await fetch(`http://127.0.0.1:${port}/api/intercom/complete`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Session-Token': sessionToken
          },
          body: JSON.stringify({
            agentId,
            sessionId: peerSessionId,
            correlationId,
            summary,
            modifiedFiles,
            testResults
          })
        });
        const data = await res.json();
        return { ok: res.ok, status: res.status, data };
      },

      async fail(correlationId, error = 'Failed', failureDetails = {}) {
        const res = await fetch(`http://127.0.0.1:${port}/api/intercom/fail`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Session-Token': sessionToken
          },
          body: JSON.stringify({
            agentId,
            sessionId: peerSessionId,
            correlationId,
            error,
            failureDetails
          })
        });
        const data = await res.json();
        return { ok: res.ok, status: res.status, data };
      },

      async confirmCancel(correlationId, reason = 'Cancelled cleanly') {
        const res = await fetch(`http://127.0.0.1:${port}/api/intercom/confirm_cancel`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Session-Token': sessionToken
          },
          body: JSON.stringify({
            agentId,
            sessionId: peerSessionId,
            correlationId,
            reason
          })
        });
        const data = await res.json();
        return { ok: res.ok, status: res.status, data };
      },

      async sendHeartbeat() {
        const res = await fetch(`http://127.0.0.1:${port}/api/intercom/heartbeat`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Session-Token': sessionToken
          },
          body: JSON.stringify({
            agentId,
            sessionId: peerSessionId,
            generation: peer.generation
          })
        });
        return await res.json();
      },

      async disconnect() {
        if (peer.heartbeatTimer) {
          clearInterval(peer.heartbeatTimer);
          peer.heartbeatTimer = null;
        }
        try {
          await fetch(`http://127.0.0.1:${port}/api/intercom/disconnect`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Session-Token': sessionToken
            },
            body: JSON.stringify({ agentId, sessionId: peerSessionId })
          });
        } catch (e) {}
      }
    };

    this.activePeers.push(peer);
    return peer;
  }

  async connectEventCollector(port, sessionToken) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/events`, [`token.${sessionToken}`], {
      headers: { Origin: `http://127.0.0.1:${port}` }
    });

    const collector = {
      ws,
      messages: [],
      workbenchEvents: [],

      async waitForEvent(predicate, timeoutMs = 5000) {
        const startTime = Date.now();
        while (Date.now() - startTime < timeoutMs) {
          const found = collector.workbenchEvents.find(predicate);
          if (found) return found;
          await new Promise(r => setTimeout(r, 20));
        }
        return null;
      },

      close() {
        try { ws.close(); } catch (e) {}
      }
    };

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket connect timed out')), 4000);
      ws.on('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        collector.messages.push(msg);
        if (msg.type === 'workbench_event' && msg.payload) {
          collector.workbenchEvents.push(msg.payload);
        }
      } catch (e) {}
    });

    this.activeSockets.push(collector);
    return collector;
  }

  async cleanupAll() {
    // 1. Disconnect active peers
    for (const peer of this.activePeers) {
      try { await peer.disconnect(); } catch (e) {}
    }
    this.activePeers = [];

    // 2. Close active sockets
    for (const collector of this.activeSockets) {
      try { collector.close(); } catch (e) {}
    }
    this.activeSockets = [];

    // 3. Shutdown servers
    for (const inst of this.activeServers) {
      try { await inst.server.shutdown(); } catch (e) {}
    }
    this.activeServers = [];

    // 4. Clean disposable directories
    for (const dir of this.createdDirs) {
      try {
        if (fs.existsSync(dir)) {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      } catch (e) {}
    }
    this.createdDirs.clear();
  }
}
