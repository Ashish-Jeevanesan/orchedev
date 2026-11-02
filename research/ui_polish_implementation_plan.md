# Workbench UI Polish Implementation Plan

**Workspace:** `D:\Ashish_P\AI-Tools\custom-OCT`  
**Date:** October 30, 2026  
**Status:** **INSPECTION & PLANNING COMPLETE — READY FOR IMPLEMENTATION**  
**Objectives:**
1. Reposition Task Prompt Composer to the left side of the application.
2. Refine the UI icon system using clean, consistent SVG stroke icons (Lucide-aligned).
3. Replace generic browser-default alerts (`alert()`, `confirm()`, `prompt()`) with custom, accessible, theme-consistent modal dialogs and toasts.

---

## 1. Baseline Audit & Pre-Implementation Inspection

### 1.1 Layout Inspection
- **Current Layout (`public/index.html` & `public/css/workbench.css`):**
  - Grid: `.workbench-layout` uses `grid-template-columns: 55% 45%`.
  - Left column: `.terminal-pane` (Area A: Interactive ConPTY terminals for Claude and Gemini).
  - Right column: `.task-pane` (Area B: Task composer at top + task-content-split with task list and task detail inspector).
  - Bottom: `.activity-drawer` (Area C: Collapsible activity feed).
- **Usability Gap:** Placing the Task Composer at the top of the right pane crowds the Task Detail Inspector, limiting vertical room for inspection logs, proposed plans, diffs, and execution output.

### 1.2 Icon System Audit
- **Current State:** A disparate mix of raw Unicode glyphs (`&#x2699;`, `&#x25B6;`, `&#x2714;`) and platform-dependent emojis (`📁`, `💬`, `✨`, `🛡️`).
- **Usability Gap:** Emojis render with inconsistent color palettes, varying font baselines, and misaligned label spacing across Windows builds.
- **Target State:** Introduce a centralized lightweight SVG icon library (`public/js/icons.js`) based on Lucide stroke icons (`2px` stroke, `14px`/`16px` sizing, `currentColor` styling) with zero external npm dependencies.

### 1.3 Browser Alert / Dialog Audit
Grep analysis of `public/` revealed **7 browser-native blocking calls**:
1. `public/js/app.js:51`: `alert('Missing authentication session token...')`
2. `public/js/app.js:284`: `prompt('Enter working project directory path:', ...)`
3. `public/js/app.js:310`: `confirm('Terminate all interactive terminals and close the workbench server?')`
4. `public/js/terminal_view.js:282`: `confirm('Restart interactive ... terminal?')`
5. `public/js/terminal_view.js:288`: `confirm('Terminate interactive ... terminal process?')`
6. `public/js/task_view.js:420`: `prompt('Enter reason for rejecting this plan:', ...)`
7. `public/js/task_view.js:883`: `confirm('Cancel active task ...?')`
- **Usability Gap:** Browser-default modals block the main UI thread, freeze terminal animations, lack dark-theme styling, and look unintegrated.
- **Target State:** Create a unified `DialogService` (`public/js/dialog_service.js`) providing Promise-based, dark-themed, accessible confirmation and prompt dialogs with focus trapping and keyboard shortcuts (`Esc`, `Enter`).

---

## 2. Target Layout Architecture (Left-Side Composer)

The main desktop interface will be reorganized into a clean, structured multi-pane layout:

```
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                       APP HEADER BAR                                            │
│   Logo | Claude CLI Status | Gemini CLI Status | Storage: DURABLE | Working Folder | Shutdown   │
├──────────────────────┬──────────────────────────────────────────┬───────────────────────────────┤
│    LEFT SIDEBAR      │              MAIN AREA                   │      RIGHT / SPLIT AREA       │
│  (Composer & List)   │         (Terminal Workspace)             │    (Task Detail Inspector)    │
│                      │                                          │                               │
│ ┌──────────────────┐ │ ┌──────────────────────────────────────┐ │ ┌───────────────────────────┐ │
│ │  TASK COMPOSER   │ │ │  Tabs: [Claude Code] [Gemini CLI]    │ │ │  Task ID & State Badge    │ │
│ │  - Target Agent  │ │ │  Meta: PID, CWD, Mode, Isolated Tag  │ │ │  One-click Copy Buttons   │ │
│ │  - Prompt Input  │ │ │                                      │ │ │  Proposed Plan / Diff     │ │
│ │  - Dispatch Btn  │ │ │  Interactive ConPTY Canvas           │ │ │  Instructions             │ │
│ │  - History Tip   │ │ │  (@xterm/xterm + FitAddon)           │ │ │  Execution Output Stream  │ │
│ └──────────────────┘ │ │                                      │ │ │  Progress Bar             │ │
│ ┌──────────────────┐ │ │  Terminal Controls:                  │ │ │  Duration Timeline        │ │
│ │  TASK LIST       │ │ │  [Start] [Restart] [Stop] [Clear]    │ │ │  [Cancel] / [Approve]     │ │
│ │  - Search Bar    │ │ └──────────────────────────────────────┘ │ └───────────────────────────┘ │
│ │  - Filter Tabs   │ │                                          │                               │
│ │  - Task Cards    │ │                                          │                               │
│ └──────────────────┘ │                                          │                               │
├──────────────────────┴──────────────────────────────────────────┴───────────────────────────────┤
│                                  AREA C: ACTIVITY FEED DRAWER                                   │
└─────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### Layout Specifications
- **Desktop ($\ge$ 1280px):**
  - Left Sidebar (`.sidebar-pane`, `340px` width):
    - Top: Task Prompt Composer with generous textarea (80px - 160px auto-expanding), target agent selector, primary *Dispatch Task* action button, and inline validation.
    - Bottom: Task navigation toolbar (search input, status filter tabs `All`, `Active`, `Approvals`, `Done`, `Failed`) and scrollable task list.
  - Main Terminal Pane (`.terminal-pane`, flex: 1.2): Full terminal canvas, meta-bar, and controls.
  - Detail Inspector Pane (`.detail-pane`, flex: 1.0): Full task inspector with plan, instructions, output, timeline, progress bar, and copy buttons.
- **Narrower Windows (< 1280px):**
  - Responsive media query shifts layout into a two-column or toggleable workspace without breaking terminal fit.
  - Composer and task list remain visible on the left; terminal workspace and task inspector share the right pane with responsive tabs or stacked layout.

---

## 3. Icon System Architecture (`public/js/icons.js`)

Implement a standalone icon registry rendering clean inline SVG icons styled via CSS `currentColor`:

### Icon Mapping
- **App Logo:** `settings` (Lucide cog/gear)
- **Claude Tab:** `bot` / `message-square`
- **Gemini Tab:** `sparkles` / `cpu`
- **Working Folder:** `folder`
- **Terminal Isolation:** `shield-check`
- **Dispatch Task:** `send` / `play`
- **Search:** `search`
- **Clear Buffer:** `trash-2` / `eraser`
- **Terminal Actions:** `play` (start), `rotate-cw` (restart), `square` (terminate)
- **Copy Actions:** `copy` / `check`
- **Approval Modal:** `alert-triangle`
- **Activity Drawer Toggle:** `chevron-up` / `chevron-down`
- **Toasts:** `check-circle` (success), `x-circle` (error), `alert-circle` (warn), `info` (info)

---

## 4. Custom Dialog & Notification System (`public/js/dialog_service.js`)

### 4.1 Dialog Architecture
Create accessible modal templates in `public/index.html`:
- `#modal-confirm`: Confirmation dialog with title, message, optional icon, confirm button (styled `.btn-danger` if destructive), and cancel button.
- `#modal-prompt`: Text prompt dialog with title, description, input field, submit, and cancel.
- `#modal-alert`: Informational alert dialog.

