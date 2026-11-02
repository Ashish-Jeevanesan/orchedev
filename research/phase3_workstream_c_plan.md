# Phase 3 Workstream C Audit & Implementation Plan: Session Health & Reconnection

**Workspace:** `D:\Ashish_P\AI-Tools\custom-OCT`  
**Date:** October 30, 2026  
**Status:** **AUDIT & IMPLEMENTATION PLAN (WORKSTREAM C ONLY)**  
**Target:** Session Registration Accuracy, Stale Session Detection, MCP Bridge Reconnection, Queued Task Preservation, and Real-Time UI Health Observability  

---

## 1. Executive Summary & Existing Architecture Findings

### 1.1 Architecture Baseline
In the Agent Workbench, orchestration occurs between two authoritative interactive ConPTY sessions:
1. **Interactive Claude Code CLI** (ConPTY session managing planning, peer discovery, and delegation).
2. **Interactive Gemini CLI** (ConPTY session managing task inbox queries, manual claiming, and execution).

Each CLI spawns an independent child stdio process running `server/mcp/workbench_mcp_bridge.js`:
- Claude loads `.workbench/claude_mcp_config.json` via `--mcp-config`.
- Gemini loads `.gemini/settings.json` via workspace settings.
- The bridges communicate with `WorkbenchServer` via loopback REST API (`/api/intercom/*`) authenticated with `X-Session-Token`.

### 1.2 Concrete Gaps Identified in Existing Implementation

| # | Component | Current Implementation | Concrete Reliability Gap | Risk / Failure Mode |
| :- | :--- | :--- | :--- | :--- |
| **C1** | `server/intercom_service.js` | `registerAgent` blindly overwrites `this.activePeers.set(agentId, peer)` without timestamp or sequence validation. | A delayed registration packet from an old or terminated session could theoretically overwrite an active, newer session. | Stale session overwrites authoritative session. |
| **C2** | `server/mcp/workbench_mcp_bridge.js` | Heartbeat sends `POST /api/intercom/heartbeat`. If coordinator returns `{ status: 'unrecognized_peer' }`, the response is ignored. | If the coordinator restarted or cleared peers, the bridge continues sending failed heartbeats without re-registering. | Bridge remains dead/unrecognized until manual CLI restart. |
| **C3** | `server/intercom_service.js` | `_checkHeartbeats()` marks peers `OFFLINE` after 25s, but does not distinguish temporary network delays from terminal disconnects. | A temporary CLI hang (e.g. heavy AST parsing or local build) flips the peer to `OFFLINE` prematurely. | False offline alerts and UI flickering. |
| **C4** | `server/intercom_service.js` | `claimTask()` validates `sessionId`, but does not verify whether the peer status is active (`ONLINE` or `BUSY`). | An agent in an `OFFLINE` or `UNREACHABLE` state could theoretically claim tasks if its session ID matches. | Task claimed by a potentially unresponsive session. |
| **C5** | `public/js/app.js` & `public/index.html` | UI only displays ConPTY process status (`RUNNING` / `STOPPED`), ignoring `peer_status` events broadcast by `IntercomService`. | User cannot see whether the MCP bridge is connected, online, or busy. A CLI might show "RUNNING" while its MCP bridge has crashed or disconnected. | Operator confusion; user does not know why `discover_peers` or delegations fail. |
| **C6** | `server/intercom_service.js` | Heartbeat expiry vs Task Execution: When an agent disconnects, `disconnectAgent` marks running tasks `FAILED`, but if a session merely misses heartbeats, the behavior was ambiguous. | Tasks could be prematurely aborted during long-running compiler steps that block stdio. | Legitimate work aborted. |

---

## 2. Session Lifecycle Model

We propose a formal 4-state session lifecycle model for registered agents:

```
                  ┌────────────────────────┐
                  │      UNREGISTERED      │
                  └───────────┬────────────┘
                              │
                    registerAgent() [POST /api/intercom/register]
                              │
                              ▼
                  ┌────────────────────────┐
                  │         ONLINE         │◄──────────────┐
                  └──────┬───────────▲─────┘               │
                         │           │                     │
           claimTask()   │           │ completeTask()      │ Heartbeat
                         ▼           │                     │ Resumed
                  ┌──────────────────┴─────┐               │
                  │          BUSY          │               │
                  └──────┬─────────────────┘               │
                         │                                 │
           Missed 15s    │ Missed 15s                      │
           Heartbeats    │ Heartbeats                      │
                         ▼                                 │
                  ┌────────────────────────┐               │
                  │      UNREACHABLE       ├───────────────┘
                  └───────────┬────────────┘
                              │
           Missed 30s Heartbeats OR Explicit disconnectAgent()
                              │
                              ▼
                  ┌────────────────────────┐
                  │        OFFLINE         │
                  └────────────────────────┘
```

