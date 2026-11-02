# Phase 3 Workstream F: CWD Authorization Remediation Report

**Workspace:** `D:\Ashish_P\AI-Tools\custom-OCT`  
**Date:** October 30, 2026  
**Status:** **REMEDIATION COMPLETE & VERIFIED (455 / 455 TESTS PASSING)**  
**Target:** Close the Medium-severity CWD authorization gap and verify authorized roots persistence & boot restoration order.

---

## 1. Existing Implementation Findings & Gap Analysis

In the initial Workstream F audit, the following gap was identified:
- **Observation:** `IntercomService.createDelegation()` verified that a working directory existed (`fs.existsSync`), was accessible, and was a directory (`fs.statSync().isDirectory()`), and that null bytes (`\0` and `%00`) were rejected.
- **Vulnerability:** It did **not** enforce an explicit authorized-workspace boundary. An authenticated client could request an arbitrary existing local directory on the machine (e.g., `C:\Windows\Temp` or another user's folder), and if that directory existed, the coordinator created the delegation.
- **Root Cause:** Absence of a centralized working-directory authorization service enforcing canonical realpath containment against configured authorized workspace roots.

---

## 2. Centralized Authorized-Root Architecture (`server/workspace_authorization.js`)

A dedicated, centralized authorization service was designed and implemented: `WorkspaceAuthorizationService`.

### 2.1 Authorized-Root Policy & Defaults
- **Default Base Root:** The Workbench project root (`baseCwd = process.cwd()`, e.g., `D:\Ashish_P\AI-Tools\custom-OCT`) is authorized by default.
- **Explicit Project Roots:** Additional project workspaces (such as `C:\pmt\bit\SpineIT-ERP` or user-selected folders) are explicitly added via `addAllowedRoot(path)`.
- **UI Workspace Selection:** When the user switches workspaces via `/api/workspace/select` or `/api/workspace/browse`, the realpath of the selected workspace is registered with `workspaceAuth.addAllowedRoot(realResolved)`.
- **Test Workspaces:** Disposable automated test directories (e.g., `tests/temp_workspace_cwd_auth`) are explicitly passed to `allowedRoots` during testing.

### 2.2 Strict Rejection Invariants
1. **No Drive-Wide Authorizations:** Bare drive roots (e.g., `C:\`, `D:\`, or `/`) are rejected from registration (`canonical.toLowerCase() === parsed.root.toLowerCase()` returns `false`).
2. **No Automatic `os.tmpdir()`:** The operating system temporary directory is **not** automatically authorized.
3. **No Unknown Root Expansion:** The system never silently expands allowed roots when an unknown directory is requested.
4. **No Device Paths:** Windows raw device paths (e.g., `\\.\` and `\\?\`) are explicitly rejected with `TaskSecurityError`.
5. **No UNC Shares:** Network UNC paths (e.g., `\\server\share`) are rejected unless explicitly registered in `allowedRoots`.

### 2.3 Authorized Roots Persistence & Boot Restoration Order
- **Storage Location:** Durable authorized workspace roots are persisted in `.workbench_workspaces.json` located within the Workbench root directory.
- **Initialization Order:**
  1. `WorkbenchServer` is instantiated; in its constructor, `new WorkspaceAuthorizationService({ baseCwd: cwd })` runs **first**.
  2. `WorkspaceAuthorizationService` constructor executes `_loadPersistedRoots()` before any other coordinator component starts.
  3. `_loadPersistedRoots()` reads `.workbench_workspaces.json`, parses the entries, and re-validates each directory against the strict security invariants.
  4. Only after all authorized roots are restored into memory does `server.start()` instantiate `IntercomService`.
  5. `IntercomService` constructor runs `_loadPersistedTasks()`.
  6. When `_loadPersistedTasks()` validates `task.cwd` against `this.workspaceAuth.authorizeCwd(task.cwd)`, previously authorized user project directories (e.g., `C:\Projects\MyApp`) are already recognized as authorized. The task **remains safely in `QUEUED_FOR_CLAIM`** and does not falsely expire.
- **Handling Deleted / Inaccessible Roots:** If a previously authorized directory is deleted, renamed, or inaccessible when Workbench restarts, `_loadPersistedRoots()` detects `!fs.existsSync()` and prunes it from the authorized list, atomically refreshing `.workbench_workspaces.json`. Any recovered task referencing that deleted root fails `authorizeCwd` and correctly transitions to `EXPIRED` with reason `'ERR_CWD_NOT_AUTHORIZED: Persisted task working directory is outside authorized roots'`.
- **Tamper Resistance:** If an adversary or faulty tool edits `.workbench_workspaces.json` to inject bare drives (e.g., `C:\`), device paths, UNC paths, or nonexistent directories, `_loadPersistedRoots()` passes every item through `addAllowedRoot()`. All malformed, non-directory, or bare root drive entries are rejected and removed on startup.

---

## 3. Canonical Path & Filesystem Containment Implementation

For every requested CWD, `WorkspaceAuthorizationService.authorizeCwd(requestedPath, trustedBase)` enforces an 8-step validation pipeline:

1. **Null-Byte Detection:** Rejects paths containing `\0` or `%00`.
2. **Device & UNC Path Rejection:** Rejects device namespaces (`\\.\`, `\\?\`) and unauthorized UNC paths (`\\`).
3. **Trusted Base Resolution:** Resolves relative paths against a trusted base directory (`trustedBase || this.baseCwd`).
4. **Filesystem Existence:** Verifies existence via `fs.statSync(resolvedPath)`.
5. **Directory Verification:** Ensures target is actually a directory (`stat.isDirectory()`).
6. **Filesystem Realpath Resolution:** Evaluates symlinks, Windows directory junctions, and NTFS reparse points via `fs.realpathSync(resolvedPath)`.
7. **Boundary Containment Check:** Uses `path.relative(rootReal, targetReal)`:
   - Windows case-insensitive comparison (`rootReal.toLowerCase()`, `targetReal.toLowerCase()`).
   - Verifies `rel === ''` (exact match) or `(!rel.startsWith('..') && !path.isAbsolute(rel))`.
   - Never relies on simple string-prefix checks (preventing sibling escapes like `custom-OCT-evil`).
8. **Symlink Escape Rejection:** If a symlink or junction inside an authorized workspace points to a target outside the authorized root, `fs.realpathSync()` resolves to the external target, which fails containment check and is rejected.

---

## 4. Enforcement Points Across Task Lifecycle

The centralized authorization policy is enforced identically across all four lifecycle boundaries:

```
[User / Web UI] ──> POST /api/tasks ────────┐
                                            │
[Claude Code]   ──> delegate_to_gemini ─────┼──> WorkspaceAuth.authorizeCwd() ──> Task Created (task.cwd = canonical)
                                            │
[REST API]      ──> /api/intercom/delegate ─┘

                                            │
[Gemini CLI]    ──> claim_task ─────────────┴──> 1. Check agent.cwd === task.cwd
                                                 2. WorkspaceAuth.authorizeCwd(task.cwd)
                                                 3. WorkspaceAuth.authorizeCwd(agent.cwd)
                                                 ──> Claim Succeeded

[Boot Recovery] ──> _loadPersistedTasks() ─────> WorkspaceAuth.authorizeCwd(task.cwd)
                                                 (If unauthorized: state -> EXPIRED)
```

### A. Task Creation & Delegation (`server/intercom_service.js:createDelegation`)
- `const taskCwd = this.workspaceAuth.authorizeCwd(cwd || this.cwd, this.cwd);`
- Throws `TaskSecurityError` with code `ERR_CWD_NOT_AUTHORIZED` before creating the task or requesting human approval.

### B. User-Originated API (`server/server.js:POST /api/tasks` & `POST /api/intercom/delegate`)
- Calls `createDelegation` which routes through `WorkspaceAuthorizationService`.
- Catches `TaskSecurityError` and returns `HTTP 403 Forbidden` with `{ error: 'ERR_CWD_NOT_AUTHORIZED', message: ... }`.

### C. Gemini Task Claim (`server/intercom_service.js:claimTask`)
- **First Check:** Validates working directory match between task and claiming agent session (`agentCwd === task.cwd`).
- **Second Check:** Revalidates `task.cwd` and `agent.cwd` against `this.workspaceAuth.authorizeCwd(...)` at claim time.
- If a directory symlink was changed after task creation to point outside the authorized root, claim is rejected with `ERR_CWD_NOT_AUTHORIZED`.

### D. Startup Recovery (`server/intercom_service.js:_loadPersistedTasks`)
- On coordinator boot, all recovered queued tasks are revalidated against `this.workspaceAuth.authorizeCwd(task.cwd, this.cwd)`.
- If an offline task's working directory is no longer authorized, it transitions safely to `EXPIRED` with reason `'ERR_CWD_NOT_AUTHORIZED: Persisted task working directory is outside authorized roots: <path>'`. It can never become claimable.

---

## 5. Source Files Modified & Added

1. **`server/workspace_authorization.js` (NEW):**
   - Centralized `WorkspaceAuthorizationService` implementation.
   - Enforces realpath resolution, allowed roots whitelist, drive escape prevention, UNC rejection, atomic persistence to `.workbench_workspaces.json`, and boot restoration order.
2. **`server/intercom_service.js` (MODIFIED):**
   - Imported `WorkspaceAuthorizationService`.
   - Initialized `workspaceAuth` in constructor.
   - Added `addAllowedRoot()`, `removeAllowedRoot()`, `getAllowedRoots()`.
   - Updated `createDelegation()` to validate CWD via `workspaceAuth.authorizeCwd()`.
   - Updated `claimTask()` to revalidate CWD at claim time.
   - Updated `_loadPersistedTasks()` to revalidate queued tasks on startup.
3. **`server/server.js` (MODIFIED):**
   - Imported `WorkspaceAuthorizationService` and `TaskSecurityError`.
   - Initialized `this.workspaceAuth` and passed to `IntercomService`.
   - Updated `/api/workspace/select` and `/api/workspace/browse` to register selected roots.
   - Updated `/api/tasks`, `/api/intercom/delegate`, and `/api/intercom/claim` to return HTTP 403 on `TaskSecurityError`.
4. **`server/terminal_manager.js` (MODIFIED during audit):**
   - Surgically prunes only `mcpServers.workbench` on terminal exit, preserving live user edits made while the terminal is running.
5. **`tests/test_phase3_workstream_f_cwd_authorization.js` (NEW):**
   - Comprehensive test suite covering all 24 positive, negative, persistence, restoration order, and tamper resistance test cases (33 assertions).
6. **`tests/test_terminal_restart_cwd.js` (MODIFIED):**
   - Supplied loopback `Origin` header to comply with Workstream F WebSocket origin verification.
7. **`tests/acceptance/run_acceptance_audit.js` (MODIFIED):**
   - Added a 1-second cooldown between acceptance suites to allow Windows ConPTY process trees to release OS handles.
8. **`package.json` (MODIFIED):**
   - Added `"test:cwd_auth": "node tests/test_phase3_workstream_f_cwd_authorization.js"`.

---

## 6. Empirical Test Results

### 6.1 Dedicated CWD Authorization Suite (`npm run test:cwd_auth`)
Command: `node tests/test_phase3_workstream_f_cwd_authorization.js`  
Result: **33 PASSED, 0 FAILED, 0 SKIPPED**

| Test # | Test Description | Result |
| :--- | :--- | :--- |
| **Test 1** | Authorized base workspace root accepted | **PASS** |
| **Test 2** | Authorized nested project directory accepted | **PASS** |
| **Test 3** | Explicitly configured external project root accepted | **PASS** |
| **Test 4** | Authorized symlinked directory within allowed root accepted | **PASS** |
| **Test 5** | Legitimate Dispatch Task creation succeeds | **PASS** |
| **Test 6** | Legitimate Claude MCP delegation queued for claim | **PASS** |
| **Test 7** | Gemini claim succeeds when task and session CWD match | **PASS** |
| **Test 8** | Arbitrary existing directory rejected with `ERR_CWD_NOT_AUTHORIZED` | **PASS** |
| **Test 9** | `C:\Windows\Temp` rejected as unauthorized root | **PASS** |
| **Test 10** | Unauthorized sibling directory rejected at task creation | **PASS** |
| **Test 11** | Parent-directory traversal rejected | **PASS** |
| **Test 12** | Bare Windows root drive `C:\` rejected from registration | **PASS** |
| **Test 13** | Unauthorized UNC path rejected | **PASS** |
| **Test 14** | Symlink inside authorized root pointing outside rejected | **PASS** |
| **Test 15** | Junction escape rejected at `createDelegation` | **PASS** |
| **Test 16** | Relative path resolved against trusted base | **PASS** |
| **Test 17** | CWD changed to unauthorized target after task creation rejected at claim | **PASS** |
| **Test 18** | User Dispatch Task and Claude delegation enforce identical policy | **PASS** |
| **Test 19** | Unauthorized CWD task during boot recovery marked `EXPIRED` | **PASS** |
| **Test 20** | Existing CWD/session mismatch error still enforced | **PASS** |
| **Test 21** | Authorized workspace root persisted to `.workbench_workspaces.json` | **PASS** |
| **Test 22** | Persisted root restored before `_loadPersistedTasks()` (queued task preserved) | **PASS** |
| **Test 23** | Deleted persisted root directory pruned on restart and task safely `EXPIRED` | **PASS** |
| **Test 24** | Tampered entry (bare drive `C:\` or invalid path) rejected and sanitized on load | **PASS** |

---

## 7. Full Regression Summary (455 / 455 Tests Passing — 100% Pass Rate)

| Test Suite | Command | Assertions | Result |
| :--- | :--- | :--- | :--- |
| **CWD Authorization Suite** | `npm run test:cwd_auth` | 33 | **PASSED** |
| **Workstream F Security Suite** | `npm run test:workstream_f` | 37 | **PASSED** |
| **Workstream E Timeout Suite** | `npm run test:workstream_e` | 56 | **PASSED** |
| **Workstream D Observability Suite** | `npm run test:workstream_d` | 54 | **PASSED** |
| **Workstream C Session Health Suite** | `npm run test:workstream_c` | 43 | **PASSED** |
| **Workstreams A & B State/Store Suite** | `npm run test:workstreams_ab` | 39 | **PASSED** |
| **Phase 2.1 Dispatch Unification Suite** | `npm run test:dispatch_unify` | 21 | **PASSED** |
| **Phase 2 Human Supervision Suite** | `npm run test:phase2` | 53 | **PASSED** |
| **Phase 1 MCP Bridge Suite** | `npm run test:mcp` | 29 | **PASSED** |
| **Phase 1.1 Live CLI Suite (3 files)** | `npm run test:cli_mcp` | 41 | **PASSED** |
| **Acceptance Audit Suite (4 files)** | `npm run test:audit` | 30 | **PASSED** |
| **Core Reliability Suite (8 files)** | `npm run test:core` | 8 | **PASSED** |
| **Full UI Integration Suite** | `npm run test:ui` | 10 | **PASSED** |
| **SpineIT Read-Only Workflow Target** | `node tests/test_verify_user_workflow.js` | 1 | **PASSED** |
| **TOTAL** | **Across all 14 verification suites** | **455** | **100% PASSED** |

*(Note: Zero nested test suites are counted twice; all totals represent distinct assertions across all runner files).*

---

## 8. Protected Invariants & Process Inventory

1. **Protected Workspace Integrity:**
   `C:\pmt\bit\SpineIT-ERP` was **NEVER** modified, written to, or altered. It was accessed solely as a read-only target in `test_verify_user_workflow.js`.
2. **Process Model Verification:**
   - Exactly one authoritative interactive Claude Code ConPTY session (PID 23320).
   - Exactly one authoritative interactive Gemini CLI ConPTY session.
   - Exactly one independent MCP stdio bridge child process per CLI.
   - **Zero hidden workers:** No background ACP or headless agent processes exist.
   - Native Claude and Gemini permission confirmation prompts remain active (`--yolo` and `--dangerously-skip-permissions` remain strictly banned).
   - Server binds exclusively to `127.0.0.1`.

---

## 9. Conclusion & Stop Condition

The Medium-severity security finding and the root persistence/restoration order have both been verified and proven through automated tests. All 33 CWD authorization checks and 455 repository-wide regression tests are passing at 100%.

Execution has halted in accordance with instructions. Workstream G has not been started. Awaiting your review and explicit authorization.
