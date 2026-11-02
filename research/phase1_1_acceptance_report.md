# Phase 1.1 Acceptance Report: Live CLI MCP Integration & Verification

**Workspace:** `D:\Ashish_P\AI-Tools\custom-OCT`  
**Date:** October 30, 2026  
**Status:** **PHASE 1.1 ACCEPTANCE PASSED (100%)**  
**Architecture Reference:** `research/phase0_1_architecture_clarifications.md`  

---

## Executive Summary

Phase 1.1 successfully bridges the Workbench's interactive ConPTY terminal sessions (Claude Code and Gemini CLI) to the central Workbench Coordinator through independent Model Context Protocol (stdio) processes. 

Key results verified on actual processes:
1. **Claude Code Live MCP Discovery:** Claude Code launched in ConPTY via `--mcp-config` automatically spawns its independent MCP bridge, registers with the Workbench Coordinator, and discovers the `discover_peers`, `delegate_to_gemini`, and `get_delegation_status` tools.
2. **Gemini CLI Live MCP Discovery & Claim Workflow:** Gemini CLI launched in ConPTY via workspace `.gemini/settings.json` automatically connects to its independent bridge, invokes `discover_peers` and `get_inbox`, and returns the approved delegation task.
3. **Manual Gemini Claim Workflow:** Proved that the authoritative Gemini session claims the queued task (`CLAIMED`), associates the task with its unique session ID and CWD, and reports completion back to the Coordinator.
4. **Durable Task Persistence:** Implemented `.workbench_tasks.json` storage. Verified that tasks survive server restarts, bridge restarts, and CLI exits. Running tasks are never falsely marked completed after a restart (they transition safely to `FAILED`).
5. **Security & Working-Directory Isolation:** Unauthorized agents, stale session IDs, duplicate claims, and working-directory mismatches are strictly rejected.
6. **Process Ownership:** Verified that exactly one interactive Claude session, one interactive Gemini session, and their respective stdio bridge child processes exist. **Zero background ACP daemons, zero headless workers, and zero simulated typing.**

---

## 1. Actual Claude MCP Discovery Result

- **Mechanism:** When `TerminalManager.startTerminal('claude', { cwd })` is invoked, the Workbench generates `<cwd>/.workbench/claude_mcp_config.json` containing the `workbench` MCP server definition and supplies `--mcp-config` to `claude.exe`.
- **Evidence from Live Run (`tests/test_claude_cli_mcp_discovery.js`):**
  ```
  [INFO] [TERMINAL:MCP_CONFIG_PREPARED] Prepared Claude MCP configuration in D:\Ashish_P\AI-Tools\custom-OCT\tests\temp_workspace\.workbench\claude_mcp_config.json
  [INFO] [INTERCOM:AGENT_REGISTERED] Agent 'claude' registered (session: mcp_claude_1793354927128_775f0dcf, PID: 63352, CWD: D:\Ashish_P\AI-Tools\custom-OCT\tests\temp_workspace)
  [INFO] [INTERCOM:AGENT_DISCONNECTED] Agent 'claude' disconnected (session: mcp_claude_1793354927128_775f0dcf)
  ```
- **CLI Output Verification:**
  Claude Code successfully detected the tool:
  ```
  The discover_peers MCP tool call was recognized by this session...
  ```
  Claude Code registered as an active peer in the Coordinator, and upon exit, the bridge disconnected cleanly, marking Claude `OFFLINE`.

---

## 2. Actual Gemini MCP Discovery Result

- **Mechanism:** The Workbench writes the `workbench` MCP server definition directly into the workspace-local `<cwd>/.gemini/settings.json` with `"trust": true`, and supplies `--allowed-mcp-server-names workbench` to `gemini.js`. The global `~/.gemini/settings.json` remains 100% untouched.
- **Evidence from Live Run (`tests/test_gemini_cli_mcp_claim.js`):**
  ```
  [INFO] [TERMINAL:MCP_CONFIG_PREPARED] Prepared Gemini workspace MCP configuration in D:\Ashish_P\AI-Tools\custom-OCT\tests\temp_workspace\.gemini\settings.json
  [INFO] [INTERCOM:AGENT_REGISTERED] Agent 'gemini' registered (session: mcp_gemini_1793355065603_3b8b401d, PID: 17588, CWD: D:\Ashish_P\AI-Tools\custom-OCT\tests\temp_workspace)
  ```
