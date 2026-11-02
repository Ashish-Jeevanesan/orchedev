# Phase 3 Workstream C Implementation Report: Session Health & Reconnection

**Workspace:** `D:\Ashish_P\AI-Tools\custom-OCT`  
**Date:** October 30, 2026  
**Status:** **IMPLEMENTED & VERIFIED (WORKSTREAM C COMPLETE)**  
**Target:** Session Registration Accuracy, Stale Session Protection, Heartbeat Degradation, Bridge Reconnection, Claim Safety, and Real-Time UI Health Observability  

---

## 1. Executive Summary

Phase 3 Workstream C has been implemented and validated across all regression suites without modifying the approved orchestration model. The workbench maintains exactly one visible interactive Claude Code ConPTY session, exactly one visible interactive Gemini CLI ConPTY session, independent stdio MCP bridges, human-supervised task approval modal, and strict loopback network isolation.

### Key Capabilities Delivered:
1. **Coordinator-Controlled Monotonic Registration Generations:** Assigned monotonic generation counter (`generation: 1, 2, ...`) per agent on the coordinator. Delayed registration packets from old sessions are rejected with typed `TaskSecurityError` (`ERR_SESSION_CONFLICT`) without overwriting active healthy sessions.
2. **Idempotent Re-registration:** Same-session re-registration updates timestamps and restores active states without bumping generation or throwing conflicts.
3. **4-State Session Health Lifecycle:** Implemented `ONLINE`, `BUSY`, `UNREACHABLE` (grace period at 15s), and `OFFLINE` (at 30s) evaluation cadence (every 2.5s). Heartbeat degradation to `UNREACHABLE` does **not** abort active running tasks.
4. **Bridge Auto-Re-registration & Exponential Backoff:** When a bridge heartbeat receives `{ status: 'unrecognized_peer' }`, the bridge automatically re-registers with the coordinator under the same session ID. Network disruptions apply backoff with jitter capped at 15s, and fatal auth errors halt cleanly.
5. **Session Health Claim Safety:** `claimTask()` strictly verifies that the claiming peer is `ONLINE` or `BUSY`. Claims from `UNREACHABLE` or `OFFLINE` sessions are rejected with `ERR_SECURITY_VIOLATION`.
6. **Task Preservation Invariant:** Tasks in `QUEUED_FOR_CLAIM` are strictly preserved when an agent disconnects or restarts, remaining immediately claimable upon reconnection.
7. **Dual UI Health Indicators:** Added separate real-time status badges for ConPTY process state (`PTY: RUNNING` / `STOPPED`) and MCP bridge state (`MCP: ONLINE`, `BUSY`, `UNREACHABLE`, `OFFLINE`) on terminal tabs and the meta-bar.

---

## 2. Source Files Changed & Rationale

| File | Change Type | Rationale |
| :--- | :--- | :--- |
| `server/intercom_service.js` | Modified | Added `AgentStatus.UNREACHABLE`, coordinator monotonic generation tracking (`this.agentGenerations`), stale registration rejection (`ERR_SESSION_CONFLICT`), 2.5s heartbeat evaluation loop, 2-stage degradation (15s/30s), active task protection during `UNREACHABLE`, recovery on heartbeat, and `claimTask` offline/unreachable guards. |
| `server/mcp/workbench_mcp_bridge.js` | Modified | Added automatic session re-registration on `unrecognized_peer` response, exponential backoff with jitter (capped at 15s) for coordinator connectivity disruptions, and backoff reset on success. |
| `public/index.html` | Modified | Added dedicated `mcp-badge-claude` and `mcp-badge-gemini` status indicators to tab buttons and `term-mcp-status` to the terminal meta-bar. |
| `public/js/terminal_view.js` | Modified | Added `updatePeerStatuses(peers)` to render color-coded MCP status badges (`ONLINE`, `BUSY`, `UNREACHABLE`, `OFFLINE`) with hover tooltips showing session ID, generation, and last heartbeat age. Invalidated MCP status on terminal restart. |
| `public/js/app.js` | Modified | Added `peer_status` WebSocket message routing to `terminalView.updatePeerStatuses()` and queried initial peers during session verification. |
| `package.json` | Modified | Added `"test:workstream_c"` script pointing to the dedicated test suite. |
| `tests/test_phase3_workstream_c.js` | Created | Comprehensive 43-assertion test suite covering all 16 minimum verification requirements for Workstream C. |
| `research/phase3_workstream_c_plan.md` | Created | Approved audit and design specification. |
| `research/phase3_workstream_c_implementation_report.md` | Created | This formal deliverable. |

