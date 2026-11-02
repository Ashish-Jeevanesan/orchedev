# Phase 3 Workstream H Audit & Implementation Plan: End-to-End Regression Strategy

**Workspace:** `D:\Ashish_P\AI-Tools\custom-OCT`  
**Date:** October 30, 2026  
**Status:** **AUDIT & IMPLEMENTATION PLAN ONLY (NO SOURCE-CODE CHANGES)**  
**Target:** End-to-End Multi-Agent Integration, Interactive ConPTY Workflows, Failure Injections, Durable Crash Recovery, Security Invariants, and Full-Stack Verification  

---

## 1. Executive Summary & Scope Definition

### 1.1 Objective & Context
Phase 3 Workstreams A through G successfully designed, hardened, and verified the core components of the Agent Workbench:
- **Workstreams A & B:** Formal state machine, strict transition matrix, typed error hierarchy, and serialized atomic persistence queue on `.workbench_tasks.json`.
- **Workstream C:** Session health lifecycle (`ONLINE`, `BUSY`, `UNREACHABLE`, `OFFLINE`), monotonic generation tracking, and dynamic MCP bridge reconnection.
- **Workstream D:** Unified `workbench_event` taxonomy, correlation navigation, execution progress log, and secret-redacted structured logging.
- **Workstream E:** Three independent timeout budgets (`approval`, `claim`, `execution`), non-destructive task timeout, late completion archival, and leak-free HTTP long-polling waiters.
- **Workstream F:** Security hardening (timing-safe token validation, strict WebSocket loopback origin enforcement, static file realpath containment, 1MB streamed body cap, ephemeral settings lifecycle), and centralized CWD authorization with boot-time root restoration.
- **Workstream G:** Frontend visual polish, responsive dark aesthetic, terminal ergonomics with focus auto-capture, buffer clear without PTY input, bounded prompt history, task list filtering and live search, progress bar visualization, late completion presentation, and supervision carousel workflow.

Across all 15 verification suites, **512 / 512 tests currently pass at 100%**.

### 1.2 Purpose of Workstream H
**Workstream H is the final integration and regression capstone of Phase 3.** Its objective is not merely to re-run isolated unit tests, but to validate the seamless, end-to-end integration of all seven previous workstreams under real operational conditions.

It establishes an exhaustive multi-tier verification harness that exercises:
1. Genuine interactive Claude Code $\leftrightarrow$ Gemini CLI ConPTY delegation.
2. User-driven Dispatch Task workflows.
3. Complex failure, timeout, and cancellation races.
4. Cold crash recovery and filesystem contention.
5. Session health degradation and reconnection.
6. Centralized CWD authorization and security boundaries.
7. Full operational UI responsiveness and accessibility.

---

## 2. Current Architecture & Cross-Workstream Integration Map

The Agent Workbench integrates three layers into a single cohesive system:

