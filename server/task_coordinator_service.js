// D:\Ashish_P\AI-Tools\custom-OCT\server\task_coordinator_service.js
// Service layer integrating CoordinationCore with WebSocket event broadcasting

import { CoordinationCore } from '../core/coordination_core.js';
import { Task, TaskState } from '../core/task.js';
import { logger } from './logger.js';

export class TaskCoordinatorService {
  constructor({ cwd, eventBroadcaster }) {
    this.cwd = cwd;
    this.projectCwd = cwd;
    this.broadcastEvent = eventBroadcaster; // function(type, payload)
    this.core = new CoordinationCore({ cwd, debug: false });
    this.isInitialized = false;

    // Explicitly labeled as session-only in-memory storage
    this.persistenceType = 'SESSION_ONLY';
  }

  setProjectCwd(newCwd) {
    this.projectCwd = newCwd;
    this.core.setCwd(newCwd);
  }

  async initialize() {
    if (this.isInitialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      await this.core.initialize();
      this.isInitialized = true;
    })();

    return this.initPromise;
  }

  createTask({ correlationId, targetAgent, prompt, cwd = null, metadata = {} }) {
    const taskCwd = cwd || this.projectCwd || this.cwd;
    const task = this.core.createTask({
      correlationId,
      targetAgent,
      prompt,
      cwd: taskCwd,
      metadata: { ...metadata, persistence: this.persistenceType }
    });

    this._emitLifecycleEvent('TASK_CREATED', task);
    return task;
  }

  _emitLifecycleEvent(eventType, task, extra = {}) {
    if (this.broadcastEvent) {
      this.broadcastEvent('task_event', {
        eventType,
        correlationId: task.correlationId,
        id: task.id,
        state: task.state,
        targetAgent: task.targetAgent,
        durationMs: task.durationMs,
        result: task.result,
        error: task.error,
        usage: task.usage,
        timestamp: Date.now(),
        ...extra
      });
    }
  }

  async dispatchTask(task, timeoutMs = 35000) {
    if (!this.isInitialized) {
      await this.initialize();
    }

    if (task.targetAgent === 'claude_gemini_workflow') {
      throw new Error(
        'The legacy headless claude_gemini_workflow has been removed. ' +
        'Please use Claude\'s visible interactive terminal to delegate tasks via delegate_to_gemini, ' +
        'or dispatch a user task directly to Gemini through the unified approval pipeline.'
      );
    }

    // Attach chunk listener to task
    const origAddChunk = task.addChunk.bind(task);
    task.addChunk = (chunk) => {
      const added = origAddChunk(chunk);
      if (added) {
        this.broadcastEvent('task_chunk', {
          correlationId: task.correlationId,
          chunk,
          timestamp: Date.now()
        });
      }
      return added;
    };

    this._emitLifecycleEvent('TASK_SENT', task);

    try {
      await this.core.executeTask(task, timeoutMs);
      this._emitLifecycleEvent('TASK_COMPLETED', task);
      return task;
    } catch (err) {
      if (task.state === TaskState.TIMED_OUT) {
        this._emitLifecycleEvent('TASK_TIMED_OUT', task, { error: err.message });
      } else {
        this._emitLifecycleEvent('TASK_FAILED', task, { error: err.message });
      }
      throw err;
    }
  }

  getTask(correlationId) {
    const task = this.core.getTask(correlationId);
    if (!task) return null;
    return this._serializeTask(task);
  }

  getAllTasks() {
    const list = [];
    for (const task of this.core.tasks.values()) {
      list.push(this._serializeTask(task));
    }
    return list;
  }

  _serializeTask(task) {
    return {
      id: task.id,
      correlationId: task.correlationId,
      targetAgent: task.targetAgent,
      prompt: task.prompt,
      cwd: task.cwd || this.projectCwd || this.cwd,
      state: task.state,
      stateHistory: task.stateHistory,
      result: task.result,
      error: task.error,
      chunksCount: task.chunks.length,
      usage: task.usage,
      startTime: task.startTime,
      endTime: task.endTime,
      durationMs: task.durationMs,
      persistence: this.persistenceType
    };
  }

  async cancelTask(correlationId) {
    const task = this.core.getTask(correlationId);
    if (!task || task.isTerminal()) return false;

    task.cancel('Cancelled by user via Workbench UI');
    if (task.targetAgent === 'gemini') {
      await this.core.geminiClient.cancelSessionPrompt();
    }
    this._emitLifecycleEvent('TASK_CANCELLED', task);
    return true;
  }

  async shutdown() {
    await this.core.shutdown();
  }
}
