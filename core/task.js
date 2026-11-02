// D:\Ashish_P\AI-Tools\custom-OCT\core\task.js
// Task model and verified protocol lifecycle state machine

export const TaskState = Object.freeze({
  CREATED: 'CREATED',
  SENT: 'SENT',
  RUNNING: 'RUNNING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  TIMED_OUT: 'TIMED_OUT',
  CANCELLED: 'CANCELLED'
});

const TERMINAL_STATES = new Set([
  TaskState.COMPLETED,
  TaskState.FAILED,
  TaskState.TIMED_OUT,
  TaskState.CANCELLED
]);

export class Task {
  constructor({ id, correlationId, targetAgent, prompt, cwd = null, metadata = {}, validator = null }) {
    if (!correlationId) throw new Error('correlationId is required');
    if (!targetAgent) throw new Error('targetAgent is required');

    this.id = id || `task_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    this.correlationId = correlationId;
    this.targetAgent = targetAgent; // 'gemini' | 'claude'
    this.prompt = prompt;
    this.cwd = cwd; // Explicit working directory for the task
    this.metadata = metadata;
    this.validator = validator; // Optional (rawText) => parsedResult

    this.state = TaskState.CREATED;
    this.stateHistory = [
      { state: TaskState.CREATED, timestamp: Date.now() }
    ];

    this.result = null;
    this.error = null;
    this.chunks = [];
    this.usage = null;
    this.durationMs = 0;
    this.startTime = null;
    this.endTime = null;
  }

  isTerminal() {
    return TERMINAL_STATES.has(this.state);
  }

  transition(newState, details = {}) {
    if (this.isTerminal()) {
      const err = new Error(
        `Invalid transition from terminal state ${this.state} to ${newState} for correlationId ${this.correlationId}`
      );
      err.code = 'ERR_TERMINAL_STATE';
      err.details = details;
      throw err;
    }

    // Valid state progressions:
    // CREATED -> SENT -> RUNNING -> COMPLETED
    // Any non-terminal state -> FAILED | TIMED_OUT | CANCELLED
    const validNextStates = {
      [TaskState.CREATED]: [TaskState.SENT, TaskState.FAILED, TaskState.CANCELLED],
      [TaskState.SENT]: [TaskState.RUNNING, TaskState.COMPLETED, TaskState.FAILED, TaskState.TIMED_OUT, TaskState.CANCELLED],
      [TaskState.RUNNING]: [TaskState.COMPLETED, TaskState.FAILED, TaskState.TIMED_OUT, TaskState.CANCELLED]
    };

    const allowed = validNextStates[this.state] || [];
    if (!allowed.includes(newState)) {
      const err = new Error(
        `Invalid state transition: ${this.state} -> ${newState} for task ${this.correlationId}`
      );
      err.code = 'ERR_INVALID_TRANSITION';
      throw err;
    }

    this.state = newState;
    const now = Date.now();
    this.stateHistory.push({ state: newState, timestamp: now, ...details });

    if (newState === TaskState.SENT && !this.startTime) {
      this.startTime = now;
    }

    if (this.isTerminal()) {
      this.endTime = now;
      if (this.startTime) {
        this.durationMs = this.endTime - this.startTime;
      }
    }
  }

  addChunk(chunk) {
    if (this.isTerminal()) {
      return false;
    }
    if (this.state === TaskState.SENT) {
      this.transition(TaskState.RUNNING);
    }
    this.chunks.push(chunk);
    return true;
  }

  complete(result, usage = null) {
    this.result = result;
    this.usage = usage;
    this.transition(TaskState.COMPLETED);
  }

  fail(error) {
    this.error = error instanceof Error ? error.message : String(error);
    this.transition(TaskState.FAILED);
  }

  timeout(errorMsg = 'Operation timed out') {
    this.error = errorMsg;
    this.transition(TaskState.TIMED_OUT);
  }

  cancel(reason = 'Cancelled by caller') {
    this.error = reason;
    this.transition(TaskState.CANCELLED);
  }
}