```
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│                                 AREA A: INTERACTIVE TERMINALS                               │
│                                                                                             │
│   ┌─────────────────────────────────────────┐     ┌─────────────────────────────────────┐   │
│   │         Claude Code CLI (ConPTY)        │     │        Gemini CLI (ConPTY)          │   │
│   │         PID 23320 (Interactive)         │     │        Interactive Pseudo-Terminal  │   │
│   └────────────────────┬────────────────────┘     └──────────────────┬──────────────────┘   │
│                        │ stdio (JSON-RPC)                            │ stdio (JSON-RPC)     │
│   ┌────────────────────▼────────────────────┐     ┌──────────────────▼──────────────────┐   │
│   │   Claude MCP Bridge (Child Process)     │     │   Gemini MCP Bridge (Child Process) │   │
│   │   Tools: discover_peers, delegate...    │     │   Tools: get_inbox, claim_task...   │   │
│   └────────────────────┬────────────────────┘     └──────────────────┬──────────────────┘   │
└────────────────────────┼─────────────────────────────────────────────┼──────────────────────┘
                         │ REST / WebSocket (Token Auth)               │
┌────────────────────────▼─────────────────────────────────────────────▼──────────────────────┐
│                       CENTRAL WORKBENCH COORDINATOR (127.0.0.1:PORT)                        │
│                                                                                             │
│   ┌─────────────────────────────────────────────────────────────────────────────────────┐   │
│   │                                 WorkbenchServer                                     │   │
│   │   - Loopback HTTP/WS Listener (127.0.0.1:0) & Timing-Safe Token Verification        │   │
│   │   - WebSocket Origin Matching & Streamed 1MB Request Limiting                       │   │
│   │   - TerminalManager (ConPTY Spawning, Auto-Focus, Ephemeral Scoped Settings)        │   │
│   └──────────────────┬───────────────────────────────────────────────┬──────────────────┘   │
│                      │                                               │                      │
│   ┌──────────────────▼─────────────────────┐   ┌─────────────────────▼──────────────────┐   │
│   │      WorkspaceAuthorizationService     │   │            IntercomService             │   │
│   │   - Canonical realpath resolution      │   │   - 10-State Machine & Typed Errors    │   │
│   │   - Whitelist of allowed roots         │   │   - 3 Decoupled Lifecycle Timeouts     │   │
│   │   - Rejection of drive & UNC escapes   │   │   - 4-State Session Health (Heartbeat) │   │
│   │   - Durable store: .workbench_workspace│   │   - Monotonic Registration Generations │   │
│   └────────────────────────────────────────┘   │   - Serialized Atomic Persistence      │   │
│                                                │   - Canonical workbench_event Stream   │   │
│                                                └─────────────────────┬──────────────────┘   │
└──────────────────────────────────────────────────────────────────────┼──────────────────────┘
                                                                       │ WebSocket Events
┌──────────────────────────────────────────────────────────────────────▼──────────────────────┐
│                             AREA B & C: FRONTEND WEB DESKTOP UI                             │
│                                                                                             │
│   ┌────────────────────────────────────────┐     ┌──────────────────────────────────────┐   │
│   │           TaskComposer & List          │     │        Task Inspector & Timeline     │   │
│   │   - Auto-expanding prompt input        │     │   - One-click copy with feedback     │   │
│   │   - Bounded 30-item prompt history     │     │   - Genuine progress visualization   │   │
│   │   - Status filter tabs (All/Active...) │     │   - Late completion archive banner   │   │
│   │   - Live search by ID or keyword       │     │   - State transition duration logs   │   │
│   └────────────────────────────────────────┘     └──────────────────────────────────────┘   │
│   ┌────────────────────────────────────────┐     ┌──────────────────────────────────────┐   │
│   │       Supervision Approval Modal       │     │        Activity Feed & Toasts        │   │
│   │   - Multi-delegation queue carousel    │     │   - Severity chips (All, Tasks, Sec) │   │
│   │   - Ctrl+Enter approve / Esc dismiss   │     │   - Clickable correlation chip nav   │   │
│   │   - Focus management & diff indicator  │     │   - FIFO 200 event & 5 toast limits  │   │
│   └────────────────────────────────────────┘     └──────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Five-Tier Testing Hierarchy & Automation Boundaries

Workstream H structures all verification into five distinct tiers, strictly separating automated programmatic tests from human-interactive terminal tests:

```
┌───────────────────────────────────────────────────────────────────────────────┐
│ TIER 5: Full End-to-End Interactive Acceptance (Human-in-the-Loop)            │
│ Real visible ConPTY terminals, human modal review, manual `claim` in Gemini   │
├───────────────────────────────────────────────────────────────────────────────┤
│ TIER 4: Interactive CLI Integration Tests (Automated ConPTY)                  │
│ Spawns live claude.exe/gemini.js processes, tests MCP handshake, exit codes   │
├───────────────────────────────────────────────────────────────────────────────┤
│ TIER 3: MCP Stdio Bridge Integration Tests (Automated JSON-RPC)               │
│ Launches workbench_mcp_bridge.js, tests tools, heartbeats, reconnect backoff  │
├───────────────────────────────────────────────────────────────────────────────┤
│ TIER 2: Service & API Integration Tests (Automated REST & WebSockets)          │
│ Tests loopback HTTP routes, WebSocket event streaming, wait route long-polls  │
├───────────────────────────────────────────────────────────────────────────────┤
│ TIER 1: Core Unit Tests (Automated Deterministic Invariants)                  │
│ Tests state transitions, path containment, timeout timers, secret scrubbing   │
└───────────────────────────────────────────────────────────────────────────────┘
```

### Automation Boundaries & Invariant Enforcements
- **Automated Tiers (Tiers 1–4):** Fully automated via Node.js test runners (`npm test`, `test:workstream_*`, `test:all`). Execute within sub-second to few-second deterministic windows using disposable test fixtures.
- **Human Interactive Tier (Tier 5):** Validates real-world developer workflows.
  - **Zero Simulated Keystrokes:** No scripts may inject synthetic typing or simulated input into ConPTY stdin.
  - **Zero Hidden ACP Workers:** All task execution by Gemini CLI must occur visibly in the authoritative terminal window.
  - **Manual Claiming:** Gemini claiming is executed by typing `claim` directly into the terminal prompt.
  - **Native Permission Prompts:** All file-system modifications (`write_file`, `replace`) and shell executions (`run_shell_command`) prompt the user for interactive confirmation.

---

## 4. Comprehensive End-to-End Scenario Matrix (H.1 – H.7)

### H.1 — Interactive Claude-to-Gemini Delegation Workflow
Validates the complete bi-directional delegation pipeline between the two interactive agents.

```
Claude (ConPTY)           MCP Bridge              Coordinator (Intercom)             Human UI                Gemini (ConPTY)
       │                       │                            │                           │                       │
       ├─ delegate_to_gemini ─►│                            │                           │                       │
       │                       ├─ POST /delegate ──────────►│                           │                       │
       │                       │                            ├─ APPROVAL_REQUESTED ─────►│                       │
       │                       │  (HTTP long-poll waiting)  │                           ├─ Modal displays ─────►│
       │                       │                            │                           ├─ (Human edits/approves)
       │                       │                            │◄─ POST /approvals/approve ┤                       │
       │                       │                            ├─ QUEUED_FOR_CLAIM         │                       │
       │                       │                            │                           │      (User types:     │
       │                       │                            │◄─ claim_task ─────────────┴────── `claim` in PTY) │
       │                       │                            ├─ CLAIMED -> RUNNING                               │
       │                       │                            │                                                   ├─ (Executes visibly)
       │                       │                            │◄─ report_progress ────────────────────────────────┤
       │                       │                            │◄─ report_task_completion ─────────────────────────┤
       │                       │                            ├─ COMPLETED                                        │
       │                       │◄─ Resolves delegation ─────┤                                                   │
       │◄─ Receives result ────┤                            │                                                   │
       ├─ (Reviews diffs)      │                            │                                                   │
