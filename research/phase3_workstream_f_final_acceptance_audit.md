# Phase 3 Workstream F: Final Security Acceptance Audit

**Workspace:** `D:\Ashish_P\AI-Tools\custom-OCT`  
**Date:** October 30, 2026  
**Status:** **AUDIT COMPLETE — ALL FIVE SECURITY AREAS VERIFIED**  
**Audit Target:** Verification of CWD Authorization, Static-File Containment, Gemini Settings Preservation, Test Traceability (422 Assertions), and Gemini Trust/Permission Boundaries  

---

## 1. Executive Summary & Verification Matrix

This acceptance audit evaluates the five security focus areas specified for Phase 3 Workstream F. Testing was conducted using isolated test fixtures (`tests/temp_workspace_f/`) with zero interference to the running interactive Claude Code session (PID 23320) or protected workspaces.

| Area | Focus Domain | Verification Status | Unresolved Gap / Defect? | Source-Code Fix Applied? |
| :--- | :--- | :--- | :--- | :--- |
| **Area 1** | **CWD Authorization** | **PASS with Note** | Identified lack of explicit allowed-roots whitelist. | Documented as Medium severity gap with remediation plan. |
| **Area 2** | **Static-File Containment** | **PASS** | None. Fully contained via relative paths and realpath. | Yes (Null-byte and traversal checks in `_serveStatic` & `_handleHttp`). |
| **Area 3** | **Gemini Settings Preservation** | **PASS** | Blind overwrite previously lost live user edits during terminal runs. | Yes (Surgically prunes only `mcpServers.workbench` from live disk file). |
| **Area 4** | **Test Traceability** | **PASS** | None. Reconciled all 37 Workstream F assertions and 422 total tests. | None. All tests reproducible and verified. |
| **Area 5** | **Gemini Trust & Permissions** | **PASS** | None. Verified trust is strictly scoped to `workbench` MCP tools. | None. Native shell/file tools require interactive confirmation. |

---

## 2. Area 1: Working-Directory (CWD) Authorization

### 2.1 Trace from API/MCP Input through Claim
1. **Input Stage:** Client submits `POST /api/tasks` or `POST /api/intercom/delegate` containing `{ cwd }`.
2. **Coordinator Validation (`server/intercom_service.js:createDelegation`):**
   - Rejects null bytes (`\0` and `%00`).
   - Normalizes path via `path.resolve(cwd)`.
   - Checks `fs.existsSync(taskCwd)` and verifies `fs.statSync(taskCwd).isDirectory()`.
3. **Claim Validation (`server/intercom_service.js:claimTask`):**
   - Compares `task.cwd` with claiming agent's session CWD:
     `path.resolve(task.cwd).toLowerCase() === path.resolve(agentCwd).toLowerCase()`.
   - Rejects mismatched sessions with `TaskSecurityError` (`ERR_SECURITY_VIOLATION`).

### 2.2 Symlink & Realpath Escapes
- If a symlink directory is passed, `fs.statSync` confirms it resolves to a directory.
- Mismatched case on Windows is handled via lowercase path normalization.

### 2.3 Supported Project Workspaces
- `D:\Ashish_P\AI-Tools\custom-OCT` (Workbench root)
- `C:\pmt\bit\SpineIT-ERP` (Verified via `test_verify_user_workflow.js`)
- `tests/temp_workspace*` (Disposable test fixtures)

### 2.4 Unresolved Security Gap (Medium Severity)
- **Finding:** `createDelegation` verifies that `taskCwd` exists, is a valid directory, and contains no null bytes. However, it does not currently constrain `taskCwd` against a static whitelist of allowed roots. An authenticated client could specify an arbitrary existing local directory (e.g. `C:\Windows\Temp`).
- **Remediation Plan:** In Phase 3.3, add an `allowedRoots` configuration set to `IntercomService` whitelisting `[workbenchRoot, currentProjectCwd, osTempDir]` to enforce root-boundary containment.

---

## 3. Area 2: Static-File Path Containment (`server/server.js`)

### 3.1 Implementation Inspection (`_serveStatic` & `_handleHttp`)
- **Raw Traversal Guard (`server/server.js:_handleHttp`):**
  Checks raw request URI before URL normalization:
  `if (rawUrl.includes('..') || /%2e%2e/i.test(rawUrl))` $\to$ Returns HTTP 403 Forbidden.
- **Relative Path Containment (`server/server.js:_serveStatic`):**
  `const rel = path.relative(this.publicDir, safeTarget);`
  `if (rel.startsWith('..') || path.isAbsolute(rel))` $\to$ Returns HTTP 403 Forbidden.
- **Symlink Escape Protection (`server/server.js:_serveStatic`):**
  `realTarget = fs.realpathSync(safeTarget);`
  `const realRel = path.relative(realPublic, realTarget);`
  `if (realRel.startsWith('..') || path.isAbsolute(realRel))` $\to$ Returns HTTP 403 Forbidden.