### Peer Record Specification:
```javascript
export const AgentStatus = Object.freeze({
  ONLINE: 'ONLINE',           // Registered, active heartbeats, idle and ready
  BUSY: 'BUSY',               // Registered, actively executing a claimed task
  UNREACHABLE: 'UNREACHABLE', // Missed heartbeats (15s-30s), grace period
  OFFLINE: 'OFFLINE'          // Missed heartbeats (>30s) or explicitly disconnected
});
```

---

## 3. Heartbeat & Stale-Session Policy

### 3.1 Timing Parameters
- **Bridge Heartbeat Cadence:** Every `10,000ms` (10s).
- **Coordinator Evaluation Cadence:** Checked every `2,500ms` (2.5s) inside `IntercomService`.
- **Grace Period Threshold (`UNREACHABLE`):** `15,000ms` (15s, 1.5 missed heartbeats).
  - Emits warning diagnostic log: `INTERCOM:AGENT_UNREACHABLE`.
  - Broadcasts UI notification `peer_status` with `status: 'UNREACHABLE'`.
  - **Does NOT abort active running tasks.**
- **Disconnect Threshold (`OFFLINE`):** `30,000ms` (30s, 3 missed heartbeats).
  - Emits error diagnostic log: `INTERCOM:AGENT_HEARTBEAT_TIMEOUT`.
  - Broadcasts UI notification `peer_status` with `status: 'OFFLINE'`.
  - If the agent has in-flight `CLAIMED` or `RUNNING` tasks:
    - Waits for a 10s grace period. If process PID is verified dead via OS probe (`process.kill(pid, 0)`), transition task to `FAILED` (`Agent process exited or disconnected`).
    - Tasks in `QUEUED_FOR_CLAIM` are **strictly preserved** and remain in the inbox for the next session.

### 3.2 Monotonic Registration Protection
To prevent old or zombie sessions from overwriting a newly established session:
```javascript
registerAgent({ agentId, sessionId, pid, cliVersion, cwd, capabilities }) {
  const existing = this.activePeers.get(agentId);
  const now = Date.now();

  // Guard: If existing session is online and was registered more recently, reject stale registration
  if (existing && existing.sessionId !== sessionId && existing.status !== AgentStatus.OFFLINE) {
    if (existing.lastHeartbeat > now - 15000) {
      logger.warn('INTERCOM:REGISTRATION_SUPERSEDED_REJECTED', ...);
      throw new TaskSecurityError(
        `Active session '${existing.sessionId}' already registered for agent '${agentId}'. Stale registration rejected.`,
        'ERR_SESSION_CONFLICT'
      );
    }
  }
  ...
}
```

---

## 4. Reconnection Protocol

### 4.1 Bridge Auto-Reconnection & Re-registration Loop
In `server/mcp/workbench_mcp_bridge.js`:
1. **Heartbeat Health Check:**
   When `POST /api/intercom/heartbeat` returns `{ status: 'unrecognized_peer' }`:
   - Bridge logs: `[MCP Bridge ${AGENT_ID}] Peer unrecognized by coordinator. Re-registering session...`
   - Bridge calls `coordinatorFetch('/api/intercom/register', 'POST', ...)` to restore registration immediately.
2. **Exponential Backoff on Network Disconnect:**
   If `WorkbenchServer` restarts while the CLI terminal remains open:
   - Heartbeat attempts fail with `ECONNREFUSED`.
   - Bridge retries with exponential backoff: 2s, 4s, 8s, up to 15s cap.
   - Once coordinator returns HTTP 200, bridge automatically re-registers and resumes normal 10s heartbeat cadence.

### 4.2 Terminal Restart Handling
When a user clicks "Restart" on a terminal tab:
1. `TerminalManager.restartTerminal(id)` terminates the old PTY process tree (including the old bridge).
2. The old bridge's `process.stdin.on('close')` fires `shutdownBridge()`, sending `POST /api/intercom/disconnect` with `oldSessionId`.
3. ConPTY spawns the new CLI process with updated environment / config.
4. The new CLI starts its bridge, generating `newSessionId`.
5. The new bridge registers with the coordinator.
6. Coordinator updates `activePeers.get(agentId)` to `newSessionId` and broadcasts `peer_status: ONLINE`.
7. Any previously queued tasks in `QUEUED_FOR_CLAIM` remain claimable by the new session.

---

## 5. Task Assignment Safety