```

- **Preconditions:** Workbench server running on loopback; Claude Code and Gemini CLI running in visible ConPTY sessions with active MCP bridges.
- **Steps:**
  1. In Claude terminal, prompt Claude: *"Delegate creating `math_utils.js` with an `add()` function to Gemini"*.
  2. Claude analyzes the request and invokes `delegate_to_gemini()`.
  3. Coordination engine creates task in `APPROVAL_REQUESTED` state.
  4. Human supervision modal opens in Workbench UI with proposed plan and instructions.
  5. Human reviewer modifies instructions: *"Also include a `multiply()` function and JSDoc comments"*, then clicks *Approve Plan* (or presses `Ctrl+Enter`).
  6. Task transitions to `QUEUED_FOR_CLAIM` and enters Gemini's inbox.
  7. In Gemini terminal, user manually runs `claim`.
  8. Gemini claims task (transitioning to `CLAIMED` $\to$ `RUNNING`), prints progress, and visibly prompts to write `math_utils.js`.
  9. User interactively approves the file write prompt in Gemini CLI.
  10. Gemini invokes `report_task_completion()` with modified files and test verification.
  11. Coordinator transitions task to `COMPLETED` and resolves Claude's waiting delegation call.
  12. Claude inspects `math_utils.js` and reports completion back to the user.
- **Expected Result:** Bi-directional delegation succeeds cleanly; human instructions are strictly honored; file changes are executed with interactive confirmation; zero orphaned processes.
- **Evidence to Capture:** Claude terminal log, Gemini terminal log, Coordinator state history, and Workbench UI Activity Feed.
- **Cleanup:** Unlink `math_utils.js` from test fixture.

---

### H.2 — User Dispatch Task Workflow
Validates user-initiated task creation directly from the Workbench UI.

- **Preconditions:** Active Workbench session; Gemini CLI terminal registered.
- **Steps:**
  1. In the Task Composer, user types: *"Generate date formatter utility in `date_format.js`"*.
  2. User clicks *Dispatch Task* (or presses `Ctrl+Enter`).
  3. Client performs validation, then calls `POST /api/tasks`.
  4. Task is created in `APPROVAL_REQUESTED` state with `fromAgent: 'user'`.
  5. Approval modal pops up immediately; user reviews and approves.
  6. Task enters Gemini inbox (`QUEUED_FOR_CLAIM`).
  7. User runs `claim` in Gemini terminal.
  8. Gemini claims task, executes changes visibly, and reports completion.
  9. Task transitions to `COMPLETED` and outputs render in the Task Inspector.
- **Expected Result:** Direct user dispatch follows the exact same state machine and approval gating as agent delegations; no separate headless runner is spawned.
- **Evidence to Capture:** Network request/response log, Activity Feed entry, Task detail inspector screenshot.
- **Cleanup:** Unlink `date_format.js`.

---

### H.3 — Lifecycle & Failure Scenario Matrix
Validates error recovery, edge-case races, and state machine invariants.

| Scenario ID | Test Scenario | Trigger Condition | Expected Lifecycle Behavior | Verification Assertion |
| :--- | :--- | :--- | :--- | :--- |
| **H.3.1** | Human Rejection | User clicks *Reject Plan* in approval modal. | Task transitions immediately to `REJECTED`. Claude delegation resolves with `rejected: true` and human reason. Task is never visible in Gemini inbox. | `task.state === 'REJECTED'`, `task.rejectReason` preserved. |
| **H.3.2** | Approval Timeout | Delegation left unapproved past `approvalTimeoutMs`. | Task transitions to `TIMED_OUT` with structured code `ERR_APPROVAL_TIMEOUT`. Waiting delegation resolves with timeout error. | `task.timeoutPhase === 'APPROVAL'`. |
| **H.3.3** | Inbox Claim Timeout | Approved task left unclaimed past `claimTimeoutMs`. | Task transitions to `TIMED_OUT` with code `ERR_CLAIM_TIMEOUT`. Removed from active inbox. | `task.timeoutPhase === 'CLAIM'`. |
| **H.3.4** | Execution Timeout | Worker claims task but exceeds `executionTimeoutMs`. | Task transitions to `TIMED_OUT` with code `ERR_EXECUTION_TIMEOUT`. ConPTY terminal process remains alive and healthy. | Terminal PID intact; peer status reverts to `ONLINE`. |
| **H.3.5** | In-Flight Cancellation | User clicks *Cancel Task* while worker is `RUNNING`. | Coordinator marks `cancellationRequested: true`. State remains `RUNNING` until worker confirms cancellation. | `status === 'cancellation_requested'`, honest reporting. |
| **H.3.6** | Worker Confirm Cancel | Worker reports aborted execution via `confirm_cancellation`. | Task transitions cleanly to `CANCELLED`. ConPTY session returns to idle. | `task.state === 'CANCELLED'`, `cancellationConfirmed: true`. |
| **H.3.7** | Late Completion Race | Worker completes task after cancellation request was issued. | Task is transitioned to `CANCELLED` (never falsely marked `COMPLETED`), but completed output is archived in `task.lateCompletion`. | `task.state === 'CANCELLED'`, `task.lateCompletion.result` preserved. |
| **H.3.8** | Late Completion After Timeout | Worker finishes execution after task officially timed out. | Task remains in `TIMED_OUT` state; result output and arrival timestamp are safely archived in `task.lateCompletion`. | `task.state === 'TIMED_OUT'`, `task.lateCompletion` rendered with amber badge. |
| **H.3.9** | Duplicate Correlation ID | Second task created with identical `correlationId`. | Rejected immediately with HTTP 400 / `TaskDuplicateError` (`ERR_DUPLICATE_TASK`). Original task is unmodified. | Existing task map size unchanged. |
| **H.3.10** | Duplicate Claim Race | Two concurrent workers attempt to claim the same task. | First claim succeeds (`QUEUED` $\to$ `CLAIMED`); second claim is rejected with `TaskStateError` (`ERR_DUPLICATE_CLAIM`). | Exactly one worker assigned. |
| **H.3.11** | Stale Session Ownership | Disconnected or replaced session attempts `completeTask`. | Rejected with `TaskSecurityError` (`ERR_SECURITY_VIOLATION`). | State remains unchanged; unauthorized update blocked. |

---

### H.4 — Persistence, Crash Recovery & File Contention
Validates durability and atomic recovery across server restarts and OS file locks.

- **Scenarios:**
  1. **Queued Task Recovery:** Stop coordinator with tasks in `QUEUED_FOR_CLAIM`. Restart server. Verify tasks are re-loaded, validated against authorized roots, and remain claimable in Gemini's inbox.
  2. **Interrupted Execution Recovery:** Kill coordinator while task is `RUNNING`. Restart server. Verify coordinator detects interrupted execution and transitions task safely to `FAILED` with state history reason `"Boot recovery: task interrupted by coordinator shutdown"`.
  3. **Authorized Roots Restoration Order:** Ensure `.workbench_workspaces.json` is loaded and validated in `WorkspaceAuthorizationService` **before** `_loadPersistedTasks()` runs, preventing false `EXPIRED` transitions on user-authorized workspaces.
  4. **Deleted Root Handling:** Delete a previously authorized workspace folder while Workbench is offline. Restart server. Verify missing directory is pruned from allowed roots and any recovered task referencing that folder transitions to `EXPIRED` with code `ERR_CWD_NOT_AUTHORIZED`.
  5. **Corrupted JSON Recovery:** Write malformed JSON into `.workbench_tasks.json`. Restart server. Verify emergency backup `.workbench_tasks.json.corrupt_<timestamp>` is created, the coordinator starts cleanly with an empty map, and the process does not crash.
  6. **Windows Rename Contention:** Trigger 25 concurrent state updates. Verify the serialized persistence queue (`_drainPersistQueue()`) buffers and applies exponential backoff retries (5 attempts, 20ms intervals) to handle transient Windows file-locking delays without data loss.

---

### H.5 — Session Health, Reconnection & Process Uniqueness
Validates that network glitches, process restarts, and bridge reconnections do not corrupt session state.

- **Scenarios:**
  1. **Monotonic Generations:** On initial registration, agent receives `generation: 1`. If the agent crashes and restarts, new registration receives `generation: 2`. Stale requests carrying generation 1 are rejected with `ERR_SESSION_CONFLICT`.
  2. **Heartbeat Degradation Timeline:**
     - 0s–15s: Agent is `ONLINE` (or `BUSY` if executing).
     - 15s–30s: Missed heartbeats transition agent to `UNREACHABLE` (grace period active; in-flight tasks are NOT aborted).
     - >30s: Continued silence transitions agent to `OFFLINE`.
  3. **Re-Registration from OFFLINE:** Reconnecting bridge sends register payload with same session ID; coordinator recognizes session, restores status to `ONLINE`, and emits `SESSION_RECOVERED`.
  4. **Strict Single-Process Invariant:** Restarting an interactive terminal via the UI (`POST /api/terminals/:id/restart`) kills the entire old process tree via `taskkill /F /T /PID` before spawning the new PID. Zero orphaned CLI processes remain in Task Manager.

---

### H.6 — Security Hardening & Isolation Boundaries
Validates all security protections established in Workstream F.

- **Scenarios:**
  1. **Loopback Only:** Verify server binds strictly to `127.0.0.1:0`. Verify connections to public LAN IPs are refused.
  2. **Timing-Safe Token Comparison:** Test invalid authentication tokens of equal length, shorter length, and longer length. Confirm constant-time evaluation via `crypto.timingSafeEqual` preventing timing-attack leaks.
  3. **WebSocket Origin Validation:** Attempt WebSocket handshake with missing `Origin` header and foreign `Origin: http://evil.com`. Confirm server rejects with HTTP 403 Forbidden. Confirm exact loopback origin succeeds.
  4. **Static Path Containment:** Test `GET /%2e%2e/package.json`, `GET /../server/server.js`, and null-byte injection `GET /index.html%00.png`. Confirm HTTP 403 / 400 responses.
  5. **Symlink Escape Protection:** Create a directory symlink inside an authorized workspace pointing outside to `C:\Windows`. Confirm `authorizeCwd()` evaluates canonical realpath and rejects with `ERR_CWD_NOT_AUTHORIZED`.
  6. **Device & UNC Path Blocks:** Attempt task creation with `cwd: "\\\\.\\COM1"` and `cwd: "\\\\fileserver\\share"`. Confirm immediate rejection.
  7. **Streamed 1MB Payload Cap:** Post payload exceeding 1,048,576 bytes. Confirm server responds with HTTP 413 Payload Too Large and drains stream safely to prevent `ECONNRESET`.
  8. **Secret Redaction in Logs:** Verify logs scrub session tokens, bearer headers, and authorization keys to `[REDACTED]`.

