// public/js/sessions_view.js
// Browse and resume past work sessions with pre-flight OneDrive hydration checks.

import { dialogService } from './dialog_service.js';

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
    this.isLoading = false;
    this.preflightCache = new Map(); // sessionId -> { status, unhydratedFiles, message }
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
    this.isLoading = true;
    this.listEl.innerHTML = '<div class="empty-state">Loading sessions...</div>';
    try {
      const res = await fetch('/api/sessions', {
        headers: { 'X-Session-Token': this.token }
      });
      const data = await res.json();
      this.sessions = Array.isArray(data.sessions) ? data.sessions : [];
      this._render();
      // Run pre-flight hydration checks in background
      this._runBackgroundPreflights();
    } catch (err) {
      this.sessions = [];
      this.listEl.innerHTML = `<div class="empty-state">Failed to load sessions: ${this._escape(err.message)}</div>`;
    } finally {
      this.isLoading = false;
    }
  }

  async _runBackgroundPreflights() {
    for (const s of this.sessions) {
      const targetId = s.claudeSessionId || s.geminiSessionId;
      const targetAgent = s.claudeSessionId ? 'claude' : 'gemini';
      if (!targetId || this.preflightCache.has(targetId)) continue;

      try {
        const res = await fetch('/api/sessions/preflight', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Session-Token': this.token
          },
          body: JSON.stringify({ sessionId: targetId, agent: targetAgent })
        });
        if (res.ok) {
          const preflight = await res.json();
          this.preflightCache.set(targetId, preflight);
          this._updateRowPreflightState(targetId, preflight);
        }
      } catch (e) {}
    }
  }

  _updateRowPreflightState(sessionId, preflight) {
    const btn = this.listEl?.querySelector(`button[data-session-id="${sessionId}"]`);
    if (!btn) return;
    btn.dataset.status = preflight.status;
    if (preflight.status === 'DEHYDRATED') {
      btn.className = 'btn btn-xs btn-warning btn-session-resume';
      btn.innerHTML = '☁️ Download & Resume';
      btn.title = preflight.message || 'Needs hydration from OneDrive';
    } else if (preflight.status === 'MISSING') {
      btn.className = 'btn btn-xs btn-outline btn-session-resume';
      btn.title = preflight.message;
    }
  }

  _matchesFilter(s) {
    if (this.currentFilter === 'all') return true;
    if (this.currentFilter === 'claude') return !!s.claudeSessionId;
    if (this.currentFilter === 'gemini') return !s.claudeSessionId && !!s.geminiSessionId;
    return true;
  }

  _render() {
    if (this.isLoading) {
      this.listEl.innerHTML = '<div class="empty-state">Loading sessions...</div>';
      return;
    }

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

      const targetId = s.claudeSessionId || s.geminiSessionId;
      const cached = this.preflightCache.get(targetId);
      const isDehydrated = cached?.status === 'DEHYDRATED';

      const btnClass = isDehydrated ? 'btn btn-xs btn-warning btn-session-resume' : 'btn btn-xs btn-primary btn-session-resume';
      const btnLabel = isDehydrated ? '☁️ Download & Resume' : 'Resume';

      return `
      <div class="session-row">
        ${badgeHtml}
        <div class="session-row-main">
          <div class="session-title">${this._escape(s.title)}</div>
          <div class="session-meta">${timeAgo(s.lastActiveAt)}</div>
        </div>
        <button class="${btnClass}"
          data-session-id="${this._escape(targetId || '')}"
          data-status="${this._escape(cached?.status || '')}"
          data-claude-id="${this._escape(s.claudeSessionId || '')}"
          data-gemini-id="${this._escape(s.geminiSessionId || '')}">${btnLabel}</button>
      </div>
    `;
    }).join('');

    this.listEl.querySelectorAll('.btn-session-resume').forEach((btn) => {
      btn.addEventListener('click', () => this._handleResumeClick(btn));
    });
  }

  async _handleResumeClick(btn) {
    const claudeId = btn.dataset.claudeId || null;
    const geminiId = btn.dataset.geminiId || null;
    const targetId = claudeId || geminiId;
    const targetAgent = claudeId ? 'claude' : 'gemini';

    const cachedPreflight = this.preflightCache.get(targetId);
    let status = cachedPreflight?.status;

    // If preflight check hasn't run yet, perform it before resuming
    if (!status) {
      btn.disabled = true;
      btn.textContent = 'Checking...';
      try {
        const res = await fetch('/api/sessions/preflight', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Session-Token': this.token
          },
          body: JSON.stringify({ sessionId: targetId, agent: targetAgent })
        });
        const data = await res.json();
        status = data.status;
        this.preflightCache.set(targetId, data);
      } catch (err) {
        status = 'MISSING';
      } finally {
        btn.disabled = false;
      }
    }

    if (status === 'MISSING') {
      await dialogService.confirm({
        title: 'Session History Not Available',
        message: 'This session cannot be opened yet because its conversation history has not synced to this device from OneDrive. Please check your OneDrive connection and try again.',
        confirmText: 'Dismiss',
        cancelText: 'Close',
        icon: 'alert-triangle'
      });
      return;
    }

    if (status === 'DEHYDRATED') {
      btn.disabled = true;
      btn.innerHTML = 'Downloading...';
      this.onToast('Downloading conversation history from OneDrive...', 'info');

      try {
        const res = await fetch('/api/sessions/preflight', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Session-Token': this.token
          },
          body: JSON.stringify({ sessionId: targetId, agent: targetAgent, hydrate: true })
        });
        const data = await res.json();
        if (data.status === 'READY') {
          this.preflightCache.set(targetId, data);
          await this._resume(claudeId, geminiId);
          return;
        } else {
          throw new Error(data.message || 'Download timed out');
        }
      } catch (err) {
        btn.disabled = false;
        btn.innerHTML = '☁️ Download & Resume';
        await dialogService.confirm({
          title: 'Sync Incomplete',
          message: 'This session cannot be opened yet because its conversation history has not synced to this device from OneDrive. Please check your OneDrive connection and try again.',
          confirmText: 'Retry Download',
          cancelText: 'Close',
          icon: 'cloud'
        });
        return;
      }
    }

    // Status is READY
    await this._resume(claudeId, geminiId);
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
