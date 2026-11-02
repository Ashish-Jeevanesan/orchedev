// D:\Ashish_P\AI-Tools\custom-OCT\core\claude_stream_client.js
// Hardened Claude Code Structured Stream Client

import { ProcessManager } from './process_manager.js';
import { TaskState } from './task.js';

const CLAUDE_BIN = 'C:\\Users\\ajeevanesan\\.local\\bin\\claude.exe';

export class ClaudeStreamClient {
  constructor({ cwd, claudeBin = CLAUDE_BIN, debug = false }) {
    this.cwd = cwd;
    this.claudeBin = claudeBin;
    this.debug = debug;
  }

  /**
   * Executes a task on Claude Code in non-interactive structured stream mode.
   */
  async executeTask(task, timeoutMs = 35000) {
    if (task.isTerminal()) {
      throw new Error(`Cannot execute task ${task.correlationId}: already in terminal state ${task.state}`);
    }

    task.transition(TaskState.SENT);

    const args = [
      '--print',
      '--verbose',
      '--permission-mode', 'plan',
      '--permission-prompts', 'none',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json'
    ];

    let resultEvent = null;
    let assistantText = '';
    const events = [];
    let isFinished = false;
    let timeoutTimer = null;

    return new Promise((resolve, reject) => {
      const managed = ProcessManager.spawnManaged({
        command: this.claudeBin,
        args,
        cwd: task.cwd || this.cwd,
        env: process.env,
        onStdoutLine: (line) => {
          if (!line.trim()) return;
          try {
            const ev = JSON.parse(line);
            events.push(ev.type);

            if (task.state === TaskState.SENT) {
              task.transition(TaskState.RUNNING);
            }

            if (ev.type === 'result') {
              resultEvent = ev;
            } else if (ev.type === 'assistant' && ev.message?.content) {
              for (const block of ev.message.content) {
                if (block.type === 'text') {
                  assistantText += block.text;
                  task.addChunk(block.text);
                }
              }
            }
          } catch (e) {
            if (this.debug) {
              console.warn(`[ClaudeStream WARN] Malformed stdout line: ${line}`);
            }
          }
        },
        onStderrLine: (line) => {
          // Stderr is actively drained to prevent OS pipe buffer deadlocks
          if (this.debug) {
            console.error(`[ClaudeStream STDERR] ${line}`);
          }
        },
        onClose: async (code, signal) => {
          if (timeoutTimer) clearTimeout(timeoutTimer);
          if (isFinished) return;
          isFinished = true;

          const finalContent = resultEvent?.result !== undefined ? resultEvent.result : assistantText;

          if (resultEvent && (resultEvent.subtype === 'success' || !resultEvent.is_error)) {
            if (task.validator && typeof task.validator === 'function') {
              try {
                const validatedResult = task.validator(finalContent);
                task.complete(validatedResult, {
                  costUSD: resultEvent.total_cost_usd,
                  durationMs: resultEvent.duration_ms,
                  usage: resultEvent.usage
                });
                resolve(task);
              } catch (valErr) {
                task.fail(valErr);
                reject(valErr);
              }
            } else {
              task.complete(finalContent, {
                costUSD: resultEvent.total_cost_usd,
                durationMs: resultEvent.duration_ms,
                usage: resultEvent.usage
              });
              resolve(task);
            }
          } else if (resultEvent && resultEvent.is_error) {
            const errMsg = resultEvent.result || `Claude task failed with error status: ${resultEvent.api_error_status}`;
            const err = new Error(errMsg);
            err.code = 'ERR_CLAUDE_TASK';
            task.fail(err);
            reject(err);
          } else {
            // Exited without a result event
            const err = new Error(`Claude process exited with code=${code}, signal=${signal} before emitting result`);
            err.code = 'ERR_EARLY_EXIT';
            task.fail(err);
            reject(err);
          }
        },
        onError: async (err) => {
          if (timeoutTimer) clearTimeout(timeoutTimer);
          if (isFinished) return;
          isFinished = true;
          task.fail(err);
          await managed.kill();
          reject(err);
        }
      });

      // Write NDJSON user message to stdin and close stdin
      const userMessage = {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: task.prompt }]
        }
      };

      try {
        managed.child.stdin.write(JSON.stringify(userMessage) + '\n');
        managed.child.stdin.end();
      } catch (err) {
        if (!isFinished) {
          isFinished = true;
          task.fail(err);
          managed.kill();
          reject(err);
        }
        return;
      }

      if (timeoutMs > 0) {
        timeoutTimer = setTimeout(async () => {
          if (!isFinished) {
            isFinished = true;
            const timeoutErr = new Error(`Claude task timed out after ${timeoutMs}ms`);
            timeoutErr.code = 'ERR_TIMEOUT';
            task.timeout(timeoutErr.message);
            await managed.kill();
            reject(timeoutErr);
          }
        }, timeoutMs);
      }
    });
  }
}