---

### H.7 — UI & Operational Integration
Validates that the frontend faithfully reflects coordinator state and provides seamless developer interaction.

- **Scenarios:**
  1. **Approval Modal & Carousel Navigation:** Create 3 tasks requiring approval simultaneously. Verify modal header displays `"Delegation 1 of 3"`. Verify *Next* and *Previous* buttons navigate the queue without mutating uninspected tasks.
  2. **Keyboard Shortcuts:** In modal, test `Ctrl+Enter` to approve; verify button disables immediately to prevent double-clicks. In modal, test `Esc` to dismiss; verify modal closes and task remains in `APPROVAL_REQUESTED`.
  3. **Task Composer:** Test prompt history recall: press `ArrowUp` in an empty textarea to load previous prompt; press `ArrowDown` to return. Test multiline text navigation: ensure arrow keys do not overwrite text when editing within lines.
  4. **Task List Filtering & Search:** Test filter tabs (`All`, `Active`, `Approvals`, `Completed`, `Failed`). Verify count badges match filtered items. Type in search bar; verify list filters in real time by correlation ID or keyword.
  5. **Task Inspector & Output:** Test copy buttons for Correlation ID, Instructions, and Output; verify visual `Copied!` tooltip feedback. Verify progress bar displays percentage or indeterminate animation during execution.
  6. **Terminal Ergonomics:** Switch tabs between Claude and Gemini; verify active terminal canvas is focused automatically. Click *Clear Buffer*; verify visible display clears while PTY process remains alive. Resize window; verify 50ms debounced resize prevents canvas jitter.

