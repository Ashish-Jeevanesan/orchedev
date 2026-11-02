# Phase 2.1 Implementation Report: Unified Dispatch Task & Elimination of Headless Execution

**Workspace:** `D:\Ashish_P\AI-Tools\custom-OCT`  
**Date:** October 30, 2026  
**Status:** **PHASE 2.1 UNIFICATION & VERIFICATION COMPLETE (100% PASS)**  
**Architecture Reference:** `research/phase0_1_architecture_clarifications.md`  

---

## Executive Summary

Phase 2.1 completes the unification of the **Dispatch Task Panel** with the **Phase 2 Human-Supervised Intercom Delegation Pipeline**, and permanently removes the legacy `_executeWorkflow` headless runner.

Key architectural and behavioral changes:
1. **Elimination of Legacy Headless Runner:** The `_executeWorkflow` method in `server/task_coordinator_service.js` (which spawned background `ClaudeStreamClient` and `GeminiAcpClient` processes with rigid 49-second wall-clock timers) has been **completely removed**. Calling `targetAgent: 'claude_gemini_workflow'` now routes directly to the human-supervised Intercom pipeline.
2. **Unified Dispatch Task Pipeline:** Tasks dispatched from the UI Dispatch Task panel or `POST /api/tasks` are correctly created as **user-originated tasks** (`fromAgent: 'user'`, `toAgent: 'gemini'`) with **mandatory human approval** (`APPROVAL_REQUESTED`). They are **never** falsely attributed as planned by Claude.
3. **Withholding Until Approval:** Unapproved user tasks are strictly withheld from Gemini's inbox until the human clicks **[Approve Plan]** in the Approval Modal.
4. **Authoritative Interactive Session Execution:** Approved tasks become `QUEUED_FOR_CLAIM` in Gemini's inbox. The developer switches to the visible interactive Gemini ConPTY terminal, types `claim`, and Gemini executes visibly on screen and reports completion through MCP.
5. **Claude MCP Delegation Unaffected:** True cross-agent delegation originates from the visible interactive Claude terminal when Claude calls `delegate_to_gemini()`, which follows the exact same approval gate, claim queue, and completion review loop.
6. **Zero Headless Agent Processes:** Spawning of secondary background Claude or Gemini agent processes for delegated tasks is 100% eliminated.

---

## 1. Architectural Unification

```
┌────────────────────────────────────────────────────────────────────────┐
│                   UNIFIED AGENT WORKBENCH ARCHITECTURE                 │
│                                                                        │
│   ENTRY POINT 1: USER DISPATCH PANEL    ENTRY POINT 2: CLAUDE TERMINAL │
│   (UI /api/tasks: fromAgent = 'user')   (MCP delegate: from = 'claude')│
│                 │                                     │                │
│                 └─────────────────┐   ┌───────────────┘                │
│                                   ▼   ▼                                │
│                   ┌───────────────────────────────────────┐            │
│                   │      IntercomService Delegation       │            │
│                   │        State Machine & Queue          │            │
│                   │   - State: APPROVAL_REQUESTED         │            │
│                   │   - Durable: .workbench_tasks.json    │            │
│                   └───────────────────┬───────────────────┘            │
│                                       │                                │
│                                       ▼                                │
│                   ┌───────────────────────────────────────┐            │
│                   │      HUMAN APPROVAL GATE (UI MODAL)   │            │
│                   │      - User Inspects / Edits / Rejects│            │
│                   │      - Clicks [Approve Plan]          │            │
│                   └───────────────────┬───────────────────┘            │
│                                       │ (State: QUEUED_FOR_CLAIM)      │
│                                       ▼                                │
│                   ┌───────────────────────────────────────┐            │
│                   │        GEMINI INBOX (MCP Bridge)      │            │
│                   │        - Discovered via get_inbox()   │            │
│                   │        - Claimed via claim_task()     │            │
│                   └───────────────────┬───────────────────┘            │
│                                       │                                │
│                                       ▼                                │
│                   ┌───────────────────────────────────────┐            │
│                   │      ONE AUTHORITATIVE GEMINI         │            │
│                   │      (Interactive ConPTY Terminal)    │            │
│                   │      - Executes visibly in workspace  │            │
│                   │      - Native CLI permission prompts  │            │
│                   │      - Calls report_task_completion() │            │
│                   └───────────────────────────────────────┘            │
│                                                                        │
│   * ZERO HEADLESS AGENT PROCESSES SPAWNED                             │
│   * ZERO SIMULATED PTY TYPING                                          │
│   * USER TASKS AND CLAUDE DELEGATIONS SHARE THE SAME AUTHORITATIVE CORE│
└────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Detailed Root-Cause Resolution for Task `CORR_1793368426782_G0CRY`

| Diagnostic Question | Root Cause Identified | Corrective Solution Implemented |
| :--- | :--- | :--- |
| **Why did Claude timeout after 49s?** | Legacy `_executeWorkflow` in `server/task_coordinator_service.js` calculated `Math.floor(140000 * 0.35) = 49000ms` and applied a rigid wall-clock timer in `core/claude_stream_client.js`. | Removed legacy `_executeWorkflow`. Tasks now use human approval and visible terminals with generous 15-minute budgets. |
| **Was it invoking the visible terminal?** | No. It was invoking a hidden background process via `ProcessManager.spawnManaged()`. The visible terminal was bypassed. | Unified all dispatches to target the visible authoritative interactive session via the MCP bridge. Zero background processes spawned. |
| **Was the timeout applied to the wrong operation?** | Yes. It was an arbitrary wall-clock timer applied to headless Turn 1 rather than an inactivity watchdog. | Replaced with decoupled lifecycle stages with independent timeout budgets. |
| **Why was no approval request generated?** | The legacy runner bypassed `IntercomService.createDelegation()`. | Routed `POST /api/tasks` through `IntercomService.createDelegation({ requiresApproval: true })`. |
| **Attribution Distinction** | Dispatch Task submissions were previously forced through Claude Turn 1. | Correctly labeled as `fromAgent: 'user'` targeting `toAgent: 'gemini'`, requiring explicit human approval. |

---

## 3. Files Created and Modified

1. `server/server.js`:
   - Updated `POST /api/tasks` to route submissions through `this.intercomService.createDelegation()` with approval gating.
   - Updated `GET /api/tasks` to return delegations from `this.intercomService.getAllDelegations()`.
   - Updated `GET /api/tasks/:correlationId` to resolve from `IntercomService`.
   - Updated `POST /api/tasks/:correlationId/cancel` to cancel through `IntercomService.cancelDelegation()`.
2. `server/task_coordinator_service.js`:
   - Completely deleted the legacy `_executeWorkflow` runner.
   - Replaced `claude_gemini_workflow` dispatch with an explicit rejection error directing users to the unified pipeline.
3. `server/intercom_service.js`:
   - Added duplicate correlation ID rejection (`if (this.delegations.has(corrId)) throw Error(...)`).
   - Verified state machine transitions and audit logging.
4. `server/terminal_manager.js`:
   - Added automatic cleanup of ephemeral `.gemini/settings.json` and `.workbench/claude_mcp_config.json` files on terminal shutdown/restart.
5. `public/index.html`:
   - Simplified Dispatch Task `#agent-selector` to target `Gemini CLI (Interactive Session)`.
   - Added guidance tip explaining how to initiate Claude $\to$ Gemini delegations from the Claude terminal.
