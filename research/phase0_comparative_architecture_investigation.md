# Phase 0: Comparative Architecture Investigation — COG, October & custom-OCT

**Workspace:** `D:\Ashish_P\AI-Tools\custom-OCT`  
**Date:** October 30, 2026  
**Status:** **INVESTIGATION COMPLETE — ARCHITECTURE PROPOSAL & AUDIT**  
**Policy:** Research & Analysis Only — No source code modifications or execution changes.  

---

## Executive Summary

This investigation analyzes three agent architectures to design the next-generation **Claude + Gemini Local Agent Workbench**:
1. **COG (`D:\Ashish_P\AI-Tools\cog-test`)**: A desktop IDE using Electron, `node-pty`, floating `xterm.js` canvas windows, 31 MCP tools, SQLite state, and PTY prompt injection ("nudging") to orchestrate multi-agent teams.
2. **October Ecosystem (`agentintercom`, `october-harness`, `moirai`)**: Open-source multi-agent infrastructure providing a Go message bus, A2A protocol specifications, MCP adapters, a headless/TUI harness with a 3-tier permission engine, and cross-harness canonical session portability.
3. **Current custom-OCT (`D:\Ashish_P\AI-Tools\custom-OCT`)**: A lightweight Node.js + ConPTY + Desktop App Mode workbench with decoupled interactive terminals and managed protocol clients (Gemini ACP and Claude Stream).

We evaluate how each system solves process ownership, interactive terminal sharing, inter-agent messaging, human takeover, and permission gating. We propose a hybrid architecture that bridges the best of COG (visible interactive PTY sessions + MCP tool exposure) and October (explicit approval gating + structured A2A message envelopes) into the hardened, secure core of `custom-OCT`.

---

## 1. System Architectures & Deep Inspection

### 1.1 COG Architecture (`D:\Ashish_P\AI-Tools\cog-test`)

```
┌────────────────────────────────────────────────────────────────────────┐
│                        COG DESKTOP (Electron)                          │
│                                                                        │
│  ┌───────────────────────────┐        ┌──────────────────────────────┐ │
│  │   Claude Terminal (PTY)   │        │     Gemini Terminal (PTY)    │ │
│  │  (claude --mcp-config ..) │        │   (gemini mcp add ... --yolo)│ │
│  └─────────────┬─────────────┘        └──────────────┬───────────────┘ │
│                │ stdio (MCP JSON-RPC)                │ stdio (MCP)     │
│                ▼                                     ▼                 │
│  ┌───────────────────────────┐        ┌──────────────────────────────┐ │
│  │   Claude MCP Server       │        │     Gemini MCP Server        │ │
│  │   (src/mcp-server/index)  │        │     (src/mcp-server/index)   │ │
│  └─────────────┬─────────────┘        └──────────────┬───────────────┘ │
│                │ HTTP / WS                           │ HTTP / WS       │
│                └───────────────┐   ┌─────────────────┘                 │
│                                ▼   ▼                                   │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                     CENTRAL HUB SERVER (Node)                    │  │
│  │  - Router: /messages/send, /tasks/post, /tasks/claim, /tasks/done│  │
│  │  - SQLite Database (.cog/hub.db)                                 │  │
│  │  - Nudge Engine (injectPrompt -> pty.write to wake idle agents)  │  │
│  └──────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────┘
```

#### Verified Source Mechanics in COG:
- **CLI Process Spawning (`src/main/cli-launch.ts`):**
  - Spawns underlying shells in ConPTY via `node-pty`.
  - Claude Code is launched by writing into the PTY:
    `claude --mcp-config "<temp>/mcp.json" --dangerously-skip-permissions`
  - Gemini CLI is registered via its CLI command, then started:
    `gemini mcp add cog-gemini -e COG_HUB_PORT=... -e COG_HUB_SECRET=... node "<path>/mcp-server/index.js"`
    followed by `gemini --yolo`.
- **Inter-Agent Communication:**
  - 31 MCP tools implemented in `src/mcp-server/index.ts`.
  - Tools include `send_message`, `post_task`, `claim_task`, `complete_task`, `read_tasks`, `get_messages`, `read_ceo_notes`, and `get_agent_output`.
  - When Claude calls `send_message(to: "Gemini", text: "...")`, the MCP server calls the Hub HTTP server (`POST /messages/send`).