---

## 5. Failure Injection & Fault Recovery Protocols

Workstream H utilizes systematic failure injection to prove system resilience:

| Failure Type | Injection Mechanism | System Invariant Tested | Expected Recovery Outcome |
| :--- | :--- | :--- | :--- |
| **Sudden Worker Crash** | Force-kill Gemini ConPTY process (`taskkill /F /PID`) while task is `RUNNING`. | Fault isolation & session health. | Coordinator transitions peer to `OFFLINE`; marks active task `FAILED`; leaves Claude session alive. |
| **Abrupt Network Severance** | Terminate WebSocket connection without sending close frame. | Socket leak protection & reconnection. | Client reconnects with exponential backoff (2s cadence); coordinator cleans up detached socket; UI restores status to `Connected`. |
| **Storage Corruption** | Overwrite `.workbench_tasks.json` with truncated JSON syntax during runtime. | Atomic persistence & data protection. | On reboot, coordinator creates `.corrupt_<timestamp>` backup, logs error, and starts clean without crashing. |
| **Filesystem Lock Contention** | Hold exclusive file lock on `.workbench_tasks.json` for 40ms during save. | Windows rename retry backoff. | `_drainPersistQueue()` retries up to 5 times with exponential backoff and succeeds on lock release. |
| **Unauthorized Symlink Retargeting** | Retarget an authorized directory junction to an unauthorized path between task creation and claim. | Dynamic claim-time CWD authorization. | `claimTask()` re-evaluates canonical realpath at claim time and rejects claim with `ERR_CWD_NOT_AUTHORIZED`. |

