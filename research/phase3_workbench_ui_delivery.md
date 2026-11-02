# Phase 3 Delivery Report: Minimal Claude + Gemini Agent Workbench UI

**Workspace:** `D:\Ashish_P\AI-Tools\custom-OCT`  
**Date:** October 29, 2026  
**Environment:** Windows 10/11 x64, Node.js v22.23.1, npm 10.9.8, Gemini CLI 0.66.0, Claude Code 2.1.312  

---

## Executive Summary

Phase 3 successfully delivered a lightweight, responsive, and secure Windows desktop workbench around the verified Claude + Gemini coordination core. The application provides:
1. **Interactive Terminals:** Genuine Windows ConPTY-backed interactive terminals for normal developer CLI interaction with Claude Code and Gemini CLI, complete with ANSI color rendering, cursor control, resizing, and copy/paste via xterm.js.
2. **Delegated Task Panel:** Background task execution via managed protocol clients (Gemini ACP stdio and Claude stream-json), supporting direct tasks and the correlated Claude $\leftrightarrow$ Gemini multi-agent loop.
3. **Activity Feed & Notifications:** Real-time event notifications driven strictly by verified protocol lifecycle state transitions.
4. **Complete Isolation:** Absolute decoupling between interactive terminals and delegated background tasks (verified by automated concurrency and keystroke isolation tests).
5. **Zero API Keys & Credential Safety:** Reuses existing local Google OAuth (`~/.gemini/settings.json`) and Claude subscriptions. No secrets exposed in URLs, headers, or logs.

All 19 automated tests (8 Phase 2 Core tests + 10 Phase 3 UI & Integration tests + 1 Tab Switch Regression test) passed with a **100% success rate**.

---

## 1. Architecture & Technology Stack

### 1.1 Architecture Decision: Node.js Server + Standalone Desktop App Mode
- **Backend:** Node.js v22.23.1 native server running on loopback (`127.0.0.1`) with dynamic port allocation (`port: 0`).
- **Interactive Pseudo-Terminal (ConPTY):** Implemented via `@homebridge/node-pty-prebuilt-multiarch` (native Windows ConPTY binary built for Node 22 ABI 127).
- **Desktop Window:** Automatically launched via Windows native browser application mode:
  ```bash
  msedge.exe --app=http://127.0.0.1:<PORT>/#token=<SESSION_TOKEN> --user-data-dir=<ISOLATED_PROFILE>
  ```
  This creates an authentic standalone desktop application window with no browser address bar, no tabs, an independent taskbar entry, and native window controls, while avoiding the 150MB+ idle overhead and native C++ rebuild friction of full Electron.
- **Frontend:** Pure vanilla ES modules with `@xterm/xterm` (v6.0) and `@xterm/addon-fit` (v0.11), bundled offline in `public/vendor/`.

### 1.2 Security & Authentication Guarantees
- **Loopback Binding:** The server listens strictly on `127.0.0.1`, rejecting any non-local network exposure.
- **Per-Launch Session Token:** Cryptographically generated via `crypto.randomBytes(24).toString('hex')`.
- **Origin Validation:** All incoming HTTP requests and WebSocket upgrades validate the `Origin` header against `127.0.0.1:<PORT>` and `localhost:<PORT>`.
- **URL Secret Protection:** The session token is passed to the frontend via the URL hash fragment (`/#token=...`), which is never transmitted in HTTP request lines or server access logs. The frontend extracts the token on bootstrap and immediately scrubs the URL with `history.replaceState()`.
- **Session-Only Persistence:** In-memory task history is explicitly tagged and displayed in the UI as `[SESSION-ONLY]`.

---

## 2. Test Verification & Results

### 2.1 UI & Server Integration Test Suite (10 / 10 PASSED)
Executed via `npm run test:ui` (`node tests/ui_integration_tests.js`):

