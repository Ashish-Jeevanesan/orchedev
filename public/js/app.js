// D:\Ashish_P\AI-Tools\custom-OCT\public\js\app.js
// Main Workbench Application Bootstrap
// Phase 3 Workstream G: Workspace Switcher, One-Click Path Copy, Global Event Routing & Reconnection

import { TerminalViewController } from './terminal_view.js';
import { TaskViewController } from './task_view.js';
import { ActivityViewController } from './activity_view.js';
import { dialogService } from './dialog_service.js';
import { getIcon, initIcons } from './icons.js';
import { PaneLayoutController } from './pane_layout.js';
import { SessionsViewController } from './sessions_view.js';

function extractAndClearToken() {
  const hash = window.location.hash;
  let token = null;

  if (hash && hash.includes('token=')) {
    const match = hash.match(/token=([a-f0-9]+)/i);
    if (match) {
      token = match[1];
    }
  }

  // Clear hash immediately for security
  if (window.location.hash) {
    history.replaceState(null, document.title, window.location.pathname + window.location.search);
  }

  // Fallback to localStorage or prompt if running in manual dev mode
  if (!token) {
    token = sessionStorage.getItem('workbench_token');
  }

  if (token) {
    sessionStorage.setItem('workbench_token', token);
  }

  return token;
}

class WorkbenchApp {
  constructor() {
    this.token = extractAndClearToken();
    this.wsEvents = null;
    this.terminalView = null;
    this.taskView = null;
    this.activityView = null;
    this.projectCwd = null;
    this.allowedRoots = [];
    this.statusEl = document.getElementById('ws-status');
  }

  async start() {
    if (!this.token) {
      dialogService.alert({
        title: 'Authentication Required',
        message: 'Missing authentication session token. Please launch via npm start / launcher.js.',
        type: 'error'
      });
      return;
    }

    // Expose app reference globally for component cross-navigation
    window.workbenchApp = this;

    // Render consistent SVG icons across header, tabs, controls, and tags
    initIcons();

    this.activityView = new ActivityViewController();
    this.paneLayout = new PaneLayoutController();
    this.paneLayout.init();

    this.taskView = new TaskViewController({
      token: this.token,
      onToast: (msg, type) => this.activityView.toast(msg, type)
    });

    this.terminalView = new TerminalViewController({
      token: this.token,
      onStatusChange: (statuses) => this.terminalView.updateProcessStatuses(statuses)
    });

    this.sessionsView = new SessionsViewController({
      token: this.token,
      onToast: (msg, type) => this.activityView.toast(msg, type),
      onResumed: (agent) => {
        if (this.terminalView) {
          this.terminalView.clearBuffer(agent);
          this.terminalView.switchTab(agent);
        }
      }
    });
    this.sessionsView.init();

    this.terminalView.init();
    await this.taskView.loadInitialTasks();

    this._connectEventsWs();
    await this._verifySession();
    this._bindGlobalActions();
  }

