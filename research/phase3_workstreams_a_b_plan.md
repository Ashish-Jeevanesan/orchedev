# Phase 3 Audit & Implementation Plan: Workstreams A & B

**Workspace:** `D:\Ashish_P\AI-Tools\custom-OCT`  
**Date:** October 30, 2026  
**Status:** **AUDIT & IMPLEMENTATION PLAN (WORKSTREAMS A & B ONLY)**  
**Target:** Reliability, State Machine Rigor & Crash Resilience  

---

## 1. Workstream A Audit: Task Lifecycle Reliability

### 1.1 Current Implementation Review (`server/intercom_service.js`)
Currently, `IntercomService` defines 12 states:
`CREATED`, `APPROVAL_REQUESTED`, `APPROVED`, `QUEUED_FOR_CLAIM`, `CLAIMED`, `RUNNING`, `COMPLETED`, `FAILED`, `CANCELLED`, `TIMED_OUT`, `REJECTED`, `EXPIRED`.

The terminal states are:
`TERMINAL_STATES = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'REJECTED', 'EXPIRED'])`.

### 1.2 Concrete Reliability Gaps Identified

| # | Reliability Gap | Current Code Behavior | Risk / Failure Mode |
| :- | :--- | :--- | :--- |
| **A1** | **No Formal Transition Matrix** | `_transitionTask(task, newState)` only checks if `task.state` is in `TERMINAL_STATES`. | Any non-terminal state can theoretically jump to any other state (e.g. `CREATED` $\to$ `COMPLETED`, or `APPROVAL_REQUESTED` $\to$ `RUNNING` bypassing approval). |
| **A2** | **Asymmetrical Mutability in `failTask`** | `failTask()` mutates `task.completedAt` and `task.error` in memory *before* calling `_transitionTask()`. | If `failTask()` is called on an already cancelled or completed task, `_transitionTask` throws, but the in-memory object has already been partially mutated. |
| **A3** | **Unacknowledged Cancellation in Flight** | When a task is cancelled while `CLAIMED` or `RUNNING`, `cancelDelegation()` sets `task.cancellationRequested = true`, but returns without defining what happens if the worker later calls `completeTask()`. | If Gemini later finishes and calls `completeTask()`, the task is completed without acknowledging that cancellation was requested. |
| **A4** | **Generic Error Codes on Duplicates** | Duplicate correlation IDs and duplicate claims throw generic `new Error(...)` strings without machine-readable error codes. | Clients and API handlers cannot distinguish between transient concurrency conflicts and fatal errors. |
| **A5** | **Dual API Redundancy in UI** | `TaskViewController.loadInitialTasks()` in `public/js/task_view.js` queries both `/api/tasks` and `/api/intercom/tasks`, processing the same items twice. | Leads to UI re-render flickering and potential race conditions in task card lists. |

### 1.3 Proposed State Machine Specification

We will implement a formal **Allowed Transition Matrix** in `server/intercom_service.js`:

```javascript
export const ALLOWED_TRANSITIONS = Object.freeze({
  [DelegationState.CREATED]: new Set([
    DelegationState.APPROVAL_REQUESTED,
    DelegationState.QUEUED_FOR_CLAIM,
    DelegationState.CANCELLED
  ]),
  [DelegationState.APPROVAL_REQUESTED]: new Set([
    DelegationState.APPROVED,
    DelegationState.REJECTED,
    DelegationState.CANCELLED,
    DelegationState.TIMED_OUT,
    DelegationState.EXPIRED
  ]),
  [DelegationState.APPROVED]: new Set([
    DelegationState.QUEUED_FOR_CLAIM,
    DelegationState.CANCELLED
  ]),
  [DelegationState.QUEUED_FOR_CLAIM]: new Set([
    DelegationState.CLAIMED,
    DelegationState.CANCELLED,
    DelegationState.TIMED_OUT,
    DelegationState.EXPIRED
  ]),
  [DelegationState.CLAIMED]: new Set([
    DelegationState.RUNNING,
    DelegationState.FAILED,
    DelegationState.CANCELLED,
    DelegationState.TIMED_OUT
  ]),
  [DelegationState.RUNNING]: new Set([
    DelegationState.COMPLETED,
    DelegationState.FAILED,
    DelegationState.CANCELLED,
    DelegationState.TIMED_OUT
  ]),
  // Terminal states allow NO transitions:
  [DelegationState.COMPLETED]: new Set(),
  [DelegationState.FAILED]: new Set(),
  [DelegationState.CANCELLED]: new Set(),
  [DelegationState.TIMED_OUT]: new Set(),
  [DelegationState.REJECTED]: new Set(),
  [DelegationState.EXPIRED]: new Set()
});
```

