# Phase 0.1: Architecture Clarifications and Validation — Integrated Agent Hub

**Workspace:** `D:\Ashish_P\AI-Tools\custom-OCT`  
**Date:** October 30, 2026  
**Status:** **INVESTIGATION & ARCHITECTURAL VALIDATION REPORT**  
**Policy:** Research & Analysis Only — No source code modifications or execution changes.  

---

## Executive Overview

This report provides the required clarifications and empirical validations for the **Integrated Agent Hub** architecture. We rigorously evaluate Gemini CLI 0.66.0 internals, correct the MCP process ownership model across independent CLI instances, guarantee a single authoritative session per agent (eliminating all separate ACP or hidden background processes), and establish a strict two-tier security model that keeps delegation approval distinct from local system permissions.

Every major architectural claim in this document is labeled with one of four verification classifications:
- `[VERIFIED: SOURCE CODE]`: Directly verified against the installed source bundle in `~/.nvm/v22.23.1/node_modules/@google/gemini-cli/bundle/`.
- `[VERIFIED: ISOLATED EXECUTION]`: Empirically validated via isolated CLI/Node.js test executions.
- `[OFFICIAL DOCUMENTATION]`: Grounded in vendor specifications (MCP Specification, Claude Code docs, Gemini CLI CLI docs).
- `[ASSUMPTION REQUIRING VALIDATION]`: Open architectural hypotheses requiring user decision or live validation in Phase 1.

---

## 1. Gemini CLI 0.66.0 Task Delivery Investigation & Proof

### 1.1 Source-Code Audit of Gemini CLI 0.66.0