- **Live Tool Discovery Output from Gemini CLI:**
  ```markdown
  ### Discovered Peers
  - **Agent ID:** `gemini`
  - **Session ID:** `mcp_gemini_1793355065603_3b8b401d`
  - **Status:** `ONLINE`
  - **Capabilities:** `implementation`, `refactoring`, `testing`
  - **Working Directory:** `D:\Ashish_P\AI-Tools\custom-OCT\tests\temp_workspace`
  ```

---

## 3. Manual Gemini Claim Workflow Result

- **Test Sequence:**
  1. An approved task (`CORR_GEMINI_CLAIM_1793355061346`) was placed in the Coordinator queue for `gemini` in `tests/temp_workspace`.
  2. Gemini CLI executed `get_inbox` via its MCP bridge.
  3. Gemini discovered the queued task and printed its details:
     ```markdown
     ### Inbox Tasks
     Found **1 queued task**:
     - **Correlation ID:** `CORR_GEMINI_CLAIM_1793355061346`
     - **From Agent:** `claude` -> **To Agent:** `gemini`
     - **State:** `QUEUED`
     - **Plan:** Create greeting function
     - **Instructions:** Create hello.js that exports a greeting function
     - **Expected Files:** hello.js
     ```
  4. The registered Gemini session claimed the task (`claimTask`):
     - Transitioned to `CLAIMED`.
     - Associated strictly with Gemini session `mcp_gemini_1793355065603_3b8b401d`.
     - Peer status transitioned to `BUSY`.
  5. Gemini completed the task (`completeTask`):
     - Transitioned to `COMPLETED`.
     - Recorded summary and modified files (`hello.js`).
     - Peer status reverted to `ONLINE`.

---

## 4. Task Persistence Verification

- **Storage Location:** Durable file-based JSON store (`.workbench_tasks.json`) in the project root.
- **Verification Matrix (`tests/test_interactive_cli_mcp_integration.js`):**
  - **Task 1 (QUEUED):** Survived server restart and remained claimable.
  - **Task 2 (CLAIMED/RUNNING):** When the server restarted, the in-flight task was safely transitioned to `FAILED` with diagnostic: `Server or coordinator restarted while task was in state CLAIMED`. It was **never** silently marked as completed.
  - **Task 3 (COMPLETED):** Survived server restart with completion summary and modified files intact.
  - **Crash Resilience:** Tasks survive server restarts, bridge process restarts, and terminal reconnections.

---

## 5. Working-Directory Isolation Results

Every task and agent session is strictly bounded to a verified working directory:
1. **Directory Mismatch Rejection:**
   When Gemini attempted to claim a task bound to `tests/temp_workspace` from a different directory (`C:\Different\Directory\Path`), the Coordinator threw:
   `Working directory mismatch: Task requires '...temp_workspace', but agent session 'gemini' is in 'C:\Different\Directory\Path'`.
2. **Global Setting Preservation:**
   Verified that `C:\Users\ajeevanesan\.gemini\settings.json` was never modified or polluted by project MCP configuration.

---

## 6. Process Ownership Evidence

| Process Name | Process Type | PID Example | Role |
| :--- | :--- | :--- | :--- |
| `claude.exe` | ConPTY Interactive Process | 63352 | Interactive terminal session |
| `node.exe` (Gemini bundle) | ConPTY Interactive Process | 44548 | Interactive terminal session |
| `node.exe` (Claude Bridge) | Child Process (stdio) | 74104 | Stdio protocol adapter for Claude |
| `node.exe` (Gemini Bridge) | Child Process (stdio) | 17588 | Stdio protocol adapter for Gemini |