| Index | Test Name | Target Scenario | Status | Elapsed | Result Details |
| :---: | :--- | :--- | :---: | :---: | :--- |
| **1** | Startup & Loopback Auth | Loopback binding & 401/200 token auth | **PASSED** | 60 ms | Verified strict binding to `127.0.0.1`, unauthenticated 401, authenticated 200. |
| **2** | Starting/Stopping Terminals | ConPTY process lifecycle | **PASSED** | 2,904 ms | Started `claude` ConPTY PID, verified active in OS, cleanly stopped via API. |
| **3** | Terminal Input & Resize | Keystroke & resize over WebSocket | **PASSED** | 1,127 ms | Forwarded `\r` and resize to `110x32`, received terminal output stream. |
| **4** | Task Submission & Events | Real-time lifecycle event broadcasting | **PASSED** | 11,551 ms | Broadcasted `TASK_CREATED` $\rightarrow$ `TASK_SENT` $\rightarrow$ `TASK_COMPLETED` over `/ws/events`. |
| **5** | Correlated Response Query | REST API retrieval of completed task | **PASSED** | 11,124 ms | Polled `GET /api/tasks/:correlationId`; matched exact correlation token and result. |
| **6** | Task Timeout Transition | Timeout enforcement on heavy query | **PASSED** | 7,436 ms | Short timeout triggered `TIMED_OUT` state with descriptive error diagnostic. |
| **7** | Shutdown During Task | Closing app while task is active | **PASSED** | 3,317 ms | Mid-flight task aborted cleanly during server shutdown without promise deadlocks. |
| **8** | Input Isolation | Human typing vs. delegated task streams | **PASSED** | 16,546 ms | Injected typing into terminal while task ran; verified zero token leakage into task output. |
| **9** | Zero Orphaned PIDs | Clean process tree termination | **PASSED** | 7,040 ms | Verified both interactive terminal PIDs were dead in OS process table after shutdown. |
| **10** | Error Handling | Invalid terminal IDs and bad payloads | **PASSED** | 7 ms | Returned clean HTTP 400 without crashing server on invalid terminal ID or missing prompt. |

### 2.2 Phase 2 Regression Test Suite (8 / 8 PASSED)
Executed via `npm run test:core` (`node tests/run_all_tests.js`):
- `test_01_sequential.js` $\rightarrow$ **PASSED** (20,996 ms)
- `test_02_invalid_response.js` $\rightarrow$ **PASSED** (20,865 ms)
- `test_03_gemini_early_exit.js` $\rightarrow$ **PASSED** (4,772 ms)
- `test_04_request_timeout.js` $\rightarrow$ **PASSED** (8,201 ms)
- `test_05_malformed_ndjson.js` $\rightarrow$ **PASSED** (101 ms)
- `test_06_claude_early_exit.js` $\rightarrow$ **PASSED** (369 ms)
- `test_07_duplicate_late_response.js` $\rightarrow$ **PASSED** (113 ms)
- `test_08_cleanup_after_failure.js` $\rightarrow$ **PASSED** (6,901 ms)

### 2.3 Terminal Tab Switching & Buffer Reconnect Regression Suite (PASSED)
Executed via `npm run test:tabs` (`node tests/test_tab_switch_regression.js`):
- **Root Cause Identified:**
  1. `public/js/terminal_view.js` previously executed `container.innerHTML = ''` and re-called `term.open()` on tab switch, ripping rendered DOM elements out of the document and desyncing xterm's internal viewport.
  2. `server/terminal_manager.js` did not register new `onData` listeners or replay scrollback when subsequent WebSockets attached to an already running ConPTY process.
- **Architectural Fix Implemented:**
  1. **Persistent Dual-Container DOM:** Both Claude (`term-container-claude`) and Gemini (`term-container-gemini`) have dedicated container elements created once; tab switching simply toggles CSS `display: block` / `display: none` without touching innerHTML.
  2. **Safe Geometric Resizing:** `fitAddon.fit()` is called via `requestAnimationFrame` only after the container has valid non-zero client dimensions.
  3. **Backend Bounded Scrollback Replay Buffer:** A 1 MB circular buffer records raw ConPTY output per terminal ID and immediately replays the full scrollback buffer to any new or reconnected WebSocket client.
  4. **Active Listener Set:** `terminalRecord.dataListeners = new Set()` guarantees multiple and reconnected sockets receive live stream data without duplicate handlers.