- **Nudge Engine (`src/main/index.ts: injectPrompt / writeChunked`):**
  - Because agents are running in interactive TUI terminals, an idle agent sits at its input prompt.
  - To deliver an incoming message or task, the Hub formats a synthetic text string:
    `[New task posted: #123 by Architect - Call read_tasks() to claim]`
  - It writes this text chunk-by-chunk into the recipient's PTY input stream (`writeToPty`), waits 150–500ms, and sends a carriage return (`\r`) to simulate human typing.
- **Context Retention:**
  - Each CLI maintains its own conversation history inside its running process.
  - Central state is preserved in SQLite (`.cog/hub.db`).
- **Security & Reliability Weaknesses Identified in COG:**
  1. **Flagrant Bypass of Permissions:** Uses `--dangerously-skip-permissions` on Claude and `--yolo` on Gemini.
  2. **PTY Keystroke Collisions:** Simulating typing into an interactive PTY while a human is typing causes character interleaving and prompt corruption.
  3. **Fragile Status Detection:** Relies on regex parsing of terminal output silence windows (`status-detector.ts`) to guess when an agent is ready to receive input.

---

### 1.2 October Ecosystem (`agentintercom`, `october-harness`, `moirai`)

```
┌────────────────────────────────────────────────────────────────────────┐
│                          OCTOBER ECOSYSTEM                             │
│                                                                        │
│   ┌─────────────────────┐                  ┌─────────────────────────┐ │
│   │   October Harness   │                  │   External Agent CLI    │ │
│   │  (TUI / RPC / SDK)  │                  │  (Claude, Codex, etc.)  │ │
│   └──────────┬──────────┘                  └────────────┬────────────┘ │
│              │                                          │              │
│              │ stdio (MCP / RPC)                        │ stdio (MCP)  │
│              ▼                                          ▼              │
│   ┌──────────────────────────────────────────────────────────────────┐ │
│   │                      OCTOBER AGENT INTERCOM                      │ │
│   │                                                                  │ │
│   │   ┌──────────────────┐    ┌─────────────────┐   ┌────────────┐   │ │
│   │   │  Agent Registry  │    │  A2A Message    │   │ Task Board │   │ │
│   │   │  (list_peers)    │    │  Router (Bus)   │   │ (Claim/Ack)│   │ │
│   │   └──────────────────┘    └─────────────────┘   └────────────┘   │ │
│   │                                                                  │ │
│   │   - Durable JSON envelopes with correlationId & replyTo          │ │
│   │   - Pull-based inbox delivery (acknowledge_messages)             │ │
│   │   - Human Approval Gates (proposals & execution gating)          │ │
│   └──────────────────────────────────┬───────────────────────────────┘ │
│                                      │                                 │
│                                      ▼                                 │
│   ┌──────────────────────────────────────────────────────────────────┐ │
│   │                         OCTOBER MOIRAI                           │ │
│   │  - Canonical Transcript Interchange (Schema v1.0)                │ │
│   │  - Discovers native session trees (~/.claude/projects, etc.)     │ │
│   │  - Tool pair atomic range extraction and fork continuation       │ │
│   └──────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────┘
```

#### Verified Source Mechanics in October:
- **Agent Intercom Protocol (`spec/`, `bus/`):**
  - Protocol v0.1 defines strict JSON envelopes:
    `{ id, correlation_id, reply_to, sender_session_id, recipient_session_id, payload, timestamp }`.
  - Communication is mediated via standard MCP tools: `list_peers`, `message_peer`, `add_task`, `claim_task`, `acknowledge_messages`.
- **Harness & Permission Engine (`october-harness`):**
  - Fork of Pi supporting 3 permission tiers:
    - `ask`: Read-only; file edits and commands require interactive user approval.
    - `accept-edits`: Read and edits allowed; terminal commands require user approval.
    - `bypass`: Unrestricted execution.
  - Project trust boundary prevents untrusted directories from registering arbitrary extensions or executing commands.
- **Moirai Canonical Transcript & Session Management (`moirai`):**
  - Discovers session histories on disk for Claude Code (`~/.claude/projects`), Codex, Pi, and Antigravity CLI.
  - Maps vendor-specific JSONL/SQLite formats into a canonical schema (`model.go`), allowing session context continuation and fork branches (`moirai continue`).