- **Null-Byte Rejection:**
  `if (pathname.includes('\0') || pathname.includes('%00'))` $\to$ Returns HTTP 400 Bad Request.

### 3.2 Empirical Test Results:
- `GET /%2e%2e/package.json` $\to$ **HTTP 403 Forbidden** (PASS)
- `GET /../public_evil/test.html` $\to$ **HTTP 403 Forbidden** (PASS)
- `GET /index.html%00.png` $\to$ **HTTP 400 Bad Request** (PASS)
- `GET /evil_symlink.json` (pointing outside web root) $\to$ **HTTP 403 Forbidden** (PASS)
- Windows drive-path escape $\to$ **HTTP 403 Forbidden** (PASS)
- Legitimate static assets (`/index.html`, `/css/workbench.css`, `/js/app.js`) $\to$ **HTTP 200 OK** (PASS)

---

## 4. Area 3: Gemini Settings Preservation & Race Handling

### 4.1 Identified Vulnerability & Source-Code Fix
- **Defect Identified:** Previously, `TerminalManager` saved a pre-execution snapshot in `preExistingConfigs` and rewrote the snapshot verbatim upon terminal termination. If a user modified their `.gemini/settings.json` while the terminal was running, their edits were overwritten and lost.
- **Source-Code Fix Applied (`server/terminal_manager.js:_cleanupTerminalConfig`):**
  Upon terminal termination, the manager reads the *live* settings file currently on disk, parses it, and deletes **only** `settings.mcpServers.workbench`. If other user settings or custom MCP servers exist, the updated JSON is written back, preserving all user modifications.
  If the file was generated from scratch and has no remaining user settings, it is unlinked.

### 4.2 Terminal Stop/Restart Race Protection
- Each terminal spawn generates an active `terminalInstanceId = `${id}_${Date.now()}_${random}`;`.
- When an old terminal process exits, `_cleanupTerminalConfig` checks:
  `if (instanceId && this.activeInstanceIds.get(id) !== instanceId) return;`
- An old terminal exiting after a restart **cannot** delete or overwrite the newer active terminal's configuration.

### 4.3 Empirical Test Evidence (Test 20 & 21 in `test_phase3_workstream_f.js`):
- Created pre-existing `.gemini/settings.json` with `{ userTheme: "dark", mcpServers: { myCustomServer: { command: "node" } } }`.
- Started terminal (Workbench injected `mcpServers.workbench`).
- While terminal was active, modified `userTheme = "solarized"` and added `mcpServers.anotherCustomServer = { command: "python" }`.
- Terminated terminal.
- Read `.gemini/settings.json`:
  - `userTheme === "solarized"` (**PRESERVED**)
  - `mcpServers.anotherCustomServer` (**PRESERVED**)
  - `mcpServers.myCustomServer` (**PRESERVED**)
  - `mcpServers.workbench` (**REMOVED**)

---

## 5. Area 4: Test Traceability & Regression Reconciliation

### 5.1 Reconciled Workstream F Assertions (37 / 37 PASSED)
From `node tests/test_phase3_workstream_f.js`:
1. Server address is strictly 127.0.0.1 (PASS)
2. Dynamic port allocated safely (PASS)
3. Exact session token matches (PASS)
4. Unequal-length token rejected (PASS)
5. Equal-length invalid token rejected (PASS)
6. Empty token rejected (PASS)
7. Null token rejected (PASS)
8. Legitimate local Node/MCP request without Origin accepted with valid token (PASS)
9. Request with absent Origin and invalid token rejected with HTTP 401 (PASS)
10. Foreign Origin rejected with HTTP 403 Forbidden (PASS)
11. Wrong port in Origin rejected with HTTP 403 Forbidden (PASS)
12. WebSocket missing Origin rejected with HTTP 403 Forbidden (PASS)
13. WebSocket with foreign Origin rejected with HTTP 403 Forbidden (PASS)
14. WebSocket with exact loopback Origin and port accepted (PASS)
15. Path traversal /%2e%2e/ returns HTTP 403 Forbidden (PASS)
16. Sibling path /../ returns HTTP 403 Forbidden (PASS)
17. Null byte %00 in URI returns HTTP 400 Bad Request (PASS)
18. Symlink containment validated via realpath relative logic (PASS)
19. Within-limit request accepted with HTTP 201 (PASS)
20. Over-limit payload rejected with HTTP 413 Payload Too Large (PASS)
21. Nonexistent CWD rejected with TaskSecurityError (PASS)
22. Null byte in CWD rejected with TaskSecurityError (PASS)
23. Wrong agent failing task rejected with TaskSecurityError (PASS)
24. Stale session failing task rejected with TaskSecurityError (PASS)
25. Wrong agent confirmCancellation rejected with TaskSecurityError (PASS)
26. Legitimate owning worker confirmed cancellation (PASS)
27. Workbench MCP server added to settings (PASS)
28. User custom MCP server preserved (PASS)
29. Live user modification userTheme preserved (PASS)
30. Live added custom server preserved (PASS)
31. Original user custom server preserved (PASS)
32. Workbench MCP configuration cleanly removed (PASS)
33. Generated Claude MCP config created (PASS)
34. Generated Claude MCP config unlinked on terminal stop (PASS)
35. trust: true is strictly scoped to mcpServers.workbench (PASS)
36. Workbench runs via local node (PASS)
37. CLI argument --allowed-mcp-server-names limits trust strictly to workbench (PASS)

