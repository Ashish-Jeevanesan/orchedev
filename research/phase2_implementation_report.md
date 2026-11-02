# Phase 2 Implementation Report: Human-Supervised Claude ↔ Gemini Delegation

**Workspace:** `D:\Ashish_P\AI-Tools\custom-OCT`  
**Date:** October 30, 2026  
**Status:** **PHASE 2 IMPLEMENTATION & ACCEPTANCE COMPLETE (100% PASS)**  
**Architecture Baseline:** `research/phase0_1_architecture_clarifications.md`  

---

## Executive Summary

Phase 2 successfully delivers the complete **Human-Supervised Delegation Workflow** between the existing interactive Claude Code and Gemini CLI terminal sessions. 

The human user remains strictly in control throughout the delegation lifecycle:
1. Claude Code formulates an architectural implementation plan and calls `delegate_to_gemini()`.
2. The Workbench intercepts the call, transitions the task to `APPROVAL_REQUESTED`, and renders an interactive **Approval Modal** in the desktop UI.
3. The developer inspects, edits instructions (if desired), and clicks **[Approve Plan]** or **[Reject Plan]**.
4. Upon approval, the task transitions to `QUEUED_FOR_CLAIM` and appears in Gemini's inbox.
5. The developer switches to the visible Gemini terminal and types `claim`.
6. Gemini CLI claims the task via its registered session, executes the work visibly in the project folder, and reports completion with modified files and test results back through MCP.
7. Claude Code receives the actual completion result in its pending tool call, inspects the modified files, runs verification tests, and prints review findings visibly in its terminal pane.
8. If corrections are required, Claude proposes a new delegation task that **requires separate, explicit human approval**, preventing unbounded autonomous loops.

All work strictly preserves the single authoritative session architecture: **zero hidden ACP daemons, zero background Claude workers, zero simulated PTY typing, and zero API keys.**

---

## 1. Architecture Changes

```
┌────────────────────────────────────────────────────────────────────────┐
│             PHASE 2 HUMAN-SUPERVISED DELEGATION ARCHITECTURE           │
│                                                                        │
│   ┌───────────────────────────┐      ┌──────────────────────────────┐  │
│   │ Claude Code (ConPTY)      │      │ Gemini CLI (ConPTY)          │  │
│   │ Interactive Terminal Pane │      │ Interactive Terminal Pane    │  │
│   └─────────────┬─────────────┘      └──────────────┬───────────────┘  │
│                 │ stdio (MCP)                       │ stdio (MCP)      │
│                 ▼                                   ▼                  │
│   ┌───────────────────────────┐      ┌──────────────────────────────┐  │
│   │ Claude MCP Stdio Bridge   │      │ Gemini MCP Stdio Bridge      │  │
│   │ (workbench_mcp_bridge.js) │      │ (workbench_mcp_bridge.js)    │  │
│   └─────────────┬─────────────┘      └──────────────┬───────────────┘  │
│                 │ Loopback HTTP/WS                  │ Loopback HTTP/WS │
│                 │ Auth: X-Session-Token             │ Auth: Token      │
│                 ▼                                   ▼                  │
│   ┌────────────────────────────────────────────────────────────────┐   │
│   │              CENTRAL WORKBENCH COORDINATOR SERVICE             │   │
│   │                                                                │   │
│   │   ┌────────────────────────────────────────────────────────┐   │   │
│   │   │             Delegation State Machine Engine            │   │   │
│   │   │  CREATED → APPROVAL_REQUESTED → APPROVED               │   │   │
│   │   │  → QUEUED_FOR_CLAIM → CLAIMED → RUNNING → COMPLETED    │   │   │
│   │   └────────────────────────────────────────────────────────┘   │   │
│   │                                ▲                               │   │
│   │   ┌────────────────────────┐   │   ┌───────────────────────┐   │   │
│   │   │ Durable Persistence    │   │   │ Human Approval Gate   │   │   │
│   │   │ (.workbench_tasks.json)│   │   │ (Approval Modal / API)│   │   │
│   │   └────────────────────────┘   │   └───────────────────────┘   │   │
│   └────────────────────────────────┼───────────────────────────────┘   │
│                                    │ WebSocket Events                  │
│                                    ▼                                   │
│   ┌────────────────────────────────────────────────────────────────┐   │
│   │                 WORKBENCH DESKTOP USER INTERFACE               │   │
│   │   - Approval Modal: Plan review, instruction editor, reject    │   │
│   │   - Header Indicator: Blinking pending approvals pill          │   │
│   │   - Task Inspector: Real-time state history, files, results    │   │
│   │   - Unified Dispatch Task Panel                                │   │
│   └────────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Delegation State Machine & Invariant Rules

Tasks transition strictly forward through validated states; terminal states are completely immutable:

```
[CREATED]
    │
    ▼
