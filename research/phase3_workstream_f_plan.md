# Phase 3 Workstream F Audit & Implementation Plan: Security Hardening

**Workspace:** `D:\Ashish_P\AI-Tools\custom-OCT`  
**Date:** October 30, 2026  
**Status:** **AUDIT & IMPLEMENTATION PLAN (WORKSTREAM F ONLY)**  
**Target:** Loopback Binding, Constant-Time Token Verification, Origin Hardening, Path Traversal Guards, Role/Ownership Isolation, Input Validation, and Ephemeral File Cleanup  

---

## 1. Executive Summary & Security Baseline

### 1.1 Architecture Baseline
The Agent Workbench operates as a local-first desktop developer tool. It coordinates between local interactive ConPTY processes (`claude.exe` and `gemini.js`), child stdio MCP bridges, a local loopback server (`WorkbenchServer`), and a browser UI.
- All network communication is strictly local (`127.0.0.1:0`).
- All REST endpoints and WebSocket channels are protected by an ephemeral 48-character hex token (`X-Session-Token`).
- Native Claude and Gemini file-modification and bash-execution permission prompts are strictly preserved (no `--dangerously-skip-permissions` or `--yolo`).

### 1.2 Security Audit Matrix (10 Core Dimensions)

| # | Dimension | Current Implementation | Audit Finding & Gap | Risk / Threat | Proposed Hardening |
| :- | :--- | :--- | :--- | :--- | :--- |
| **F1** | **Loopback Binding** | `server.listen(port, '127.0.0.1')` | **Compliant.** Never binds to `0.0.0.0` or public interfaces. | Remote network exposure. | Maintain invariant; verify dynamic high port. |
| **F2** | **Session Token Validation** | `headerToken === this.sessionToken` | Plain string equality (`===`) is vulnerable to timing analysis. | Side-channel timing attack. | Implement `crypto.timingSafeEqual` for all token comparisons. |
| **F3** | **WebSocket Origin Validation** | `_isOriginValid(origin)` | Permissive when `origin` header is absent or opaque. | Cross-Site WebSocket Hijacking (CSWSH) from malicious local HTML. | Enforce strict localhost/127.0.0.1 matching with exact allocated port. |
| **F4** | **MCP Bridge Authentication** | `process.env.WORKBENCH_SESSION_TOKEN` | Auth failures log to stderr; bridge handles 401/403 by stopping retries. | Rogue local process masquerading as bridge. | Validate process PID, session ID, and token simultaneously upon registration. |
| **F5** | **Working Directory Isolation** | `claimTask()` checks `task.cwd === agentCwd` | `createDelegation` does not validate whether `cwd` is within accessible filesystem paths. | Directory confusion or accidental out-of-bounds writes. | Validate `path.resolve(cwd)` exists, is a directory, and reject null bytes (`\0`). |
| **F6** | **Path Traversal Protection** | `_serveStatic` uses `safePath.startsWith(this.publicDir)` | On Windows, case-insensitive paths can bypass case-sensitive `startsWith`. | Directory traversal reading server files (`/etc/passwd`, `C:\Windows`). | Case-insensitive normalized path prefix check + null byte rejection. |
| **F7** | **Task Ownership & Roles** | Ownership validated in `claimTask` and `completeTask` | `confirmCancellation` did not verify `task.toAgent === agentId`. | Worker B confirming cancellation of Worker A's task. | Add strict role and ownership validation across all task lifecycle handlers. |
| **F8** | **Input Validation & DoS Bounds** | JSON body parsed without size caps | Maliciously large JSON payloads could exhaust heap memory. | Denial of Service via unbounded memory allocation. | Enforce 1MB max body limit and validate string types, lengths, and arrays. |
| **F9** | **Sensitive Information in Logs** | Redacted in `logger.js` via `redactSecrets` | Completed in Workstream D; need verification across all server exception paths. | Token leakage in crash traces. | Confirm recursive redaction on all error objects and log calls. |
| **F10** | **Ephemeral CLI Config Cleanup** | `terminalManager.generatedFiles` set cleaned on `shutdownAll()` | Per-terminal termination does not unlink the specific config immediately. | Stale configs with old session tokens left on disk. | Unlink ephemeral config files immediately upon terminal stop/restart. |

---

## 2. Hardening Specifications

### 2.1 Constant-Time Token Comparison (`server/server.js`)
Replace standard string comparison with `crypto.timingSafeEqual`:
```javascript
  _isAuthenticated(req) {
    const headerToken = req.headers['x-session-token'];
    const auth = req.headers['authorization'];
    let candidate = null;

    if (typeof headerToken === 'string') {
      candidate = headerToken;
    } else if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
      candidate = auth.slice(7);
    }

    if (!candidate || typeof this.sessionToken !== 'string') return false;

    const candBuf = Buffer.from(candidate);
    const sessBuf = Buffer.from(this.sessionToken);
    if (candBuf.length !== sessBuf.length) return false;

    return crypto.timingSafeEqual(candBuf, sessBuf);
  }
```

### 2.2 Strict WebSocket & REST Origin Validation
In `_isOriginValid(origin)`:
```javascript
  _isOriginValid(origin) {
    if (!origin) return false; // In browser contexts, Origin is always sent
    try {
      const u = new URL(origin);
      const isLoopbackHost = (u.hostname === '127.0.0.1' || u.hostname === 'localhost');
      const isMatchingPort = Number(u.port) === this.allocatedPort;
      return isLoopbackHost && isMatchingPort;
    } catch (e) {
      return false;
    }
  }
```

