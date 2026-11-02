# Phase 3 Workstream E Audit & Implementation Plan: Timeout & Cancellation Reliability

**Workspace:** `D:\Ashish_P\AI-Tools\custom-OCT`  
**Date:** October 30, 2026  
**Status:** **AUDIT & IMPLEMENTATION PLAN (WORKSTREAM E ONLY)**  
**Target:** Approval vs. Execution Budget Decoupling, Deterministic State Clock Architecture, Interactive Process Preservation, and Late-Completion State Invariants  

---

## 1. Executive Summary & Existing Architecture Findings

### 1.1 Architecture Baseline
The Agent Workbench operates an asynchronous delegation pipeline:
1. Claude or User submits task $\to$ `APPROVAL_REQUESTED`.
2. Human approves via UI $\to$ `APPROVED` $\to$ `QUEUED_FOR_CLAIM`.
3. Gemini discovers and claims task $\to$ `CLAIMED` $\to$ `RUNNING`.
4. Gemini reports completion $\to$ `COMPLETED` (or error $\to$ `FAILED`).
5. Claude long-polls `GET /api/intercom/tasks/:id/wait` via `IntercomService.waitForCompletion()`.

### 1.2 Concrete Gaps Identified in Existing Implementation

| # | Component | Current Implementation | Concrete Reliability Gap | Risk / Failure Mode |
| :- | :--- | :--- | :--- | :--- |
| **E1** | `server/intercom_service.js` | `waitForCompletion(correlationId, timeoutMs)` starts a single static `setTimeout` with `executionTimeoutMs` (e.g. 15m) at task creation. | If human approval takes 10 minutes, `waitForCompletion`'s timer has already consumed 10 minutes of execution time. | Worker's execution is prematurely aborted even though the task only ran for 5 minutes. |
| **E2** | `server/intercom_service.js` | `_handleTimeout()` transitions task to `TIMED_OUT` using a generic timeout message without specifying which lifecycle phase expired. | Client cannot distinguish an approval expiration from an execution timeout. | Ambiguous error diagnostics. |
| **E3** | `server/intercom_service.js` | If an agent calls `completeTask()` after a task has already reached `TIMED_OUT`, it throws a generic error and drops the completed work. | Worker completed the algorithm slightly late, but the work is lost and not recorded for human audit. | Silent loss of late-completed worker output. |
| **E4** | `server/server.js` | `GET /api/intercom/tasks/:id/wait` holds the HTTP request open indefinitely until resolution or server timeout. | If HTTP connection drops (e.g. client network blip), the coordinator promise could hang in memory. | Memory leak of unresolved promise handles. |
| **E5** | `server/intercom_service.js` | Interactive CLI process vs. Task Timeout: Need explicit verification that a task timing out does NOT terminate the ConPTY process or kill the interactive session. | Operator's interactive terminal session could be unexpectedly terminated by a task failure. | Unnecessary disruption of developer terminal session. |

---

## 2. Formal Timeout Policy & Budget Decoupling

Timeouts are strictly decoupled into three independent, non-overlapping lifecycle budgets:

```
  [CREATED]
      │
      ▼
[APPROVAL_REQUESTED]  ──► Clock A: approvalTimeoutMs (default: 15m)
      │                   [Waiting for human does NOT consume execution time]
      ▼
  [APPROVED]
      │
      ▼
[QUEUED_FOR_CLAIM]    ──► Clock B: claimTimeoutMs (default: 15m)
      │                   [Time in inbox does NOT consume execution time]
      ▼
   [CLAIMED]
      │
      ▼
   [RUNNING]          ──► Clock C: executionTimeoutMs (default: 15m)
      │                   [Full 15m execution budget granted upon claim]
      ▼
  [COMPLETED]
```

### Complete Budget Policy:

