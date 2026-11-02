# Phase 3 Workstream D Audit & Implementation Plan: Observability & Diagnostics

**Workspace:** `D:\Ashish_P\AI-Tools\custom-OCT`  
**Date:** October 30, 2026  
**Status:** **AUDIT & IMPLEMENTATION PLAN (WORKSTREAM D ONLY)**  
**Target:** Real-Time Activity Feed, Unified Event Taxonomy, Bounded Feed Storage, State Duration Metrics, and Secret-Redacted Server Logging  

---

## 1. Executive Summary & Existing Architecture Findings

### 1.1 Architecture Baseline
The Agent Workbench emits events from:
1. `server/intercom_service.js` (delegation creation, approval, state transitions, peer registration, heartbeats)
2. `server/server.js` (WebSocket broadcasting over `/ws/events`, terminal actions, directory changes)
3. `server/logger.js` (file logging to `logs/workbench.log` and console output)
4. `public/js/activity_view.js` (bottom drawer activity feed and toast alerts)
5. `public/js/task_view.js` (task detail panel and state transition history)

### 1.2 Concrete Gaps Identified in Existing Implementation

| # | Component | Current Implementation | Concrete Observability Gap | Risk / Failure Mode |
| :- | :--- | :--- | :--- | :--- |
| **D1** | `server/intercom_service.js` & `server/server.js` | Emits both `task_state_changed` AND `intercom_event` (`TASK_<STATE>`) for every single state transition. | `app.js` processes both events, resulting in duplicate log entries in the activity feed for every state transition. | Activity feed clutter and duplicate toast notifications. |
| **D2** | `public/js/activity_view.js` | Extracts detail via `payload.step || payload.error || (payload.result ? 'Completed successfully' : '')`. | If `payload` contains a task object or intercom event without `step`, the event detail renders as blank whitespace. | Uninformative activity entries with missing context. |
| **D3** | `public/js/activity_view.js` | Appends DOM elements to `#activity-feed` indefinitely without an upper bound. | Long sessions accumulate thousands of DOM nodes. | Browser memory bloat, violating Performance Constraint 6 (*"Ensure task history and activity feed do not grow without bounds"*). |
| **D4** | `server/logger.js` | Hardcodes `CWD = 'D:\\Ashish_P\\AI-Tools\\custom-OCT'` and does not sanitize log messages. | Session tokens (`X-Session-Token`) and authorization headers can leak into `logs/workbench.log`. | Security violation (*"Avoid exposing secrets, authentication tokens, or sensitive terminal contents"*). |
| **D5** | `public/js/task_view.js` | State transition history lists timestamps and reasons, but does not calculate or display elapsed time spent in each state. | User cannot determine how long a task spent awaiting approval vs. in execution without manual log inspection. | Poor diagnostic readability. |
| **D6** | `server/intercom_service.js` & `workbench_mcp_bridge.js` | No explicit progress reporting mechanism (`TASK_PROGRESS`) during lengthy task execution. | Long-running tasks show no incremental activity between `CLAIMED` and `COMPLETED`. | Operator cannot tell if Gemini is still working or hung. |

---

## 2. Unified Event Taxonomy

We define a standardized, typed event model across the workbench. Every event emitted over `/ws/events` or logged will conform to the **WorkbenchEvent Schema**:

```typescript
interface WorkbenchEvent {
  eventId: string;           // Unique monotonic ID (e.g., 'EVT_1793557200000_1a2b')
  eventType: string;         // Standard event identifier
  level: 'INFO' | 'WARN' | 'ERROR'; // Visual and severity classification
  timestamp: number;         // Epoch timestamp (ms)
  correlationId?: string;    // Associated task correlation ID (if applicable)
  agentId?: string;          // Originating or affected agent ('claude' | 'gemini' | 'user' | 'system')
  summary: string;           // Clean, concise human-readable description (1 line)
  details?: Record<string, unknown>; // Rich diagnostic metadata (no raw secrets)
}
```

### Complete Event Catalog:

| Category | Event Type | Level | Summary Template |
| :--- | :--- | :--- | :--- |
| **Task Creation** | `TASK_CREATED` | `INFO` | `Task ${correlationId} created by ${fromAgent} for ${toAgent}` |
| **Approval** | `APPROVAL_REQUESTED` | `INFO` | `Human approval requested for delegation ${correlationId}` |
| **Approval** | `APPROVAL_GRANTED` | `INFO` | `Delegation ${correlationId} approved by ${actor}` |
| **Approval** | `APPROVAL_REJECTED` | `WARN` | `Delegation ${correlationId} rejected by ${actor}: ${reason}` |
| **Queueing** | `TASK_QUEUED` | `INFO` | `Task ${correlationId} placed in ${toAgent} claimable inbox` |
| **Claiming** | `TASK_CLAIMED` | `INFO` | `Task ${correlationId} claimed by ${agentId} (session ${sessionId})` |
| **Execution** | `EXECUTION_STARTED` | `INFO` | `Execution started on ${correlationId}` |
| **Execution** | `TASK_PROGRESS` | `INFO` | `Task ${correlationId} progress: ${step}` |
| **Completion** | `TASK_COMPLETED` | `INFO` | `Task ${correlationId} completed in ${durationMs}ms: ${summary}` |
| **Review** | `CLAUDE_REVIEW_STARTED` | `INFO` | `Claude reviewing implementation of ${correlationId}` |
| **Review** | `CLAUDE_REVIEW_COMPLETED` | `INFO` | `Claude completed review of ${correlationId}` |
| **Failure** | `TASK_FAILED` | `ERROR` | `Task ${correlationId} failed: ${error}` |
| **Timeout** | `TASK_TIMED_OUT` | `ERROR` | `Task ${correlationId} timed out in state ${state} after ${budget}ms` |
| **Cancellation** | `CANCELLATION_REQUESTED` | `WARN` | `Cancellation requested for active task ${correlationId}` |
| **Cancellation** | `TASK_CANCELLED` | `WARN` | `Task ${correlationId} cancelled: ${reason}` |
| **Recovery** | `TASK_RECOVERED` | `WARN` | `Task ${correlationId} recovered on coordinator startup: ${state}` |
| **Session** | `SESSION_REGISTERED` | `INFO` | `Agent '${agentId}' connected (session ${sessionId}, gen ${generation})` |
| **Session** | `SESSION_DEGRADED` | `WARN` | `Agent '${agentId}' connectivity degraded (UNREACHABLE, missed heartbeats)` |
| **Session** | `SESSION_RECOVERED` | `INFO` | `Agent '${agentId}' connectivity restored (ONLINE)` |
| **Session** | `SESSION_DISCONNECTED` | `WARN` | `Agent '${agentId}' disconnected (session ${sessionId})` |

---

## 3. De-duplication & Event Consolidation

### 3.1 Single Source of Truth for State Transitions
In `server/intercom_service.js`:
- Eliminate the dual emission (`this.broadcastEvent('task_state_changed', ...)` AND `this.broadcastEvent('intercom_event', ...)`).
- Replace with a single structured `workbench_event` broadcast:
  ```javascript
  this._emitWorkbenchEvent({
    eventType: `TASK_${newState}`,
    level: this._levelForState(newState),
    correlationId: task.correlationId,
    agentId: actor,
    summary: this._summaryForTransition(task, newState, reason, actor),
    details: { from: previousState, to: newState, reason, actor }
  });
  ```
- Keep `task_state_changed` payload format inside `details` for backward compatibility with `task_view.js` upserting.

---

## 4. Bounded Activity Feed with Rolling FIFO Window

In `public/js/activity_view.js`:
- Introduce a strict rolling window cap: `MAX_FEED_ENTRIES = 200`.
- When `this.feed.children.length > MAX_FEED_ENTRIES`:
  - Remove the oldest entry (`this.feed.firstElementChild.remove()`).
- Add level badges with color coding:
  - `INFO`: Soft blue/gray tag
  - `WARN`: Amber tag
  - `ERROR`: Red tag
- Render formatted 3-part layout:
  `[TIMESTAMP] [LEVEL] [CORRELATION_ID] — [HUMAN_SUMMARY]`
- Clicking a correlation ID chip in the feed automatically selects that task in `TaskViewController`.

---

