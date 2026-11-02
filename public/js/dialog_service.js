// D:\Ashish_P\AI-Tools\custom-OCT\public\js\dialog_service.js
// Centralized Accessible Modal Dialog Service
// Replaces generic browser alert(), confirm(), and prompt() with theme-consistent, accessible dialogs.

import { getIcon } from './icons.js';

export class DialogService {
  constructor() {
    this.modalEl = null;
    this.activeResolver = null;
    this.lastFocusedElement = null;
    this._initDom();
  }

  _initDom() {
    let el = document.getElementById('modal-custom-dialog');
    if (!el) {
      el = document.createElement('div');
      el.id = 'modal-custom-dialog';
      el.className = 'modal-backdrop';
      el.style.display = 'none';
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-modal', 'true');
      el.setAttribute('aria-labelledby', 'dialog-modal-title');
      document.body.appendChild(el);
    }
    this.modalEl = el;

    window.addEventListener('keydown', (e) => {
      if (!this.modalEl || this.modalEl.style.display !== 'flex') return;

      if (e.key === 'Escape') {
        e.preventDefault();
        this._dismiss(null);
      }
    });
  }

  _dismiss(value) {
    if (this.activeResolver) {
      const resolve = this.activeResolver;
      this.activeResolver = null;
      resolve(value);
    }
    if (this.modalEl) {
      this.modalEl.style.display = 'none';
      this.modalEl.innerHTML = '';
    }
    if (this.lastFocusedElement && typeof this.lastFocusedElement.focus === 'function') {
      try { this.lastFocusedElement.focus(); } catch (e) {}
      this.lastFocusedElement = null;
    }
  }

  confirm({
    title = 'Confirm Action',
    message = 'Are you sure you want to proceed?',
    confirmText = 'Confirm',
    cancelText = 'Cancel',
    destructive = false,
    icon = 'alert-triangle'
  } = {}) {
    this.lastFocusedElement = document.activeElement;

    return new Promise((resolve) => {
      this.activeResolver = (val) => resolve(val === true);

      const confirmBtnClass = destructive ? 'btn-danger' : 'btn-primary';
      const iconHtml = getIcon(icon, 18, 'dialog-icon');

      this.modalEl.innerHTML = `
        <div class="modal-dialog modal-dialog-sm" role="document">
          <div class="modal-header">
            <div class="modal-title" id="dialog-modal-title">
              <span class="modal-icon">${iconHtml}</span>
              <span>${this._escape(title)}</span>
            </div>
            <button class="btn-close" id="btn-dialog-close" title="Close (Esc)">&times;</button>
          </div>
          <div class="modal-body">
            <p class="dialog-message">${this._escape(message)}</p>
          </div>
          <div class="modal-footer">
            <button class="btn btn-sm btn-secondary" id="btn-dialog-cancel">${this._escape(cancelText)}</button>
            <button class="btn btn-sm ${confirmBtnClass}" id="btn-dialog-confirm">${this._escape(confirmText)}</button>
          </div>
        </div>
      `;

      this.modalEl.style.display = 'flex';

      const btnClose = document.getElementById('btn-dialog-close');
      const btnCancel = document.getElementById('btn-dialog-cancel');
      const btnConfirm = document.getElementById('btn-dialog-confirm');

      btnClose?.addEventListener('click', () => this._dismiss(false));
      btnCancel?.addEventListener('click', () => this._dismiss(false));
      btnConfirm?.addEventListener('click', () => {
        btnConfirm.disabled = true;
        if (btnCancel) btnCancel.disabled = true;
        this._dismiss(true);
      });

      requestAnimationFrame(() => {
        if (destructive && btnCancel) {
          btnCancel.focus();
        } else if (btnConfirm) {
          btnConfirm.focus();
        }
      });
    });
  }

