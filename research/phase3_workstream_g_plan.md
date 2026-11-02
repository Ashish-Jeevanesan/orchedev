# Phase 3 Workstream G Audit & Implementation Plan: UI & Usability

**Workspace:** `D:\Ashish_P\AI-Tools\custom-OCT`  
**Date:** October 30, 2026  
**Status:** **AUDIT & IMPLEMENTATION PLAN ONLY (NO SOURCE-CODE CHANGES)**  
**Target:** Interactive Terminal Ergonomics, Task Management & Filtering, Supervision Modal Workflow, Activity Feed Drawer, Dark-Mode Visual Aesthetics, and Keyboard Accessibility  

---

## 1. Executive Summary & Baseline Architecture

### 1.1 Architecture Baseline
The Agent Workbench operates as a local-first Windows developer desktop application. The frontend is built with vanilla HTML/CSS/ES Modules served over loopback HTTP/WebSocket, rendering in an isolated native desktop window via Microsoft Edge/Chrome `--app` mode with zero Electron bloat (~40MB idle RAM).

Underlying the interface is the Phase 3 backend engine:
- **Interactive Terminals (Area A):** Two persistent Windows ConPTY pseudo-terminals (`claude.exe` and `gemini.js`), bridged via WebSocket streams and rendered via `@xterm/xterm` and `@xterm/addon-fit`.
- **Delegated Task Engine (Area B):** Centralized state machine (`IntercomService`) orchestrating human-supervised delegation between Claude Code and Gemini CLI, backed by serialized atomic persistence (`.workbench_tasks.json`) and authorized workspace roots (`.workbench_workspaces.json`).
- **Observability & Diagnostics (Area C):** Canonical `workbench_event` bus streaming real-time status transitions, duration metrics, and throttled execution progress.

### 1.2 Purpose of Workstream G
Workstreams A through F hardened the backend state machine, persistence queue, session health, diagnostics, timeouts, and security boundaries (455/455 tests passing). 

**Workstream G focuses exclusively on the frontend user experience, visual polish, workflow ergonomics, and usability.** It ensures that developer interactions—monitoring long-running tasks, approving delegations, switching terminal sessions, inspecting multi-step outputs, and managing project workspaces—are responsive, high-contrast, intuitive, and keyboard-accessible.

---

## 2. Comprehensive Frontend Audit & Gap Analysis

An exhaustive audit of `public/index.html`, `public/css/workbench.css`, and `public/js/*.js` identified key strengths and specific usability gaps across seven primary dimensions:

### Audit Matrix (G1 – G7)

| Dimension | Component | Current State | Audit Finding & Usability Gap | Target Enhancement |
| :--- | :--- | :--- | :--- | :--- |
| **G1** | **Header Bar & Global Status** | Static header with pills for Claude/Gemini ConPTY, Approvals, and Working Folder. | Working folder path is truncated with ellipsis; no direct copy button. Approvals badge blinks but has no clear badge count tooltip or active task highlight. | Add instant copy-path button, improve visual hierarchy, and show actionable dropdown for pending approval queue. |
| **G2** | **ConPTY Terminal Workspace** | Tabbed interface switching between Claude and Gemini terminals with PTY/MCP badges. | Switching tabs can occasionally desynchronize terminal focus; no "Clear Terminal" shortcut or button; FitAddon resize can cause momentary scroll jitter if container dimensions change rapidly. | Add focus auto-capture on tab switch, clear buffer action, debounced `fit()` calculation, and terminal status tooltips. |
| **G3** | **Task Composer & Submission** | Multiline textarea with `Dispatch Task` button and `Ctrl+Enter` shortcut. | No input validation feedback for whitespace-only prompts prior to server rejection; no character counter or prompt template snippets; target agent selector is single-option. | Add inline validation, visual submit state, auto-expanding textarea up to max height, and prompt history recall (`Up`/`Down` arrow keys). |
| **G4** | **Task List, Filtering & Search** | Vertical list showing correlation ID, target badge, state badge, and elapsed timer. | In large sessions, list becomes cluttered; no status filter tabs (All, Active, Completed, Failed, Pending); no search bar to filter by correlation ID or prompt keyword. | Implement multi-filter toolbar (`All`, `Active`, `Approvals`, `Completed`, `Failed`), text search filter, and task count summary per category. |
| **G5** | **Task Detail & Output Inspector** | Split pane displaying state timeline, instructions, progress log, and output. | Raw task outputs lack one-click copy; late completion results need more prominent visual badging; no syntax highlighting or structured fold/unfold for large JSON outputs. | Add one-click copy buttons with "Copied!" feedback, dedicated late completion badge, formatted progress bars, and collapsible metadata sections. |
| **G6** | **Human Supervision Modal** | Modal with metadata grid, proposed plan, and editable instruction textarea. | Modal lacks keyboard navigation (`Esc` to dismiss, `Ctrl+Enter` to approve); if multiple approvals arrive simultaneously, there is no queue counter or Next/Prev navigation. | Add full keyboard trap & shortcuts, multi-task approval carousel ("Approval 1 of 3"), and visual diff indicator when instructions are edited. |
| **G7** | **Activity Feed & Notifications** | Bottom collapsible drawer rendering rolling `workbench_event` items with clickable chips. | Feed drawer toggle button is small; correlation chip click selects task but does not scroll it into view; no filter for event severity levels (`INFO`, `WARN`, `ERROR`). | Add severity filter chips, smooth scroll-to-task integration, unread event counter on header, and toast dismiss buttons. |