### 1.4 Structured Error Hierarchy
Define strongly-typed custom error classes for deterministic error handling:
- `TaskStateError` (`code: ERR_INVALID_TRANSITION`)
- `TaskTerminalError` (`code: ERR_TERMINAL_STATE`)
- `TaskDuplicateError` (`code: ERR_DUPLICATE_TASK`)
- `TaskSecurityError` (`code: ERR_SECURITY_VIOLATION`)

---

## 2. Workstream B Audit: Crash Recovery & Persistence

### 2.1 Current Implementation Review
Persistence is file-based via `storageFile = path.join(this.cwd, '.workbench_tasks.json')`.
- On boot, `_loadPersistedTasks()` parses JSON and transitions `CLAIMED`/`RUNNING` tasks to `FAILED`.
- On updates, `_persist()` writes to `.tmp_${Date.now()}` and executes `fs.renameSync()`.

### 2.2 Concrete Reliability Gaps Identified

| # | Reliability Gap | Current Code Behavior | Risk / Failure Mode |
| :- | :--- | :--- | :--- |
| **B1** | **Windows Atomic Rename Lock Contention** | `fs.renameSync(tempFile, this.storageFile)` does not handle Windows file lock contention (e.g. Antivirus, Windows Search Indexer, IDE watchers). | On Windows, `renameSync` throws `EPERM` or `EBUSY` if the destination handle was briefly held. When it fails, the update is dropped and orphaned `.tmp_*` files accumulate. |
| **B2** | **Concurrent Write Race** | Rapid consecutive state changes trigger multiple `_persist()` calls synchronously in the same tick. | Multiple temporary files are written concurrently, risking out-of-order renames or corrupted state. |
| **B3** | **Unprotected JSON Parse Failures** | If `.workbench_tasks.json` is corrupted or partially written, `_loadPersistedTasks()` catches the error and leaves `this.delegations` empty. | The next state write immediately overwrites `.workbench_tasks.json`, permanently destroying all prior history without leaving a backup for recovery. |
| **B4** | **Unchecked Timeout Recovery on Boot** | Tasks loaded from disk that were in `APPROVAL_REQUESTED` or `QUEUED_FOR_CLAIM` before shutdown do not check if their timeout budget expired while the server was offline. | A task created days ago could be resurrected and claimed as fresh without checking time limits. |
| **B5** | **Orphaned Temporary File Accumulation** | Interrupted write attempts leave `.workbench_tasks.json.tmp_*` files in the workspace root. | Disk pollution in project directory. |

### 2.3 Proposed Persistence Architecture (Zero New Databases)

We do **not** need SQLite or an external database. The JSON file architecture is simple, transparent, and portable. We will harden it with a **Serialized Atomic Persistence Queue**:

1. **Serialized Write Queue:**
   - Coalesce multiple rapid state updates into a single asynchronous write pass.
   - If a write is in-flight, flag `this.hasPendingPersist = true` and flush immediately after completion.
2. **Windows Retry Engine for `rename`:**
   - Implement exponential backoff retry (up to 5 attempts across 100ms) for Windows `EPERM`/`EBUSY` rename locks.
   - Fallback to safe atomic write-replace (`copyFileSync` + `unlinkSync`).
3. **Emergency Backup on Malformed JSON:**
   - If `JSON.parse` fails during `_loadPersistedTasks()`, immediately save an emergency backup:
     `.workbench_tasks.json.corrupt_${Date.now()}`.
   - Emit a high-signal diagnostic warning in `logs/workbench.log`.
4. **Offline Expiry Catch-up on Boot:**
   - During `_loadPersistedTasks()`, evaluate tasks against their configured timeout budget.
   - If `task.state === 'APPROVAL_REQUESTED'` or `'QUEUED_FOR_CLAIM'` and `now - task.createdAt > task.timeoutMs`:
     Safely transition to `EXPIRED` or `TIMED_OUT` with `actor: 'coordinator_recovery'`.
5. **Orphaned Tmp File Cleanup:**
   - On coordinator startup, glob and remove any existing `.workbench_tasks.json.tmp_*` files left by abnormal process crashes.

---

