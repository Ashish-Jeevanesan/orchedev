# Known Bugs

## BUG-001: `delegate_to_gemini` fails with `fetch failed` after 5 minutes

- **Status:** Open
- **Severity:** High. Every delegation that takes longer than 5 minutes (approval + claim + execution) fails on the delegating side.
- **Found:** 2026-11-03
- **Component:** `server/mcp/workbench_mcp_bridge.js`, specifically `coordinatorFetch()` and the `delegate_to_gemini` handler

### What happens
Claude calls `delegate_to_gemini`. About 5 minutes later the tool call fails with:

```
Error executing delegate_to_gemini: fetch failed
```

The task is **not** lost. On the server it stays in `QUEUED_FOR_CLAIM` / `RUNNING`, and Gemini can still claim and finish it. But Claude never receives the result, so its review step breaks. Claude has to recover by polling `get_delegation_status`.

### Evidence (2026-11-03, `logs/workbench.log`)
| Task | Created (UTC) | Claude's call failed | Server state at failure |
|---|---|---|---|
| `CORR_1793695234069_b1a12a28` (audit) | 08:40:34 | ~08:45:34 | `QUEUED_FOR_CLAIM` |
| `CORR_1793695520618_ed861264` (copy) | 08:45:20 | ~08:50:20 | `QUEUED_FOR_CLAIM` |

Both failed exactly 5 minutes after creation. The server process stayed up and kept listening on its port the whole time.

### Root cause
The bridge's `POST /api/intercom/delegate` request stays open until the task finishes. `coordinatorFetch()` uses Node's built-in `fetch` (undici). Undici's default `headersTimeout` is **300 s**, so any request that gets no response headers within 5 minutes is aborted. The `timeoutSeconds` argument (default 900 s on the coordinator side) has no effect on this client-side limit.

### Repro
1. `npm start`
2. From the Claude terminal, call `delegate_to_gemini` with any task.
3. Approve it in the UI, but don't claim it in Gemini, or give Gemini a task that takes more than 5 minutes.
4. After about 5 minutes the Claude tool call fails with `fetch failed`. `get_delegation_status` shows the task is still alive.

### Fix options
1. **Quick fix:** give the delegate request its own undici `Agent` with `headersTimeout` and `bodyTimeout` set to `timeoutMs` plus a margin, e.g. `fetch(url, { ...options, dispatcher: new Agent({ headersTimeout: t, bodyTimeout: t }) })`. Note that the overall delegation lifetime can exceed `timeoutMs`, because approval, claim and execution each have their own 15-minute timeout.
2. **Better fix:** stop holding one long request open. Have `/delegate` return the `correlationId` right away, then have the bridge poll `GET /api/intercom/tasks/:id` (for example every 5 s) until the task reaches a final state. The tool call still waits, but no single HTTP request lives longer than a few seconds.

### Related issues seen in the same session
- **Claim window vs. one-task-at-a-time worker:** the claim timeout (15 min from approval) runs while Gemini is busy with an earlier task. If several tasks are queued, the later ones expire before Gemini can get to them.
- **Inbox only shows tasks from Gemini's current folder:** the bridge queries `/api/intercom/inbox?cwd=<BRIDGE_CWD>`. A task created in the UI with folder `Claude cowork` (`CORR_1793695724686_7YF19`) is likely hidden from a Gemini terminal running in `orchedev`. Unconfirmed.
- **Wrong `potentialImpact` text:** read-only tasks still say "Modifies workspace files in …".