---

## 3. Detailed Specification of Workstream G Enhancements

### 3.1 G1: Header Bar & Workspace Management Ergonomics
1. **Interactive Working Folder Component:**
   - Display full path in a tooltip with one-click "Copy Path" button.
   - Show disk drive icon and quick-switch dropdown of recently authorized workspaces from `.workbench_workspaces.json`.
   - Maintain the native Windows folder browser integration via PowerShell `FolderBrowserDialog`.
2. **Global Session Health Indicators:**
   - Dual-badge pill per agent: `PTY: RUNNING` (green) / `STOPPED` (muted) and `MCP: ONLINE` (green) / `BUSY` (blue) / `UNREACHABLE` (yellow) / `OFFLINE` (red).
   - Approval alert pill: Pulsing amber badge indicating count of delegations awaiting human review; clicking opens the approval queue directly.
   - WebSocket connection heartbeat pulse with automatic reconnection countdown.

### 3.2 G2: Terminal Workspace & ConPTY Usability
1. **Focus & Resizing Stability:**
   - When switching between "Claude Code CLI" and "Gemini CLI" tabs, immediately call `terminal.focus()` so developer keystrokes are captured without requiring a manual mouse click.
   - Wrap `fitAddon.fit()` in `requestAnimationFrame` with a 50ms debounce to eliminate canvas redraw flicker during window drag/maximize.
2. **Terminal Utility Bar:**
   - Add a `Clear` button to purge the visible xterm scrollback buffer without disrupting the underlying ConPTY process.
   - Add a `Scroll to Bottom` button when user has scrolled up into terminal history.
   - Show active terminal dimensions (`cols x rows`), active process PID, and working directory.

### 3.3 G3: Task Composer & Prompt Ergonomics
1. **Auto-Expanding Textarea:**
   - Input field expands smoothly from 3 lines up to 10 lines as text is entered, then enables an internal scrollbar.
2. **Keyboard Shortcuts & Validation:**
   - `Ctrl+Enter` (or `Cmd+Enter`) triggers immediate dispatch.
   - Disallow empty or whitespace-only submissions with subtle red border pulse and inline helper tip ("Please enter a prompt before dispatching").
   - Add prompt history recall: Pressing `Up` arrow in an empty prompt field loads the previously submitted prompt.

### 3.4 G4: Task List Filtering, Search & Organization
1. **Filter Tabs Bar:**
   - `All` (total count badge)
   - `Active` (`QUEUED`, `CLAIMED`, `RUNNING`)
   - `Pending Approval` (`APPROVAL_REQUESTED`)
   - `Completed` (`COMPLETED`)
   - `Failed / Timed Out` (`FAILED`, `TIMED_OUT`, `CANCELLED`)