## 3. Implementation Plan: Workstreams A & B

### Step 1: Formal Transition Matrix & Typed Errors (`server/intercom_service.js`)
1. Add `ALLOWED_TRANSITIONS` table.
2. Update `_transitionTask(task, newState, reason, actor)`:
   - Check `ALLOWED_TRANSITIONS[task.state]?.has(newState)`.
   - Throw `TaskStateError` if transition is invalid.
   - Prevent state mutation if validation fails.
3. Add `ERR_*` error codes for duplicate claims, stale sessions, and invalid transitions.

### Step 2: In-Flight Cancellation & Acknowledgment (`server/intercom_service.js`)
1. Extend `cancelDelegation()`:
   - When cancelling an active (`CLAIMED`/`RUNNING`) task, set `task.cancellationRequested = true`.
   - Add `confirmCancellation({ agentId, sessionId, correlationId, reason })` allowing the worker agent to acknowledge cancellation and cleanly transition to `CANCELLED`.
2. Update `completeTask()`:
   - If `task.cancellationRequested === true`, record in `task.stateHistory` that completion arrived after cancellation request, and transition state appropriately.

### Step 3: Hardened Atomic Persistence & Windows Retry Engine (`server/intercom_service.js`)
1. Implement `_persistAsync()` with serialized queue:
   ```javascript
   async _persist() {
     if (this.isPersisting) {
       this.pendingPersist = true;
       return;
     }
     this.isPersisting = true;
     try {
       await this._atomicWriteWithRetry();
     } finally {
       this.isPersisting = false;
       if (this.pendingPersist) {
         this.pendingPersist = false;
         this._persist();
       }
     }
   }
   ```
2. Implement `_atomicWriteWithRetry()`:
   - Write to unique temp file.
   - Attempt atomic rename with retry loop (5 attempts, 20ms delays) handling Windows `EPERM`/`EBUSY`.
   - Remove temp file on error.

### Step 4: Boot Recovery, Expiry Catch-Up & Corruption Protection (`server/intercom_service.js`)
1. Clean up orphaned `.tmp_*` files on startup.
2. In `_loadPersistedTasks()`:
   - Try-catch `JSON.parse`.
   - If malformed: copy to `.corrupt_<timestamp>` backup before initializing empty map.
   - For `CLAIMED`/`RUNNING` tasks: transition to `FAILED` with recovery record in `stateHistory`.
   - For `APPROVAL_REQUESTED`/`QUEUED_FOR_CLAIM` tasks: check if elapsed time exceeds timeout budget; transition to `EXPIRED` if budget exceeded.

### Step 5: Master Regression Test Suite (`tests/test_phase3_workstreams_a_b.js`)
Create a dedicated test suite verifying:
- **Test 1:** All valid state transitions succeed and append to `stateHistory`.
- **Test 2:** Invalid transitions throw `ERR_INVALID_TRANSITION` and preserve state.
- **Test 3:** Terminal states cannot be transitioned (`ERR_TERMINAL_STATE`).
- **Test 4:** Cancellation requested on running task preserves flag and allows worker confirmation.
- **Test 5:** Duplicate correlation IDs rejected with `ERR_DUPLICATE_TASK` (HTTP 400).
- **Test 6:** Rapid concurrent state updates serialize to disk without partial writes or file lock errors.
- **Test 7:** Corrupted JSON files trigger automatic `.corrupt_*` backup without crashing server.
- **Test 8:** Server restart recovery converts running tasks to `FAILED` and catches up expired tasks.
- **Test 9:** Recovered queued tasks remain available in Gemini's inbox for manual claim.

---

## 4. Architectural Boundaries Preserved

- **Zero Process Model Changes:** Exactly 1 interactive Claude ConPTY session, exactly 1 interactive Gemini ConPTY session, 1 stdio bridge per CLI.
- **Zero Hidden Workers:** No ACP workers, no headless background Claude/Gemini agents.
- **Zero Automated Stdin Injection:** No simulated typing or fake claiming.
- **Zero API Keys:** Preserves local OAuth / subscription logins.
- **Scope Limit:** Workstreams A & B only. Workstreams C through G remain untouched until A & B are verified.

---

## 5. Next Step

Please review and confirm whether you approve this **Audit and Implementation Plan for Workstreams A and B**. Once approved, we will apply the surgical enhancements to `server/intercom_service.js`, add the new regression suite `tests/test_phase3_workstreams_a_b.js`, and run all verification passes.