[APPROVAL_REQUESTED] ──(User Rejects)──> [REJECTED] (Terminal)
    │
    ├─(User Edits & Approves)─> [APPROVED] ──> [QUEUED_FOR_CLAIM]
    │                                                 │
    ├─(User Approves Plan)────> [APPROVED] ──> [QUEUED_FOR_CLAIM]
    │                                                 │
    ├─(User Cancels)─────────────────────────> [CANCELLED] (Terminal)
    │                                                 │
    │                                          (Gemini Claims)
    │                                                 │
    │                                                 ▼
    │                                             [CLAIMED]
    │                                                 │
    │                                                 ▼
    │                                             [RUNNING]
    │                                                 │
    ├───────────────────────(Worker Completes)────────┴──> [COMPLETED] (Terminal)
    │                                                 │
    ├───────────────────────(Worker Fails)────────────┴──> [FAILED] (Terminal)
    │
    └───────────────────────(Timeout Expiry)─────────────> [TIMED_OUT] (Terminal)
```

### Invariants Enforced in `server/intercom_service.js`:
- **Terminal Immutability:** Once in `COMPLETED`, `FAILED`, `CANCELLED`, `TIMED_OUT`, or `REJECTED`, calling `_transitionTask` throws an error.
- **Withholding Unapproved Work:** Unapproved tasks are filtered out of `getInbox()` queries. Gemini never sees tasks until human approval is recorded.
- **Audit Preservation:** When a user edits instructions before approving, `task.originalInstructions` stores Claude's exact text, while `task.instructions` stores the human-edited directive.
- **State History Audit:** Every transition records `{ from, to, timestamp, reason, actor }` persisted directly to `.workbench_tasks.json`.

---

## 3. Human Approval UI Implementation

### Components Added to Desktop Interface:
1. **Header Pending Approvals Pill (`public/index.html`, `#pill-approvals`):**
   - Renders in the top navigation bar when delegations are awaiting human action (`0 PENDING`, `1 PENDING`, etc.).
   - Blinking warning indicator attracts attention without disrupting active typing.
   - Clicking the pill opens the approval modal directly.
2. **Approval Modal (`#modal-approval`):**
   - Displays task metadata: Correlation ID, Source Agent (`Claude Code`), Target Agent (`Gemini CLI`), Target Working Directory, Created Timestamp.
   - **Proposed Plan Viewer:** Formatted code box displaying Claude's architectural rationale.
   - **Interactive Instructions Editor:** Multi-line editable textarea allowing the human to adjust instructions before approving. A badge (`EDITED BY HUMAN`) appears dynamically when the text is modified.
   - **Impact Disclosure:** Clarifies target session and reminds the developer that native file and command permissions will remain active.
   - **Decision Buttons:**
     - `[Approve Plan]` / `[Approve with Edited Instructions]` (Green): Transitions task to `QUEUED_FOR_CLAIM` and alerts Gemini.
     - `[Reject Plan]` (Red): Prompts for rejection reason, marks task `REJECTED`, and resolves Claude's tool call.
     - `[Cancel]` (Muted): Dismisses modal without taking action.