---

## 6. Required Test Fixtures & Teardown Lifecycle

### 6.1 Test Directory Structure
All destructive and file-modifying tests run strictly inside dedicated, disposable fixtures under the workbench root:
```
D:\Ashish_P\AI-Tools\custom-OCT\tests\temp_workspace_h_e2e\
├── .workbench\
│   └── claude_mcp_config.json      <-- Ephemeral config (cleaned on exit)
├── .gemini\
│   └── settings.json               <-- Ephemeral config (cleaned on exit)
├── .workbench_tasks.json           <-- Isolated test tasks
├── .workbench_workspaces.json      <-- Isolated test workspaces
└── src\                            <-- Generated test code
```

### 6.2 Strict Workspace Safety Invariant
- **`C:\pmt\bit\SpineIT-ERP` is strictly a read-only target.**
- No tests may write, modify, or delete files in `C:\pmt\bit\SpineIT-ERP`.
- Any automated or manual test involving SpineIT must only inspect directory structure or perform read-only queries (as proven in `test_verify_user_workflow.js`).

### 6.3 Cleanup Lifecycle Guarantee
Every test suite must implement a robust `finally` block:
1. Close all active WebSockets.
2. Terminate all spawned child processes and ConPTY instances.
3. Close the HTTP/WS server listener.
4. Recursively delete `tests/temp_workspace_h_e2e/`.

---