  _connectEventsWs() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/events`;

    const ws = new WebSocket(wsUrl, [`token.${this.token}`]);
    this.wsEvents = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'auth', token: this.token }));
      if (this.statusEl) {
        this.statusEl.className = 'connection-status connected';
        this.statusEl.querySelector('.status-text').textContent = 'Connected';
      }
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'workbench_event') {
          // Canonical event stream for Activity Feed (single source of truth)
          this.activityView.logWorkbenchEvent(msg.payload);
        } else if (msg.type === 'approval_requested') {
          const payload = msg.payload;
          if (payload.task) {
            this.taskView.upsertTask(payload.task);
            this.taskView.openApprovalModal(payload.task);
          }
        } else if (msg.type === 'approval_decision') {
          const payload = msg.payload;
          if (payload.task) this.taskView.upsertTask(payload.task);
        } else if (msg.type === 'task_state_changed') {
          const payload = msg.payload;
          if (payload.task) this.taskView.upsertTask(payload.task);
        } else if (msg.type === 'task_event') {
          const payload = msg.payload;
          this.taskView.upsertTask(payload);
        } else if (msg.type === 'intercom_event') {
          if (msg.payload && msg.payload.task) this.taskView.upsertTask(msg.payload.task);
        } else if (msg.type === 'task_chunk') {
          const payload = msg.payload;
          this.taskView.appendChunk(payload.correlationId, payload.chunk);
        } else if (msg.type === 'terminal_status') {
          this.terminalView.updateProcessStatuses(msg.payload);
        } else if (msg.type === 'peer_status') {
          if (this.terminalView && typeof this.terminalView.updatePeerStatuses === 'function') {
            this.terminalView.updatePeerStatuses(msg.payload);
          }
        } else if (msg.type === 'workspace_changed') {
          const newCwd = msg.payload.projectCwd;
          this.setWorkingFolderDisplay(newCwd);
        }
      } catch (e) {
        console.error('Error handling WebSocket event:', e);
      }
    };

    ws.onclose = () => {
      if (this.statusEl) {
        this.statusEl.className = 'connection-status';
        this.statusEl.querySelector('.status-text').textContent = 'Disconnected';
      }
      setTimeout(() => this._connectEventsWs(), 2000);
    };
  }

  setWorkingFolderDisplay(cwd, allowedRoots = null) {
    this.projectCwd = cwd;
    if (Array.isArray(allowedRoots)) {
      this.allowedRoots = allowedRoots;
    }

    const pathEl = document.getElementById('ws-path-display');
    if (pathEl) {
      pathEl.textContent = cwd;
      pathEl.title = `Current Project Working Directory: ${cwd}`;
    }

    if (this.taskView) {
      this.taskView.setProjectCwd(cwd);
    }

    // Populate quick-switch dropdown if multiple authorized roots are available
    const switchEl = document.getElementById('ws-quick-switch');
    if (switchEl && this.allowedRoots && this.allowedRoots.length > 1) {
      switchEl.innerHTML = this.allowedRoots.map(root => {
        const isSelected = root.toLowerCase() === cwd.toLowerCase() ? 'selected' : '';
        const shortName = root.split(/[\\/]/).filter(Boolean).pop() || root;
        return `<option value="${root}" ${isSelected}>${shortName} (${root})</option>`;
      }).join('');
      switchEl.style.display = 'inline-block';
    } else if (switchEl) {
      switchEl.style.display = 'none';
    }
  }

  async _verifySession() {
    try {
      const res = await fetch('/api/session/verify', {
        headers: { 'X-Session-Token': this.token }
      });
      const data = await res.json();
      if (data.allowedRoots) {
        this.allowedRoots = data.allowedRoots;
      }
      if (data.projectCwd) {
        this.setWorkingFolderDisplay(data.projectCwd, data.allowedRoots);
      }
      if (data.terminals) {
        this.terminalView.updateProcessStatuses(data.terminals);
      }

      // Query active peers for initial MCP bridge health indicators
      try {
        const peersRes = await fetch('/api/intercom/peers', {
          headers: { 'X-Session-Token': this.token }
        });
        const peers = await peersRes.json();
        if (Array.isArray(peers) && this.terminalView && typeof this.terminalView.updatePeerStatuses === 'function') {
          this.terminalView.updatePeerStatuses(peers);
        }
      } catch (err) {}
    } catch (e) {
      console.error('Session verify failed:', e);
    }
  }

  _bindGlobalActions() {
    // 1. One-Click Copy Working Folder Path
    const copyPathBtn = document.getElementById('btn-copy-ws-path');
    if (copyPathBtn) {
      copyPathBtn.addEventListener('click', () => {
        if (!this.projectCwd) return;
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(this.projectCwd).then(() => {
            copyPathBtn.classList.add('btn-copied');
            copyPathBtn.textContent = 'Copied!';
            setTimeout(() => {
              copyPathBtn.classList.remove('btn-copied');
              copyPathBtn.textContent = 'Copy';
            }, 1500);
          }).catch(err => {
            this.activityView.toast(`Copy failed: ${err.message}`, 'error');
          });
        }
      });
    }

    // 2. Quick Switch Dropdown for Authorized Roots
    const switchEl = document.getElementById('ws-quick-switch');
    if (switchEl) {
      switchEl.addEventListener('change', async (e) => {
        const targetPath = e.target.value;
        if (!targetPath || targetPath === this.projectCwd) return;

        try {
          const res = await fetch('/api/workspace/select', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Session-Token': this.token
            },
            body: JSON.stringify({ path: targetPath })
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Failed to switch workspace');

          this.setWorkingFolderDisplay(data.projectCwd);
          this.activityView.toast(`Switched working folder to: ${data.projectCwd}`, 'info');
        } catch (err) {
          this.activityView.toast(`Workspace switch failed: ${err.message}`, 'error');
          // Revert selection
          switchEl.value = this.projectCwd;
        }
      });
    }

    // 3. Browse Folder Dialog (Windows native PowerShell dialog)
    const browseBtn = document.getElementById('btn-browse-folder');
    if (browseBtn) {
      browseBtn.addEventListener('click', async () => {
        browseBtn.disabled = true;
        browseBtn.textContent = 'Selecting...';
        try {
          const res = await fetch('/api/workspace/browse', {
            method: 'POST',
            headers: { 'X-Session-Token': this.token }
          });
          const data = await res.json();
          if (data.projectCwd && !data.cancelled) {
            this.setWorkingFolderDisplay(data.projectCwd);
            this.activityView.toast(`Working folder updated: ${data.projectCwd}`, 'info');
          }
        } catch (err) {
          this.activityView.toast(`Folder browse error: ${err.message}`, 'error');
        } finally {
          browseBtn.disabled = false;
          browseBtn.textContent = 'Browse...';
        }
      });
    }

    // 4. Clickable path display for manual prompt entry
    const pathEl = document.getElementById('ws-path-display');
    if (pathEl) {
      pathEl.style.cursor = 'pointer';
      pathEl.addEventListener('click', async () => {
        const manual = await dialogService.prompt({
          title: 'Set Working Project Directory',
          message: 'Enter absolute path to an accessible project workspace:',
          placeholder: 'D:\\Projects\\MyApp',
          defaultValue: this.projectCwd || '',
          icon: 'folder'
        });
        if (manual && manual.trim()) {
          try {
            const res = await fetch('/api/workspace/select', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-Session-Token': this.token
              },
              body: JSON.stringify({ path: manual.trim() })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed to set directory');
            this.setWorkingFolderDisplay(data.projectCwd);
            this.activityView.toast(`Working folder set to: ${data.projectCwd}`, 'info');
          } catch (e) {
            this.activityView.toast(e.message, 'error');
          }
        }
      });
    }

    // 5. Shutdown Button
    const shutdownBtn = document.getElementById('btn-shutdown');
    if (shutdownBtn) {
      shutdownBtn.addEventListener('click', async () => {
        const confirmed = await dialogService.confirm({
          title: 'Shutdown Workbench',
          message: 'Terminate all interactive terminals, close background bridges, and shutdown the workbench server listener?',
          confirmText: 'Shutdown',
          destructive: true,
          icon: 'power'
        });

        if (confirmed) {
          try {
            await fetch('/api/shutdown', {
              method: 'POST',
              headers: { 'X-Session-Token': this.token }
            });
            document.body.innerHTML = `
              <div style="display:flex; height:100vh; align-items:center; justify-content:center; flex-direction:column; gap:16px;">
                <h2>Workbench Shutdown Complete</h2>
                <p style="color:#8392a5;">All terminal sessions, managed processes, and server listeners were cleanly terminated.</p>
                <p style="color:#546274;">You may close this window.</p>
              </div>
            `;
          } catch (e) {
            window.close();
          }
        }
      });
    }
  }
}

window.addEventListener('DOMContentLoaded', () => {
  const app = new WorkbenchApp();
  app.start();
});