- **Open-Source vs. Proprietary Division:**
  - **Open Source:** Agent Intercom Go daemon, MCP adapters, harness engine, Moirai session conversion.
  - **Proprietary (October Desktop):** The visual infinite canvas, spatial terminal nodes, cloud relay tunnel.

---

### 1.3 Current custom-OCT Architecture (`D:\Ashish_P\AI-Tools\custom-OCT`)

```
┌────────────────────────────────────────────────────────────────────────┐
│                   CURRENT custom-OCT ARCHITECTURE                      │
│                                                                        │
│   ┌────────────────────────────────────────────────────────────────┐   │
│   │                   Desktop App Window (Edge/Chrome)             │   │
│   │   - Area A: Interactive ConPTY Terminals (Claude & Gemini)     │   │
│   │   - Area B: Delegated Task Panel & Live Stream Inspector       │   │
│   │   - Area C: Real-Time Activity & Audit Feed Drawer             │   │
│   └─────────────────┬────────────────────────────┬─────────────────┘   │
│                     │ /ws/terminal               │ /ws/events & REST   │
│                     ▼                            ▼                     │
│   ┌────────────────────────────────────────────────────────────────┐   │
│   │                  Local Server (127.0.0.1:Dynamic)              │   │
│   │   - Session Token Authentication & Origin Validation           │   │
│   │   - Structured Logging (logs/workbench.log)                    │   │
│   └─────────┬────────────────────────────────────┬─────────────────┘   │
│             │                                    │                     │
│             ▼                                    ▼                     │
│  ┌───────────────────────────┐         ┌───────────────────────────┐   │
│  │  Terminal Manager         │         │  Task Coordinator Service │   │
│  │  - Persistent ConPTY PTYs │         │  - 7-State Task Model     │   │
│  │  - 1MB Replay Buffer      │         │  - Explicit CWD routing   │   │
│  └──────────┬────────────────┘         └─────────────┬─────────────┘   │
│             │                                        │                 │
│             ├─────────────┐                          ├─────────────┐   │
│             ▼             ▼                          ▼             ▼   │
│        Claude PTY    Gemini PTY                 Claude Stream   Gemini │
│        Interactive   Interactive                Print Process    ACP   │
│        (claude.exe)  (gemini.cmd)               (One-off)     (Daemon) │
│                                                                        │
│   * INTERACTIVE PROCESSES ARE 100% DECOUPLED FROM DELEGATED PROCESSES  │
└────────────────────────────────────────────────────────────────────────┘
```

#### Key Characteristics of Current custom-OCT:
- **Strict Process Decoupling:**
  - Interactive Claude & Gemini terminals are persistent ConPTY child processes (`PID A`, `PID B`). Keystrokes flow directly from xterm.js over WebSocket to ConPTY stdin.
  - Delegated tasks run on separate managed protocol processes: Gemini ACP (`gemini --acp` over stdio JSON-RPC) and Claude Stream (`claude --print ...`).
  - Interactive terminals and delegated tasks **never share the same process or stdio pipe**, eliminating character interleaving.
- **Limitation of the Current Model:**
  - The interactive Claude terminal is completely unaware of the delegated task running in the right panel.
  - The human cannot prompt Claude in the left terminal: *"Ask Gemini to implement this"*, because the interactive Claude session does not have an MCP tool or alias pointing to Gemini.

---

## 2. Comparative Analysis

### 2.1 Process & Session Ownership

| Dimension | COG (`cog-test`) | October Ecosystem | Current custom-OCT |
| :--- | :--- | :--- | :--- |
| **Terminal Processes** | Interactive PTY per agent | Headless RPC / Interactive TUI | Interactive ConPTY PTY per CLI |
| **Delegated Execution** | Executes inside the same PTY via injected typing | Dispatched over A2A Bus to peer harness | Dedicated background protocol clients (ACP / Print) |
| **Instance Count** | 1 instance per agent (shared for human and automation) | 1 session per agent node on the bus | 2 instances per agent (1 interactive PTY + 1 delegated protocol process) |
| **Session Persistence** | Native CLI process memory + `.cog/hub.db` | Append-only JSONL session trees (`~/.october/`) | Native CLI process memory (PTY) + in-memory task registry |

### 2.2 Messaging Protocol & Correlation

