// Resizable & collapsible pane layout: sidebar / terminal / task-detail panes.
// Persists widths and collapsed state to localStorage so the layout survives reload.

const STORAGE_KEY = 'workbench_pane_layout';
const MIN_SIDEBAR = 220;
const MAX_SIDEBAR = 560;
const MIN_DETAIL = 260;
const MAX_DETAIL = 640;
const COLLAPSED_WIDTH = '40px';

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw);
  } catch (e) {
    return {};
  }
}

function saveState(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {}
}

export class PaneLayoutController {
  constructor() {
    this.layoutEl = document.querySelector('.workbench-layout');
    this.sidebarPane = document.getElementById('pane-sidebar');
    this.terminalPane = document.getElementById('pane-terminal');
    this.detailPane = document.getElementById('pane-detail');
    this.handleLeft = document.getElementById('resize-handle-left');
    this.handleRight = document.getElementById('resize-handle-right');
    this.btnToggleSidebar = document.getElementById('btn-toggle-sidebar');
    this.btnToggleDetail = document.getElementById('btn-toggle-detail');
    this.btnToggleTerminal = document.getElementById('btn-toggle-terminal');
    this.collapsedTerminalLabel = document.getElementById('collapsed-label-terminal');

    this.state = Object.assign({
      sidebarWidth: 340,
      detailWidth: 360,
      sidebarCollapsed: false,
      detailCollapsed: false,
      terminalCollapsed: false
    }, loadState());

    this._drag = null;
  }

  init() {
    if (!this.layoutEl) return;

    this._applyWidths();
    this._applyCollapsedClasses();

    if (this.handleLeft) {
      this.handleLeft.addEventListener('mousedown', (e) => this._startDrag('left', e));
    }
    if (this.handleRight) {
      this.handleRight.addEventListener('mousedown', (e) => this._startDrag('right', e));
    }

    if (this.btnToggleSidebar) {
      this.btnToggleSidebar.addEventListener('click', () => this.toggle('sidebar'));
    }
    if (this.btnToggleDetail) {
      this.btnToggleDetail.addEventListener('click', () => this.toggle('detail'));
    }
    if (this.btnToggleTerminal) {
      this.btnToggleTerminal.addEventListener('click', () => this.toggle('terminal'));
    }
    if (this.collapsedTerminalLabel) {
      this.collapsedTerminalLabel.addEventListener('click', () => this.toggle('terminal'));
    }

    // Note: no native window 'resize' listener here. terminal_view.js already listens
    // for real window resizes and re-fits xterm on its own; this controller only needs
    // to trigger that same re-fit after a drag/toggle, via _fitTerminal(). Listening for
    // 'resize' here too would re-trigger on the synthetic event _fitTerminal() dispatches,
    // recursing forever.
  }

  toggle(pane) {
    const key = `${pane}Collapsed`;
    this.state[key] = !this.state[key];
    saveState(this.state);
    this._applyCollapsedClasses();
    this._fitTerminal();
  }

  _applyWidths() {
    this.layoutEl.style.setProperty('--w-sidebar', this.state.sidebarCollapsed ? COLLAPSED_WIDTH : `${this.state.sidebarWidth}px`);
    this.layoutEl.style.setProperty('--w-detail', this.state.detailCollapsed ? COLLAPSED_WIDTH : `${this.state.detailWidth}px`);
  }

  _applyCollapsedClasses() {
    this.layoutEl.classList.toggle('sidebar-collapsed', !!this.state.sidebarCollapsed);
    this.layoutEl.classList.toggle('detail-collapsed', !!this.state.detailCollapsed);

    if (this.sidebarPane) {
      this.sidebarPane.classList.toggle('pane-is-collapsed', !!this.state.sidebarCollapsed);
    }
    if (this.detailPane) {
      this.detailPane.classList.toggle('pane-is-collapsed', !!this.state.detailCollapsed);
    }
    if (this.terminalPane) {
      this.terminalPane.classList.toggle('pane-is-collapsed', !!this.state.terminalCollapsed);
    }

    if (this.btnToggleSidebar) {
      this.btnToggleSidebar.textContent = this.state.sidebarCollapsed ? '»' : '«';
      this.btnToggleSidebar.title = this.state.sidebarCollapsed ? 'Show Task Composer panel' : 'Hide Task Composer panel';
    }
    if (this.btnToggleDetail) {
      this.btnToggleDetail.textContent = this.state.detailCollapsed ? '«' : '»';
      this.btnToggleDetail.title = this.state.detailCollapsed ? 'Show Task Detail panel' : 'Hide Task Detail panel';
    }
    if (this.btnToggleTerminal) {
      this.btnToggleTerminal.title = this.state.terminalCollapsed ? 'Show Terminal panel' : 'Hide Terminal panel';
      this.btnToggleTerminal.style.display = this.state.terminalCollapsed ? 'none' : '';
    }

    this._applyWidths();
  }

  _startDrag(side, e) {
    e.preventDefault();
    const startX = e.clientX;
    const startSidebar = this.state.sidebarWidth;
    const startDetail = this.state.detailWidth;

    // Dragging a handle always re-expands the pane it controls.
    if (side === 'left' && this.state.sidebarCollapsed) {
      this.state.sidebarCollapsed = false;
    }
    if (side === 'right' && this.state.detailCollapsed) {
      this.state.detailCollapsed = false;
    }
    this._applyCollapsedClasses();

    const handleEl = side === 'left' ? this.handleLeft : this.handleRight;
    handleEl.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    this._drag = { side, startX, startSidebar, startDetail };

    const onMove = (ev) => this._onDrag(ev);
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      handleEl.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      this._drag = null;
      saveState(this.state);
      this._fitTerminal();
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  _onDrag(e) {
    if (!this._drag) return;
    const { side, startX, startSidebar, startDetail } = this._drag;
    const dx = e.clientX - startX;

    if (side === 'left') {
      const next = Math.min(MAX_SIDEBAR, Math.max(MIN_SIDEBAR, startSidebar + dx));
      this.state.sidebarWidth = next;
    } else {
      const next = Math.min(MAX_DETAIL, Math.max(MIN_DETAIL, startDetail - dx));
      this.state.detailWidth = next;
    }
    this._applyWidths();
    this._fitTerminal();
  }

  _fitTerminal() {
    // Reuse terminal_view's existing debounced window 'resize' handler to re-fit xterm
    // to its container's new width after a drag or a pane collapse/expand.
    window.dispatchEvent(new Event('resize'));
  }
}
