// D:\Ashish_P\AI-Tools\custom-OCT\server\logger.js
// Structured, Secret-Redacted File & Console Logger for Agent Workbench
// Phase 3 Workstream D: Recursive Secret Redaction, Defense-in-Depth String Sanitization, Dynamic Path

import fs from 'fs';
import path from 'path';

/**
 * Recursively redacts sensitive keys and values from objects, arrays, and primitives.
 */
export function redactSecrets(data, depth = 0) {
  if (depth > 6 || data === null || data === undefined) return data;

  if (typeof data === 'string') {
    return sanitizeString(data);
  }

  if (data instanceof Error) {
    return {
      name: data.name,
      message: sanitizeString(data.message),
      code: data.code,
      stack: sanitizeString(data.stack || '')
    };
  }

  if (Array.isArray(data)) {
    return data.map(item => redactSecrets(item, depth + 1));
  }

  if (typeof data === 'object') {
    const redacted = {};
    for (const [key, value] of Object.entries(data)) {
      const lowerKey = key.toLowerCase();
      const isSensitiveKey =
        lowerKey.includes('token') ||
        lowerKey.includes('secret') ||
        lowerKey.includes('password') ||
        lowerKey.includes('cookie') ||
        lowerKey === 'key' ||
        lowerKey === 'apikey' ||
        lowerKey === 'authorization';

      if (isSensitiveKey && (typeof value !== 'object' || value === null)) {
        redacted[key] = '[REDACTED]';
      } else {
        redacted[key] = redactSecrets(value, depth + 1);
      }
    }
    return redacted;
  }

  return data;
}

/**
 * Defense-in-depth string sanitization for headers, tokens, URLs, cookies, and error messages.
 */
export function sanitizeString(str) {
  if (typeof str !== 'string') return '';
  return str
    // Redact Bearer / Authorization headers
    .replace(/(authorization\s*[:=]\s*Bearer\s+)[^\s,"';]+/gi, '$1[REDACTED]')
    .replace(/(Bearer\s+)[a-zA-Z0-9._\-]{16,}/gi, '$1[REDACTED]')
    // Redact X-Session-Token
    .replace(/(X-Session-Token\s*[:=]\s*)[a-zA-Z0-9_\-]+/gi, '$1[REDACTED]')
    // Redact token subprotocol in WebSocket urls
    .replace(/(token\.)[a-f0-9]{16,}/gi, '$1[REDACTED]')
    // Redact token/auth/session/key in query parameters
    .replace(/([?&](?:token|session|auth|key|secret)=)[^&\s"';]+/gi, '$1[REDACTED]')
    // Redact cookie assignments
    .replace(/((?:session_token|token|session|auth|jwt)\s*=\s*)[^;\s,"']+/gi, '$1[REDACTED]')
    // Redact raw hex tokens (32 to 64 chars) preceded by label
    .replace(/(['"]?(?:token|sessionToken|session_token)['"]?\s*[:=]\s*['"])[a-f0-9]{32,64}(['"])/gi, '$1[REDACTED]$2');
}

export class Logger {
  constructor({ cwd = process.cwd(), logFile = null } = {}) {
    this.cwd = path.resolve(cwd);
    this.logDir = path.join(this.cwd, 'logs');
    this.logFile = logFile || path.join(this.logDir, 'workbench.log');

    try {
      if (!fs.existsSync(this.logDir)) {
        fs.mkdirSync(this.logDir, { recursive: true });
      }
      this.stream = fs.createWriteStream(this.logFile, { flags: 'a', encoding: 'utf-8' });
      this.stream.on('error', (err) => {
        console.error('[Logger Stream Error]', err.message);
      });
    } catch (e) {
      console.error('[Logger Init Warning] Could not initialize file stream:', e.message);
      this.stream = null;
    }
  }

  _format(level, action, message, data = null) {
    const timestamp = new Date().toISOString();
    const sanitizedMsg = sanitizeString(typeof message === 'string' ? message : JSON.stringify(message));
    let dataStr = '';
    if (data !== null && data !== undefined) {
      try {
        const cleanedData = redactSecrets(data);
        dataStr = ` | data=${sanitizeString(JSON.stringify(cleanedData))}`;
      } catch (e) {
        dataStr = ' | data=[Unserializable Data]';
      }
    }
    return `[${timestamp}] [${level}] [${action}] ${sanitizedMsg}${dataStr}\n`;
  }

  _write(level, action, message, data = null) {
    try {
      if (this.stream && this.stream.writable) {
        const formatted = this._format(level, action, message, data);
        this.stream.write(formatted);
      }
    } catch (e) {
      // Defense-in-depth: Never throw or disrupt caller if logging fails
    }
  }

  info(action, message, data = null) {
    try {
      const sanitizedMsg = sanitizeString(typeof message === 'string' ? message : JSON.stringify(message));
      console.log(`[INFO] [${action}] ${sanitizedMsg}`);
      this._write('INFO', action, message, data);
    } catch (e) {}
  }

  warn(action, message, data = null) {
    try {
      const sanitizedMsg = sanitizeString(typeof message === 'string' ? message : JSON.stringify(message));
      console.warn(`[WARN] [${action}] ${sanitizedMsg}`);
      this._write('WARN', action, message, data);
    } catch (e) {}
  }

  error(action, message, data = null) {
    try {
      const sanitizedMsg = sanitizeString(typeof message === 'string' ? message : JSON.stringify(message));
      console.error(`[ERROR] [${action}] ${sanitizedMsg}`);
      this._write('ERROR', action, message, data);
    } catch (e) {}
  }

  debug(action, message, data = null) {
    try {
      this._write('DEBUG', action, message, data);
    } catch (e) {}
  }

  close() {
    try {
      if (this.stream) {
        this.stream.end();
      }
    } catch (e) {}
  }
}

export const logger = new Logger();