## 5. State Duration Metrics in Task Detail View

In `public/js/task_view.js`:
Calculate and display the time spent in each lifecycle state:
```javascript
// Render state duration timeline
stateHistory.map((entry, idx) => {
  const nextTimestamp = stateHistory[idx + 1]?.timestamp || task.completedAt || Date.now();
  const durationMs = nextTimestamp - entry.timestamp;
  const durationStr = durationMs > 1000 ? `${(durationMs / 1000).toFixed(1)}s` : `${durationMs}ms`;
  return `• ${new Date(entry.timestamp).toLocaleTimeString()} → <strong>${entry.to}</strong> [${durationStr}] (${entry.reason || 'Normal progression'}) — <em>${entry.actor}</em>`;
});
```
This allows immediate diagnosis of whether delays occurred in human approval, inbox queueing, or agent execution.

---

## 6. Secret Redaction & Structured File Logging

In `server/logger.js`:
1. **Dynamic CWD:** Initialize log path relative to `process.cwd()` or constructor parameter rather than hardcoded string.
2. **Automated Token Sanitization:**
   Implement regex scrubber:
   ```javascript
   function sanitizeLogData(input) {
     if (typeof input !== 'string') input = JSON.stringify(input);
     return input
       .replace(/token[=:][\s"']*([a-f0-9]{32,64})/gi, 'token=[REDACTED_TOKEN]')
       .replace(/X-Session-Token[\s"':]+([a-f0-9]{32,64})/gi, 'X-Session-Token: [REDACTED_TOKEN]')
       .replace(/token\.([a-f0-9]{32,64})/gi, 'token.[REDACTED_TOKEN]');
   }
   ```
3. **Structured Log Levels:** Standardize `INFO`, `WARN`, `ERROR`, `DEBUG` formatting with ISO timestamps and structured JSON data payloads.

---

## 7. Proposed Test Matrix (`tests/test_phase3_workstream_d.js`)

We will create a dedicated regression suite verifying:

| Test # | Test Name | Verification Objective |
| :--- | :--- | :--- |
| **D-T1** | Unified Event Schema | Verify all emitted events contain `eventId`, `eventType`, `level`, `timestamp`, `summary`. |
| **D-T2** | Event De-duplication | Verify state transitions emit exactly one event per transition (zero duplicate events). |
| **D-T3** | Correlation ID Inclusion | Verify all task-related events preserve correlation ID. |
| **D-T4** | Severity Level Classification | Verify `FAILED`/`TIMED_OUT` emit `ERROR`, `UNREACHABLE`/`CANCELLED` emit `WARN`, `COMPLETED` emits `INFO`. |
| **D-T5** | State Duration Calculation | Verify `stateHistory` accurately computes duration spent in `APPROVAL_REQUESTED` and `RUNNING`. |
| **D-T6** | Bounded Activity Feed (FIFO) | Verify adding 250 events to activity feed caps at 200 elements without memory growth. |
| **D-T7** | Secret Token Redaction | Verify `logger` redacts `X-Session-Token` and session cookies in disk logs. |
| **D-T8** | Diagnostic Error Detail | Verify failed operations provide actionable diagnostic messages in task detail and events. |
| **D-T9** | Session Health Events | Verify registration, degradation, and recovery emit distinct structured events. |
| **D-T10** | Progress Reporting Event | Verify worker can emit `TASK_PROGRESS` and it appears in the real-time event feed. |

---

## 8. Security & Architectural Invariants

- **Zero Process Model Changes:** Still exactly 1 Claude ConPTY session and 1 Gemini ConPTY session.
- **Zero Hidden Workers:** No background ACP or headless agent processes.
- **Zero Automated Stdin Injection:** All task claiming remains manual and visible.
- **No Token Leaks:** All logs, WebSocket payloads, and activity feeds redact authentication tokens.
- **Protected Paths:** `C:\pmt\bit\SpineIT-ERP` remains completely untouched.

---

## 9. Next Step

Please review and confirm whether you approve this **Audit and Implementation Plan for Workstream D**. Once approved, we will apply the surgical enhancements, create the test suite `tests/test_phase3_workstream_d.js`, and run full verification.