| Dimension | COG (`cog-test`) | October Ecosystem | Current custom-OCT |
| :--- | :--- | :--- | :--- |
| **Transport** | MCP stdio $\leftrightarrow$ Local HTTP/WS Hub | MCP stdio $\leftrightarrow$ Go A2A Bus | Direct WebSocket / REST / ACP JSON-RPC |
| **Message Structure** | Unstructured text nudges + tool call payloads | Standardized v0.1 JSON envelopes (`correlation_id`, `reply_to`) | Strongly typed 7-state Task model (`correlationId`) |
| **Reply Correlation** | Ad-hoc (agent quotes task ID in completion text) | Cryptographic/UUID correlation envelope | Immutable `correlationId` tracking across all turns |
| **Idle Delivery** | Simulates typing into PTY (`writeToPty` + `\r`) | Pull-based inbox (`acknowledge_messages`) or CLI wake-up | Dedicated managed protocol connection (ACP / stdio) |

### 2.3 Human Takeover & Control

| Dimension | COG (`cog-test`) | October Ecosystem | Current custom-OCT |
| :--- | :--- | :--- | :--- |
| **Manual Input** | Human types into same PTY where nudges land | User interacts via TUI, web UI, or approval prompts | Dedicated visible terminal tabs with 100% input isolation |
| **Keystroke Collision Risk** | **High** (PTY nudge can interleave with human typing) | **Zero** (Messages are routed via MCP, not PTY stdin) | **Zero** (Keystrokes go to ConPTY, tasks go to ACP/stream) |
| **Approval Gates** | None (`--dangerously-skip-permissions` / `--yolo`) | Supported (`ask` / `accept-edits` approval queue) | Currently manual confirmation only |

### 2.4 Security & Permissions

| Dimension | COG (`cog-test`) | October Ecosystem | Current custom-OCT |
| :--- | :--- | :--- | :--- |
| **CLI Permissions** | Fully bypassed (`--dangerously-skip-permissions`, `--yolo`) | 3-tier gated (`ask`, `accept-edits`, `bypass`) | Plan-only mode on Claude stream; interactive terminal retains default user permissions |
| **Network Exposure** | Local HTTP server with simple shared secret | Loopback daemon or authenticated hosted relay | Strict loopback `127.0.0.1` + dynamic port + session token in hash |
| **Credential Safety** | Ambient environment | Ambient environment + token storage | Existing OAuth (`oauth-personal`) & Claude subscription; zero API keys |

---

## 3. Sequence Diagrams

### 3.1 Flow A: Current custom-OCT Workflow (Decoupled Background Task)

```
User -> Dispatch Panel: Enter prompt & select 'Claude <-> Gemini Workflow'
Dispatch Panel -> Task Coordinator: POST /api/tasks (correlationId)
Task Coordinator -> Claude Stream: Spawn claude.exe --print (Generate task)
Claude Stream --> Task Coordinator: {"question": "...", "expectedKey": "..."}
Task Coordinator -> Gemini ACP: sendRpc('session/prompt', question)
Gemini ACP --> Task Coordinator: {"answer": "...", "correlationId": "..."}
Task Coordinator -> Claude Stream: Spawn claude.exe --print (Verify answer)
Claude Stream --> Task Coordinator: {"validation": "PASSED"}
Task Coordinator -> UI Event Feed: Broadcast TASK_COMPLETED
* Note: Interactive terminal panels show zero activity during this execution.
```

### 3.2 Flow B: Target Architecture (Interactive Terminal + Approval Gated Delegation)

```
Developer -> Claude Terminal: Types: "Design the index refactor and delegate implementation to Gemini"
Claude Code -> Local MCP Tool: call delegate_to_gemini(plan, files, expectedOutcome)
Local MCP Tool -> Workbench Core: POST /api/delegations/request (plan, correlationId)
Workbench Core -> UI Approval Modal: Render Plan & prompt human for EXPLICIT APPROVAL
Developer -> UI Approval Modal: Reviews plan, clicks [APPROVE IMPLEMENTATION]
Workbench Core -> Gemini Interactive Session / Protocol: Dispatch approved plan to Gemini
Gemini Session -> Workbench Core: Streams execution chunks & file changes to Gemini Terminal & Task Inspector
Gemini Session --> Local MCP Tool: Returns implementation result & diff summary
Local MCP Tool --> Claude Code: Delivers Gemini's result as tool output in Claude's active session
Claude Code -> Claude Terminal: Reviews Gemini's changes, runs verification, displays final report to user
* Both agents' activities are visible live in their respective terminal panes.
```