3. **Task Inspector Integration (`public/js/task_view.js`):**
   - Tasks awaiting approval feature a prominent **[Review & Approve]** button.
   - Approved tasks waiting for worker claim display:
     `[WAITING FOR GEMINI CLAIM] Type 'claim' in Gemini CLI to execute.`
   - Complete state history timeline rendered with timestamps, transition paths, reasons, and actors.
   - Dedicated sections for `Modified Files`, `Verification & Test Results`, and `Summary`.

---

## 4. Claude Delegation & Review Workflow

1. **Tool Invocation (`server/mcp/workbench_mcp_bridge.js`):**
   - Claude invokes `delegate_to_gemini({ plan, instructions, expectedFiles, timeoutSeconds })`.
   - Tool arguments are validated; `instructions` must be a non-empty string.
   - Bridge calls `POST /api/intercom/delegate`, creating the task in `APPROVAL_REQUESTED` state and holding the stdio JSON-RPC tool promise open.
2. **Human Approval:**
   - The developer approves via the UI modal or REST endpoint.
   - Task enters `QUEUED_FOR_CLAIM`.
3. **Gemini Claim & Execution:**
   - Gemini CLI claims the task via `claim_task`, transitions to `RUNNING`, modifies files, and calls `report_task_completion`.
4. **Structured Result Delivery to Claude:**
   - Claude's pending tool promise resolves with:
     ```
     Gemini implementation completed successfully!
     Correlation ID: CORR_...
     Duration: 12s
     Summary: Implemented validateUser in auth.js
     Files Modified: auth.js
     Test Results: Unit tests passed: 4 passed, 0 failed

     Please review these changes, run appropriate tests in your terminal, and report your review findings to the user.
     ```
5. **Claude Turn 2 Verification:**
   - Claude receives the actual tool response, inspects the files, executes tests, and reports findings visibly in its terminal pane.

---

## 5. Multi-Turn Correction Loop

If Claude identifies bugs or regressions during verification:
1. Claude prepares a specific bug-fix plan.
2. Claude calls `delegate_to_gemini` again with the correction instructions.
3. The Coordinator creates a new task in `APPROVAL_REQUESTED` state.
4. **Mandatory Human Approval:** The correction task does **NOT** run autonomously; the developer must review and click `[Approve Plan]`.
5. Gemini claims the correction and executes the fix.
6. Claude re-verifies.
- **Safety Guarantee:** Eliminates runaway agent-to-agent infinite loops.

---

## 6. Unified Dispatch Task Panel

The Dispatch Task panel in the Workbench UI has been fully unified with the central Coordinator:
- Background ACP daemons are **completely removed**.
- Tasks dispatched from the UI create delegation records with immutable correlation IDs in the same durable queue.
- Both routes (manual Claude MCP delegation and UI Dispatch Panel) service the **same authoritative Gemini session** and persist to the same `.workbench_tasks.json` store.

---

## 7. Security Audit: Gemini Trust Configuration

In Phase 1.1, workspace-local `.gemini/settings.json` was generated with `"trust": true`. As required by Section 10, we conducted an empirical source audit in `node_modules/@google/gemini-cli/bundle/chunk-HJ5KJXNZ.js:374273`:

```javascript
if (serverConfig.trust) {
  rules.push({
    toolName: `${MCP_TOOL_PREFIX}${serverName}_*`
  });
}
```

### Verified Findings:
1. **Scope of Trust:** The `trust: true` flag applies **exclusively** to tools prefixed with `mcp_workbench_*` (`discover_peers`, `get_inbox`, `claim_task`, `report_task_completion`).
2. **No Filesystem Bypass:** It does **NOT** grant global workspace trust. It does **NOT** enable `--yolo`.
3. **Native Permission Controls Preserved:** Native Gemini CLI tools (`replace`, `write_file`, `run_shell_command`, etc.) do **NOT** have the `mcp_workbench_` prefix and continue to enforce native confirmation prompts before modifying files or executing shell commands.
4. **Global Settings Isolation:** Configuration is written strictly to `<workspace>/.gemini/settings.json`. The user's global `~/.gemini/settings.json` is never modified.

---

## 8. Timeout, Recovery & Process Ownership

- **Timeout Budgets:**
  - Separate 15-minute budget for human approval and execution.
  - Timeouts never auto-approve or silently execute work; expired tasks transition to `TIMED_OUT`.
