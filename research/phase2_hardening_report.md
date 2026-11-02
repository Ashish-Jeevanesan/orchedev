# Claude + Gemini Agent Workbench: Phase 2 Hardening & Reliability Report

**Workspace:** `D:\Ashish_P\AI-Tools\custom-OCT`  
**Date:** October 29, 2026  
**Environment:** Windows 10/11 x64, Node.js v22.23.1, npm 10.9.8, Gemini CLI 0.66.0, Claude Code 2.1.312  

---

## Executive Summary

Phase 2 transitioned the disposable proof-of-concept into a hardened, production-grade local multi-agent coordination core. The coordination engine (`core/`) implements a validated, protocol-grounded task lifecycle state machine, deterministic correlation ID tracking, pipe deadlock prevention, robust NDJSON streaming, and Windows process-tree termination.

All 8 targeted reliability scenarios were executed and passed with a 100% success rate:
- Sequential correlated requests execute cleanly without cross-contamination.
- Malformed outputs and schema violations are caught before task completion.
- Abrupt child process crashes (both Gemini ACP and Claude) are detected instantly without promise deadlocks.
- Bounded timeouts reliably abort long queries.
- Malformed NDJSON frames and ANSI escape codes are tolerated without crashing.
- Duplicate, late, and orphaned responses are rejected and audited without state corruption.
- Full process tree termination guarantees zero orphaned child processes or file locks.

The coordination core is verified as reliable and ready for desktop UI integration.

---

## 1. Findings from Code Inspection

Inspection of the initial proof scripts (`test_gemini_acp.js`, `test_claude_stream.js`, `test_claude_stream_stdin.js`, `e2e_workbench_proof.js`) and logs revealed key vulnerabilities and operational requirements:

### 1.1 Child Process Launch & Termination
- **Proof Behavior:** Child processes were launched via `child_process.spawn`. Process termination relied on `child.stdin.end()` followed by `child.kill('SIGTERM')`.
- **Limitation on Windows:** In `win32`, `child.kill('SIGTERM')` maps to `TerminateProcess` strictly on the top-level PID. Descendant processes (e.g. Node child workers, ripgrep processes, tool subprocesses) were not guaranteed to exit, risking orphaned processes.
- **Hardened Solution:** Implemented `ProcessManager.terminateProcessTree(pid)`, which on Windows executes `taskkill /F /T /PID <pid>` to force-kill the entire process tree.

### 1.2 NDJSON Parsing & Stream Framing
- **Proof Behavior:** Input lines from `stdout` were read via `readline` and parsed using `JSON.parse(line)`.
- **Vulnerabilities:**
  - If a child process emitted non-JSON text (such as warnings, debug messages, or ANSI color sequences), unhandled parsing errors could destabilize the stream handler.
  - Partial or split JSON lines required strict line buffering.
- **Hardened Solution:** Line-buffered parser with safe JSON decoding (`try-catch`), structured error routing, and malformed line tolerance. Valid messages arriving after garbage or debug output are processed without interruption.

### 1.3 Correlation ID Generation & Propagation
- **Proof Behavior:** Correlation IDs were generated as arbitrary strings (`CORR-<timestamp>-<hash>`) and embedded solely inside user prompt text.
- **Vulnerability:** Validation was handled post-hoc using regex string stripping (`replace(/```json/g, '')`). There was no programmatic link between the correlation token and internal execution lifecycle states.
- **Hardened Solution:** The `Task` entity now encapsulates the `correlationId` as its primary key. The `CoordinationCore` maintains a strict registry (`tasks = new Map()`). External and agent responses are correlated directly to their registered task before state transitions can occur.

### 1.4 Stdio Deadlock Prevention
- **Proof Behavior:** `e2e_workbench_proof.js` attached a `readline` interface to Claude's `stdout`, but left `child.stderr` unmonitored.
- **Vulnerability:** If Claude Code or any spawned tool emitted more than 64 KB of diagnostics or warnings to `stderr`, the OS pipe buffer would saturate, causing the child process to block indefinitely (deadlock).
- **Hardened Solution:** `ProcessManager.spawnManaged` explicitly attaches continuous draining listeners to both `stdout` and `stderr` for every spawned agent process.

### 1.5 Authentication & Error Handling
- **Proof Behavior:** Relied on ambient environment inheritance (`env: process.env`).
- **Confirmation:** Gemini ACP reliably reuses `~/.gemini/settings.json` (`selectedType: "oauth-personal"`) and `~/.gemini/oauth_creds.json`. Claude Code reuses its authenticated native session.
- **Hardened Solution:** Sudden agent crashes or pipe breaks reject all pending RPC promises immediately with `ERR_PROCESS_EXITED`, preventing calling promises from hanging.

### 1.6 Security & Logging Audit
- **Findings:** Logs in `custom-OCT` contain RPC request IDs, method names, tool chunk text, token counts, and durations.
- **Confirmation:** Zero API keys, OAuth tokens, client secrets, cookie headers, or refresh tokens were dumped, logged, or written to disk.

---

## 2. Established Task Lifecycle State Model

The state machine strictly reflects states that the underlying protocols can actually establish.

```
       [ CREATED ]
            |
            v
         [ SENT ]
            |
            +------------+
            | (first ev) | (immediate complete)
            v            v
       [ RUNNING ]   [ COMPLETED ]
            |
            +---------------------------+
            |                           |
            v                           v
       [ COMPLETED ]         [ FAILED / TIMED_OUT / CANCELLED ]