| Phase | State | Dedicated Timeout | Clock Starts At | Clock Resets / Halts At |
| :--- | :--- | :--- | :--- | :--- |
| **1. Approval Phase** | `APPROVAL_REQUESTED` | `approvalTimeoutMs` (default: 15m) | Task submission timestamp (`approvalRequestedAt`) | When human approves or rejects |
| **2. Inbox Claim Phase** | `QUEUED_FOR_CLAIM` | `claimTimeoutMs` (default: 15m) | Approval timestamp (`approvedAt`) | When Gemini claims task (`claimTime`) |
| **3. Execution Phase** | `CLAIMED` $\to$ `RUNNING` | `executionTimeoutMs` (default: 15m) | Worker claim timestamp (`startedAt` / `claimTime`) | When worker completes, fails, or cancels |

---

## 3. Deterministic Lifecycle Clock Architecture

### 3.1 Eliminating the Flawed Pre-Approval Timer in `waitForCompletion`
Currently, `waitForCompletion` starts a single `setTimeout` when called. We will replace this with **State-Aware Resolution**:
1. `waitForCompletion` subscribes to coordinator task resolution.
2. The coordinator's `_checkLifecycleTimeouts()` (evaluating every 2.5s) is the **single authoritative clock**.
3. When `_checkLifecycleTimeouts()` determines that `now - approvalRequestedAt > approvalTimeoutMs`, it transitions the task to `TIMED_OUT` with reason:
   `Delegation approval timed out after ${budget}ms awaiting human review`
4. When `_checkLifecycleTimeouts()` determines that `now - startedAt > executionTimeoutMs`, it transitions the task to `TIMED_OUT` with reason:
   `Task execution timed out after ${budget}ms during worker execution`
5. `waitForCompletion`'s pending resolution promise is resolved/rejected based on the coordinator's state change, ensuring that waiting for human approval never consumes a single millisecond of execution time!

---

## 4. Interactive Process Preservation vs. Task Timeout Invariant

### Mandate:
*"Do not kill an interactive CLI process merely because an individual task timed out. Distinguish a task timeout from a terminal/session failure."*

### Specification:
- When a task times out during execution:
  1. The task transitions to `TIMED_OUT` in the coordinator and `.workbench_tasks.json`.
  2. The worker peer status (`gemini`) is reverted from `BUSY` to `ONLINE`.
  3. The ConPTY process (`gemini.js` / `claude.exe`) is **STRICTLY PRESERVED** and remains alive.
  4. The terminal WebSocket remains open, and the user can continue typing in the CLI.
  5. The MCP bridge remains running, healthy, and ready to claim subsequent tasks.

---

## 5. In-Flight Cancellation & Late Completion Semantics

### 5.1 Honest Cancellation Reporting
- When a user clicks "Cancel" on an active task (`CLAIMED` or `RUNNING`):
  - Coordinator returns `{ status: 'cancellation_requested' }`.
  - The task state remains `RUNNING` with `cancellationRequested = true`.
  - The system **never lies** that the process has stopped until the worker confirms cancellation.

### 5.2 Late Completion Preservation
- If Gemini finishes and calls `report_task_completion` after cancellation was requested:
  - Task transitions to `CANCELLED` (never `COMPLETED`).
  - Completed summary, modified files, and test results are preserved in `task.lateCompletion`.
- If Gemini finishes and calls `report_task_completion` after execution timeout (`TIMED_OUT`):
  - Task state remains `TIMED_OUT` (terminal state immutability preserved).
  - Completed summary and modified files are preserved in `task.lateCompletion`.
  - Coordinator returns `{ success: false, timedOut: true, lateRecorded: true, summary }` rather than crashing or throwing an unhandled exception.

---

## 6. Implementation Strategy & Code Enhancements

### 6.1 `server/intercom_service.js`
1. **Decouple `waitForCompletion`:** Remove premature static `setTimeout` that consumes execution budget during approval. Let `_checkLifecycleTimeouts()` drive phase-specific timeouts deterministically.
2. **Phase-Specific Timeout Error Messages:** Update `_checkLifecycleTimeouts()` to format clear, phase-specific diagnostic errors:
   - `ERR_APPROVAL_TIMEOUT: Delegation approval timed out after ${budget}ms`
   - `ERR_CLAIM_TIMEOUT: Task claim timed out after ${budget}ms`
   - `ERR_EXECUTION_TIMEOUT: Task execution timed out after ${budget}ms`