## 7. Implementation Sequence for Workstream H

Workstream H implementation will be executed in four sequential phases upon authorization:

### Phase H.1: Test Harness & Failure Injection Utilities
- Create `tests/helpers/e2e_test_harness.js` providing programmatic server instantiation, mock MCP peer factories, WebSocket event collectors, and failure injection helpers (process killing, corrupt storage injection).

### Phase H.2: Automated End-to-End Suite (`tests/test_phase3_workstream_h_e2e.js`)
- Implement comprehensive automated test suite covering:
  - Part 1: Unified Delegation & Human Approval Pipeline (Scenarios H.1 & H.2).
  - Part 2: State Machine Lifecycle, Timeouts & Cancellation Races (Scenario H.3).
  - Part 3: Crash Recovery, Root Persistence & Contention (Scenario H.4).
  - Part 4: Session Health, Heartbeat Lifecycle & Generations (Scenario H.5).
  - Part 5: Security Invariants, Timing Attacks, Traversal & CWD Containment (Scenario H.6).
  - Part 6: UI Client Component Integration & DOM Event Routing (Scenario H.7).

### Phase H.3: Full Repository Master Regression Execution
- Execute the complete repository regression suite across all 16 verification suites:
  - `npm run test:workstream_h` (New suite)
  - `npm run test:workstream_g` (57 assertions)
  - `npm run test:cwd_auth` (33 assertions)
  - `npm run test:workstream_f` (37 assertions)
  - `npm run test:workstream_e` (56 assertions)
  - `npm run test:workstream_d` (54 assertions)
  - `npm run test:workstream_c` (43 assertions)
  - `npm run test:workstreams_ab` (39 assertions)
  - `npm run test:dispatch_unify` (21 assertions)
  - `npm run test:phase2` (53 assertions)
  - `npm run test:mcp` (29 assertions)
  - `npm run test:cli_mcp` (41 assertions)
  - `npm run test:audit` (30 assertions)
  - `npm run test:core` (8 assertions)
  - `npm run test:ui` (10 assertions)
  - `node tests/test_verify_user_workflow.js` (1 assertion)
- **Target: Maintain 100% pass rate across 560+ total assertions.**

### Phase H.4: Final Phase 3 Acceptance Report
- Produce `research/phase3_workstream_h_implementation_report.md` and the master Phase 3 closure report `research/phase3_implementation_report.md`.

---

## 8. Expected Evidence & Acceptance Criteria

Workstream H will be considered complete and verified when:
1. **Full Operational Verification:** Both the automated E2E suite and the live interactive workflow have been executed and verified.
2. **Zero Regressions:** All 512 baseline tests plus all new Workstream H assertions pass (expected ~570 total assertions).
3. **No Process Leaks:** Windows process audits confirm zero orphaned Node, ConPTY, Claude, or Gemini processes after shutdown.
4. **Architectural Purity:** Confirmed zero headless agent runners, zero simulated typing, manual claiming preserved, and native CLI permission prompts active.
5. **Protected Workspace Untouched:** Verified zero modifications to `C:\pmt\bit\SpineIT-ERP`.

---

## 9. Risks, Dependencies & Unresolved Questions

### 9.1 Technical Risks & Mitigations
- **Risk: Windows File Locking during Rapid Persistence Tests.**
  - *Mitigation:* The atomic persistence queue in `IntercomService` already implements exponential backoff retries (5 attempts, 20ms intervals). Tests will allow 100ms settling time between rapid batch writes.
- **Risk: ConPTY Handle Release Latency on Windows.**
  - *Mitigation:* Child process termination on Windows win32 requires up to 500ms for OS handles to fully close. Test suites incorporate asynchronous cleanup waits before deleting temporary directories.
- **Risk: Interactive Rate-Limiting or Network Latency.**
  - *Mitigation:* Programmatic E2E tests mock the LLM inference responses while testing the genuine protocol and bridge layers, ensuring tests complete in seconds without hitting model API quotas.

### 9.2 Dependencies
- Node.js runtime (`node.exe` v22.23.1).
- Windows ConPTY API (`@homebridge/node-pty-prebuilt-multiarch`).
- MCP SDK (`@modelcontextprotocol/sdk`).

---

## 10. Strict Stop Condition

This document is the **Audit and Implementation Plan only**.
No application source code, frontend files, tests, or existing reports have been modified.
Workstream H implementation will not begin until you have reviewed and authorized this plan.