- **Server Restart Recovery:**
  - Tasks in `QUEUED_FOR_CLAIM` remain claimable after server restarts.
  - Tasks in `CLAIMED` or `RUNNING` transition safely to `FAILED` with diagnostic message: `Server or coordinator restarted while task was in state RUNNING`. They are **never** falsely restored as completed.
- **Process Ownership Evidence:**
  - 1 interactive Claude Code process in ConPTY.
  - 1 interactive Gemini CLI process in ConPTY.
  - 1 lightweight stdio MCP bridge process per CLI.
  - **Zero background ACP workers, zero hidden Claude workers, zero simulated typing.**

---

## 9. Comprehensive Acceptance Test Results

All acceptance scenarios defined in Section 12 were implemented in `tests/test_phase2_human_delegation.js` and verified against live processes:

```
===============================================================
  Phase 2: Human-Supervised Delegation Acceptance Suite       
===============================================================

--- SCENARIO A: Successful Human-Supervised Delegation ---
  [PASS] Claude delegation call remains pending awaiting human approval
  [PASS] Exactly 1 delegation task awaiting approval
  [PASS] Task state is APPROVAL_REQUESTED
  [PASS] Task fromAgent is claude
  [PASS] Gemini inbox is empty before human approval (unapproved task is withheld)
  [PASS] Server confirmed task approval
  [PASS] Task transitioned to QUEUED_FOR_CLAIM
  [PASS] Approver recorded for audit history
  [PASS] Gemini discovers the approved task in its inbox
  [PASS] Correlation ID matches approved task
  [PASS] Gemini claim_task succeeded
  [PASS] Task state transitioned to RUNNING
  [PASS] Gemini report_task_completion acknowledged
  [PASS] Claude delegation call resolved upon Gemini completion
  [PASS] Claude received success status
  [PASS] Claude received modified files list
  [PASS] Claude received test results
  [PASS] Claude instructed to review implementation
  [PASS] Final task state is COMPLETED
  [PASS] History records creation in APPROVAL_REQUESTED
  [PASS] History records APPROVAL_REQUESTED->APPROVED
  [PASS] History records APPROVED->QUEUED_FOR_CLAIM
  [PASS] History records QUEUED_FOR_CLAIM->CLAIMED
  [PASS] History records CLAIMED->RUNNING
  [PASS] History records RUNNING->COMPLETED

--- SCENARIO B: Rejected Delegation ---
  [PASS] Dangerous plan caught in APPROVAL_REQUESTED state
  [PASS] Server confirmed rejection
  [PASS] Task transitioned to REJECTED
  [PASS] Rejection reason preserved in task record
  [PASS] Rejected task was never exposed to Gemini inbox
  [PASS] Claude delegation call unblocked on rejection
  [PASS] Claude received structured rejection header
  [PASS] Claude received human rejection reason
  [PASS] Claude prompted to formulate alternative

--- SCENARIO C: Edited Instructions Before Approval ---
  [PASS] Original instructions recorded
  [PASS] Active instructions updated to human-edited version
  [PASS] Original instructions preserved for audit trail
  [PASS] Gemini received human-edited instructions upon claim

--- SCENARIO D: Task Cancellation Across Lifecycle ---
  [PASS] Cancelled task in APPROVAL_REQUESTED state
  [PASS] Task is in QUEUED_FOR_CLAIM state
  [PASS] Cancelled approved unclaimed task
  [PASS] Coordinator reports cancellation_requested for active task (honest reporting)
  [PASS] cancellationRequested flag recorded on active task

--- SCENARIO E: Multi-Turn Correction Loop ---
  [PASS] Correction delegation requires separate human approval (no unbounded loop)
  [PASS] Approved correction is ready in Gemini inbox
  [PASS] Correction completed successfully
  [PASS] Correction test results verified

--- SCENARIO F: Security & Invariant Enforcement ---
  [PASS] Terminal state immutability strictly enforced
  [PASS] Duplicate approval rejected
  [PASS] Stale session rejected from completing task
  [PASS] Tasks persisted to .workbench_tasks.json
  [PASS] Persistent storage contains auditable task records
  [PASS] State history persisted to disk with timestamps and actors

===============================================================
  PHASE 2 ACCEPTANCE SUITE RESULTS: 53 PASSED, 0 FAILED
===============================================================
```