### 4.2 Behavior & Accessibility Requirements
- **Promise-Based:** `await dialogService.confirm({ ... })` returns `boolean`.
- **Keyboard Navigation:** `Enter` submits; `Esc` cancels/dismisses.
- **Focus Management:** Focus enters dialog on open and returns to the triggering element on close.
- **Duplicate Click Prevention:** Action buttons disable immediately upon submission.
- **Zero Thread Blocking:** Does not freeze ConPTY terminal background streams or xterm rendering.

### 4.3 Replacement Plan for Existing Native Dialogs
1. `app.js:51` $\to$ `dialogService.alert({ title: 'Authentication Required', message: '...', type: 'error' })`
2. `app.js:284` $\to$ `await dialogService.prompt({ title: 'Set Working Project Directory', message: '...', defaultValue: this.projectCwd })`
3. `app.js:310` $\to$ `await dialogService.confirm({ title: 'Shutdown Workbench', message: '...', confirmText: 'Shutdown', destructive: true })`
4. `terminal_view.js:282` $\to$ `await dialogService.confirm({ title: 'Restart Terminal', message: '...', confirmText: 'Restart', destructive: true })`
5. `terminal_view.js:288` $\to$ `await dialogService.confirm({ title: 'Terminate Terminal', message: '...', confirmText: 'Terminate', destructive: true })`
6. `task_view.js:420` $\to$ `await dialogService.prompt({ title: 'Reject Proposed Plan', message: '...', defaultValue: 'Plan requires revision', confirmText: 'Reject Plan' })`
7. `task_view.js:883` $\to$ `await dialogService.confirm({ title: 'Cancel Active Task', message: '...', confirmText: 'Cancel Task', destructive: true })`

---

## 5. Implementation Work Breakdown

1. **Step 1: Icon Library & SVG Renderer (`public/js/icons.js`)**
   - Create lightweight SVG icon generator.
   - Replace raw emojis and Unicode characters in `public/index.html` with clean SVG icons.
2. **Step 2: Unified Dialog Service (`public/js/dialog_service.js` & `public/index.html`)**
   - Add accessible confirmation and prompt modal structures to `public/index.html`.
   - Implement `DialogService` with `confirm()`, `prompt()`, and `alert()`.
   - Replace all 7 browser-native calls in `app.js`, `terminal_view.js`, and `task_view.js`.
3. **Step 3: Left-Side Task Composer Layout Refactor**
   - Reorganize `public/index.html` structure: move `.task-composer` and `.task-list-panel` into `.sidebar-pane` on the left.
   - Structure `.terminal-pane` and `.task-detail-panel` in the main/right view.
   - Update `public/css/workbench.css` with clean desktop grid (`340px minmax(400px, 1.2fr) minmax(320px, 1fr)`), smooth scrollbars, and media queries for smaller screens.
4. **Step 4: Refined Toast Notifications & CSS Polish**
   - Enhance `.toast` styling with SVG status icons, subtle shadows, and progress countdown.
5. **Step 5: Automated Testing & Verification**
   - Update `tests/test_phase3_workstream_g.js` and `tests/ui_integration_tests.js` to ensure DOM bindings and dialog components are verified.
   - Execute the entire repository regression suite (574+ assertions) to confirm 100% pass rate.
6. **Step 6: Delivery & Reporting**
   - Produce `research/ui_polish_implementation_report.md`.

---

## 6. Strict Architecture & Safety Invariants

- **Interactive Processes Unchanged:** Exactly one interactive Claude ConPTY session (PID 23320) and one interactive Gemini session.
- **Zero Hidden ACP Workers:** All task claiming remains manual in the visible Gemini terminal.
- **Zero Simulated Keystrokes:** No simulated typing into ConPTY stdin.
- **Native CLI Permission Prompts Active:** No `--yolo` or `--dangerously-skip-permissions`.
- **Protected Workspace Untouched:** `C:\pmt\bit\SpineIT-ERP` remains 100% untouched.
- **Loopback & Auth Maintained:** Server remains bound to `127.0.0.1` with constant-time token validation.