2. **Live Search Input:**
   - Fast client-side filtering by Correlation ID, agent name, or prompt substring.
3. **Task Card Micro-Interactions:**
   - Live tick timer for running tasks (`42s elapsed`).
   - State duration badge for finished tasks (`took 1m 14s`).
   - Subtle hover highlight and distinct active card border.

### 3.5 G5: Task Detail Inspector & Output Experience
1. **Header & Quick Actions:**
   - Prominent Correlation ID badge with one-click "Copy ID" button.
   - For in-flight tasks (`APPROVAL_REQUESTED`, `QUEUED`, `RUNNING`), display active `Cancel Task` button.
2. **State Duration Timeline (`_renderStateHistoryTimeline`):**
   - Horizontal step timeline with icons and exact millisecond/second durations spent in each phase:
     `CREATED` $\to$ `APPROVAL_REQUESTED` (12s) $\to$ `APPROVED` $\to$ `QUEUED` (4s) $\to$ `CLAIMED` $\to$ `RUNNING` (45s) $\to$ `COMPLETED`.
3. **Execution Progress Bar:**
   - When `TASK_PROGRESS` reports progress events, render a modern progress bar with percentage and stage message (e.g. `[45%] Compiling TypeScript bundle`).
4. **Output Presentation:**
   - Clean monospace result box with syntax styling, line numbers toggle, and "Copy Output" button.
   - If task was marked `TIMED_OUT` or `CANCELLED` but completed later, show amber banner:  
     `[LATE COMPLETION RECORDED]` with full completed output and arrival timestamp.

### 3.6 G6: Human Supervision Modal Polish & Keyboard Workflow
1. **Keyboard Accessibility:**
   - `Ctrl+Enter`: Instantly approve plan.
   - `Esc`: Dismiss modal (keeps task in `APPROVAL_REQUESTED` state).
   - Auto-focus cursor directly into the instructions textarea so human reviewers can edit immediately.
2. **Multi-Task Carousel:**
   - If Claude submits multiple delegations before human review, the modal header displays:  
     `Delegation 1 of 3` with `Previous` and `Next` navigation buttons.
3. **Diff Highlighting:**
   - When human modifies Claude's proposed instructions, display an `EDITED BY HUMAN` badge and a toggleable "Show Original Instructions" comparison view.

### 3.7 G7: Activity Feed & Toast System
1. **Severity Filters:**
   - Toggle buttons to filter feed by `All`, `Tasks`, `Terminals`, `Security`, and `Errors`.
2. **Interactive Event Chips:**
   - Clicking a correlation ID chip in the feed automatically switches to the Task Panel, selects the task, and scrolls the card into view.
3. **Bounded Toast Notifications:**
   - Modern floating toasts (max 5 simultaneous) with progress countdown bar, automatic 4s dismissal, and explicit `[X]` close button.

---

## 4. Visual Design System & Aesthetics (`public/css/workbench.css`)

The UI adheres strictly to a disciplined dark-mode developer aesthetic (avoiding distracting animations or unneeded styling frameworks):

### Color Tokens
- **Backgrounds:**
  - Base: `#0b0d13` (deep void)
  - Surface: `#12151e` (panel cards)
  - Elevated: `#1a1e2b` (toolbars, modals, inputs)
  - Input: `#0e111a` (code/text inputs)
- **Borders:** `#262c3e` (subtle grid boundaries), `#3b82f6` (focus glow)
- **Text:** `#f1f5f9` (primary), `#8392a5` (secondary muted), `#546274` (metadata labels)
- **Status Accents:**
  - Success/Completed: `#10b981` (emerald)
  - Running/Active: `#3b82f6` (sapphire blue)
  - Approval/Warning: `#f59e0b` (amber)
  - Failure/Cancelled: `#ef4444` (crimson)
  - Info/Trace: `#06b6d4` (cyan)

### Typography
- **UI Proportions:** 12px/13px system font (`Segoe UI`, `-apple-system`, `sans-serif`) for crisp desktop text.
- **Code & Terminals:** `Consolas`, `Cascadia Code`, `JetBrains Mono`, `monospace` with `line-height: 1.45`.

---

## 5. Step-by-Step Implementation Work Breakdown