3. **Late Completion on `TIMED_OUT` Tasks:**
   In `completeTask()`: If `task.state === DelegationState.TIMED_OUT`:
   - Preserve completed work in `task.lateCompletion = { summary, modifiedFiles, testResults, timestamp: Date.now() }`.
   - Save persistence queue (`this._persist()`).
   - Log `INTERCOM:LATE_COMPLETION_PRESERVED` warning.
   - Return `{ timedOut: true, lateCompletion: task.lateCompletion }`.

### 6.2 `server/server.js`
1. Add query parameter support to `GET /api/intercom/tasks/:id/wait?pollTimeout=30000`:
   If the client HTTP connection times out before task completion, respond with HTTP `204 No Content` or `{ status: 'still_running' }` so the client can safely re-poll without aborting the task.

### 6.3 `server/mcp/workbench_mcp_bridge.js`
1. In `get_delegation_status`: Return explicit phase-specific diagnostics and `lateCompletion` data if available.

---

## 7. Proposed Regression Test Suite (`tests/test_phase3_workstream_e.js`)

We will create a dedicated regression suite verifying:

| Test # | Test Name | Verification Objective |
| :--- | :--- | :--- |
| **E-T1** | Approval Timeout Independence | Awaiting human approval consumes zero execution budget; approval budget times out independently. |
| **E-T2** | Claim Timeout Independence | Approved task in queue consumes zero execution budget; claim budget times out independently. |
| **E-T3** | Full Execution Budget Granted Upon Claim | Task gets the full `executionTimeoutMs` starting from the claim timestamp, regardless of approval delay. |
| **E-T4** | Interactive Process Preservation on Timeout | Task execution timeout transitions task to `TIMED_OUT` while ConPTY process remains alive (PID alive, peer `ONLINE`). |
| **E-T5** | Honest In-Flight Cancellation | `cancelDelegation` on running task reports `cancellation_requested` without falsely claiming process stopped. |
| **E-T6** | Worker Cancellation Confirmation | Explicit `confirmCancellation` cleanly transitions task to `CANCELLED` and restores peer to `ONLINE`. |
| **E-T7** | Late Completion After Cancellation | Worker completing task after cancellation request transitions to `CANCELLED` with work preserved in `lateCompletion`. |
| **E-T8** | Late Completion After Timeout | Worker completing task after `TIMED_OUT` preserves `TIMED_OUT` state and records work in `lateCompletion`. |
| **E-T9** | Terminal State Immutability | Late failure or late cancellation on `COMPLETED` or `TIMED_OUT` task cannot mutate terminal state. |
| **E-T10** | Deterministic Coordinator Clock | Verifies `_checkLifecycleTimeouts()` evaluates budgets with consistent, deterministic timestamp math. |
| **E-T11** | HTTP Long-Poll Re-poll Safety | Client re-polling `wait` endpoint receives updated state without leaking handles or duplicating timers. |
| **E-T12** | Structured Diagnostic Error Codes | Timeout errors contain typed codes (`ERR_APPROVAL_TIMEOUT`, `ERR_EXECUTION_TIMEOUT`). |

---

## 8. Security & Architectural Invariants Preserved

- **Zero Hidden Workers:** No background ACP or headless agent processes.
- **Zero Process Model Changes:** Exactly 1 interactive Claude ConPTY session, exactly 1 interactive Gemini ConPTY session.
- **Zero Simulated Typing:** All task claiming remains manual in the visible Gemini terminal.
- **Native Permissions Preserved:** CLI permission prompts remain fully active.
- **Protected Paths:** `C:\pmt\bit\SpineIT-ERP` remains 100% untouched.

---

## 9. Next Step & Stop Condition

Please review and confirm whether you approve this **Audit and Implementation Plan for Workstream E**. Once approved, we will apply the surgical enhancements, create the test suite `tests/test_phase3_workstream_e.js`, and run full regression verification.
