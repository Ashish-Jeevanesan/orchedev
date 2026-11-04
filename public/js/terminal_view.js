// D:\Ashish_P\AI-Tools\custom-OCT\public\js\terminal_view.js
// Persistent ConPTY Terminal View using Dedicated DOM Containers & xterm.js

import { dialogService } from './dialog_service.js';

export class TerminalViewController {
  constructor({ token, onStatusChange }) {
    this.token = token;
    this.onStatusChange = onStatusChange;
    this.activeTab = 'claude'; // 'claude' | 'gemini'

    this.sessions = {
      claude: {
        containerId: 'term-container-claude',
        term: null,
        fitAddon: null,
        ws: null,
        isRunning: false,
        pid: null,
        reconnectTimer: null
      },
      gemini: {
        containerId: 'term-container-gemini',
        term: null,
        fitAddon: null,
        ws: null,
        isRunning: false,
        pid: null,
        reconnectTimer: null
      }
    };

    this.pidEl = document.getElementById('term-pid');
    this.sizeEl = document.getElementById('term-size');
    this.cwdEl = document.getElementById('term-cwd');

    this._bindControls();
  }

  init() {
    this._initTerminal('claude');
    this._initTerminal('gemini');
    this.switchTab('claude');
  }

  _initTerminal(id) {
    const sess = this.sessions[id];
    const container = document.getElementById(sess.containerId);
    if (!container) return;

    const term = new window.Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'Consolas, "Cascadia Code", "JetBrains Mono", monospace',
      scrollOnUserInput: true,
      theme: {
        background: '#000000',
        foreground: '#e2e8f0',
        cursor: '#3b82f6',
        selectionBackground: 'rgba(59, 130, 246, 0.3)'
      }
    });

    const fitAddon = new window.FitAddon.FitAddon();
    term.loadAddon(fitAddon);

    // Open terminal into its persistent dedicated container ONCE
    term.open(container);

    sess.term = term;
    sess.fitAddon = fitAddon;

    term.onData((data) => {
      // Intercept Ctrl+L (\x0c) to perform clean client + server buffer reset
      if (data === '\x0c') {
        this.clearActiveBuffer();
        return;
      }
      if (sess.ws && sess.ws.readyState === WebSocket.OPEN) {
        sess.ws.send(JSON.stringify({ type: 'input', data }));
      }
    });

    term.onResize(({ cols, rows }) => {
      if (sess.ws && sess.ws.readyState === WebSocket.OPEN) {
        sess.ws.send(JSON.stringify({ type: 'resize', cols, rows }));
      }
      if (this.activeTab === id && this.sizeEl) {
        this.sizeEl.textContent = `${cols}x${rows}`;
      }
    });

    // Start WebSocket stream
    this.connect(id);
  }

  switchTab(id) {
    this.activeTab = id;

    // 1. Update UI tab buttons
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.term === id);
    });

    // 2. Toggle persistent container visibility (NO innerHTML wiping!)
    for (const [termId, sess] of Object.entries(this.sessions)) {
      const container = document.getElementById(sess.containerId);
      if (container) {
        if (termId === id) {
          container.style.display = 'block';
        } else {
          container.style.display = 'none';
        }
      }
    }

    const activeSess = this.sessions[id];

    // 3. Update status indicators
    this.pidEl.textContent = activeSess.pid || '-';
    this.sizeEl.textContent = `${activeSess.term.cols}x${activeSess.term.rows}`;

    // 4. Safe resize calculation: call fitAddon ONLY after layout renders with non-zero dimensions
    requestAnimationFrame(() => {
      const container = document.getElementById(activeSess.containerId);
      if (container && container.clientWidth > 0 && container.clientHeight > 0) {
        try {
          activeSess.fitAddon.fit();
          this.sizeEl.textContent = `${activeSess.term.cols}x${activeSess.term.rows}`;
        } catch (e) {}
      }
      activeSess.term.focus();
    });

    // 5. Ensure socket is connected
    if (!activeSess.ws || activeSess.ws.readyState === WebSocket.CLOSED) {
      this.connect(id);
    }
  }

  connect(id) {
    const sess = this.sessions[id];
    if (sess.ws && (sess.ws.readyState === WebSocket.OPEN || sess.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    if (sess.reconnectTimer) {
      clearTimeout(sess.reconnectTimer);
      sess.reconnectTimer = null;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/terminal?id=${id}`;

    // Pass token via subprotocol
    const ws = new WebSocket(wsUrl, [`token.${this.token}`]);
    sess.ws = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'auth', token: this.token }));

      // Safe fit after connection if container is visible
      const container = document.getElementById(sess.containerId);
      if (container && container.clientWidth > 0 && container.clientHeight > 0) {
        try {
          sess.fitAddon.fit();
        } catch (e) {}
      }

      ws.send(JSON.stringify({
        type: 'resize',
        cols: sess.term.cols,
        rows: sess.term.rows
      }));
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'output' && msg.data) {
          sess.term.write(msg.data, () => {
            sess.term.scrollToBottom();
          });
        } else if (msg.type === 'exit') {
          sess.term.writeln(`\r\n\x1b[33m[Process exited with code ${msg.exitCode}]\x1b[0m\r\n`);
          sess.isRunning = false;
        }
      } catch (e) {
        sess.term.write(event.data, () => {
          sess.term.scrollToBottom();
        });
      }
    };

    ws.onclose = () => {
      sess.isRunning = false;
      if (this.activeTab === id) {
        this.pidEl.textContent = '-';
      }
    };
  }

  updateProcessStatuses(statuses) {
    for (const id of ['claude', 'gemini']) {
      const status = statuses[id];
      if (!status) continue;

      const sess = this.sessions[id];
      sess.isRunning = (status.status === 'RUNNING');
      sess.pid = status.pid;
      sess.cwd = status.cwd;

      if (this.activeTab === id) {
        this.pidEl.textContent = status.pid || '-';
        if (this.cwdEl) this.cwdEl.textContent = status.cwd || '-';
      }

      // Update badge
      const tabBadge = document.getElementById(`tab-badge-${id}`);
      if (tabBadge) {
        tabBadge.textContent = `PTY: ${status.status}`;
        tabBadge.className = `badge badge-sm ${status.status === 'RUNNING' ? 'badge-success' : 'badge-outline'}`;
      }

      // Update header pill
      const pill = document.getElementById(`pill-${id}`);
      const val = document.getElementById(`val-${id}`);
      if (pill && val) {
        val.textContent = status.status;
        pill.className = `pill ${status.status.toLowerCase()}`;
      }
    }
  }

  updatePeerStatuses(peers) {
    if (!Array.isArray(peers)) return;
    this.peerStatuses = this.peerStatuses || {};

    for (const peer of peers) {
      this.peerStatuses[peer.agentId] = peer;
    }

    for (const id of ['claude', 'gemini']) {
      const peer = this.peerStatuses[id];
      const mcpBadge = document.getElementById(`mcp-badge-${id}`);
      const mcpStatus = peer ? peer.status : 'OFFLINE';

      if (mcpBadge) {
        mcpBadge.textContent = `MCP: ${mcpStatus}`;
        let badgeClass = 'badge-outline';
        if (mcpStatus === 'ONLINE') badgeClass = 'badge-success';
        else if (mcpStatus === 'BUSY') badgeClass = 'badge-primary';
        else if (mcpStatus === 'UNREACHABLE') badgeClass = 'badge-warning';
        else if (mcpStatus === 'OFFLINE') badgeClass = 'badge-outline';
        mcpBadge.className = `badge badge-sm ${badgeClass}`;
        if (peer && peer.lastHeartbeat) {
          const ago = Math.round((Date.now() - peer.lastHeartbeat) / 1000);
          mcpBadge.title = `MCP Session: ${peer.sessionId}\nGen: ${peer.generation || 1}\nLast Heartbeat: ${ago}s ago`;
        }
      }

      if (this.activeTab === id) {
        const metaMcp = document.getElementById('term-mcp-status');
        if (metaMcp) {
          metaMcp.textContent = mcpStatus;
        }
      }
    }
  }

  clearBuffer(id) {
    const sess = this.sessions[id];
    if (sess && sess.term) {
      sess.term.reset();
      if (sess.ws && sess.ws.readyState === WebSocket.OPEN) {
        sess.ws.send(JSON.stringify({ type: 'input', data: '\x0c' }));
      }
      sess.term.scrollToBottom();
      sess.term.focus();
    }
  }

  clearActiveBuffer() {
    this._callTermAction(this.activeTab, 'clear');
  }

  _bindControls() {
    document.getElementById('tab-claude').addEventListener('click', () => this.switchTab('claude'));
    document.getElementById('tab-gemini').addEventListener('click', () => this.switchTab('gemini'));

    const clearBtn = document.getElementById('btn-term-clear');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => this.clearActiveBuffer());
    }

    document.getElementById('btn-term-start').addEventListener('click', () => {
      this._callTermAction(this.activeTab, 'start');
    });

    document.getElementById('btn-term-restart').addEventListener('click', async () => {
      const confirmed = await dialogService.confirm({
        title: `Restart ${this.activeTab.toUpperCase()} Terminal`,
        message: `Terminate the running ${this.activeTab.toUpperCase()} terminal process tree and spawn a fresh interactive session?`,
        confirmText: 'Restart Terminal',
        destructive: true,
        icon: 'rotate-cw'
      });
      if (confirmed) {
        this.clearBuffer(this.activeTab);
        this._callTermAction(this.activeTab, 'restart');
      }
    });

    document.getElementById('btn-term-stop').addEventListener('click', async () => {
      const confirmed = await dialogService.confirm({
        title: `Terminate ${this.activeTab.toUpperCase()} Terminal`,
        message: `Forcefully terminate the active ${this.activeTab.toUpperCase()} terminal process tree?`,
        confirmText: 'Terminate Process',
        destructive: true,
        icon: 'square'
      });
      if (confirmed) {
        this._callTermAction(this.activeTab, 'terminate');
      }
    });

    let resizeTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        const sess = this.sessions[this.activeTab];
        const container = sess ? document.getElementById(sess.containerId) : null;
        if (sess && sess.fitAddon && container && container.clientWidth > 0 && container.clientHeight > 0) {
          requestAnimationFrame(() => {
            try {
              sess.fitAddon.fit();
              if (this.sizeEl) {
                this.sizeEl.textContent = `${sess.term.cols}x${sess.term.rows}`;
              }
            } catch (e) {}
          });
        }
      }, 50);
    });
  }

  async _callTermAction(id, action) {
    try {
      const sess = this.sessions[id];

      if (action === 'restart') {
        if (sess && sess.term) {
          sess.term.reset();
        }
        if (sess && sess.ws) {
          try { sess.ws.close(); } catch(e){}
          sess.ws = null;
        }
      } else if (action === 'terminate') {
        if (sess && sess.term) {
          sess.term.writeln(`\r\n\x1b[33m[Terminal terminated by user]\x1b[0m\r\n`);
        }
        if (sess && sess.ws) {
          try { sess.ws.close(); } catch(e){}
          sess.ws = null;
        }
      } else if (action === 'clear') {
        if (sess && sess.term) {
          sess.term.reset();
          if (sess.ws && sess.ws.readyState === WebSocket.OPEN) {
            sess.ws.send(JSON.stringify({ type: 'input', data: '\x0c' }));
          }
          sess.term.scrollToBottom();
          sess.term.focus();
        }
      }

      const res = await fetch(`/api/terminals/${id}/${action}`, {
        method: 'POST',
        headers: { 'X-Session-Token': this.token }
      });
      const data = await res.json();

      if (data && sess) {
        sess.cwd = data.cwd;
        sess.pid = data.pid;
        if (this.activeTab === id) {
          if (this.cwdEl) this.cwdEl.textContent = data.cwd || '-';
          if (this.pidEl) this.pidEl.textContent = data.pid || '-';
        }
      }

      this.connect(id);
    } catch (e) {
      console.error(`Terminal action ${action} failed:`, e);
    }
  }
}
