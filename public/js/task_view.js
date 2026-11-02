// D:\Ashish_P\AI-Tools\custom-OCT\public\js\task_view.js
// Delegated Task Panel View: Task Composer, Filterable List, Live Detail Inspector & Approval Carousel
// Phase 3 Workstream G: UI Ergonomics, Search/Filter, Progress Bars, Late Completion, & Keyboard Accessibility

import { dialogService } from './dialog_service.js';
import { getIcon } from './icons.js';

export class TaskViewController {
  constructor({ token, onToast }) {
    this.token = token;
    this.onToast = onToast;
    this.tasks = new Map(); // correlationId -> task
    this.selectedTaskId = null;
    this.timerInterval = null;
    this.projectCwd = null;

    // Filter & Search State
    this.currentFilter = 'all'; // 'all' | 'active' | 'approvals' | 'completed' | 'failed'
    this.searchQuery = '';

    // Prompt History
    this.promptHistory = this._loadPromptHistory();
    this.historyIndex = -1;

    // Elements: Composer
    this.promptInput = document.getElementById('task-prompt-input');
    this.agentSelector = document.getElementById('agent-selector');
    this.dispatchBtn = document.getElementById('btn-dispatch-task');
    this.validationMsgEl = document.getElementById('composer-validation-msg');

    // Elements: List & Search
    this.listContainer = document.getElementById('task-list-container');
    this.detailContainer = document.getElementById('task-detail-container');
    this.taskSearchInput = document.getElementById('task-search-input');
    this.filterTabsContainer = document.getElementById('task-filter-tabs');

    // Elements: Header Approvals Pill
    this.pillApprovals = document.getElementById('pill-approvals');
    this.valApprovals = document.getElementById('val-approvals');

    // Elements: Approval Modal & Carousel
    this.modalApproval = document.getElementById('modal-approval');
    this.modalCarouselNav = document.getElementById('modal-carousel-nav');
    this.carouselCounter = document.getElementById('appr-carousel-counter');
    this.btnApprPrev = document.getElementById('btn-appr-prev');
    this.btnApprNext = document.getElementById('btn-appr-next');
    this.apprCorrId = document.getElementById('appr-corr-id');
    this.apprSourceAgent = document.getElementById('appr-source-agent');
    this.apprTargetAgent = document.getElementById('appr-target-agent');
    this.apprCwd = document.getElementById('appr-cwd');
    this.apprExpectedFiles = document.getElementById('appr-expected-files');
    this.apprCreatedTime = document.getElementById('appr-created-time');
    this.apprPlanText = document.getElementById('appr-plan-text');
    this.apprInstructionsInput = document.getElementById('appr-instructions-input');
    this.badgeInstructionsEdited = document.getElementById('badge-instructions-edited');
    this.btnApprApprove = document.getElementById('btn-appr-approve');
    this.btnApprReject = document.getElementById('btn-appr-reject');
    this.btnApprCancel = document.getElementById('btn-appr-cancel');
    this.btnCloseApproval = document.getElementById('btn-close-approval');

    this.currentModalTask = null;
    this.pendingApprovalQueue = [];
    this.carouselIndex = 0;
    this.lastFocusedElement = null;

    this._bindEvents();
    this._startElapsedTimer();
  }

  setProjectCwd(cwd) {
    this.projectCwd = cwd;
  }

