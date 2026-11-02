// D:\Ashish_P\AI-Tools\custom-OCT\core\process_manager.js
// Child process lifecycle, deadlock prevention, and Windows process-tree cleanup

import { spawn, execSync } from 'child_process';
import readline from 'readline';

export class ProcessManager {
  /**
   * Safely terminates a process and all its child processes.
   * On Windows, uses taskkill /F /T /PID to guarantee no orphaned descendants.
   */
  static async terminateProcessTree(pid) {
    if (!pid || typeof pid !== 'number') return;

    if (process.platform === 'win32') {
      try {
        // Execute synchronously or asynchronously to ensure tree is dead
        execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
      } catch (err) {
        // Expected if process already exited
      }
    } else {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch (e) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch (e2) {}
      }
    }
  }

  /**
   * Spawns a managed process with proper stdio piping, stderr draining, and lifecycle hooks.
   */
  static spawnManaged({ command, args, cwd, env = process.env, onStdoutLine, onStderrLine, onClose, onError }) {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const stdoutRl = readline.createInterface({ input: child.stdout, terminal: false });
    const stderrRl = readline.createInterface({ input: child.stderr, terminal: false });

    stdoutRl.on('line', (line) => {
      if (onStdoutLine) onStdoutLine(line);
    });

    stderrRl.on('line', (line) => {
      if (onStderrLine) onStderrLine(line);
    });

    child.on('error', (err) => {
      if (onError) onError(err);
    });

    child.on('close', (code, signal) => {
      if (onClose) onClose(code, signal);
    });

    return {
      child,
      pid: child.pid,
      async kill() {
        if (child.pid) {
          await ProcessManager.terminateProcessTree(child.pid);
        }
      }
    };
  }
}
