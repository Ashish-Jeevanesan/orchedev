// D:\Ashish_P\AI-Tools\custom-OCT\public\js\activity_view.js
// Activity & Notification Feed Controller
// Phase 3 Workstream G: Bounded Feed (200 entries FIFO), Correlation Navigation, Severity Filtering, and Safe Rendering

import { getIcon } from './icons.js';

export class ActivityViewController {
  constructor() {
    this.drawer = document.getElementById('activity-drawer');
    this.feed = document.getElementById('activity-feed');
    this.countEl = document.getElementById('activity-count');
    this.toggleBtn = document.getElementById('drawer-toggle');
    this.clearBtn = document.getElementById('btn-clear-activity');
    this.toastContainer = document.getElementById('toast-container');
    this.filterChipsContainer = document.getElementById('activity-filters');

    this.count = 0;
    this.MAX_FEED_ENTRIES = 200;
    this.MAX_TOASTS = 5;
    this.seenEventIds = new Set();
    this.currentCategory = 'ALL'; // 'ALL' | 'TASKS' | 'TERMINALS' | 'SECURITY' | 'ERRORS'

    this._bindEvents();
  }

  _bindEvents() {
    if (this.toggleBtn) {
      this.toggleBtn.addEventListener('click', (e) => {
        if (e.target.closest('#activity-filters') || e.target.closest('#btn-clear-activity')) {
          return;
        }
        this.drawer.classList.toggle('expanded');
        const icon = this.drawer.querySelector('.drawer-icon');
        if (icon) {
          icon.innerHTML = this.drawer.classList.contains('expanded') ? '&#x25BC;' : '&#x25B2;';
        }
      });
    }

    if (this.clearBtn) {
      this.clearBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.feed.innerHTML = '';
        this.count = 0;
        this.countEl.textContent = '0';
        this.seenEventIds.clear();
      });
    }

    // Severity & Category Filter Chips
    if (this.filterChipsContainer) {
      this.filterChipsContainer.addEventListener('click', (e) => {
        e.stopPropagation();
        const chip = e.target.closest('.filter-chip');
        if (!chip) return;
        const cat = chip.dataset.sev || 'ALL';
        this.currentCategory = cat;

        this.filterChipsContainer.querySelectorAll('.filter-chip').forEach(c => {
          c.classList.toggle('active', c.dataset.sev === cat);
        });

        this._applyFeedFilter();
      });
    }

    // Event delegation for clickable correlation ID chips
    if (this.feed) {
      this.feed.addEventListener('click', (e) => {
        const chip = e.target.closest('.activity-corr-chip');
        if (chip) {
          const corrId = chip.getAttribute('data-corr');
          if (corrId && window.workbenchApp && window.workbenchApp.taskView) {
            window.workbenchApp.taskView.selectTask(corrId);
          }
        }
      });
    }
  }

  _classifyEventCategory(evt) {
    const level = (evt.level || 'INFO').toUpperCase();
    const type = (evt.eventType || '').toUpperCase();

    if (level === 'ERROR' || type.includes('FAIL') || type.includes('ERROR')) {
      return 'ERRORS';
    }
    if (type.includes('SECURITY') || type.includes('AUTH') || type.includes('DENIED') || type.includes('ESCAPE')) {
      return 'SECURITY';
    }
    if (type.startsWith('TERMINAL_') || type.startsWith('AGENT_') || type.startsWith('PEER_') || type.includes('PTY')) {
      return 'TERMINALS';
    }
    if (type.startsWith('TASK_') || type.startsWith('APPROVAL_') || type.startsWith('WORKFLOW_') || evt.correlationId) {
      return 'TASKS';
    }
    return 'OTHER';
  }

  _applyFeedFilter() {
    if (!this.feed) return;
    const entries = this.feed.querySelectorAll('.activity-entry');
    for (const entry of entries) {
      const cat = entry.dataset.category;
      const level = entry.dataset.level;

      if (this.currentCategory === 'ALL') {
        entry.style.display = 'flex';
      } else if (this.currentCategory === 'ERRORS' && (level === 'ERROR' || cat === 'ERRORS')) {
        entry.style.display = 'flex';
      } else if (this.currentCategory === cat) {
        entry.style.display = 'flex';
      } else {
        entry.style.display = 'none';
      }
    }
  }

  logWorkbenchEvent(evt) {
    if (!evt || typeof evt !== 'object') return;

    // Suppress duplicate event IDs across WebSocket replays
    if (evt.eventId) {
      if (this.seenEventIds.has(evt.eventId)) {
        return;
      }
      this.seenEventIds.add(evt.eventId);
      if (this.seenEventIds.size > 500) {
        // Prune older event IDs to bound memory
        const it = this.seenEventIds.values();
        for (let i = 0; i < 100; i++) {
          this.seenEventIds.delete(it.next().value);
        }
      }
    }

    this.count++;
    if (this.countEl) this.countEl.textContent = this.count;

    // Enforce FIFO upper bound on feed elements (200 entries max)
    while (this.feed.children.length >= this.MAX_FEED_ENTRIES) {
      this.feed.firstElementChild.remove();
    }

    const time = evt.timestamp ? new Date(evt.timestamp).toLocaleTimeString() : new Date().toLocaleTimeString();
    const level = (evt.level || 'INFO').toUpperCase();
    const eventType = evt.eventType || 'EVENT';
    const summary = evt.summary || eventType;
    const corrId = evt.correlationId || null;
    const category = this._classifyEventCategory(evt);

    let levelClass = 'badge-outline';
    if (level === 'ERROR') levelClass = 'badge-danger';
    else if (level === 'WARN') levelClass = 'badge-warning';
    else if (level === 'INFO') levelClass = 'badge-primary';

    const entry = document.createElement('div');
    entry.className = `activity-entry activity-level-${level.toLowerCase()}`;
    entry.dataset = entry.dataset || {};
    entry.dataset.category = category;
    entry.dataset.level = level;

    let corrHtml = '';
    if (corrId) {
      corrHtml = `<button class="activity-corr-chip" data-corr="${this._escape(corrId)}" title="Click to view task details">[${this._escape(corrId)}]</button>`;
    }

    entry.innerHTML = `
      <span class="activity-time">${time}</span>
      <span class="badge badge-xs ${levelClass}">${this._escape(level)}</span>
      <span class="activity-tag ${this._escape(eventType)}">${this._escape(eventType)}</span>
      ${corrHtml}
      <span class="activity-summary">${this._escape(summary)}</span>
    `;

    // Filter visibility check
    if (this.currentCategory !== 'ALL') {
      const matchErrors = this.currentCategory === 'ERRORS' && (level === 'ERROR' || category === 'ERRORS');
      if (this.currentCategory !== category && !matchErrors) {
        entry.style.display = 'none';
      }
    }

    this.feed.appendChild(entry);
    this.feed.scrollTop = this.feed.scrollHeight;

    // Trigger visual toast only on important lifecycle confirmations
    if (eventType === 'TASK_COMPLETED') {
      this.toast(`Task ${corrId || ''} completed successfully!`, 'success');
    } else if (eventType === 'TASK_FAILED') {
      this.toast(`Task ${corrId || ''} failed: ${summary}`, 'error');
    } else if (eventType === 'TASK_TIMED_OUT') {
      this.toast(`Task ${corrId || ''} timed out`, 'error');
    } else if (eventType === 'SESSION_DEGRADED') {
      this.toast(summary, 'error');
    } else if (eventType === 'SESSION_RECOVERED') {
      this.toast(summary, 'info');
    }
  }

  logEvent(eventType, payload) {
    if (!payload || typeof payload !== 'object') return;
    this.logWorkbenchEvent({
      eventId: `LEGACY_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      eventType,
      level: eventType.includes('FAIL') || eventType.includes('ERROR') ? 'ERROR' : eventType.includes('CANCEL') || eventType.includes('REJECT') ? 'WARN' : 'INFO',
      timestamp: Date.now(),
      correlationId: payload.correlationId || null,
      summary: payload.step || payload.error || (payload.result ? 'Completed successfully' : eventType),
      details: payload
    });
  }

  toast(message, type = 'info') {
    if (!this.toastContainer) return;
    while (this.toastContainer.children.length >= this.MAX_TOASTS) {
      this.toastContainer.firstElementChild.remove();
    }

    const iconName = type === 'success' ? 'check-circle' : type === 'error' ? 'x-circle' : type === 'warning' ? 'alert-triangle' : 'info';
    const iconHtml = getIcon(iconName, 16, 'toast-icon');

    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = `
      <span class="toast-icon-wrap">${iconHtml}</span>
      <span class="toast-msg">${this._escape(message)}</span>
      <button class="toast-dismiss" title="Dismiss" aria-label="Dismiss">&times;</button>
    `;

    const dismissBtn = el.querySelector('.toast-dismiss');
    dismissBtn?.addEventListener('click', () => {
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 200);
    });

    this.toastContainer.appendChild(el);

    setTimeout(() => {
      if (el.parentNode) {
        el.style.opacity = '0';
        el.style.transition = 'opacity 0.3s ease';
        setTimeout(() => el.remove(), 300);
      }
    }, 4500);
  }

  _escape(str) {
    if (typeof str !== 'string') return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}