  _loadPromptHistory() {
    try {
      const raw = sessionStorage.getItem('workbench_prompt_history');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed.slice(0, 30);
      }
    } catch (e) {}
    return [];
  }

  _savePromptHistory(prompt) {
    if (!prompt || typeof prompt !== 'string') return;
    const clean = prompt.trim();
    if (!clean) return;

    // Filter out duplicates and prepend
    this.promptHistory = [clean, ...this.promptHistory.filter(p => p !== clean)].slice(0, 30);
    try {
      sessionStorage.setItem('workbench_prompt_history', JSON.stringify(this.promptHistory));
    } catch (e) {}
    this.historyIndex = -1;
  }

  async loadInitialTasks() {
    try {
      const res = await fetch('/api/tasks', {
        headers: { 'X-Session-Token': this.token }
      });
      const data = await res.json();
      if (data && Array.isArray(data.tasks)) {
        for (const task of data.tasks) {
          this.tasks.set(task.correlationId, task);
        }
      }

      this.renderList();
      this.updateApprovalPill();
    } catch (e) {
      console.error('Failed to load initial tasks:', e);
    }
  }

  _bindEvents() {
    // 1. Dispatch Button
    if (this.dispatchBtn) {
      this.dispatchBtn.addEventListener('click', () => this.submitTask());
    }

    // 2. Composer Keyboard & History Navigation
    if (this.promptInput) {
      this.promptInput.addEventListener('input', () => {
        this._adjustTextareaHeight();
        this._clearValidation();
      });

      this.promptInput.addEventListener('keydown', (e) => {
        // Ctrl+Enter / Cmd+Enter to dispatch
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
          e.preventDefault();
          this.submitTask();
          return;
        }

        // ArrowUp history recall: only if at start or textarea is empty
        if (e.key === 'ArrowUp') {
          const atStart = this.promptInput.selectionStart === 0 && this.promptInput.selectionEnd === 0;
          if (atStart && this.promptHistory.length > 0) {
            e.preventDefault();
            if (this.historyIndex < this.promptHistory.length - 1) {
              this.historyIndex++;
              this.promptInput.value = this.promptHistory[this.historyIndex];
              this._adjustTextareaHeight();
            }
          }
        } else if (e.key === 'ArrowDown') {
          const atEnd = this.promptInput.selectionStart === this.promptInput.value.length;
          if (atEnd && this.historyIndex >= 0) {
            e.preventDefault();
            this.historyIndex--;
            if (this.historyIndex >= 0) {
              this.promptInput.value = this.promptHistory[this.historyIndex];
            } else {
              this.promptInput.value = '';
            }
            this._adjustTextareaHeight();
          }
        }
      });
    }

    // 3. Search Input
    if (this.taskSearchInput) {
      this.taskSearchInput.addEventListener('input', (e) => {
        this.searchQuery = (e.target.value || '').trim().toLowerCase();
        this.renderList();
      });
    }

    // 4. Filter Tabs
    if (this.filterTabsContainer) {
      this.filterTabsContainer.addEventListener('click', (e) => {
        const btn = e.target.closest('.filter-btn');
        if (!btn) return;
        const filter = btn.dataset.filter;
        if (filter) {
          this.currentFilter = filter;
          this.filterTabsContainer.querySelectorAll('.filter-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.filter === filter);
          });
          this.renderList();
        }
      });
    }

    // 5. Approval Pill Click
    if (this.pillApprovals) {
      this.pillApprovals.addEventListener('click', () => {
        this._refreshPendingQueue();
        if (this.pendingApprovalQueue.length > 0) {
          this.carouselIndex = 0;
          this.openApprovalModal(this.pendingApprovalQueue[0]);
        }
      });
    }

    // 6. Modal Close / Cancel
    if (this.btnCloseApproval) {
      this.btnCloseApproval.addEventListener('click', () => this.closeApprovalModal());
    }
    if (this.btnApprCancel) {
      this.btnApprCancel.addEventListener('click', () => this.closeApprovalModal());
    }

    // 7. Modal Approve & Reject
    if (this.btnApprApprove) {
      this.btnApprApprove.addEventListener('click', () => this.approveCurrentModal());
    }
    if (this.btnApprReject) {
      this.btnApprReject.addEventListener('click', () => this.rejectCurrentModal());
    }

    // 8. Modal Carousel Navigation
    if (this.btnApprPrev) {
      this.btnApprPrev.addEventListener('click', () => {
        if (this.pendingApprovalQueue.length > 1 && this.carouselIndex > 0) {
          this.carouselIndex--;
          this.openApprovalModal(this.pendingApprovalQueue[this.carouselIndex]);
        }
      });
    }
    if (this.btnApprNext) {
      this.btnApprNext.addEventListener('click', () => {
        if (this.pendingApprovalQueue.length > 1 && this.carouselIndex < this.pendingApprovalQueue.length - 1) {
          this.carouselIndex++;
          this.openApprovalModal(this.pendingApprovalQueue[this.carouselIndex]);
        }
      });
    }

    // 9. Modal Global Keyboard Shortcuts (Esc & Ctrl+Enter)
    window.addEventListener('keydown', (e) => {
      if (!this.modalApproval || this.modalApproval.style.display !== 'flex') return;

      if (e.key === 'Escape') {
        e.preventDefault();
        this.closeApprovalModal();
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        this.approveCurrentModal();
      }
    });

    // 10. Modal Instructions Edit Listener
    if (this.apprInstructionsInput) {
      this.apprInstructionsInput.addEventListener('input', () => {
        if (!this.currentModalTask) return;
        const original = this.currentModalTask.originalInstructions || this.currentModalTask.instructions;
        const current = this.apprInstructionsInput.value;
        const isEdited = current.trim() !== original.trim();

        if (this.badgeInstructionsEdited) {
          this.badgeInstructionsEdited.style.display = isEdited ? 'inline-block' : 'none';
        }
        if (this.btnApprApprove) {
          this.btnApprApprove.innerHTML = isEdited
            ? '<span class="btn-icon">&#x2714;</span> Approve with Edited Instructions'
            : '<span class="btn-icon">&#x2714;</span> Approve Plan';
        }
      });
    }
  }

  _adjustTextareaHeight() {
    if (!this.promptInput) return;
    this.promptInput.style.height = 'auto';
    const newHeight = Math.min(Math.max(this.promptInput.scrollHeight, 64), 160);
    this.promptInput.style.height = `${newHeight}px`;
  }

  _showValidation(message) {
    if (this.validationMsgEl) {
      this.validationMsgEl.textContent = message;
      this.validationMsgEl.style.display = 'inline-block';
    }
    if (this.promptInput) {
      this.promptInput.classList.add('validation-error');
    }
  }

  _clearValidation() {
    if (this.validationMsgEl) {
      this.validationMsgEl.style.display = 'none';
      this.validationMsgEl.textContent = '';
    }
    if (this.promptInput) {
      this.promptInput.classList.remove('validation-error');
    }
  }

  _refreshPendingQueue() {
    this.pendingApprovalQueue = Array.from(this.tasks.values())
      .filter(t => t.state === 'APPROVAL_REQUESTED')
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  openApprovalModal(task) {
    this.lastFocusedElement = document.activeElement;
    this._refreshPendingQueue();

    // Determine carousel position
    const foundIdx = this.pendingApprovalQueue.findIndex(t => t.correlationId === task.correlationId);
    if (foundIdx >= 0) {
      this.carouselIndex = foundIdx;
    } else {
      this.pendingApprovalQueue.unshift(task);
      this.carouselIndex = 0;
    }

    this.currentModalTask = task;
    if (!this.modalApproval) return;

    // Update carousel navigation UI
    if (this.modalCarouselNav && this.carouselCounter) {
      if (this.pendingApprovalQueue.length > 1) {
        this.modalCarouselNav.style.display = 'flex';
        this.carouselCounter.textContent = `${this.carouselIndex + 1} of ${this.pendingApprovalQueue.length}`;
        if (this.btnApprPrev) this.btnApprPrev.disabled = (this.carouselIndex === 0);
        if (this.btnApprNext) this.btnApprNext.disabled = (this.carouselIndex === this.pendingApprovalQueue.length - 1);
      } else {
        this.modalCarouselNav.style.display = 'none';
      }
    }

    if (this.apprCorrId) this.apprCorrId.textContent = task.correlationId;
    if (this.apprSourceAgent) this.apprSourceAgent.textContent = task.fromAgent || 'Claude Code';
    if (this.apprTargetAgent) this.apprTargetAgent.textContent = task.toAgent || 'Gemini CLI';
    if (this.apprCwd) this.apprCwd.textContent = task.cwd || this.projectCwd || '-';
    if (this.apprExpectedFiles) {
      this.apprExpectedFiles.textContent = (task.expectedFiles && task.expectedFiles.length > 0)
        ? task.expectedFiles.join(', ')
        : 'None specified';
    }
    if (this.apprCreatedTime) {
      this.apprCreatedTime.textContent = new Date(task.createdAt || Date.now()).toLocaleTimeString();
    }
    if (this.apprPlanText) {
      this.apprPlanText.textContent = task.plan || task.instructions || '-';
    }
    if (this.apprInstructionsInput) {
      this.apprInstructionsInput.value = task.instructions || '';
    }
    if (this.badgeInstructionsEdited) {
      this.badgeInstructionsEdited.style.display = 'none';
    }
    if (this.btnApprApprove) {
      this.btnApprApprove.innerHTML = '<span class="btn-icon">&#x2714;</span> Approve Plan';
      this.btnApprApprove.disabled = false;
    }
    if (this.btnApprReject) {
      this.btnApprReject.disabled = false;
    }

    this.modalApproval.style.display = 'flex';

    // Auto-focus instructions input for rapid keyboard review
    requestAnimationFrame(() => {
      if (this.apprInstructionsInput) this.apprInstructionsInput.focus();
    });
  }

  closeApprovalModal() {
    this.currentModalTask = null;
    if (this.modalApproval) {
      this.modalApproval.style.display = 'none';
    }
    // Restore focus
    if (this.lastFocusedElement && typeof this.lastFocusedElement.focus === 'function') {
      try { this.lastFocusedElement.focus(); } catch (e) {}
    }
  }

  async approveCurrentModal() {
    if (!this.currentModalTask) return;
    const task = this.currentModalTask;
    const corrId = task.correlationId;
    const edited = this.apprInstructionsInput ? this.apprInstructionsInput.value.trim() : null;

    try {
      this.btnApprApprove.disabled = true;
      if (this.btnApprReject) this.btnApprReject.disabled = true;

      const res = await fetch(`/api/intercom/approvals/${corrId}/approve`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-Token': this.token
        },
        body: JSON.stringify({
          editedInstructions: edited !== (task.originalInstructions || task.instructions) ? edited : null,
          approver: 'human-ui'
        })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to approve task');

      this.onToast(`Delegation ${corrId} approved! Ready in Gemini inbox.`, 'success');
      if (data.task) this.upsertTask(data.task);

      // Check if there are other pending approvals in the queue
      this._refreshPendingQueue();
      if (this.pendingApprovalQueue.length > 0) {
        this.carouselIndex = Math.min(this.carouselIndex, this.pendingApprovalQueue.length - 1);
        this.openApprovalModal(this.pendingApprovalQueue[this.carouselIndex]);
      } else {
        this.closeApprovalModal();
      }
    } catch (err) {
      this.onToast(`Approval failed: ${err.message}`, 'error');
      this.btnApprApprove.disabled = false;
      if (this.btnApprReject) this.btnApprReject.disabled = false;
    }
  }

  async rejectCurrentModal() {
    if (!this.currentModalTask) return;
    const task = this.currentModalTask;
    const corrId = task.correlationId;
    const reason = await dialogService.prompt({
      title: 'Reject Proposed Plan',
      message: 'Explain why this plan is being rejected so Claude Code can revise the delegation:',
      placeholder: 'e.g., Please add unit test coverage',
      defaultValue: 'Plan requires revision',
      confirmText: 'Reject Plan',
      icon: 'x-circle'
    });
    if (reason === null) return; // User cancelled prompt

    try {
      this.btnApprReject.disabled = true;
      if (this.btnApprApprove) this.btnApprApprove.disabled = true;

      const res = await fetch(`/api/intercom/approvals/${corrId}/reject`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-Token': this.token
        },
        body: JSON.stringify({
          reason: reason.trim() || 'Rejected by user',
          rejecter: 'human-ui'
        })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to reject task');

      this.onToast(`Delegation ${corrId} rejected.`, 'info');
      if (data.task) this.upsertTask(data.task);

      this._refreshPendingQueue();
      if (this.pendingApprovalQueue.length > 0) {
        this.carouselIndex = Math.min(this.carouselIndex, this.pendingApprovalQueue.length - 1);
        this.openApprovalModal(this.pendingApprovalQueue[this.carouselIndex]);
      } else {
        this.closeApprovalModal();
      }
    } catch (err) {
      this.onToast(`Rejection failed: ${err.message}`, 'error');
      this.btnApprReject.disabled = false;
      if (this.btnApprApprove) this.btnApprApprove.disabled = false;
    }
  }

  updateApprovalPill() {
    let pendingCount = 0;
    for (const task of this.tasks.values()) {
      if (task.state === 'APPROVAL_REQUESTED') {
        pendingCount++;
      }
    }

    if (this.pillApprovals && this.valApprovals) {
      if (pendingCount > 0) {
        this.pillApprovals.style.display = 'flex';
        this.valApprovals.textContent = `${pendingCount} PENDING`;
      } else {
        this.pillApprovals.style.display = 'none';
      }
    }
  }

  async submitTask() {
    const rawPrompt = this.promptInput.value || '';
    const cleanPrompt = rawPrompt.trim();

    if (!cleanPrompt) {
      this._showValidation('Please enter a task prompt before dispatching.');
      this.promptInput.focus();
      return;
    }

    this._clearValidation();
    this.dispatchBtn.disabled = true;
    this.dispatchBtn.textContent = 'Submitting...';

    const correlationId = `CORR_${Date.now()}_${Math.random().toString(36).substring(2, 7).toUpperCase()}`;

    try {
      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-Token': this.token
        },
        body: JSON.stringify({
          correlationId,
          targetAgent: 'gemini',
          prompt: cleanPrompt,
          cwd: this.projectCwd,
          requiresApproval: true
        })
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Failed to dispatch task');
      }

      this._savePromptHistory(cleanPrompt);
      this.promptInput.value = '';
      this._adjustTextareaHeight();
      this.onToast(`Task ${correlationId} created — awaiting approval!`, 'info');

      if (data.task) {
        this.upsertTask(data.task);
        this.selectTask(data.task.correlationId);
        this.openApprovalModal(data.task);
      }
    } catch (err) {
      this.onToast(`Dispatch failed: ${err.message}`, 'error');
    } finally {
      this.dispatchBtn.disabled = false;
      this.dispatchBtn.innerHTML = '<span class="btn-icon">&#x25B6;</span> Dispatch Task';
    }
  }

  upsertTask(task) {
    const existing = this.tasks.get(task.correlationId);
    const merged = existing ? { ...existing, ...task } : task;
    this.tasks.set(task.correlationId, merged);
    this.renderList();
    this.updateApprovalPill();

    if (this.selectedTaskId === task.correlationId) {
      this.renderDetail();
    }
  }

  appendChunk(correlationId, chunk) {
    const task = this.tasks.get(correlationId);
    if (!task) return;

    if (!task.liveChunks) task.liveChunks = '';
    task.liveChunks += chunk;

    if (this.selectedTaskId === correlationId) {
      const outputEl = document.getElementById('detail-output-stream');
      if (outputEl) {
        outputEl.textContent = task.liveChunks;
        outputEl.scrollTop = outputEl.scrollHeight;
      }
    }
  }

  selectTask(correlationId) {
    this.selectedTaskId = correlationId;
    this.renderList();
    this.renderDetail();

    // Scroll selected task into view smoothly
    requestAnimationFrame(() => {
      const card = this.listContainer.querySelector(`.task-card[data-id="${correlationId}"]`);
      if (card && typeof card.scrollIntoView === 'function') {
        card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    });
  }

  _matchesFilter(task, filter) {
    switch (filter) {
      case 'active':
        return ['APPROVAL_REQUESTED', 'APPROVED', 'QUEUED_FOR_CLAIM', 'CLAIMED', 'RUNNING'].includes(task.state);
      case 'approvals':
        return task.state === 'APPROVAL_REQUESTED';
      case 'completed':
        return task.state === 'COMPLETED';
      case 'failed':
        return ['FAILED', 'TIMED_OUT', 'CANCELLED', 'EXPIRED', 'REJECTED'].includes(task.state);
      case 'all':
      default:
        return true;
    }
  }

  _matchesSearch(task, query) {
    if (!query) return true;
    const q = query.toLowerCase();
    const corr = (task.correlationId || '').toLowerCase();
    const prompt = (task.prompt || task.instructions || task.plan || '').toLowerCase();
    const agent = (task.targetAgent || `${task.fromAgent || ''} ${task.toAgent || ''}`).toLowerCase();
    return corr.includes(q) || prompt.includes(q) || agent.includes(q);
  }

  _copyToClipboard(text, btnEl, originalHtml) {
    if (!navigator.clipboard || !navigator.clipboard.writeText) {
      // Fallback
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        this._showCopiedState(btnEl, originalHtml);
        return;
      } catch (e) {
        this.onToast('Could not copy to clipboard', 'error');
        return;
      }
    }

    navigator.clipboard.writeText(text).then(() => {
      this._showCopiedState(btnEl, originalHtml);
    }).catch(err => {
      this.onToast(`Copy failed: ${err.message}`, 'error');
    });
  }

  _showCopiedState(btnEl, originalHtml) {
    if (!btnEl) return;
    btnEl.classList.add('btn-copied');
    btnEl.innerHTML = '<span style="font-size:10px;">&#x2714;</span> Copied!';
    setTimeout(() => {
      btnEl.classList.remove('btn-copied');
      btnEl.innerHTML = originalHtml;
    }, 1500);
  }

  renderList() {
    const allTasks = Array.from(this.tasks.values()).reverse();

    // Calculate category counts
    let countActive = 0;
    let countApprovals = 0;
    let countCompleted = 0;
    let countFailed = 0;

    for (const t of allTasks) {
      if (this._matchesFilter(t, 'active')) countActive++;
      if (this._matchesFilter(t, 'approvals')) countApprovals++;
      if (this._matchesFilter(t, 'completed')) countCompleted++;
      if (this._matchesFilter(t, 'failed')) countFailed++;
    }

    // Update filter badge counts
    const elAll = document.getElementById('count-all');
    const elActive = document.getElementById('count-active');
    const elAppr = document.getElementById('count-approvals');
    const elDone = document.getElementById('count-completed');
    const elFail = document.getElementById('count-failed');

    if (elAll) elAll.textContent = allTasks.length;
    if (elActive) elActive.textContent = countActive;
    if (elAppr) elAppr.textContent = countApprovals;
    if (elDone) elDone.textContent = countCompleted;
    if (elFail) elFail.textContent = countFailed;

    // Filter and search
    const filteredTasks = allTasks.filter(task => {
      return this._matchesFilter(task, this.currentFilter) && this._matchesSearch(task, this.searchQuery);
    });

    if (filteredTasks.length === 0) {
      const emptyMsg = this.searchQuery
        ? `No tasks matching "${this._escape(this.searchQuery)}".`
        : (allTasks.length === 0 ? 'No delegated tasks in this session yet.' : 'No tasks match current filter.');
      this.listContainer.innerHTML = `<div class="empty-state">${emptyMsg}</div>`;
      return;
    }

    this.listContainer.innerHTML = filteredTasks.map(task => {
      const isSelected = task.correlationId === this.selectedTaskId ? 'selected' : '';
      const badgeClass = this._getBadgeClass(task.state);
      const elapsed = this._computeElapsed(task);
      const promptText = task.prompt || task.instructions || task.plan || 'No instructions provided';
      const agentText = task.targetAgent || (task.fromAgent ? `${task.fromAgent} → ${task.toAgent}` : 'intercom');

      return `
        <div class="task-card ${isSelected}" data-id="${task.correlationId}">
          <div class="task-card-header">
            <span class="task-corr-id">${task.correlationId}</span>
            <span class="badge badge-xs ${badgeClass}">${task.state}</span>
          </div>
          <div class="task-card-prompt">${this._escape(promptText)}</div>
          <div class="task-card-footer">
            <span>Agent: ${this._escape(agentText)}</span>
            <span>${elapsed}</span>
          </div>
        </div>
      `;
    }).join('');

    this.listContainer.querySelectorAll('.task-card').forEach(card => {
      card.addEventListener('click', () => {
        this.selectTask(card.dataset.id);
      });
    });
  }

  renderDetail() {
    const task = this.tasks.get(this.selectedTaskId);
    if (!task) {
      this.detailContainer.innerHTML = '<div class="empty-state">Select a task on the left to inspect parameters, execution timeline, and output.</div>';
      return;
    }

    const badgeClass = this._getBadgeClass(task.state);
    const elapsed = this._computeElapsed(task);
    const isTerminal = ['COMPLETED', 'FAILED', 'TIMED_OUT', 'CANCELLED', 'REJECTED', 'EXPIRED'].includes(task.state);
    const promptContent = task.prompt || task.instructions || task.plan || '-';
    const outputContent = task.result || task.liveChunks || (isTerminal ? '(No output received)' : 'Waiting for agent stream chunks...');
    const agentLabel = task.targetAgent || (task.fromAgent ? `${task.fromAgent} → ${task.toAgent}` : 'intercom');

    // Progress data check
    const hasProgress = (task.state === 'RUNNING' || task.state === 'CLAIMED') && (
      (task.progressHistory && task.progressHistory.length > 0) || task.lastProgress
    );
    const latestProgress = task.lastProgress || (task.progressHistory ? task.progressHistory[task.progressHistory.length - 1] : null);
    const hasPercent = latestProgress && typeof latestProgress.percent === 'number' && !isNaN(latestProgress.percent);

    this.detailContainer.innerHTML = `
      <div class="detail-section">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 8px;">
          <div>
            <div style="display:flex; align-items:center; gap:8px;">
              <span style="font-size: 14px; font-weight: 700; color: var(--color-info); font-family: var(--font-mono);">
                ${task.correlationId}
              </span>
              <button class="btn btn-xs btn-outline" id="btn-copy-corr-id" title="Copy correlation ID">Copy</button>
            </div>
            <div style="font-size: 11px; color: var(--text-muted); margin-top: 2px;">
              Route: <strong>${this._escape(agentLabel)}</strong> | Duration: <strong>${elapsed}</strong> | Storage: <strong>Durable (.workbench_tasks)</strong>
            </div>
            <div style="font-size: 11px; color: var(--text-muted); margin-top: 4px; font-family: var(--font-mono);">
              Folder: <span style="color: var(--color-info);">${this._escape(task.cwd || '-')}</span>
            </div>
          </div>
          <div style="display:flex; gap: 8px; align-items:center;">
            <span class="badge ${badgeClass}">${task.state}</span>
            ${task.state === 'APPROVAL_REQUESTED' ? `<button class="btn btn-xs btn-primary" id="btn-detail-approve">Review & Approve</button>` : ''}
            ${!isTerminal && task.state !== 'APPROVAL_REQUESTED' ? `<button class="btn btn-xs btn-danger" id="btn-cancel-task">Cancel Task</button>` : ''}
          </div>
        </div>

        ${hasProgress ? `
          <div class="task-progress-box" id="task-progress-box">
            <div class="progress-bar-label">
              <span class="progress-stage">${latestProgress.step ? `[${this._escape(latestProgress.step)}]` : 'Progress'} ${latestProgress.message ? this._escape(latestProgress.message) : ''}</span>
              <span>${hasPercent ? `${latestProgress.percent}%` : 'Executing'}</span>
            </div>
            <div class="progress-bar-wrap">
              <div class="progress-bar-fill ${hasPercent ? '' : 'indeterminate'}" style="${hasPercent ? `width: ${latestProgress.percent}%;` : ''}"></div>
            </div>
          </div>
        ` : ''}

        ${task.state === 'QUEUED_FOR_CLAIM' ? `
          <div class="impact-box" style="margin-top: 8px;">
            <span class="impact-icon">&#x23F3;</span>
            <span>Task approved! Waiting for Gemini claim. In visible Gemini terminal, type: <code>claim</code></span>
          </div>
        ` : ''}

        ${task.state === 'RUNNING' || task.state === 'CLAIMED' ? `
          <div class="impact-box" style="margin-top: 8px; background: rgba(59, 130, 246, 0.1); border-color: rgba(59, 130, 246, 0.3); color: #93c5fd;">
            <span class="impact-icon">&#x2699;</span>
            <span>Gemini CLI is executing this task in the visible terminal pane. Native file permission prompts remain active.</span>
          </div>
        ` : ''}
      </div>

      ${task.lateCompletion ? `
        <div class="late-completion-banner" id="task-late-completion-box">
          <div class="late-completion-title">&#x26A0; Late Completion Recorded</div>
          <div class="late-completion-meta">
            Completed at ${new Date(task.lateCompletion.completedAt).toLocaleTimeString()} after task expired/cancelled (${((task.lateCompletion.executionDurationMs || 0) / 1000).toFixed(1)}s duration).
          </div>
          <div class="late-completion-output">${this._escape(task.lateCompletion.result || '(No output)')}</div>
        </div>
      ` : ''}

      ${task.plan ? `
        <div class="detail-section">
          <div class="detail-title">Proposed Plan</div>
          <div class="code-block" style="max-height: 100px;">${this._escape(task.plan)}</div>
        </div>
      ` : ''}

      <div class="detail-section">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 6px;">
          <div class="detail-title" style="margin-bottom:0;">Instructions</div>
          <button class="btn btn-xs btn-outline" id="btn-copy-instructions" title="Copy instructions">Copy</button>
        </div>
        <div class="code-block" style="max-height: 80px;">${this._escape(promptContent)}</div>
      </div>

      ${task.modifiedFiles && task.modifiedFiles.length > 0 ? `
        <div class="detail-section">
          <div class="detail-title">Modified Files</div>
          <div class="code-block" style="color: #4ade80;">${this._escape(task.modifiedFiles.join('\n'))}</div>
        </div>
      ` : ''}

      ${task.testResults ? `
        <div class="detail-section">
          <div class="detail-title">Verification & Test Results</div>
          <div class="code-block">${this._escape(typeof task.testResults === 'object' ? JSON.stringify(task.testResults, null, 2) : String(task.testResults))}</div>
        </div>
      ` : ''}

      <div class="detail-section">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 6px;">
          <div class="detail-title" style="margin-bottom:0;">Agent Response / Implementation Output</div>
          <button class="btn btn-xs btn-outline" id="btn-copy-output" title="Copy output">Copy</button>
        </div>
        <div class="code-block" id="detail-output-stream">${this._escape(outputContent)}</div>
      </div>

      ${task.error ? `
        <div class="detail-section" style="border-color: rgba(239, 68, 68, 0.4);">
          <div class="detail-title" style="color: var(--color-danger);">Error Diagnostic</div>
          <div class="code-block" style="color: #fca5a5;">${this._escape(task.error)}</div>
        </div>
      ` : ''}

      <div class="detail-section">
        <div class="detail-title">State Transition History & Duration Timeline</div>
        <div style="font-size: 11px; font-family: var(--font-mono); color: var(--text-muted); line-height: 1.6;">
          ${this._renderStateHistoryTimeline(task)}
        </div>
      </div>

      ${task.progressHistory && task.progressHistory.length > 0 ? `
        <div class="detail-section">
          <div class="detail-title">Execution Progress Log</div>
          <div style="font-size: 11px; font-family: var(--font-mono); color: var(--color-info); line-height: 1.5;">
            ${task.progressHistory.map(p => `&bull; ${new Date(p.timestamp).toLocaleTimeString()}: <strong>${this._escape(p.step || 'Progress')}</strong> ${p.percent !== undefined ? `(${p.percent}%)` : ''} ${p.message ? `&mdash; ${this._escape(p.message)}` : ''}`).join('<br>')}
          </div>
        </div>
      ` : ''}
    `;

    // Bind Copy Buttons
    const btnCopyCorr = document.getElementById('btn-copy-corr-id');
    if (btnCopyCorr) {
      btnCopyCorr.addEventListener('click', () => {
        this._copyToClipboard(task.correlationId, btnCopyCorr, 'Copy');
      });
    }

    const btnCopyInst = document.getElementById('btn-copy-instructions');
    if (btnCopyInst) {
      btnCopyInst.addEventListener('click', () => {
        this._copyToClipboard(promptContent, btnCopyInst, 'Copy');
      });
    }

    const btnCopyOut = document.getElementById('btn-copy-output');
    if (btnCopyOut) {
      btnCopyOut.addEventListener('click', () => {
        this._copyToClipboard(outputContent, btnCopyOut, 'Copy');
      });
    }

    const detailApproveBtn = document.getElementById('btn-detail-approve');
    if (detailApproveBtn) {
      detailApproveBtn.addEventListener('click', () => {
        this.openApprovalModal(task);
      });
    }

    const cancelBtn = document.getElementById('btn-cancel-task');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', async () => {
        const confirmed = await dialogService.confirm({
          title: 'Cancel Active Task',
          message: `Are you sure you want to cancel delegation task ${task.correlationId}? In-flight execution will be notified to abort cleanly.`,
          confirmText: 'Cancel Task',
          destructive: true,
          icon: 'alert-triangle'
        });
        if (confirmed) {
          await this.cancelTask(task.correlationId);
        }
      });
    }
  }

  async cancelTask(correlationId) {
    try {
      const res = await fetch(`/api/intercom/tasks/${correlationId}/cancel`, {
        method: 'POST',
        headers: { 'X-Session-Token': this.token }
      });
      const data = await res.json();
      if (data.status === 'cancelled' || data.cancelled) {
        this.onToast(`Task ${correlationId} cancelled`, 'info');
        if (data.task) this.upsertTask(data.task);
      }
    } catch (e) {
      try {
        const res2 = await fetch(`/api/tasks/${correlationId}/cancel`, {
          method: 'POST',
          headers: { 'X-Session-Token': this.token }
        });
        const d2 = await res2.json();
        if (d2.cancelled) this.onToast(`Task ${correlationId} cancelled`, 'info');
      } catch (err) {
        console.error('Cancel failed:', err);
      }
    }
  }

  _renderStateHistoryTimeline(task) {
    if (!task.stateHistory || task.stateHistory.length === 0) {
      return `&bull; ${new Date(task.createdAt || Date.now()).toLocaleTimeString()} &rarr; <strong>${this._escape(task.state)}</strong>`;
    }

    const isTerminal = ['COMPLETED', 'FAILED', 'TIMED_OUT', 'CANCELLED', 'REJECTED', 'EXPIRED'].includes(task.state);
    const now = Date.now();

    return task.stateHistory.map((h, idx) => {
      const entryTime = typeof h.timestamp === 'number' && !isNaN(h.timestamp) ? h.timestamp : task.createdAt || now;
      const nextEntry = task.stateHistory[idx + 1];
      let durationMs = 0;
      let isLive = false;

      if (nextEntry && typeof nextEntry.timestamp === 'number') {
        durationMs = Math.max(0, nextEntry.timestamp - entryTime);
      } else if (isTerminal) {
        durationMs = Math.max(0, (task.completedAt || now) - entryTime);
      } else {
        durationMs = Math.max(0, now - entryTime);
        isLive = true;
      }

      let durStr = durationMs >= 1000 ? `${(durationMs / 1000).toFixed(1)}s` : `${durationMs}ms`;
      if (isLive) durStr = `${durStr} active`;

      const timeStr = new Date(entryTime).toLocaleTimeString();
      const stateName = this._escape(h.to || h.state || 'UNKNOWN');
      const reasonStr = h.reason ? `(${this._escape(h.reason)})` : '';
      const actorStr = this._escape(h.actor || 'system');

      return `&bull; <span style="color:var(--text-dim);">${timeStr}</span> &rarr; <strong>${stateName}</strong> <span class="badge badge-xs badge-outline" style="margin: 0 4px;">${durStr}</span> ${reasonStr} <span style="color:var(--text-dim);">&mdash; ${actorStr}</span>`;
    }).join('<br>');
  }

  _computeElapsed(task) {
    if (task.completedAt && task.startedAt) {
      return `${((task.completedAt - task.startedAt) / 1000).toFixed(1)}s`;
    }
    if (task.durationMs) {
      return `${(task.durationMs / 1000).toFixed(1)}s`;
    }
    if (task.startedAt) {
      return `${((Date.now() - task.startedAt) / 1000).toFixed(1)}s`;
    }
    if (task.createdAt) {
      return `${((Date.now() - task.createdAt) / 1000).toFixed(1)}s`;
    }
    return '0.0s';
  }

  _startElapsedTimer() {
    this.timerInterval = setInterval(() => {
      let hasRunning = false;
      for (const task of this.tasks.values()) {
        if (['RUNNING', 'CLAIMED', 'SENT'].includes(task.state)) {
          hasRunning = true;
          break;
        }
      }
      if (hasRunning) {
        this.renderList();
        if (this.selectedTaskId) {
          const selected = this.tasks.get(this.selectedTaskId);
          if (selected && ['RUNNING', 'CLAIMED', 'SENT'].includes(selected.state)) {
            this.renderDetail();
          }
        }
      }
    }, 500);
  }

  _getBadgeClass(state) {
    switch (state) {
      case 'COMPLETED': return 'badge-success';
      case 'RUNNING': return 'badge-warning';
      case 'CLAIMED': return 'badge-warning';
      case 'APPROVED': return 'badge-primary';
      case 'QUEUED_FOR_CLAIM': return 'badge-primary';
      case 'APPROVAL_REQUESTED': return 'badge-warning';
      case 'REJECTED': return 'badge-danger';
      case 'FAILED': return 'badge-danger';
      case 'TIMED_OUT': return 'badge-danger';
      case 'EXPIRED': return 'badge-danger';
      case 'CANCELLED': return 'badge-outline';
      default: return 'badge-outline';
    }
  }

  _escape(str) {
    if (typeof str !== 'string') return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
}