### 5.1 Claim Invariants
In `IntercomService.claimTask()`:
- **Session Identity Match:** `peer.sessionId === sessionId`.
- **Session Status Invariant:** `peer.status !== AgentStatus.OFFLINE`. Tasks cannot be claimed by offline or dead sessions.
- **Working Directory Check:** Task directory must match peer directory (case-insensitive path resolution).
- **State Invariant:** Task must be in `QUEUED_FOR_CLAIM`.

### 5.2 Delegation Target Validation
In `createDelegation()`:
- When Claude delegates to Gemini via `delegate_to_gemini`:
  - Coordinator checks if `gemini` peer exists and returns peer connectivity info.
  - If Gemini is `OFFLINE` or unregistered, the task is still queued (`QUEUED_FOR_CLAIM` after approval), but the tool response gives Claude a clear informational warning:
    `"Task queued successfully for Gemini. Note: Gemini CLI MCP bridge is currently OFFLINE/UNREACHABLE. Task will be available for claiming once Gemini connects."`

---

## 6. UI Visibility & Health Indicator Enhancements

### 6.1 Dual Health Indicators (PTY Process + MCP Bridge)
Currently, tab badges only show ConPTY status: `RUNNING` / `STOPPED`.
We propose adding an MCP Bridge Status indicator to each tab:
- **Tab Header:**
  - `Claude Code CLI` [PTY: RUNNING] [MCP: ONLINE]
  - `Gemini CLI` [PTY: RUNNING] [MCP: ONLINE]
- **Status Dot Colors:**
  - `ONLINE`: Bright Green (`#10b981`)
  - `BUSY`: Blue (`#3b82f6`)
  - `UNREACHABLE`: Amber Blink (`#f59e0b`)
  - `OFFLINE`: Gray / Red (`#ef4444`)

### 6.2 Frontend WebSocket Handler (`public/js/app.js`)
Wire `peer_status` handler:
```javascript
} else if (msg.type === 'peer_status') {
  this.terminalView.updatePeerStatuses(msg.payload);
}
```
Update `TerminalViewController` to reflect peer connection state, session ID, and last heartbeat age on the active tab and meta-bar.

---

## 7. Regression & Acceptance Test Matrix (`tests/test_phase3_workstream_c.js`)

We will create a dedicated test suite verifying:

| Test # | Test Name | Verification Objective |
| :--- | :--- | :--- |
| **C-T1** | Registration & Initial Health | Verify `registerAgent` records PID, CWD, sessionId, and sets status to `ONLINE`. |
| **C-T2** | Heartbeat Updates Timestamp | Verify `recordHeartbeat` refreshes `lastHeartbeat` and keeps peer `ONLINE`. |
| **C-T3** | Heartbeat Rejection on Stale Session | Heartbeat presenting an invalid or old `sessionId` is rejected (`status: 'unrecognized_peer'`). |
| **C-T4** | Graceful Transition to UNREACHABLE | Peer with no heartbeat for 15s transitions to `UNREACHABLE` without aborting tasks. |
| **C-T5** | Transition to OFFLINE after 30s | Peer with no heartbeat for 30s transitions to `OFFLINE`. |
| **C-T6** | Bridge Auto-Re-registration | When heartbeat returns `unrecognized_peer`, bridge automatically re-registers. |
| **C-T7** | Queued Tasks Preserved across Disconnect | Tasks in `QUEUED_FOR_CLAIM` remain claimable when Gemini disconnects and reconnects. |
| **C-T8** | Stale Session Rejected from Claiming | Offline or mismatched session cannot claim queued tasks (`ERR_SECURITY_VIOLATION`). |
| **C-T9** | Terminal Restart Sequence | Simulating terminal kill + respawn updates session ID cleanly and preserves queued tasks. |
| **C-T10** | Monotonic Session Precedence | Delayed registration packet with old timestamp cannot overwrite newer active session. |

---

## 8. Security & Architectural Invariants

- **Zero Process Model Changes:** Still exactly 1 Claude ConPTY session and 1 Gemini ConPTY session.
- **Zero Automated Spawning:** Reconnection does NOT automatically launch new terminal windows; it reconnects existing or manually restarted terminals.
- **Zero Simulated Typing:** All task claiming remains explicit via native CLI commands (`claim_task`).
- **No Permissions Bypass:** Native CLI permission prompts remain 100% active.
- **No Database Addition:** In-memory registry with durable task correlation in `.workbench_tasks.json`.

---

## 9. Next Step

Please review and confirm whether you approve this **Audit and Implementation Plan for Workstream C**. Once approved, we will apply the surgical enhancements, create the test suite `tests/test_phase3_workstream_c.js`, and run full verification.
