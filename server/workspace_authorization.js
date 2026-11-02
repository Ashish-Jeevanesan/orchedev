// D:\Ashish_P\AI-Tools\custom-OCT\server\workspace_authorization.js
// Centralized Working-Directory Authorization Service for Agent Workbench
// Phase 3 Workstream F Remediation: Canonical Path Containment, Symlink Escapes & Allowed Roots

import fs from 'fs';
import path from 'path';
import { TaskSecurityError } from './intercom_service.js';

export class WorkspaceAuthorizationService {
  constructor({ baseCwd = process.cwd(), allowedRoots = [], persistRoots = true } = {}) {
    this.baseCwd = path.resolve(baseCwd);
    this.allowedRoots = new Set();
    this.persistRoots = persistRoots;
    this.storageFile = path.join(this.baseCwd, '.workbench_workspaces.json');

    // 1. Authorize base project root by default
    this.addAllowedRoot(this.baseCwd, false);

    // 2. Restore persisted authorized roots from previous sessions BEFORE task recovery
    if (this.persistRoots) {
      this._loadPersistedRoots();
    }

    // 3. Add any explicitly configured roots
    if (Array.isArray(allowedRoots)) {
      for (const root of allowedRoots) {
        this.addAllowedRoot(root);
      }
    }
  }

  _loadPersistedRoots() {
    try {
      if (!fs.existsSync(this.storageFile)) return;
      const raw = fs.readFileSync(this.storageFile, 'utf8');
      if (!raw || !raw.trim()) return;
      const parsed = JSON.parse(raw);
      const roots = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.roots) ? parsed.roots : []);
      let prunedAny = false;
      for (const r of roots) {
        if (!this.addAllowedRoot(r, false)) {
          // If a previously stored root is no longer valid or no longer exists, it was pruned
          prunedAny = true;
        }
      }
      if (prunedAny) {
        this._savePersistedRoots();
      }
    } catch (e) {
      // Storage read error isolated; preserve baseCwd in memory
    }
  }

  _savePersistedRoots() {
    if (!this.persistRoots) return;
    try {
      const payload = {
        version: 1,
        lastUpdated: Date.now(),
        roots: Array.from(this.allowedRoots)
      };
      const tmp = `${this.storageFile}.tmp_${Date.now()}`;
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
      try {
        fs.renameSync(tmp, this.storageFile);
      } catch (err) {
        fs.writeFileSync(this.storageFile, JSON.stringify(payload, null, 2), 'utf8');
        try { fs.unlinkSync(tmp); } catch (_) {}
      }
    } catch (e) {
      // Storage write error isolated
    }
  }

  addAllowedRoot(rootPath, save = true) {
    if (!rootPath || typeof rootPath !== 'string') return false;
    if (rootPath.includes('\0') || rootPath.includes('%00')) return false;

    try {
      const resolved = path.resolve(rootPath);
      if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
        const canonical = fs.realpathSync(resolved);
        // Do not allow bare root drives (e.g. 'C:\', 'D:\', '/') as allowed roots
        const parsed = path.parse(canonical);
        if (canonical.toLowerCase() === parsed.root.toLowerCase()) {
          return false;
        }
        const wasAdded = !this.allowedRoots.has(canonical);
        this.allowedRoots.add(canonical);
        if (wasAdded && save) {
          this._savePersistedRoots();
        }
        return true;
      }
    } catch (e) {
      return false;
    }
    return false;
  }

  removeAllowedRoot(rootPath) {
    if (!rootPath || typeof rootPath !== 'string') return false;
    try {
      const canonical = fs.realpathSync(path.resolve(rootPath));
      const deleted = this.allowedRoots.delete(canonical);
      if (deleted) {
        this._savePersistedRoots();
      }
      return deleted;
    } catch (e) {
      return false;
    }
  }

  getAllowedRoots() {
    return Array.from(this.allowedRoots);
  }

  /**
   * Validates and authorizes a requested working directory.
   * Returns canonical real path if authorized, or throws TaskSecurityError.
   */
  authorizeCwd(requestedPath, trustedBase = null) {
    if (!requestedPath || typeof requestedPath !== 'string' || !requestedPath.trim()) {
      throw new TaskSecurityError('Working directory path is required', 'ERR_CWD_NOT_AUTHORIZED');
    }

    // 1. Reject null bytes and encoded null bytes
    if (requestedPath.includes('\0') || requestedPath.includes('%00')) {
      throw new TaskSecurityError('Invalid working directory: Null byte detected', 'ERR_SECURITY_VIOLATION');
    }

    // 2. Reject Windows raw device paths (e.g., \\.\ or \\?\)
    if (requestedPath.startsWith('\\\\.\\') || requestedPath.startsWith('\\\\?\\')) {
      throw new TaskSecurityError('Invalid working directory: Device paths are not supported', 'ERR_SECURITY_VIOLATION');
    }

    // 3. Reject UNC network shares unless explicitly authorized
    if (requestedPath.startsWith('\\\\') && !this._isUncExplicitlyAuthorized(requestedPath)) {
      throw new TaskSecurityError('Invalid working directory: UNC network paths are not authorized', 'ERR_CWD_NOT_AUTHORIZED');
    }

    // 4. Resolve relative paths against trusted base directory
    const base = trustedBase ? path.resolve(trustedBase) : this.baseCwd;
    const resolvedPath = path.resolve(base, requestedPath);

    // 5. Verify directory exists and is accessible
    let stat;
    try {
      stat = fs.statSync(resolvedPath);
    } catch (e) {
      throw new TaskSecurityError(`Working directory does not exist or is inaccessible: ${resolvedPath}`, 'ERR_CWD_NOT_AUTHORIZED');
    }

    // 6. Verify it is a directory
    if (!stat.isDirectory()) {
      throw new TaskSecurityError(`Working directory is not a directory: ${resolvedPath}`, 'ERR_CWD_NOT_AUTHORIZED');
    }

    // 7. Resolve filesystem real path (evaluates symlinks, junctions, reparse points)
    let realPath;
    try {
      realPath = fs.realpathSync(resolvedPath);
    } catch (e) {
      throw new TaskSecurityError(`Failed to resolve canonical real path: ${resolvedPath}`, 'ERR_CWD_NOT_AUTHORIZED');
    }

    // 8. Verify boundary containment against configured authorized roots
    const isAuthorized = this._isContainedInAllowedRoots(realPath);
    if (!isAuthorized) {
      throw new TaskSecurityError(
        `Working directory '${resolvedPath}' resolves to unauthorized location outside configured workspace roots`,
        'ERR_CWD_NOT_AUTHORIZED',
        { requestedPath, resolvedPath }
      );
    }

    return realPath;
  }

  _isContainedInAllowedRoots(targetRealPath) {
    const targetNorm = targetRealPath.toLowerCase();

    for (const allowedRoot of this.allowedRoots) {
      const rootNorm = allowedRoot.toLowerCase();

      // Check relative path boundary
      const rel = path.relative(rootNorm, targetNorm);

      // If rel is '' (exact match) or does not start with '..' and is not absolute, it is contained!
      if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
        return true;
      }
    }

    return false;
  }

  _isUncExplicitlyAuthorized(uncPath) {
    const targetNorm = uncPath.toLowerCase();
    for (const root of this.allowedRoots) {
      if (root.startsWith('\\\\') && targetNorm.startsWith(root.toLowerCase())) {
        return true;
      }
    }
    return false;
  }
}