---

## 4. Feature Reuse Matrix

| Capability | COG (`cog-test`) | October Ecosystem | Current custom-OCT | Recommended Strategy for Target System |
| :--- | :---: | :---: | :---: | :--- |
| **Local MCP Bridge for Agents** | **Yes** (`src/mcp-server`) | **Yes** (`adapters/`) | No (Direct protocol) | **Reuse COG/October MCP server design**: Register local MCP tool in interactive Claude and Gemini sessions. |
| **Genuine ConPTY Windows Terminals** | Yes (Electron) | No (Headless/TUI) | **Yes** (`node-pty` Node 22) | **Retain custom-OCT implementation**: High performance, zero Electron rebuild issues, 5ms keystroke latency. |
| **Human Approval Gating** | No (Auto-bypass) | **Yes** (Approval queue) | No | **Adopt October Approval Gate**: Intercept cross-agent delegation and require explicit human UI approval before worker proceeds. |
| **Correlated Request/Reply State** | Weak (ad-hoc) | **Yes** (A2A Bus Envelopes) | **Yes** (7-State Task Core) | **Retain & Extend custom-OCT Task Core**: Rock-solid state transitions and duplicate rejection. |
| **Per-Process CWD Tracking** | Partial | Partial | **Yes** (Explicit CWD) | **Retain custom-OCT implementation**: Full support for project folder switching without silent restarts. |
| **Session Transcript Portability** | No | **Yes** (`moirai`) | No | **Evaluate Moirai**: Use Moirai transcript codecs for exporting/importing conversation trees if cross-session history is needed. |
| **Process Tree Cleanup on Windows** | Partial | Partial | **Yes** (`taskkill /F /T`) | **Retain custom-OCT implementation**: Prevents zombie descendant processes on Windows. |

---

## 5. Recommended Architecture for custom-OCT

We recommend an **Integrated Agent Hub Architecture** that preserves the lightweight desktop shell of `custom-OCT` while adding an **Agent Intercom MCP Server** attached directly to the interactive CLI sessions:

```
┌────────────────────────────────────────────────────────────────────────┐
│                   RECOMMENDED AGENT WORKBENCH ARCHITECTURE             │
│                                                                        │
│   ┌────────────────────────────────────────────────────────────────┐   │
│   │                 Desktop Application Window (UI)                │   │
│   │   - Left Pane: Interactive Claude Terminal (ConPTY)            │   │
│   │   - Center/Right Pane: Interactive Gemini Terminal (ConPTY)    │   │
│   │   - Slide-over: Human Approval Modal for Delegated Plans       │   │
│   │   - Right Drawer: Delegated Tasks & Correlated Activity Feed   │   │
│   └─────────────────┬────────────────────────────┬─────────────────┘   │
│                     │ /ws/terminal               │ /ws/events & REST   │
│                     ▼                            ▼                     │
│   ┌────────────────────────────────────────────────────────────────┐   │
│   │             Workbench Core & Server (127.0.0.1:Dynamic)        │   │
│   │   - Terminal Manager (ConPTY lifecycle & CWD routing)          │   │
│   │   - Task Coordinator Service (7-state model + Approval Gate)   │   │
│   │   - Dedicated File Logger (logs/workbench.log)                 │   │
│   └─────────────────┬──────────────────────────────────────────────┘   │
│                     │                                                  │
│                     ▼ HTTP / Local RPC                                 │
│   ┌────────────────────────────────────────────────────────────────┐   │
│   │               Workbench Intercom MCP Server                    │   │
│   │   Exposes tools to interactive CLIs:                           │   │
│   │   - delegate_to_gemini(plan, instructions)                     │   │
│   │   - request_human_approval(description, steps)                 │   │
│   │   - send_intercom_message(to, text, correlationId)             │   │
│   │   - report_task_completion(taskId, resultSummary)              │   │
│   └─────────┬────────────────────────────────────┬─────────────────┘   │
│             │ stdio (MCP)                        │ stdio (MCP)         │
│             ▼                                    ▼                     │
│        Claude CLI                           Gemini CLI                 │
│        Interactive Session                  Interactive Session        │
│        (claude --mcp-config ...)            (gemini mcp add ...)       │
│                                                                        │
│   * BOTH AGENTS OPERATE VISIBLY IN THEIR RESPECTIVE TERMINALS          │
│   * ZERO KEYSTROKE COLLISIONS — MESSAGES FLOW VIA LOCAL MCP SERVER     │
│   * HUMAN APPROVAL IS EXPLICIT BEFORE WORKER EXECUTION                 │
└────────────────────────────────────────────────────────────────────────┘
```