### Full Regression Test Summary:
| Suite | Command | Assertions / Tests | Status |
| :--- | :--- | :---: | :---: |
| **Phase 2 Acceptance Suite** | `npm run test:phase2` | 53 / 53 assertions | **PASSED** |
| **Phase 1 MCP Stdio Bridge** | `npm run test:mcp` | 29 / 29 assertions | **PASSED** |
| **Phase 1.1 Live CLI Suite** | `npm run test:cli_mcp` | 41 / 41 assertions | **PASSED** |
| **Core Reliability Suite** | `npm run test:core` | 8 / 8 files | **PASSED** |
| **UI Integration Suite** | `npm run test:ui` | 10 / 10 tests | **PASSED** |

---

## 10. Files Created and Modified

1. `server/intercom_service.js`: Complete 12-state delegation lifecycle, terminal state immutability, human approval gating (`APPROVAL_REQUESTED`, `APPROVED`, `QUEUED_FOR_CLAIM`, `REJECTED`, `CANCELLED`), state transition history, original instruction preservation on edit, and durable persistence.
2. `server/mcp/workbench_mcp_bridge.js`: Support for human rejection handling, `testResults` reporting, `BRIDGE_CWD` working-directory propagation.
3. `server/server.js`: REST endpoints for approval decisions (`/api/intercom/approvals/pending`, `/api/intercom/approvals/:id/approve`, `/api/intercom/approvals/:id/reject`), task cancellation, and full listing.
4. `server/terminal_manager.js`: Auto-generation of `.workbench/claude_mcp_config.json` and `.gemini/settings.json` with scoped tool trust, passing `--cwd` to bridge.
5. `public/index.html`: Header approval pill (`#pill-approvals`), Human Delegation Approval Modal (`#modal-approval`).
6. `public/css/workbench.css`: Dark-theme modal dialog, approval meta-grid, plan box, instructions editor, impact notice, blinking indicator.
7. `public/js/task_view.js`: Modal event wiring, real-time approval status updates, instruction editing, state history rendering, waiting banner for Gemini claim, cancellation.
8. `public/js/app.js`: WebSocket event routing for `approval_requested`, `approval_decision`, `task_state_changed`, `intercom_event`.
9. `package.json`: Added `test:phase2`, `test:cli_mcp`, `test:mcp` test runners.
10. `tests/test_phase2_human_delegation.js`: Exhaustive acceptance suite covering Scenarios A through F (53 assertions).

---

## 11. Startup and Usage Instructions

1. **Start the Workbench:**
   ```powershell
   npm start
   ```
2. **Select Working Project Directory:**
   Click **Browse...** in the top header or select a project directory (e.g. `tests/temp_workspace`).
3. **Launch Terminals:**
   Claude Code and Gemini CLI terminals spawn in ConPTY with independent MCP bridges connected.
4. **Initiate Delegation in Claude Terminal:**
   Type to Claude:
   ```
   Please design a refactor for auth.js and delegate the implementation to Gemini using the delegate_to_gemini tool.
   ```
5. **Review in Approval Modal:**
   The Workbench pops up the Approval Modal displaying Claude's plan. Inspect or edit instructions, then click **[Approve Plan]**.
6. **Claim in Gemini Terminal:**
   Switch to the Gemini terminal and type:
   ```
   claim
   ```
   Gemini claims the task, executes the code modifications visibly on screen, and reports completion.
7. **Claude Automatic Review:**
   Claude's pending delegation unblocks with Gemini's completion summary and modified files list. Claude automatically inspects the code, runs tests, and prints its review findings in its terminal pane.

---

## 12. Stop Condition Reached

Phase 2 implementation and acceptance testing are complete. No Phase 3 code has been written. All tests pass with 100% compliance. Awaiting your review and explicit approval.
