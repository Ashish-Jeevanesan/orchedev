// Browse and resume past work sessions. A "session" here is organized around Claude's
// conversation -- the unit the human actually thinks in -- with whatever Gemini
// delegation happened inside it following along underneath, rather than as two
// unrelated-looking entries. A session only shows as "Gemini" on its own when it was
// genuinely used standalone, with no Claude session paired to it at all.
//
// Resuming replays the real session id(s) back to the CLI(s) via their own --resume
// flag (server/session_pairings.js + cli_session_registry.js do the pairing/merging),
// so this restores actual conversation history, not just a summary -- and resuming a
// paired session brings both Claude and Gemini back in one click.

function timeAgo(iso) {
  if (!iso) return '';
  const diffMs = Date.now() - new Date(iso).getTime();
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

export class SessionsViewController {
  constructor({ token, onToast, onResumed }) {
    this.token = token;
    this.onToast = onToast || (() => {});
    this.onResumed = onResumed || (() => {});
    this.modalEl = document.getElementById('modal-sessions');
    this.listEl = document.getElementById('sessions-list-container');
    this.filterTabsEl = document.getElementById('sessions-filter-tabs');
    this.currentFilter = 'all';
    this.sessions = [];
  }

  init() {
    const openBtn = document.getElementById('btn-open-sessions');
    if (openBtn) {
      openBtn.addEventListener('click', () => this.open());
    }

    const closeBtn = document.getElementById('btn-close-sessions');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => this.close());
    }

    if (this.modalEl) {
      this.modalEl.addEventListener('click', (e) => {
        if (e.target === this.modalEl) this.close();
      });
    }

    if (this.filterTabsEl) {
      this.filterTabsEl.addEventListener('click', (e) => {
        const btn = e.target.closest('.filter-btn');
        if (!btn) return;
        this.currentFilter = btn.dataset.agent;
        this.filterTabsEl.querySelectorAll('.filter-btn').forEach((b) => {
          b.classList.toggle('active', b === btn);
        });
        this._render();
      });
    }

    window.addEventListener('keydown', (e) => {
      if (this.modalEl && this.modalEl.style.display === 'flex' && e.key === 'Escape') {
        this.close();
      }
    });
  }

  async open() {
    if (!this.modalEl) return;
    this.modalEl.style.display = 'flex';
    await this._loadSessions();
  }

  close() {
    if (this.modalEl) this.modalEl.style.display = 'none';
  }

  async _loadSessions() {
    this.listEl.innerHTML = '<div class="empty-state">Loading...</div>';
    try {
      const res = await fetch('/api/sessions', {
        headers: { 'X-Session-Token': this.token }
      });
      const data = await res.json();
      this.sessions = Array.isArray(data.sessions) ? data.sessions : [];
      this._render();
    } catch (err) {
      this.listEl.innerHTML = `<div class="empty-state">Failed to load sessions: ${this._escape(err.message)}</div>`;
    }
  }

  // 'all' | 'claude' (has a claude session, with or without paired gemini) |
  // 'gemini' (gemini-only, standalone -- a session with a claude side is never shown
  // here, since it's not "separately named" Gemini work)
  _matchesFilter(s) {
    if (this.currentFilter === 'all') return true;
    if (this.currentFilter === 'claude') return !!s.claudeSessionId;
    if (this.currentFilter === 'gemini') return !s.claudeSessionId && !!s.geminiSessionId;
    return true;
  }

  _render() {
    const filtered = this.sessions.filter((s) => this._matchesFilter(s));

    if (filtered.length === 0) {
      this.listEl.innerHTML = '<div class="empty-state">No past sessions recorded yet.</div>';
      return;
    }

    this.listEl.innerHTML = filtered.map((s) => {
      const isStandaloneGemini = !s.claudeSessionId && !!s.geminiSessionId;
      const badgeHtml = isStandaloneGemini
        ? '<span class="session-agent-badge badge badge-sm badge-success">Gemini</span>'
        : s.geminiSessionId
          ? '<span class="session-agent-badge badge badge-sm badge-primary">Claude</span><span class="badge badge-xs badge-outline" title="This session also delegated work to Gemini">+Gemini</span>'
          : '<span class="session-agent-badge badge badge-sm badge-primary">Claude</span>';

      return `
      <div class="session-row">
        ${badgeHtml}
        <div class="session-row-main">
          <div class="session-title">${this._escape(s.title)}</div>
          <div class="session-meta">${timeAgo(s.lastActiveAt)}</div>
        </div>
        <button class="btn btn-xs btn-primary btn-session-resume"
          data-claude-id="${this._escape(s.claudeSessionId || '')}"
          data-gemini-id="${this._escape(s.geminiSessionId || '')}">Resume</button>
      </div>
    `;
    }).join('');

    this.listEl.querySelectorAll('.btn-session-resume').forEach((btn) => {
      btn.addEventListener('click', () => this._resume(btn.dataset.claudeId || null, btn.dataset.geminiId || null));
    });
  }

  async _resume(claudeSessionId, geminiSessionId) {
    try {
      const res = await fetch('/api/sessions/resume', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-Token': this.token
        },
        body: JSON.stringify({ claudeSessionId: claudeSessionId || undefined, geminiSessionId: geminiSessionId || undefined })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Resume failed');

      const label = claudeSessionId && geminiSessionId
        ? 'Resumed Claude + Gemini session'
        : claudeSessionId
          ? 'Resumed Claude session'
          : 'Resumed Gemini session';
      this.onToast(label, 'info');
      this.close();
      this.onResumed(claudeSessionId ? 'claude' : 'gemini');
    } catch (err) {
      this.onToast(`Resume failed: ${err.message}`, 'error');
    }
  }

  _escape(str) {
    const div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
  }
}