Workstream G will be implemented sequentially across 6 logical sub-tasks:

### Task G.1: Visual Design System & CSS Layout Refinements
- Update `public/css/workbench.css` with enhanced dark-mode tokens, button hover states, timeline styling, progress bars, filter toolbars, and modal improvements.
- Ensure 100% responsive layout between terminal pane (60%) and task pane (40%) with clean overflow management.

### Task G.2: ConPTY Terminal Ergonomics & Auto-Focus
- Update `public/js/terminal_view.js` to ensure instantaneous auto-focus on tab switch.
- Add `Clear Buffer` button, debounced `fit()` resizing, and terminal status tooltips.
- Verify zero terminal desynchronization during tab switches.

### Task G.3: Task Composer Enhancements & Prompt History
- Update `public/js/task_view.js` and `public/index.html` with auto-expanding textarea, whitespace validation feedback, and prompt recall via `Up`/`Down` arrow keys.

### Task G.4: Task List Filtering, Search & Active Timers
- Add status filter tab bar (`All`, `Active`, `Approvals`, `Completed`, `Failed`) and instant search input to `task-list-panel`.
- Enhance task cards with real-time elapsed timers, phase duration badges, and hover micro-interactions.

### Task G.5: Task Inspector, Progress Visualization & Late Completion Viewer
- Implement progress bar rendering for in-flight tasks reporting `TASK_PROGRESS`.
- Implement one-click copy buttons for Correlation ID, instructions, and output.
- Add prominent `LATE COMPLETION RECORDED` view with output and timestamps.

### Task G.6: Supervision Modal Workflow & Activity Feed Polish
- Add `Ctrl+Enter` approval shortcut and `Esc` dismiss shortcut to `#modal-approval`.
- Add multi-delegation carousel navigation when multiple tasks await approval.
- Add severity filters to the Activity Feed and smooth scroll-to-task integration.

---

## 6. Verification & Testing Strategy

### 6.1 Automated UI & Usability Test Suite (`tests/test_phase3_workstream_g.js`)
A dedicated suite will verify all frontend endpoints, state bindings, and DOM structures:
1. **Control Inventory:** Verify presence and accessibility of all filter tabs, search input, clear terminal button, copy buttons, and modal shortcuts.
2. **Filter & Search Logic:** Test client-side filtering algorithms (filtering by state, searching by keyword and correlation ID).
3. **Keyboard Shortcut Handlers:** Verify event dispatchers for `Ctrl+Enter` in composer, `Ctrl+Enter` in modal, and `Esc` in modal.
4. **Progress Bar & Timeline Rendering:** Verify DOM generation of `progressHistory` and `stateHistoryTimeline`.
5. **Prompt History Recall:** Test buffer storage and retrieval of submitted prompts.
6. **Late Completion Display:** Verify proper badging and rendering when tasks contain `lateCompletion`.

### 6.2 Full Repository Regression Verification
Run all existing 14 test suites to guarantee 0 regressions:
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

All **455+ assertions** must pass.

### 6.3 Safety & Protected Invariants
- **Zero Headless Workers:** No background ACP or headless agents.
- **Two Authoritative Sessions:** One interactive Claude ConPTY and one interactive Gemini ConPTY.
- **Manual Claiming:** Task claim remains manual via native CLI in the visible terminal.
- **Native CLI Prompts Active:** No `--dangerously-skip-permissions` or `--yolo`.
- **Protected Workspace:** `C:\pmt\bit\SpineIT-ERP` remains 100% untouched.

---

## 7. Deliverable Artifacts for Workstream G

Upon execution approval, Workstream G will produce:
1. Updated UI assets: `public/index.html`, `public/css/workbench.css`, `public/js/task_view.js`, `public/js/terminal_view.js`, `public/js/activity_view.js`, `public/js/app.js`.
2. Dedicated test suite: `tests/test_phase3_workstream_g.js`.
3. Completion report: `research/phase3_workstream_g_implementation_report.md`.

---

## 8. Strict Stop Condition

This document is the **Audit and Implementation Plan only**.
No application source code or frontend files have been modified.
Workstream G execution will not begin until you have reviewed and authorized this plan.