### 2.3 Windows Case-Insensitive Path Traversal Guard (`server/server.js`)
In `_serveStatic`:
```javascript
  _serveStatic(req, res, pathname) {
    if (pathname.includes('\0')) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      return res.end('Bad Request');
    }

    let filePath = pathname === '/' ? '/index.html' : pathname;
    const safePath = path.resolve(this.publicDir, '.' + filePath);

    // Case-insensitive prefix check for Windows
    if (!safePath.toLowerCase().startsWith(this.publicDir.toLowerCase())) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      return res.end('Forbidden: Access Denied');
    }
    ...
```

### 2.4 Payload Size Capping & Input Validation (1MB Limit)
In `_readBody(req)`:
```javascript
  _readBody(req, maxBytes = 1048576) { // 1MB cap
    return new Promise((resolve, reject) => {
      let body = '';
      let received = 0;
      req.on('data', chunk => {
        received += chunk.length;
        if (received > maxBytes) {
          req.destroy();
          reject(new Error('Payload Too Large: Maximum body size is 1MB'));
          return;
        }
        body += chunk;
      });
      req.on('end', () => resolve(body));
      req.on('error', reject);
    });
  }
```

### 2.5 Role and Task Ownership Invariants (`server/intercom_service.js`)
Enforce:
1. `createDelegation`:
   - `instructions` must be string, $1 \le \text{length} \le 100,000$.
   - `fromAgent` must be in `['claude', 'gemini', 'user']`.
   - `toAgent` must be in `['claude', 'gemini']`.
   - `cwd` must be an existing directory on the host filesystem.
2. `confirmCancellation`:
   - `task.toAgent === agentId`.
   - `peer.sessionId === sessionId`.
3. `reportProgress`:
   - `task.toAgent === agentId`.
   - `peer.sessionId === sessionId`.
   - `task.state` must be `CLAIMED` or `RUNNING`.

### 2.6 Ephemeral Config Immediate Cleanup (`server/terminal_manager.js`)
In `terminal_manager.js`:
- When a terminal terminates (`terminate(id)` or `restartTerminal(id)`):
  - Immediately unlink the generated config file for that terminal (`.workbench/claude_mcp_config.json` or `.gemini/settings.json`).
  - Do not leave stale session tokens on disk when the terminal process is stopped.

---

## 3. Proposed Regression Test Suite (`tests/test_phase3_workstream_f.js`)

We will create a dedicated regression test suite verifying:

| Test # | Test Name | Verification Objective |
| :--- | :--- | :--- |
| **F-T1** | Loopback Binding Exclusivity | Verify server binds strictly to `127.0.0.1` and never exposes external interfaces. |
| **F-T2** | Constant-Time Token Comparison | Verify `_isAuthenticated` succeeds for valid tokens and fails for invalid/empty/truncated tokens using `crypto.timingSafeEqual`. |
| **F-T3** | Cross-Origin WebSocket Rejection | Verify WebSockets with external origin (`http://malicious.com`) are rejected with HTTP 403. |
| **F-T4** | Missing/Mismatched Port Origin Rejection | Verify requests presenting the wrong port in `Origin` header are rejected. |
| **F-T5** | Case-Insensitive Path Traversal Guard | Verify attempts to access `../`, `%2e%2e/`, or Windows drive-letter escapes are blocked with HTTP 403. |
| **F-T6** | Null-Byte Injection Rejection | Verify paths containing `%00` or `\0` are rejected with HTTP 400. |
| **F-T7** | Request Body Size Cap (1MB DoS Guard) | Verify payloads exceeding 1MB are rejected and connection destroyed. |
| **F-T8** | Invalid/Nonexistent CWD Rejection | Verify `createDelegation` with non-existent or invalid directory path throws error. |
| **F-T9** | Task Ownership & Role Spoofing Guard | Verify Agent A cannot claim, complete, fail, or confirm cancellation of Agent B's task. |
| **F-T10** | Stale Session Role Impersonation Guard | Verify terminated session ID cannot claim or complete tasks. |
| **F-T11** | Ephemeral Config Unlink on Terminal Stop | Verify terminating terminal unlinks `.workbench/claude_mcp_config.json` immediately. |
| **F-T12** | Secret Redaction Defense-in-Depth | Verify tokens, auth headers, and session cookies are never written to disk logs. |

---

## 4. Protected Boundaries Preserved

- **Zero Hidden Workers:** No background ACP or headless agent processes.
- **Zero Process Model Changes:** Exactly 1 interactive Claude ConPTY session, exactly 1 interactive Gemini ConPTY session.
- **Zero Simulated Typing:** All task claiming remains manual in the visible Gemini terminal.
- **Native Permissions Preserved:** CLI permission prompts remain fully active.
- **Protected Paths:** `C:\pmt\bit\SpineIT-ERP` remains 100% untouched.

---

## 5. Next Step & Stop Condition

Please review and confirm whether you approve this **Audit and Implementation Plan for Workstream F**. Once approved, we will apply the surgical enhancements, create the test suite `tests/test_phase3_workstream_f.js`, and run full regression verification.