---

## 3. Session State Transition Implementation

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

### Complete Invariant Mapping:

| State | Definition | Permitted Next States | Task Claim Permitted? | Active Task Aborted? |
| :--- | :--- | :--- | :--- | :--- |
| `ONLINE` | Registered, heartbeat < 15s, idle | `BUSY`, `UNREACHABLE`, `OFFLINE` | **Yes** | No |
| `BUSY` | Registered, heartbeat < 15s, executing task | `ONLINE`, `UNREACHABLE`, `OFFLINE` | No (already busy) | No |
| `UNREACHABLE` | Heartbeat between 15s and 30s (grace period) | `ONLINE`, `BUSY`, `OFFLINE` | **No** (rejected) | **No** (grace period) |
| `OFFLINE` | Heartbeat $\ge$ 30s or explicit disconnect | `ONLINE` (on re-registration) | **No** (rejected) | Only on confirmed exit |

---

## 4. Registration Generation & Stale-Session Protection

1. **Coordinator-Controlled Monotonic Counter:**
   - In `IntercomService`, `this.agentGenerations.set(agentId, nextGen)` controls session ordering.
   - Client timestamps are never trusted as the authority for session ordering.
2. **Stale Session Conflict Protection:**
   - If an incoming registration presents a different `sessionId` while an existing session is `ONLINE` or `BUSY` with fresh heartbeats (< 15s), registration is rejected:
     `TaskSecurityError: Session conflict: Agent '${agentId}' already has an active session '${existing.sessionId}' (generation ${existing.generation}). Stale or concurrent registration rejected.`
     `code: 'ERR_SESSION_CONFLICT'`
3. **Idempotent Re-registration:**
   - When a bridge re-registers with the same `sessionId`, the coordinator updates `lastHeartbeat`, restores status from `UNREACHABLE`/`OFFLINE` to `ONLINE` or `BUSY`, and preserves the generation counter.
4. **Delayed Disconnect and Heartbeat Protection:**
   - `recordHeartbeat()` and `disconnectAgent()` require exact `peer.sessionId === sessionId` matching. Delayed packets from old terminated sessions return `false` without touching the active session.

---

## 5. Heartbeat & Reconnection Behavior

- **Cadence:** Bridge sends heartbeats every 10 seconds.
- **Evaluation:** Coordinator checks heartbeats every 2.5 seconds (`2500ms`).
- **Degradation:**
  - At 15s elapsed: Peer transitions to `UNREACHABLE`. Emits `INTERCOM:AGENT_UNREACHABLE` warning. Broadcasts `peer_status`. Active tasks continue unaffected.
  - At 30s elapsed: Peer transitions to `OFFLINE`. Emits `INTERCOM:AGENT_HEARTBEAT_TIMEOUT`. Broadcasts `peer_status`.
- **Recovery:** A valid heartbeat from the current session immediately restores peer status to `BUSY` (if it has running tasks) or `ONLINE`, broadcasting the updated status.
- **Bridge Re-registration on Unrecognized Session:** If coordinator restarts and drops in-memory peers, the next heartbeat returns `{ status: 'unrecognized_peer' }`. The bridge automatically calls `/api/intercom/register` with the same session ID, restoring connectivity with an incremented generation.

---

## 6. Claim & Queue Safety

1. **Strict Claim Validation in `claimTask()`:**
   - Exact `peer.sessionId === sessionId` matching.
   - Peer status must be `ONLINE` or `BUSY`. If `peer.status === AgentStatus.OFFLINE` or `AgentStatus.UNREACHABLE`, throws `TaskSecurityError` (`ERR_SECURITY_VIOLATION`).
   - Task state must be `QUEUED_FOR_CLAIM`.
   - Working directory matching (case-insensitive path comparison).
