# OrcheDev

**Orchestrate with control. Execute with confidence.**

OrcheDev is a local-first, human-supervised orchestration workbench for AI coding agents. It connects visible AI CLI sessions through a shared task coordination layer, allowing developers to delegate work, approve execution, monitor progress, and independently review results.

## Why OrcheDev?

AI coding agents are powerful, but coordinating multiple agents safely is difficult. OrcheDev provides a controlled workflow without hiding execution behind background model sessions.

- **Visible execution:** Work happens in the existing interactive CLI sessions.
- **Human approval:** Delegated tasks require approval before entering the worker queue.
- **Controlled delegation:** Agents coordinate through MCP tools and a shared task lifecycle.
- **Independent review:** The delegating agent can inspect the worker's changes and validation results.
- **Local-first:** The workbench runs on the developer's machine.
- **Observable lifecycle:** Task state, progress, cancellation, failures, and completion are tracked.
- **Native permissions:** CLI permission prompts remain under the user's control.

## How it works

1. A developer asks an interactive agent to perform a task.
2. The agent prepares a delegation request.
3. OrcheDev presents the request for human approval.
4. The worker receives the approved task in its inbox.
5. The developer claims the task in the worker's visible terminal.
6. The worker performs the implementation using its native CLI workflow.
7. The worker reports completion or failure through MCP.
8. The delegating agent independently reviews the result.

No hidden headless model workers or simulated terminal typing are required.

## Architecture

OrcheDev uses a local Node.js server, a desktop interface, terminal sessions, MCP bridges, and a shared task coordinator.

Core architectural principles:

- One authoritative interactive session per configured CLI.
- A separate MCP stdio bridge for each CLI.
- A shared task coordination and persistence layer.
- Human approval before delegation enters the execution queue.
- Explicit worker claiming in the visible terminal.
- Native CLI permission handling.
- Loopback-only server binding and authenticated local communication.

## Project status

OrcheDev is under active development. Features, configuration, and setup instructions may change as the project evolves.

## Safety principles

OrcheDev is designed around explicit human control:

- No blanket permission bypasses.
- No automatic approval of delegated work.
- No hidden headless agent sessions.
- No simulated PTY input to make an agent appear active.
- No automatic assumption that requesting cancellation means execution has stopped.

## Requirements

See the project documentation for the currently supported Windows environment, Node.js version, CLI versions, and setup process.

### macOS Prerequisites

When installing OrcheDev on macOS, ensure that **Xcode Command Line Tools** are installed before running `npm install`:
```bash
xcode-select --install
```
This is required because the terminal PTY dependency (`@homebridge/node-pty-prebuilt-multiarch`) compiles native bindings from source on Darwin if prebuilt binaries are unavailable for the specific architecture.

## Documentation

Project architecture, implementation reports, testing notes, and development documentation are maintained in the `research/` directory.

## Contributing

Contributions, bug reports, and suggestions are welcome. Please open an issue before making substantial architectural changes.

## License

License selection is pending a source provenance and third-party dependency review. Until a license is added, all rights are reserved by the copyright holder.

---

**OrcheDev** — a control plane for human-directed AI development.