- **Regression Test Verification:**
  - `Claude -> Gemini -> Claude` tab switching verified: Claude buffer retained across turns, zero cross-talk.
  - `Gemini -> Claude -> Gemini` tab switching verified: Gemini buffer retained across turns, zero cross-talk.
  - Fresh WebSocket reconnection verified: full scrollback replay (1,760+ chars) received immediately upon reconnect.

### 2.4 Working Project Directory Selection Suite (6 / 6 CHECKS PASSED)
Executed via `npm run test:cwd` (`node tests/test_working_directory.js`):
- **Verified Capabilities:**
  1. Initial default working directory correctly points to workbench startup directory.
  2. Non-existent and inaccessible directories rejected with HTTP 400.
  3. Valid directory selection updates server state and emits `workspace_changed` WebSocket events.
  4. Newly launched interactive Claude and Gemini terminals explicitly spawn in the selected project folder.
  5. Delegated tasks explicitly inherit and execute within the selected project directory.
  6. Folder switching does NOT silently restart or disturb already-running terminal sessions (Rule 6 verified).

**Grand Total:** 20 / 20 Tests Passing.

---

## 3. Empirical Performance Measurements

Measured on Windows 10/11 x64 (Node.js v22.23.1) via `tests/benchmark_perf.js`:

| Metric | Measured Value | Analysis & Comparison |
| :--- | :---: | :--- |
| **Cold Application Startup** | **21.12 ms** | Near-instantaneous server startup and ephemeral port binding. |
| **Idle Memory Footprint** | **60.77 MB RSS** | ~60MB RAM total (Node.js engine + ConPTY agent), compared to 150MB+ for standard Electron. |
| **Terminal Input Latency** | **5.05 ms** | Keystroke roundtrip over WebSocket to Windows ConPTY while a delegated task is actively executing in background. |
| **Task State Propagation** | **4.4 s** | Latency from task submission to agent process initialization and `TASK_SENT` event. |
| **Shutdown & Cleanup Time** | **3.6 s** | Full teardown of ConPTY sessions, ACP stdio processes, WebSockets, and loopback listener. |

---

## 4. Operational Guide

### 4.1 Running the Workbench
From `D:\Ashish_P\AI-Tools\custom-OCT`:
```powershell
# Start the workbench (spawns server + native desktop window)
npm start
```

### 4.2 Running Tests
```powershell
# Run the Phase 2 regression suite (8 core tests)
npm run test:core

# Run the Phase 3 UI & Server integration test suite (10 tests)
npm run test:ui

# Run the Terminal Tab Switching Regression suite
npm run test:tabs

# Run the Working Project Directory Selection suite
npm run test:cwd

# Run all 20 automated tests across all suites
npm run test:all
```

### 4.3 Using Interactive Terminals
1. In the left pane, switch between **Claude Code CLI** and **Gemini CLI** tabs.
2. Click **Start** to spawn the interactive process inside Windows ConPTY.
3. Type commands normally. Keystrokes, ANSI colors, cursor movements, and interactive prompts work exactly as in a native terminal.
4. Click **Terminate** to shut down the terminal process, or type `exit`.

### 4.4 Dispatching Delegated Tasks
1. In the right pane, select the target:
   - `Claude Code (Structured Stream)`: Single-turn structured execution.
   - `Gemini CLI (ACP stdio)`: Direct query to Gemini ACP session.
   - `Claude ↔ Gemini Workflow (Correlated)`: Multi-turn loop (Claude prompts $\rightarrow$ Gemini answers $\rightarrow$ Claude verifies).
2. Enter your task instruction into the textarea.
3. Click **Dispatch Task** (or press `Ctrl+Enter`).
4. Monitor real-time status in the task card, live streaming text chunks in the detail panel, and lifecycle entries in the bottom Activity Drawer.