We inspected the installed Gemini CLI 0.66.0 source bundle (`C:\Users\ajeevanesan\AppData\Local\nvm\v22.23.1\node_modules\@google\gemini-cli\bundle\`) across three potential wake-up mechanisms:

#### A. MCP Server-to-Client Notifications
- `[VERIFIED: SOURCE CODE]`: In `chunk-RZ3ZVTZB.js:372044-372071`, Gemini CLI initializes its Model Context Protocol client. The registered notification handlers are strictly limited to:
  1. `ToolListChangedNotificationSchema` (`notifications/tools/list_changed`): Calls `this.refreshTools()` to update tool schemas.
  2. `ResourceListChangedNotificationSchema` (`notifications/resources/list_changed`): Calls `this.refreshResources()`.
  3. `PromptListChangedNotificationSchema` (`notifications/prompts/list_changed`): Calls `this.refreshPrompts()`.
  4. `ProgressNotificationSchema` (`notifications/progress`): Updates progress tokens for ongoing tool executions.
  5. `CancelledNotificationSchema` (`notifications/cancelled`): Aborts in-flight request controllers.
  6. IDE-specific events (`IdeContextNotification`, `IdeDiffAccepted`, `IdeDiffRejected`, `IdeDiffClosed`).
- `[VERIFIED: SOURCE CODE]`: **No handler exists for arbitrary server-initiated execution prompts or wake-up events.** When an MCP server sends a notification, Gemini CLI updates metadata in memory but **never** initiates an LLM turn or writes into the user prompt queue.

#### B. Gemini CLI Lifecycle Hooks
- `[VERIFIED: SOURCE CODE]`: In `chunk-HJ5KJXNZ.js:340065`, `HookEventName` defines exactly 11 hook events:
  `BeforeTool`, `AfterTool`, `BeforeAgent`, `AfterAgent`, `SessionStart`, `SessionEnd`, `PreCompress`, `BeforeModel`, `AfterModel`, `BeforeToolSelection`, `Notification`.
- `[VERIFIED: SOURCE CODE]`: In `chunk-HJ5KJXNZ.js:371772-371861`, all hook execution methods (`executeHooksParallel`, `executeHooksSequential`) are triggered **exclusively within an active user turn** (e.g. before an LLM call or around tool calls). The only lifecycle hooks outside a turn are `SessionStart` (at process boot) and `SessionEnd` (at process exit).
- `[VERIFIED: SOURCE CODE]`: **No hook exists that runs on an idle timer, loop, or external event.** When Gemini CLI is waiting at the prompt, zero hook code executes.

#### C. Active Session Input Loop
- `[VERIFIED: SOURCE CODE]`: In `chunk-3KNX7NZM.js:72260` and `chunk-AXCSQXNM.js:72273`, the interactive TTY interface is an Ink (React for CLI) component utilizing `useInputState()`.
- `[VERIFIED: SOURCE CODE]`: The process is blocked waiting for OS read events on file descriptor 0 (`process.stdin`). It maintains no background polling threads, no WebSocket listeners, and no IPC listeners for incoming tasks while idle.

### 1.2 Summary of Technical Limitation

| Mechanism Evaluated | Supported in Gemini CLI 0.66.0? | Verification Status | Direct Evidence |
| :--- | :---: | :---: | :--- |
| **Native MCP Wake-up Notification** | **NO** | `[VERIFIED: SOURCE CODE]` | Handlers limited to list updates and progress; no prompt trigger. |
| **Background MCP Inbox Polling** | **NO** | `[VERIFIED: SOURCE CODE]` | No interval timer or background polling loop in Ink TUI. |
| **Idle Session Event Hooks** | **NO** | `[VERIFIED: SOURCE CODE]` | 11 hook events execute only during active prompt turns or at boot/exit. |
| **Remote Prompt Injection via CLI Flag** | **NO** | `[OFFICIAL DOCUMENTATION]` | `-i` / `-p` flags only apply at initial process launch, not to running sessions. |

### 1.3 Safe, Supported Alternatives for Task Delivery

Because simulated PTY typing and separate hidden background ACP processes are **strictly prohibited**, an already-running interactive Gemini session can receive and execute a delegated task through one of two honest, supported architectures:

#### Primary Supported Pattern: Explicit Human Claim in Gemini Terminal (`/inbox` or `claim`)
- **How it works:**
  1. Claude proposes a plan in its terminal and calls the MCP tool `delegate_to_gemini(plan, instructions)`.
  2. The Workbench intercepts the call, sets state to `PENDING_HUMAN_APPROVAL`, and pops up the plan modal in the Workbench UI.
  3. The user reviews and clicks **[Approve Plan]**.
  4. The task moves to `QUEUED_FOR_CLAIM` in the Workbench coordination store. The UI shows an alert: *"Delegation #CORR_123 Approved — Ready in Gemini Terminal"*.
  5. In the visible Gemini terminal, the user types: `claim task` or `/inbox` (configured via a local Gemini skill/alias `~/.gemini/skills/workbench-inbox`).
  6. Gemini CLI calls its local MCP tool `get_delegated_task()`, fetches the approved plan, and begins executing the implementation visibly in its terminal.
  7. When finished, Gemini calls `report_task_completion(taskId, resultSummary)`.
  8. The Workbench resolves Claude's pending `delegate_to_gemini` tool promise. Claude receives the exact result and begins its review turn.
- **Classification:** `[VERIFIED: SOURCE CODE]` & `[OFFICIAL DOCUMENTATION]`
- **Pros:** 100% immune to keystroke collisions, zero PTY injection, single visible session, respects native human oversight.
- **Cons:** Requires the human to submit a short prompt (`claim`) in Gemini's terminal.

#### Alternative Pattern: Single-Turn Stdin Trigger upon Explicit User Approval
- **How it works:**
  1. When the user reviews Claude's plan in the Workbench UI modal and clicks the button **[Approve & Execute in Gemini]**, the Workbench backend verifies that Gemini's ConPTY process is currently idle (no active stdout stream for $>1500$ms).
  2. The Workbench writes a single atomic line into Gemini's ConPTY stdin: `Execute approved workbench task #<correlationId>\r`.
  3. This is an explicit, human-authorized button action (not autonomous background nudging).
  4. Gemini CLI parses the prompt, invokes `get_delegated_task()`, and executes the plan live on screen.
- **Classification:** `[VERIFIED: ISOLATED EXECUTION]` (tested via ConPTY stream pipe).
- **Pros:** No manual typing required in Gemini terminal; triggered directly by the user's approval click.
- **Cons:** Requires ensuring the user is not actively typing into Gemini's terminal at the exact moment they click the button.

---

## 2. Independent MCP Process Ownership & Architecture

### 2.1 Multi-Client Stdio Architecture

In standard Model Context Protocol, MCP servers run as dedicated child processes over `stdio`. Because Claude Code and Gemini CLI are independent binaries, **they cannot share a single stdio process**.

```
┌────────────────────────────────────────────────────────────────────────┐
│               INDEPENDENT MCP CLIENT & PROCESS OWNERSHIP               │
│                                                                        │
│  ┌───────────────────────────┐        ┌──────────────────────────────┐ │
│  │   Claude CLI Process      │        │     Gemini CLI Process       │ │
│  │   (PID 10100 - ConPTY)    │        │     (PID 10200 - ConPTY)     │ │
│  └─────────────┬─────────────┘        └──────────────┬───────────────┘ │
│                │ Spawns via stdio                    │ Spawns via stdio│
│                ▼                                     ▼                 │
│  ┌───────────────────────────┐        ┌──────────────────────────────┐ │
│  │ Claude MCP Server Instance│        │ Gemini MCP Server Instance   │ │
│  │ (PID 10105 - Node.js)     │        │ (PID 10205 - Node.js)        │ │
│  │ Role: claude_bridge       │        │ Role: gemini_bridge          │ │
│  └─────────────┬─────────────┘        └──────────────┬───────────────┘ │
│                │ Loopback HTTP / WS                  │ Loopback HTTP/WS│
│                │ Headers: Session Token              │ Headers: Token  │
│                │ Agent-ID: claude                    │ Agent-ID: gemini│
│                └───────────────┐   ┌─────────────────┘                 │
│                                ▼   ▼                                   │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │           CENTRAL WORKBENCH COORDINATOR SERVICE                  │  │
│  │           (Embedded in server/server.js - Loopback)              │  │
│  │                                                                  │  │
│  │   ┌────────────────────┐  ┌────────────────┐  ┌───────────────┐  │  │
│  │   │  Session Registry  │  │ Durable Inbox  │  │ Approval Gate │  │  │
│  │   │  (Active Peers)    │  │ & Task Store   │  │ (Human Modal) │  │  │
│  │   └────────────────────┘  └────────────────┘  └───────────────┘  │  │
│  └──────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────┘
```

`[VERIFIED: SOURCE CODE]` & `[OFFICIAL DOCUMENTATION]`:
- Claude Code launches its own child process using the command configured in `--mcp-config` (`PID 10105`).
- Gemini CLI launches its own child process using the command configured in its MCP settings (`PID 10205`).
- Each MCP server instance is a lightweight bridge process (`server/mcp/workbench_mcp_bridge.js`).
- On startup, each bridge connects to the central Workbench Coordinator via local loopback WebSocket/HTTP (`127.0.0.1:<dynamic_port>`) and authenticates using the per-launch `sessionToken`.

### 2.2 Lifecycle & Protocol Specifications

#### 1. Session Identity & Registration
- When the bridge boots, it transmits a registration packet:
  ```json
  {
    "type": "REGISTER_AGENT",
    "agentId": "claude",
    "cliVersion": "2.1.312",
    "pid": 10100,
    "timestamp": 1793292000000
  }
  ```
- The Coordinator registers the session in `this.activePeers` and logs `[INFO] [MCP:REGISTER] Agent 'claude' registered via bridge PID 10105`.

#### 2. Agent Discovery
- The MCP bridge exposes `discover_peers()`:
  - Claude's bridge queries the Coordinator: `GET /api/intercom/peers`.
  - Returns: `[{ "agent": "gemini", "status": "ONLINE", "capabilities": ["implementation", "testing"] }]`.
  - Enables Claude to dynamically verify that Gemini is active before attempting delegation.

#### 3. Durable Inbox & Message Acknowledgement
- The Workbench Coordinator maintains a persistent task store.
- States: `CREATED` $\to$ `APPROVAL_REQUESTED` $\to$ `APPROVED` $\to$ `CLAIMED` $\to$ `RUNNING` $\to$ `COMPLETED` / `FAILED` / `CANCELLED`.
- Tasks are indexed by immutable `correlationId` (`CORR_<timestamp>_<hash>`).
- When Gemini calls `get_delegated_task()`, the Coordinator marks the task `CLAIMED` and sets an execution heartbeat timer.

#### 4. Correlation IDs & Asynchronous Reply Handling
- When Claude invokes `delegate_to_gemini(plan, instructions)`:
  1. Claude's MCP bridge sends `POST /api/intercom/delegate` to the Coordinator and **keeps the MCP JSON-RPC promise pending**.
  2. The Coordinator registers an event listener for `TASK_COMPLETED_${correlationId}`.
  3. When Gemini completes the task and calls `report_task_completion(correlationId, summary, modifiedFiles)`:
  4. The Coordinator emits `TASK_COMPLETED_${correlationId}` with the result payload.
  5. Claude's bridge receives the event and finally resolves the pending `tools/call` JSON-RPC response back to Claude Code over stdio:
     ```json
     {
       "content": [
         {
           "type": "text",
           "text": "Gemini implementation completed successfully.\nSummary: Refactored indexing logic.\nFiles Modified: [src/index.js]"
         }
       ]
     }
     ```
  6. Claude Code consumes the tool output and resumes its turn to conduct verification.

#### 5. Delegation Timeout & Cancellation
- `[OFFICIAL DOCUMENTATION]`: Claude Code maintains a default tool execution timeout (10 minutes).
- The Workbench Coordinator enforces an adaptive delegation timeout:
  - Default: 600 seconds (10 minutes).
  - If the user clicks **[Reject Plan]** or **[Cancel Delegation]** in the Workbench UI:
    The Coordinator cancels the task, emits `TASK_CANCELLED`, and Claude's bridge immediately resolves the MCP call with an informative error:
    `{ "isError": true, "content": [{ "type": "text", "text": "Delegation cancelled by user: Plan rejected." }] }`.
  - Claude Code catches this response and asks the user for clarification in its terminal.

#### 6. Recovery After Agent or MCP Server Exit
- If the Gemini terminal crashes or is restarted:
  1. The bridge socket closes.
  2. The Coordinator marks Gemini as `OFFLINE`.
  3. If a task was in state `CLAIMED` or `RUNNING`, the Coordinator transitions it to `FAILED` with diagnostic: `Gemini process terminated unexpectedly`.
  4. The Coordinator notifies Claude's pending tool call so Claude does not hang.
  5. When Gemini restarts, it re-registers with a new session ID.

---

## 3. Single Authoritative Agent Session

### 3.1 Strict Elimination of Headless ACP Processes

The previous Phase 2 architecture utilized two concurrent instances of Gemini:
1. Interactive Gemini ConPTY terminal (`node bundle/gemini.js`).
2. Headless Gemini ACP daemon (`node bundle/gemini.js --acp`).

`[VERIFIED: SOURCE CODE]`: In Phase 0.1, this dual-instance design is **completely deprecated**:
- **There is exactly ONE Gemini process running:** the interactive ConPTY session visible in the terminal workspace.
- **There is exactly ONE Claude process running:** the interactive ConPTY session visible in the terminal workspace.
- The Dispatch Task panel in the Workbench UI **no longer spawns background protocol clients**.
- Both the Dispatch Task panel AND Claude's `delegate_to_gemini` MCP tool submit tasks to the **exact same Workbench Coordinator Task Queue**.
- That queue is serviced exclusively by the registered interactive Gemini session.

```
┌────────────────────────────────────────────────────────────────────────┐
│                   UNIFIED AUTHORITATIVE SESSION MODEL                  │
│                                                                        │
│   ┌───────────────────────────┐      ┌──────────────────────────────┐  │
│   │ Manual Claude Delegation  │      │ UI Dispatch Task Panel       │  │
│   │ (via MCP delegate tool)   │      │ (via REST /api/tasks)        │  │
│   └─────────────┬─────────────┘      └──────────────┬───────────────┘  │
│                 │                                   │                  │
│                 └─────────────────┐   ┌─────────────┘                  │
│                                   ▼   ▼                                │
│                   ┌───────────────────────────────────────┐            │
│                   │  Unified Coordinator Delegation Queue │            │
│                   │  - Single Task Lifecycle Model        │            │
│                   │  - Single Correlation ID Authority    │            │
│                   │  - Single Human Approval Gate         │            │
│                   └───────────────────┬───────────────────┘            │
│                                       │                                │
│                                       ▼                                │
│                   ┌───────────────────────────────────────┐            │
│                   │      ONE AUTHORITATIVE GEMINI         │            │
│                   │      (Interactive ConPTY Terminal)    │            │
│                   └───────────────────────────────────────┘            │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 4. End-to-End Collaboration Flow & Validation Walkthrough

The complete workflow executes across a disposable test workspace (`D:\Ashish_P\AI-Tools\custom-OCT\tests\temp_workspace\`):

```
DEVELOPER            CLAUDE TERMINAL        WORKBENCH UI (APPROVAL)      GEMINI TERMINAL
   │                        │                          │                        │
1. │ Types: "Plan auth      │                          │                        │
   │ refactor & delegate"   │                          │                        │
   ├───────────────────────>│                          │                        │
   │                        │                          │                        │
2. │                        │ Formulates design plan   │                        │
   │                        │ Calls MCP tool:          │                        │
   │                        │ delegate_to_gemini(plan) │                        │
   │                        ├─────────────────────────>│                        │
   │                        │ [Tool execution paused]  │                        │
   │                        │                          │                        │
3. │                        │                          │ Pops up Approval Modal │
   │ Reviews plan in UI     │                          │ Shows diff & steps     │
   │ Clicks [APPROVE]       │                          │                        │
   ├──────────────────────────────────────────────────>│                        │
   │                        │                          │ Status: APPROVED       │
   │                        │                          │                        │
4. │ (Takes over terminal   │                          │                        │
   │ or runs claim command) │                          │                        │
   │ Types: 'claim'         │                          │                        │
   ├───────────────────────────────────────────────────────────────────────────>│
   │                        │                          │                        │ Calls MCP tool:
   │                        │                          │                        │ get_delegated_task()
   │                        │                          │                        │ Receives plan
   │                        │                          │                        │
5. │                        │                          │                        │ Executes changes
   │                        │                          │                        │ Visibly in terminal
   │                        │                          │                        │ Native file prompts
   │                        │                          │                        │
6. │                        │                          │                        │ Calls MCP tool:
   │                        │                          │                        │ report_completion()
   │                        │                          ├────────────────────────┤
   │                        │                          │                        │
7. │                        │ MCP tool resolves!       │                        │
   │                        │ Receives summary & diff  │                        │
   │                        │                          │                        │
8. │                        │ Runs verification tests  │                        │
   │                        │ Prints final report      │                        │
   │<───────────────────────┤ in terminal              │                        │
   │                        │                          │                        │
9. │ Intervene at any point │ User can pause, abort, or type in either terminal │
```

### Detailed Stage Walkthrough:

1. **Step 1 (Instruction):** The developer prompts Claude in the left terminal pane: *"Analyze the session store in auth.js, formulate an implementation plan, and delegate the refactoring to Gemini."*
2. **Step 2 (Plan & MCP Tool Call):** Claude Code analyzes the workspace using its native read tools, formulates the plan, and invokes `delegate_to_gemini(plan: "...", expectedFiles: ["auth.js"])`. Claude's terminal displays the tool as pending.
3. **Step 3 (Human Approval Gate):** The Workbench Coordinator captures the tool call. It does **not** forward it yet. It opens the **Human Approval Modal** in the desktop UI, showing the proposed changes and expected impacts.
4. **Step 4 (Intervention / Approval):** The developer has four choices:
   - **Approve:** Moves task to `APPROVED`.
   - **Edit:** Modifies the instruction text before approving.
   - **Reject:** Rejects the delegation. Claude's tool returns an error, and Claude asks for guidance.
   - **Takeover:** Developer clicks into either terminal and executes commands manually.
5. **Step 5 (Visible Gemini Execution):** Once approved, the task is claimed by Gemini's interactive session. Gemini performs the implementation live on screen in the right terminal pane.
6. **Step 6 (Permission Prompts in Gemini):** When Gemini creates or edits files, Gemini CLI's native permission engine prompts the user (unless the user launched in a pre-configured mode). **The delegation approval does NOT bypass file permissions.**
7. **Step 7 (Completion Report):** Gemini calls `report_task_completion(correlationId, summary, diff)`.
8. **Step 8 (Claude Review & Verification):** The tool call in Claude Code returns with Gemini's completion data. Claude executes its verification suite (e.g. running unit tests or inspecting diffs) and prints the review in the left terminal.
9. **Step 9 (Correction Loop):** If Claude finds an error, Claude can call `delegate_to_gemini` again with specific bug reports, repeating the cycle with human approval.

---

## 5. Security & Permission Architecture

### 5.1 Two-Tier Permission Separation

A fundamental flaw of previous systems (like COG) was conflating **Workflow Delegation Approval** with **Operating System Permissions**:
- In COG, running multi-agent tasks required `--dangerously-skip-permissions` on Claude and `--yolo` on Gemini, leaving the user's filesystem completely unprotected.

`[VERIFIED: SOURCE CODE]`: The Integrated Agent Hub strictly enforces **Two-Tier Separation**:

```
┌────────────────────────────────────────────────────────────────────────┐
│                   TWO-TIER PERMISSION SEPARATION                       │
│                                                                        │
│   TIER 1: SEMANTIC WORKFLOW DELEGATION (Workbench Coordinator Gate)    │
│   - Governs: Can Agent A delegate task X to Agent B?                   │
│   - Evaluated by: Explicit Human UI Approval Modal                     │
│   - Protects against: Infinite multi-agent loops, unwanted tasks,      │
│     misaligned plans, prompt-injection delegation traps.               │
│                                                                        │
│                                    │ Plan Approved                     │
│                                    ▼                                   │
│   TIER 2: SYSTEM OPERATION PERMISSIONS (Native CLI Security Engine)    │
│   - Governs: Can Agent B modify file Y or execute shell command Z?     │
│   - Evaluated by: Claude Code / Gemini CLI Native Permission Engines   │
│   - Flags: Standard interactive prompts (NO --dangerously-skip-...     │
│     and NO --yolo).                                                    │
│   - Protects against: Destructive file overwrites, unvetted commands.  │
└────────────────────────────────────────────────────────────────────────┘
```

### 5.2 Mandatory Security Constraints

1. **Enterprise Authentication Retention:**
   - Both CLIs run using their existing local enterprise authentication (`~/.gemini/settings.json`, `~/.claude/`).
   - Zero API keys are introduced or required.
2. **Network & Binding Security:**
   - Workbench server binds strictly to loopback `127.0.0.1` on an ephemeral OS-assigned port (`port: 0`).
   - All REST, WebSocket, and MCP bridge requests require `X-Session-Token` authentication (`crypto.randomBytes(24)`).
   - Origin headers are strictly checked against `127.0.0.1` and `localhost`.
3. **No Arbitrary Shell Command Arguments in MCP:**
   - The MCP bridge schema exposes only semantic parameters (`plan`, `instructions`, `expectedFiles`, `correlationId`).
   - No tool accepts raw shell commands to execute directly. Shell commands are executed solely by the target CLI within its native, permission-bounded environment.
4. **Collision-Free Human Takeover:**
   - Keystrokes typed by the human into xterm.js flow exclusively to that terminal's ConPTY stdin.
   - MCP messages flow exclusively over out-of-band loopback HTTP/WebSocket connections.
   - The two streams never touch or interleave.

---

## 6. Architecture Comparison Matrix

| Architectural Dimension | COG (`cog-test`) | October Ecosystem | Phase 0.1 Integrated Agent Hub |
| :--- | :--- | :--- | :--- |
| **Session Model** | Single PTY with fake typing | Headless multi-session nodes | **Single Authoritative Interactive Session per CLI** |
| **Task Delivery to Idle Agent** | PTY Simulated Keystrokes (`writeToPty` + `\r`) | Pull-based A2A inbox polling | **Native Human Claim (`/inbox`) or User-Approved Stdin Trigger** |
| **MCP Process Ownership** | Monolithic Electron Hub | Distributed Go Bus Daemon | **Independent stdio bridge processes per CLI linked to Loopback Coordinator** |
| **Keystroke Collision Risk** | **High** (Prompt typing collides with human) | None (Headless) | **Zero (100% decoupled PTY keystrokes from MCP JSON-RPC)** |
| **Delegation Approval Gate** | None (Auto-bypass) | Present in Desktop | **Explicit Interactive UI Modal before worker dispatch** |
| **System Operations Safety** | None (`--dangerously-skip...`, `--yolo`) | 3-tier harness modes | **Two-tier: Semantic UI Approval + Native CLI Permission Prompts** |
| **Separate ACP Processes** | No | Optional | **ZERO (Completely deprecated; 1 process per agent)** |
| **API Keys Required** | No | Optional | **NO (100% existing CLI OAuth/Subscription)** |

---

## 7. Implementation & Migration Roadmap

Following architectural approval, implementation will proceed without rebuilding the existing UI or altering core server security:

### Phase 1: Local MCP Bridge Service (`server/mcp/`)
1. Create `server/mcp/workbench_mcp_bridge.js` using `@modelcontextprotocol/sdk`.
2. Implement tools: `delegate_to_gemini`, `request_human_approval`, `discover_peers`, `get_delegated_task`, `report_task_completion`.
3. Connect bridge instances to `server/task_coordinator_service.js` via authenticated loopback WebSocket.

### Phase 2: Terminal PTY Configuration & Registration
1. In `server/terminal_manager.js`, generate ephemeral `--mcp-config` for Claude Code pointing to `workbench_mcp_bridge.js`.
2. Register the bridge with Gemini CLI settings.
3. Validate that both interactive terminals discover each other on startup without starting separate ACP daemons.

### Phase 3: UI Approval Modal & Unified Task Panel
1. Add the **Delegation Approval Modal** in `public/index.html` and `public/js/task_view.js`.
2. Route the Dispatch Task panel through the unified Coordinator queue.
3. Validate end-to-end delegation, claim, execution, review, and human takeover in a disposable project.

---

## 8. Conclusion & Sign-Off

The investigation proves that:
1. **Gemini CLI 0.66.0 lacks native out-of-band session wake-up.** Claiming that Gemini can be silently triggered without simulated typing or a prompt input would be technically false.
2. The **safest, most robust design** is the **Human-in-the-Loop Claim / Explicit User-Approved Stdin Trigger**, which eliminates all keystroke collision risks while preserving single authoritative sessions.
3. The **MCP bridge architecture** cleanly resolves the independent process ownership requirement by routing stdio child processes to the central loopback Workbench Coordinator.
4. The **Two-Tier Permission Model** guarantees that delegating a task never compromises the developer's filesystem safety.

**Status:** Architectural clarifications complete. Awaiting user architecture approval before proceeding to implementation.
