// D:\Ashish_P\AI-Tools\custom-OCT\core\coordination_core.js
// Central Workbench Coordination Core with Task Lifecycle & Correlation Guarantees

import { Task, TaskState } from './task.js';
import { GeminiAcpClient } from './gemini_acp_client.js';
import { ClaudeStreamClient } from './claude_stream_client.js';

export class CoordinationCore {
  constructor({ cwd, debug = false }) {
    this.cwd = cwd;
    this.debug = debug;

    this.geminiClient = new GeminiAcpClient({ cwd, debug });
    this.claudeClient = new ClaudeStreamClient({ cwd, debug });

    this.tasks = new Map(); // correlationId -> Task
    this.duplicateOrLateResponses = [];
    this.orphanResponses = [];
    this.metrics = {
      totalTasks: 0,
      completedTasks: 0,
      failedTasks: 0,
      timedOutTasks: 0
    };
  }

  async initialize() {
    await this.geminiClient.start();
    await this.geminiClient.initialize();
    await this.geminiClient.createSession();
  }

  setCwd(newCwd) {
    this.cwd = newCwd;
  }

  createTask({ correlationId, targetAgent, prompt, cwd = null, metadata = {} }) {
    if (!correlationId) {
      correlationId = `CORR_${Date.now()}_${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
    }

    if (this.tasks.has(correlationId)) {
      throw new Error(`Task with correlationId ${correlationId} already exists`);
    }

    const task = new Task({
      correlationId,
      targetAgent,
      prompt,
      cwd: cwd || this.cwd,
      metadata
    });
    this.tasks.set(correlationId, task);
    this.metrics.totalTasks++;
    return task;
  }

  getTask(correlationId) {
    return this.tasks.get(correlationId);
  }

  async executeTask(task, timeoutMs = 30000) {
    if (task.targetAgent === 'gemini') {
      try {
        await this.geminiClient.executeTask(task, timeoutMs);
        this.metrics.completedTasks++;
        return task;
      } catch (err) {
        if (task.state === TaskState.TIMED_OUT) this.metrics.timedOutTasks++;
        else this.metrics.failedTasks++;
        throw err;
      }
    } else if (task.targetAgent === 'claude') {
      try {
        await this.claudeClient.executeTask(task, timeoutMs);
        this.metrics.completedTasks++;
        return task;
      } catch (err) {
        if (task.state === TaskState.TIMED_OUT) this.metrics.timedOutTasks++;
        else this.metrics.failedTasks++;
        throw err;
      }
    } else {
      const err = new Error(`Unknown target agent: ${task.targetAgent}`);
      task.fail(err);
      this.metrics.failedTasks++;
      throw err;
    }
  }

  /**
   * Safe handler for incoming asynchronous or external responses to guard
   * against unknown, duplicate, or late messages.
   */
  handleExternalResponse(correlationId, payload) {
    const task = this.tasks.get(correlationId);
    if (!task) {
      this.orphanResponses.push({ correlationId, payload, timestamp: Date.now() });
      return { status: 'ORPHAN_IGNORED' };
    }

    if (task.isTerminal()) {
      this.duplicateOrLateResponses.push({
        correlationId,
        currentState: task.state,
        payload,
        timestamp: Date.now()
      });
      return { status: 'DUPLICATE_LATE_REJECTED', currentState: task.state };
    }

    task.complete(payload);
    this.metrics.completedTasks++;
    return { status: 'ACCEPTED', task };
  }

  async shutdown() {
    await this.geminiClient.close();
  }
}