### Core Innovations in the Recommended Architecture:
1. **Interactive CLIs Discover Each Other via MCP (No Fake Typing):**
   - Claude Code is launched with `--mcp-config` pointing to the local Workbench MCP Server.
   - Gemini CLI is launched with an MCP server registered pointing to the same server.
   - Claude naturally discovers tools like `delegate_to_gemini` and `request_human_approval`.
   - Communication flows over clean, structured JSON-RPC via the MCP protocol. No simulated PTY typing or prompt injection is used, completely eliminating keystroke collisions!
2. **Explicit Human-in-the-Loop Approval Gate:**
   - When Claude calls `delegate_to_gemini(plan, steps)`, the Workbench Intercom halts the tool response and creates a pending `APPROVAL_REQUESTED` state.
   - The UI presents the plan to the developer in an interactive modal with `[Approve]` and `[Reject/Modify]` controls.
   - Only when approved does the Workbench route the instruction to Gemini.
3. **Dual Execution Visibility:**
   - Because the task was dispatched to Gemini via the communication layer, Gemini executes the plan in its interactive session (or via ACP if running headless), and all activities are mirrored live in the workbench UI.
   - Gemini reports the completed diff/result back via `report_task_completion`, which resolves Claude's pending `delegate_to_gemini` tool call.
   - Claude receives Gemini's exact output, conducts verification, and reports back to the user in the left terminal pane.
4. **Zero API Keys & Enterprise Authentication:**
   - Both CLIs continue using their existing enterprise OAuth / subscription profiles.

---

## 6. Migration Plan

The migration can be executed in three incremental steps without breaking existing features:

1. **Step 1: Implement the Workbench Intercom MCP Server (`server/mcp/`)**
   - Build a lightweight local MCP server using `@modelcontextprotocol/sdk`.
   - Expose four core tools: `delegate_to_gemini`, `request_human_approval`, `send_message`, and `get_inbox`.
   - Connect the MCP server to `server/task_coordinator_service.js`.
2. **Step 2: Auto-Register MCP Config on Interactive Terminal Launch**
   - In `server/terminal_manager.js`, generate an ephemeral MCP config for Claude Code (`claude --mcp-config ...`) and Gemini CLI (`gemini mcp add ...`).
   - Validate that both CLIs load the tools on startup.
3. **Step 3: Add UI Approval Drawer & Synchronize Task Panel**
   - Add a pending approval notification/card in the UI for plans awaiting human sign-off.
   - Unify the Dispatch Task panel to use the same internal delegation pipeline.

---

## 7. Technical Limitations & Open Questions

1. **Claude Code Tool Execution Model:** Claude Code natively executes MCP tool calls inside its active conversation loop. However, while a tool call is awaiting human approval in the UI, Claude Code's turn remains open (held by the MCP request promise). We must verify Claude Code's maximum tool-call timeout window (typically 10 minutes) so human review does not time out.
2. **Gemini CLI Interactive Tool Execution:** Gemini CLI's interactive TTY UI handles tool calls differently from ACP mode. We must test whether Gemini CLI in interactive terminal mode requires manual tool confirmation or if `-y` / `--yolo` is acceptable when human approval has already been granted at the Workbench UI level.
3. **Context Window Growth:** When Claude and Gemini exchange multi-turn implementation reports, long code diffs will accumulate in Claude's interactive context. Moirai session compaction or summary tools may be considered if sessions extend beyond 20 turns.

---

## 8. Conclusion

The investigation confirms that:
- **COG's strength** was visible terminal interaction and MCP tool discovery, but its PTY typing injection ("nudging") and lack of human approval gates were major safety weaknesses.
- **October's strength** was structured message envelopes, permission gating, and session portability.
- **custom-OCT's strength** is its verified Windows ConPTY terminal stability, clean process management, zero keystroke collisions, and hardened task lifecycle.

The recommended architecture merges the best of all three: **Genuine ConPTY visible terminals + Local MCP inter-agent discovery + Explicit UI Human Approval Gates**, delivering the exact target experience without API keys or destructive dependencies.