6. `public/js/task_view.js`:
   - Updated `submitTask()` to submit tasks with `requiresApproval: true` and immediately open the Approval Modal.
7. `tests/test_phase2_dispatch_unification.js`:
   - New acceptance test suite verifying user dispatch, approval gating, inbox withholding, visible Gemini claim, and zero headless spawning (21 assertions).
8. `package.json`:
   - Added `test:dispatch_unify` test script.

---

## 4. Test Suite Execution & Acceptance Results

### Master Test Summary:

| Test Suite | Command | Assertions / Tests | Status |
| :--- | :--- | :---: | :---: |
| **Dispatch Task Unification** | `npm run test:dispatch_unify` | 21 / 21 assertions | **PASSED (100%)** |
| **Phase 2 Human-Supervised Delegation** | `npm run test:phase2` | 53 / 53 assertions | **PASSED (100%)** |
| **Phase 1 MCP Stdio Bridge** | `npm run test:mcp` | 29 / 29 assertions | **PASSED (100%)** |
| **Live CLI Interactive MCP Suite** | `npm run test:cli_mcp` | 41 / 41 assertions | **PASSED (100%)** |
| **Full Acceptance Audit Matrix** | `npm run test:audit` | 4 / 4 suites (30 tests) | **PASSED (100%)** |
| **Core Reliability Tests** | `npm run test:core` | 8 / 8 files | **PASSED (100%)** |
| **UI Integration Suite** | `npm run test:ui` | 10 / 10 tests | **PASSED (100%)** |
| **Terminal Tab Switch Regression** | `npm run test:tabs` | Full persistence | **PASSED (100%)** |
| **Working Directory Matrix** | `npm run test:cwd` | 6 / 6 matrix checks | **PASSED (100%)** |
| **Terminal CWD Restart** | `npm run test:restart_cwd` | 5 / 5 checks | **PASSED (100%)** |
| **Single Character Echo** | `npm run test:echo` | 1:1 echo verified | **PASSED (100%)** |
| **SpineIT-ERP Read-Only Workflow** | `node tests/test_verify_user_workflow.js` | Full pipeline | **PASSED (100%)** |

---

## 5. Process Ownership Verification

Running process table during task dispatch:
- **Interactive Terminal 1:** `claude.exe` (ConPTY interactive session).
- **Interactive Terminal 2:** `node.exe` (Gemini CLI ConPTY interactive session).
- **Protocol Adapter 1:** `node.exe server/mcp/workbench_mcp_bridge.js --agent claude` (stdio transport).
- **Protocol Adapter 2:** `node.exe server/mcp/workbench_mcp_bridge.js --agent gemini` (stdio transport).
- **Background Headless Agents:** **0 (Zero)**.
- **Simulated Typing Injections:** **0 (Zero)**.

---

## 6. Stop Condition Reached

Phase 2.1 corrective unification is complete. No Phase 3 code has been written. All 12 test suites are passing at 100%. Awaiting your review and explicit approval.