2. **Queued Task Preservation Invariant:**
   - When Gemini explicitly disconnects or misses heartbeats, `QUEUED_FOR_CLAIM` tasks are **never deleted or failed**.
   - When Gemini reconnects, all queued tasks remain immediately available in `getInbox()`.

---

## 7. UI Health Indicators

- **Tab Badges:** Each tab displays two distinct badges:
  - `PTY: RUNNING` (Green) or `PTY: STOPPED` (Outline).
  - `MCP: ONLINE` (Green), `MCP: BUSY` (Blue), `MCP: UNREACHABLE` (Amber blinking), or `MCP: OFFLINE` (Outline).
- **Meta-Bar:** Displays `MCP: <STATUS>` reflecting the active terminal's bridge health.
- **Tooltip Detail:** Hovering over the MCP badge displays `MCP Session: <ID>`, `Gen: <GEN>`, and `Last Heartbeat: <N>s ago`.
- **Lifecycle Invalidation:** Terminating or restarting a terminal immediately resets the MCP badge to `MCP: OFFLINE` until the new bridge registers.

---

## 8. Test Commands & Exact Results

### Master Test Matrix (All 10 Suites Passed — 100% Pass Rate):

| Test Command | Test Suite Description | Tests | Result |
| :--- | :--- | :--- | :--- |
| `npm run test:workstream_c` | Phase 3 Workstream C Dedicated Suite | 43 / 43 | **PASSED** |
| `npm run test:workstreams_ab` | Phase 3 Workstreams A & B Regression Suite | 39 / 39 | **PASSED** |
| `npm run test:dispatch_unify` | Phase 2.1 Dispatch Unification Suite | 21 / 21 | **PASSED** |
| `npm run test:phase2` | Phase 2 Human-Supervised Delegation Acceptance | 53 / 53 | **PASSED** |
| `npm run test:mcp` | Phase 1 MCP Bridge Lifecycle & Agent Registration | 29 / 29 | **PASSED** |
| `npm run test:cli_mcp` | Phase 1.1 Live Interactive CLI MCP Integration (3 Suites) | 41 / 41 | **PASSED** |
| `npm run test:audit` | Full Acceptance Audit (4 Suites) | 30 / 30 | **PASSED** |
| `npm run test:core` | Core Reliability Test Matrix (8 Suites) | 8 / 8 | **PASSED** |
| `npm run test:ui` | Full UI & Server Integration Test Suite (10 Tests) | 10 / 10 | **PASSED** |
| `node tests/test_verify_user_workflow.js` | SpineIT-ERP Read-Only Verification Target | 1 / 1 | **PASSED** |
| **TOTAL** | **Across all 10 verification suites** | **275 / 275** | **100% PASSED** |

---

## 9. Process Model Verification

- Exactly one interactive Claude Code ConPTY session (`C:\Users\ajeevanesan\.local\bin\claude.exe`).
- Exactly one interactive Gemini CLI ConPTY session (`bundle/gemini.js`).
- One stdio MCP bridge child process per CLI (`server/mcp/workbench_mcp_bridge.js`).
- **Zero hidden workers:** No background ACP or headless agent processes exist.
- **Zero automated stdin injection:** All task claiming is explicit via native CLI commands (`claim_task`).

---

## 10. Security Verification

- Loopback-only binding: Server binds strictly to `127.0.0.1:0`.
- Session Token Authentication: Enforced via `X-Session-Token` on all REST and WebSocket connections.
- Origin Validation: External origins rejected with HTTP 403 Forbidden.
- Protected Workspaces: `C:\pmt\bit\SpineIT-ERP` verified completely untouched.
- Native Permission Prompts: Native Claude and Gemini file/command confirmation prompts remain fully enabled.

---

## 11. Known Limitations & Scope Boundary

- **Workstream Scope:** Strictly limited to Workstream C. Workstreams D through H remain untouched.
- **Next Phase:** Awaiting explicit review and authorization before proceeding.
