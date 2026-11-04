// Deterministic, auditable policy for auto-approving Gemini CLI's own native
// interactive permission prompts (the "Allow execution of [Tool]? 1. Allow once ..."
// confirmations Gemini prints into its own terminal output).
//
// This is intentionally NOT "ask an AI to judge this command": the prompt text itself
// can contain content Gemini read from an external source (a ticket, a document, a
// file), so handing it to another model to classify as safe/unsafe just moves the
// prompt-injection attack surface one step sideways instead of closing it. Decisions
// here are made by matching the command against fixed, explicit categories -- the same
// kind of "read-only / no side effects" categories Claude Code itself treats as
// low-risk -- never by reasoning about the specific text.
//
// Hard rule, no exceptions: any prompt carrying Gemini's own "untrusted input" /
// "CRITICAL SECURITY WARNING" marker is always escalated to the human. That marker
// means an argument's *value* came from external content Gemini processed, which this
// policy has no way to independently verify -- the command name alone (even something
// as mundane as `cat`) tells you nothing about whether that value is safe.

const UNTRUSTED_MARKERS = [
  'CRITICAL SECURITY WARNING',
  'Untrusted Command Flags Detected',
  'sourced from untrusted input'
];

// Broad, Claude-Code-like "read-only, side-effect-free" categories. Matched against
// the command's leading verb/cmdlet, not the full text, so flags/arguments don't need
// to be enumerated -- but DANGEROUS_PATTERNS below still runs first as a hard veto.
const SAFE_CATEGORIES = [
  { name: 'fs-read-only', test: (cmd) => /^(Get-ChildItem|Get-Content|Get-Item|Get-Location|ls|dir|cat|head|tail|find|tree|pwd|wc|stat)\b/i.test(cmd) },
  { name: 'git-read-only', test: (cmd) => /^git\s+(status|log|diff|show|branch|remote(\s+-v)?|rev-parse|blame|describe)\b/i.test(cmd) },
  { name: 'process-inspect', test: (cmd) => /^(Get-Process|tasklist|ps)\b/i.test(cmd) },
  { name: 'echo-noop', test: (cmd) => /^(echo|Write-Output|Write-Host)\b/i.test(cmd) },
  { name: 'npm-read-only', test: (cmd) => /^npm\s+(list|ls|view|outdated|audit(\s+--dry-run)?)\b/i.test(cmd) }
];

// Hard veto, checked before categories: never auto-approve regardless of category
// match. Defense-in-depth in case a read-only-looking command is chained with
// something destructive.
const DANGEROUS_PATTERNS = [
  /\brm\s+-rf\b/i,
  /\bdel\s+\/[sf]/i,
  /Remove-Item/i,
  /\bformat\b/i,
  /\bshutdown\b/i,
  /\bnetsh\b/i,
  /\b(curl|wget|Invoke-WebRequest|Invoke-RestMethod)\b/i,
  /\bsudo\b/i,
  /reg\s+add|reg\s+delete/i,
  /[|;&]/, // command chaining/piping: refuse to reason about compound commands
  />/ // any output redirection -- treat as a write even on a "read-only" verb
];

function containsUntrustedMarker(promptText) {
  const lower = promptText.toLowerCase();
  return UNTRUSTED_MARKERS.some((m) => lower.includes(m.toLowerCase()));
}

function isApprovalPrompt(promptText) {
  return /Allow execution of/i.test(promptText) && /Allow once/i.test(promptText);
}

// Gemini's prompt renders the requested command in a box above the Yes/No menu, e.g.
// "Shell  Get-ChildItem -Path "...""; this is a best-effort extraction, not a parser --
// if it can't confidently find the command, evaluate() escalates rather than guessing.
function extractRequestedCommand(promptText) {
  const match = promptText.match(/Shell\s{1,4}(.+)/i);
  return match ? match[1].trim() : null;
}

/**
 * @param {string} promptText - a quiet-output snapshot of the Gemini terminal's raw
 *   PTY output (may include ANSI escape sequences).
 * @returns {{isPrompt: boolean, decision?: 'AUTO_APPROVE'|'ESCALATE', reason?: string, command?: string}}
 */
export function evaluate(promptText) {
  if (!isApprovalPrompt(promptText)) {
    return { isPrompt: false };
  }

  if (containsUntrustedMarker(promptText)) {
    return { isPrompt: true, decision: 'ESCALATE', reason: 'untrusted-input-marker' };
  }

  const command = extractRequestedCommand(promptText);
  if (!command) {
    return { isPrompt: true, decision: 'ESCALATE', reason: 'command-not-parsed' };
  }

  if (DANGEROUS_PATTERNS.some((p) => p.test(command))) {
    return { isPrompt: true, decision: 'ESCALATE', reason: 'matches-dangerous-pattern', command };
  }

  const matched = SAFE_CATEGORIES.find((c) => c.test(command.trim()));
  if (matched) {
    return { isPrompt: true, decision: 'AUTO_APPROVE', reason: matched.name, command };
  }

  return { isPrompt: true, decision: 'ESCALATE', reason: 'no-safe-category-match', command };
}