  prompt({
    title = 'Input Required',
    message = 'Please enter a value:',
    placeholder = '',
    defaultValue = '',
    confirmText = 'Submit',
    cancelText = 'Cancel',
    icon = 'terminal'
  } = {}) {
    this.lastFocusedElement = document.activeElement;

    return new Promise((resolve) => {
      this.activeResolver = (val) => resolve(typeof val === 'string' ? val : null);

      const iconHtml = getIcon(icon, 18, 'dialog-icon');

      this.modalEl.innerHTML = `
        <div class="modal-dialog modal-dialog-sm" role="document">
          <div class="modal-header">
            <div class="modal-title" id="dialog-modal-title">
              <span class="modal-icon">${iconHtml}</span>
              <span>${this._escape(title)}</span>
            </div>
            <button class="btn-close" id="btn-dialog-close" title="Close (Esc)">&times;</button>
          </div>
          <div class="modal-body">
            <p class="dialog-message">${this._escape(message)}</p>
            <input type="text" id="dialog-prompt-input" class="search-input" style="margin-top:10px; font-size:12px; height:32px;" placeholder="${this._escape(placeholder)}" value="${this._escape(defaultValue)}" />
          </div>
          <div class="modal-footer">
            <button class="btn btn-sm btn-secondary" id="btn-dialog-cancel">${this._escape(cancelText)}</button>
            <button class="btn btn-sm btn-primary" id="btn-dialog-confirm">${this._escape(confirmText)}</button>
          </div>
        </div>
      `;

      this.modalEl.style.display = 'flex';

      const input = document.getElementById('dialog-prompt-input');
      const btnClose = document.getElementById('btn-dialog-close');
      const btnCancel = document.getElementById('btn-dialog-cancel');
      const btnConfirm = document.getElementById('btn-dialog-confirm');

      const submit = () => {
        const val = input ? input.value : '';
        btnConfirm.disabled = true;
        if (btnCancel) btnCancel.disabled = true;
        this._dismiss(val);
      };

      btnClose?.addEventListener('click', () => this._dismiss(null));
      btnCancel?.addEventListener('click', () => this._dismiss(null));
      btnConfirm?.addEventListener('click', submit);

      input?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          submit();
        }
      });

      requestAnimationFrame(() => {
        if (input) {
          input.focus();
          input.select();
        }
      });
    });
  }

  alert({
    title = 'Alert',
    message = '',
    confirmText = 'OK',
    type = 'info',
    icon = 'info'
  } = {}) {
    this.lastFocusedElement = document.activeElement;

    return new Promise((resolve) => {
      this.activeResolver = () => resolve();

      const iconName = type === 'error' ? 'alert-circle' : icon;
      const iconHtml = getIcon(iconName, 18, 'dialog-icon');

      this.modalEl.innerHTML = `
        <div class="modal-dialog modal-dialog-sm" role="document">
          <div class="modal-header">
            <div class="modal-title" id="dialog-modal-title">
              <span class="modal-icon" style="${type === 'error' ? 'color: var(--color-danger);' : ''}">${iconHtml}</span>
              <span>${this._escape(title)}</span>
            </div>
            <button class="btn-close" id="btn-dialog-close" title="Close (Esc)">&times;</button>
          </div>
          <div class="modal-body">
            <p class="dialog-message" style="${type === 'error' ? 'color: #fca5a5;' : ''}">${this._escape(message)}</p>
          </div>
          <div class="modal-footer">
            <button class="btn btn-sm btn-primary" id="btn-dialog-confirm">${this._escape(confirmText)}</button>
          </div>
        </div>
      `;

      this.modalEl.style.display = 'flex';

      const btnClose = document.getElementById('btn-dialog-close');
      const btnConfirm = document.getElementById('btn-dialog-confirm');

      btnClose?.addEventListener('click', () => this._dismiss());
      btnConfirm?.addEventListener('click', () => this._dismiss());

      requestAnimationFrame(() => {
        btnConfirm?.focus();
      });
    });
  }

  _escape(str) {
    if (typeof str !== 'string') return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
}

export const dialogService = new DialogService();