```

### Protocol-Grounded State Definitions
1. **`CREATED`**: Task initialized in memory with immutable `correlationId`, target agent, and optional output validator.
2. **`SENT`**: Payload written to agent stdio (`child.stdin.write`). Start timestamp recorded.
3. **`RUNNING`**: First protocol event received (ACP `session/update` chunk for Gemini; `assistant` or `system` event for Claude).
4. **`COMPLETED`**: Terminal response received and passed schema validation. Output recorded, end timestamp and duration finalized.
5. **`FAILED`**: Process crash, protocol error, or output schema validation failure.
6. **`TIMED_OUT`**: Configured timeout elapsed before a terminal response was produced.
7. **`CANCELLED`**: Explicit cancellation (via ACP `session/cancel` or caller abort).

> **Why `ACKNOWLEDGED` was omitted:** Neither Gemini ACP nor Claude Code provides a dedicated protocol acknowledgement packet between input transmission and stream execution. Gemini starts emitting `session/update` chunks directly, while Claude emits `system`/`assistant` events. Inventing a synthetic ACK state would misrepresent the underlying transport.

### Strict State Invariants
- Once a task enters a terminal state (`COMPLETED`, `FAILED`, `TIMED_OUT`, `CANCELLED`), no further state transitions are permitted.
- Any attempt to mutate an already terminal task throws `ERR_TERMINAL_STATE`.
- Tasks configured with output validators (`task.validator`) only transition to `COMPLETED` if validation succeeds; otherwise, they transition directly to `FAILED`.

---

## 3. Reliability Test Suite Results

All 8 tests were implemented in `D:\Ashish_P\AI-Tools\custom-OCT\tests\` and executed via the master runner `run_all_tests.js`.

### Reliability Matrix

| Index | Test Name | Target Scenario | Status | Elapsed | Result Details |
| :---: | :--- | :--- | :---: | :---: | :--- |
| **1** | `test_01_sequential.js` | Two sequential requests with different correlation IDs | **PASSED** | 23,627 ms | Task 1 (`CORR_SEQ_1`) and Task 2 (`CORR_SEQ_2`) completed sequentially. Verified zero cross-contamination. |
| **2** | `test_02_invalid_response.js` | Invalid or unexpected response handling | **PASSED** | 23,596 ms | Validator rejected non-conforming response; task transitioned cleanly to `FAILED`. Recovery task completed normally. |
| **3** | `test_03_gemini_early_exit.js` | Gemini process exits before replying | **PASSED** | 5,445 ms | Process tree terminated mid-flight. Client caught exit, rejected pending RPC with `ERR_PROCESS_EXITED`, task marked `FAILED`. No hang. |
| **4** | `test_04_request_timeout.js` | Request timeout enforcement | **PASSED** | 8,092 ms | 1500 ms timeout triggered on long query. Task transitioned to `TIMED_OUT` with `ERR_TIMEOUT`. Coordinator remained stable. |
| **5** | `test_05_malformed_ndjson.js` | Malformed or incomplete NDJSON resilience | **PASSED** | 104 ms | Fed truncated JSON, raw logs, and ANSI escape sequences. Parser handled all lines safely and parsed subsequent valid RPC. |
| **6** | `test_06_claude_early_exit.js` | Claude process exits before final result | **PASSED** | 390 ms | Child exited without emitting `result` event. Client caught exit, transitioned task to `FAILED` with `ERR_EARLY_EXIT`. |
| **7** | `test_07_duplicate_late_response.js` | Duplicate or late response protection | **PASSED** | 114 ms | Late duplicate rejected with `DUPLICATE_LATE_REJECTED`. Orphan message rejected with `ORPHAN_IGNORED`. Original task unmodified. |
| **8** | `test_08_cleanup_after_failure.js` | Resource and process cleanup after failure | **PASSED** | 6,989 ms | Full coordinator session initiated. Shutdown invoked after failure. Verified PID was completely terminated with 0 zombie processes. |

**Summary:** 8 / 8 PASSED (Total Suite Duration: 68.36 s).  
**Audit Artifact:** `D:\Ashish_P\AI-Tools\custom-OCT\tests\reliability_test_results.json`.

---

## 4. Latency Measurements & Token Usage Analysis

### 4.1 Latency Breakdown
From the authenticated end-to-end multi-agent execution (`e2e_workbench_proof.js`):

| Phase | Agent / Component | Elapsed Time | Description |
| :--- | :--- | :---: | :--- |
| **Startup & Init** | Gemini ACP | 3,356 ms | Process spawn, JSON-RPC `initialize`, `session/new` |
| **Turn 1 (Task Generation)** | Claude Code | 7,671 ms | Claude stream-json execution with plan-only permissions |
| **Turn 2 (Task Execution)** | Gemini ACP | 14,242 ms | `session/prompt` roundtrip, model inference, chunk streaming |
| **Turn 3 (Verification)** | Claude Code | 26,529 ms | Verification and validation comparison |
| **Shutdown & Cleanup** | Stdio & ProcessManager | 2,303 ms | Graceful stdin close and process tree cleanup |
| **Total End-to-End** | Multi-Agent Loop | **64,101 ms** | Complete correlated multi-agent roundtrip |

### 4.2 In-Depth Analysis of Gemini ACP Input Tokens (67,587 Tokens)
In `e2e_proof_report.json`, Gemini ACP reported:
```json
"usage": {
  "inputTokens": 67587,
  "outputTokens": 149,
  "cachedReadTokens": 51376,
  "thoughtTokens": 726,
  "totalTokens": 67736
}
```

#### Key Findings:
1. **76% of Tokens Were Cached Read Tokens:**
   - Of the 67,587 reported input tokens, **51,376 were `cachedReadTokens`**.
   - Only **16,211 tokens** were uncached / new context.
2. **Composition of Context Tokens:**
   - In `test_gemini_acp.js` (a single-turn prompt in an empty folder), `inputTokens` was **17,988**.
   - Gemini CLI's baseline ACP session context includes:
     - Core agent instructions and persona mandates.
     - Complete JSON schemas for all registered tools (`run_shell_command`, `read_file`, `write_file`, `replace`, `grep_search`, `glob`, `web_fetch`, `ask_user`, `enter_plan_mode`, `invoke_agent`, `activate_skill`).
     - Installed skill instructions (`skill-creator`, `antigravity-support`).
     - The user's root memory context (`~/.gemini/GEMINI.md`, measuring ~32 KB).
3. **Cumulative Context Reporting:**
   - Google's Code Assist backend and Gemini API report `promptTokenCount` as the **cumulative context window size** presented to the model on that turn.
   - It is **not** an indication that 67,587 novel tokens were processed from scratch across the wire.
   - The server-side context cache efficiently served 51,376 tokens at reduced latency and cached token cost.

---

## 5. Preservation of Human Control & Terminal Integration Limitations

Our preferred development workflow uses visible interactive terminals allowing manual typing at any time.

### 5.1 Prototype Behavior vs. Interactive Terminals
The current coordination core communicates via **managed programmatic stdio streams** (JSON-RPC for Gemini ACP, stream-JSON for Claude Code). It does **not** attach to or wrap an active pseudoterminal (PTY/ConPTY) where a human user is interactively typing commands.

### 5.2 Critical Limitations of Shared-Terminal Input
1. **Keystroke Interleaving & Collision:** If programmatic agent requests and human keyboard strokes share the same standard input stream, keystrokes will interleave into the protocol frames. A human typing `ls -la` while an agent transmits `{"jsonrpc":"2.0"...}` results in corrupted protocol payloads and broken shell commands.
2. **Terminal Echo & Output Scrambling:** In raw interactive terminal modes, user typing is echoed back to the terminal screen. If the agent simultaneously writes streaming JSON or tool output to stdout, terminal display buffers will interleave characters, producing unreadable display corruption.
3. **Prompt Hijacking & State Confusion:** In a shared prompt session, if an agent is awaiting input and the human types, the input may be consumed by the agent rather than the terminal shell, or vice-versa.

### 5.3 Recommended Architecture for Human Control
To preserve concurrent human typing and agent execution safely, the workbench UI must **decouple the terminal execution contexts**:
- **Isolated Agent Sessions:** Programmatic agent coordination runs in managed background processes or headless PTYs.
- **Dedicated Interactive Terminals:** The human user interacts through a dedicated visible terminal tab (backed by a dedicated ConPTY instance on Windows).
- **Explicit Handoff:** Tasks passed between the user and the agent workbench are mediated through structured workbench events (e.g. "Send to Agent", "Inject to Terminal as Command"), never through raw concurrent stdin sharing.

---

## 6. Recommendation on UI Readiness

### Verdict: **READY FOR UI DEVELOPMENT**

The local coordination core has satisfied all architectural and reliability criteria:
1. **Authentication:** Zero API keys required; seamlessly reuses existing Google OAuth and Claude subscriptions.
2. **Protocol Conformance:** Gemini ACP operates cleanly over NDJSON stdio; Claude Code operates cleanly with `--verbose` stream-json.
3. **Task Lifecycle:** Robust, verified 7-state model with strict terminal state enforcement.
4. **Resilience:** Passed all 8 stress tests covering timeouts, process tree termination, malformed NDJSON, and crash recovery.
5. **Clean Workspace:** Zero modifications to `C:\pmt\bit\SpineIT-ERP`; all artifacts isolated within `D:\Ashish_P\AI-Tools\custom-OCT`.

The coordination core (`D:\Ashish_P\AI-Tools\custom-OCT\core\coordination_core.js`) is stable and ready to serve as the backend engine for a desktop workbench UI.