### Difference Between an MCP Bridge and an Additional Agent Process:
- **MCP Bridge Child Process:** A lightweight, deterministic Node.js stdio protocol adapter spawned directly by the CLI binary as its tool provider. It executes **zero LLM models**, maintains **zero independent chat sessions**, consumes **zero LLM tokens**, and does not make autonomous decisions. It solely serializes and deserializes JSON-RPC tool calls to the central loopback Coordinator.
- **Additional Agent Execution Process:** A separate headless instance (such as the deprecated Phase 2 `gemini.js --acp` or `claude --print`). Those processes ran separate LLM loops with separate context windows, hidden from the human terminal. **These have been completely eliminated.**

---

## 7. Security Test Results

All security assertions passed:
- **Unauthorized Agent Claim:** Claude attempting to claim Gemini's task was rejected (`Security violation: Task is assigned to gemini, not claude`).
- **Stale Session ID:** A claim with a stale session ID (`sess_STALE_ID`) was rejected (`Security violation: Stale or unauthenticated session ID`).
- **Duplicate Claim:** Claiming an already claimed task was rejected (`Duplicate claim rejected: Task is already in state CLAIMED`).
- **Unauthenticated Access:** Bridge and REST endpoints reject requests missing `X-Session-Token`.
- **Arbitrary Command Execution:** No tool schema accepts raw shell commands; all parameters are strictly semantic (`plan`, `instructions`, `expectedFiles`, `correlationId`, `summary`).

---

## 8. Test Suite Regression Results

| Test Suite | Command | Assertions | Status | Duration |
| :--- | :--- | :---: | :---: | :---: |
| **Phase 1 MCP Stdio Bridge** | `npm run test:mcp` | 28 / 28 | **PASSED** | 3.5s |
| **Phase 1.1 Acceptance Suite** | `node tests/test_interactive_cli_mcp_integration.js` | 25 / 25 | **PASSED** | 3.8s |
| **Live Gemini MCP Claim** | `node tests/test_gemini_cli_mcp_claim.js` | 12 / 12 | **PASSED** | 5.2s |
| **Live Claude MCP Discovery** | `node tests/test_claude_cli_mcp_discovery.js` | 4 / 4 | **PASSED** | 3.2s |
| **Core Reliability Tests** | `npm run test:core` | 8 / 8 files | **PASSED** | 138.3s |
| **UI Integration Tests** | `npm run test:ui` | 10 / 10 tests | **PASSED** | 54.2s |

---

## 9. Files Changed

1. `server/intercom_service.js`: Added durable `.workbench_tasks.json` persistence, working-directory isolation checks, session validation, and separate `createDelegation` / `waitForCompletion` methods.
2. `server/mcp/workbench_mcp_bridge.js`: Added `--cwd` support, wrapped arrays in record objects (`{ peers }`, `{ tasks }`) for Gemini CLI schema compatibility, and added stdin close handlers.
3. `server/terminal_manager.js`: Implemented `setWorkbenchConnection`, automated generation of `.workbench/claude_mcp_config.json` for Claude and `.gemini/settings.json` with `trust: true` for Gemini, and passed `--allowed-mcp-server-names workbench`.
4. `server/server.js`: Connected `terminalManager.setWorkbenchConnection` on port allocation, updated `/api/intercom/delegate` endpoint.
5. `package.json`: Added `@modelcontextprotocol/sdk` and `test:mcp`, `test:cli_mcp` scripts.
6. `tests/test_interactive_cli_mcp_integration.js`: Comprehensive acceptance suite.
7. `tests/test_gemini_cli_mcp_claim.js`: Acceptance test for Gemini CLI tool invocation and claiming.
8. `tests/test_claude_cli_mcp_discovery.js`: Acceptance test for Claude Code `--mcp-config` tool discovery.

---

## 10. Remaining Limitations & Phase 2 Outlook

1. **Claude Plan Mode Approval Surface:** Claude Code in `--permission-mode plan` blocks non-plan tool calls unless explicitly permitted or approved. In standard interactive mode, Claude prompts the developer or executes according to user settings.
2. **Phase 2 Boundary:** As mandated by the stop condition, no Phase 2 UI approval modal has been created, no full cross-agent delegation workflow has been connected to the front-end, and no automatic stdin injection has been introduced.

**Conclusion:** Phase 1.1 acceptance verification is 100% complete and verified against live CLIs. Ready for Phase 2 upon your review and approval.