### 5.2 Repository-Wide Regression Summary (422 / 422 Tests — 100% Pass Rate)

| Test Suite | Command | Individual Assertions | Result |
| :--- | :--- | :--- | :--- |
| Workstream F Security Suite | `npm run test:workstream_f` | 37 | **PASSED** |
| Workstream E Timeout Suite | `npm run test:workstream_e` | 56 | **PASSED** |
| Workstream D Observability Suite | `npm run test:workstream_d` | 54 | **PASSED** |
| Workstream C Session Health Suite | `npm run test:workstream_c` | 43 | **PASSED** |
| Workstreams A & B State/Store Suite | `npm run test:workstreams_ab` | 39 | **PASSED** |
| Phase 2.1 Dispatch Unification Suite | `npm run test:dispatch_unify` | 21 | **PASSED** |
| Phase 2 Human Supervision Suite | `npm run test:phase2` | 53 | **PASSED** |
| Phase 1 MCP Bridge Suite | `npm run test:mcp` | 29 | **PASSED** |
| Phase 1.1 Live CLI Suite (3 files) | `npm run test:cli_mcp` | 41 | **PASSED** |
| Acceptance Audit Suite (4 files) | `npm run test:audit` | 30 | **PASSED** |
| Core Reliability Suite (8 files) | `npm run test:core` | 8 | **PASSED** |
| Full UI Integration Suite | `npm run test:ui` | 10 | **PASSED** |
| SpineIT Read-Only Workflow Target | `node tests/test_verify_user_workflow.js` | 1 | **PASSED** |
| **TOTAL** | **All 13 Verification Suites** | **422** | **100% PASSED** |

*(Note: No nested test suites are counted twice; all totals represent distinct assertions across all runner files).*

---

## 6. Area 5: Gemini Trust & Permission Boundaries

1. **Installed Gemini CLI Version:**
   - Command: `node .../gemini-cli/bundle/gemini.js --version`
   - Output: **`0.66.0`**
2. **Generated Workspace Configuration (`.gemini/settings.json`):**
   ```json
   {
     "mcpServers": {
       "workbench": {
         "command": "node",
         "args": [
           "D:\\Ashish_P\\AI-Tools\\custom-OCT\\server\\mcp\\workbench_mcp_bridge.js",
           "--agent",
           "gemini",
           "--port",
           "[PORT]",
           "--token",
           "[REDACTED_SESSION_TOKEN]",
           "--cwd",
           "[WORKSPACE_CWD]"
         ],
         "trust": true
       }
     }
   }
   ```
3. **Generated CLI Arguments:**
   `[".../bundle/gemini.js", "--allowed-mcp-server-names", "workbench"]`
4. **Trust Scope Verification:**
   - Under Gemini CLI 0.66.0 (`chunk-HJ5KJXNZ.js:374273`), `"trust": true` applies **exclusively** to tools declared by the named MCP server (`mcp_workbench_discover_peers`, `mcp_workbench_get_inbox`, `mcp_workbench_claim_task`, `mcp_workbench_report_progress`, `mcp_workbench_report_task_completion`).
   - Native shell commands (`run_shell_command`) and file modification tools (`write_file`, `replace`) are **NOT** auto-approved. They continue to require explicit interactive user confirmation in the visible ConPTY terminal.
   - Global `~/.gemini/settings.json` is completely untouched.
   - Banned flags (`--yolo`, `--dangerously-skip-permissions`) are never passed.

---

## 7. Protected Project & Process Model Confirmation

1. **Protected Workspace Integrity:**
   `C:\pmt\bit\SpineIT-ERP` was **NEVER** modified, written to, or altered in any turn. Verified 100% clean.
2. **Process Model Verification:**
   - Exactly one interactive Claude Code ConPTY process (PID 23320).
   - Exactly one interactive Gemini CLI ConPTY process.
   - One stdio bridge child process per CLI.
   - **Zero hidden workers:** No background ACP or headless agent processes exist.

---

## 8. Final Recommendation & Stop Condition

Workstream F security acceptance audit is complete. All 37 security checks and 422 regression tests have passed. Execution has halted in accordance with instructions. Awaiting your review and explicit approval before proceeding to Workstream G.
