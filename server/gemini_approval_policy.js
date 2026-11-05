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
//
// File-edit prompts ("Apply this change?") are a separate, narrower case: they are
// auto-approved only when the target file is one Claude itself listed in
// `expectedFiles` on a task it delegated to Gemini -- a task a human already approved
// through the workbench's own "Task Delegation Approval Required" modal before it ever
// reached Gemini's inbox. This is not a live judgment on the diff's content (which
// could itself contain adversarial text), just recognizing that the human's approval
// of that task already covers writes within its declared file list.

const UNTRUSTED_MARKERS = [
  'CRITICAL SECURITY WARNING',
  'Untrusted Command Flags Detected',
  'sourced from untrusted input'
];

// Gemini's prompt is a raw PTY snapshot, so it carries ANSI color/cursor-movement
// escape sequences (e.g. "\u001b[38;2;255;255;255m", "\u001b[121X"). Those sequences
// use ';' as a parameter separator and letters as final bytes, so left unstripped they
// corrupt both command extraction (trailing escape bytes get appended to the "command")
// and the chaining/piping veto below (a color code's embedded ';' falsely reads as
// command chaining). Stripped once, at the top of evaluate(), before anything else runs.
function stripAnsi(text) {
  return String(text).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

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
  />/ // any output redirection -- treat as a write even on a "read-only" verb
];

// A single PowerShell "call operator" invocation of a quoted path, e.g.
// & 'C:\Program Files\Git\bin\git.exe' status -- this is how PowerShell invokes an
// executable whose path contains spaces, not command chaining. Only this one leading
// occurrence is stripped before the chaining/piping check below; any further &, ;, or |
// left in the command still vetoes it as a compound command refused rather than reasoned
// about.
function stripLeadingCallOperator(cmd) {
  const match = cmd.match(/^&\s*(?:'[^']*'|"[^"]*")/);
  return match ? cmd.slice(match[0].length) : cmd;
}

function hasChainingOrPiping(cmd) {
  return /[|;&]/.test(stripLeadingCallOperator(cmd));
}

function containsUntrustedMarker(promptText) {
  const lower = promptText.toLowerCase();
  return UNTRUSTED_MARKERS.some((m) => lower.includes(m.toLowerCase()));
}

// File types never auto-approved for edit even if listed in a task's expectedFiles --
// defense-in-depth against a delegated task's own expectedFiles list being used to
// smuggle through a change to something security/CI-relevant.
const SENSITIVE_FILE_PATTERNS = [
  /package(-lock)?\.json$/i,
  /\.env(\..+)?$/i,
  /^\.github\/workflows\//i,
  /(^|\/)dockerfile$/i,
  /\.ya?ml$/i
];

function isShellApprovalPrompt(promptText) {
  return /Allow execution of/i.test(promptText) && /Allow once/i.test(promptText);
}

function isEditApprovalPrompt(promptText) {
  return /Apply this change\?/i.test(promptText);
}

function isSkillActivationPrompt(promptText) {
  return /Activate Skill/i.test(promptText) && /Do you want to proceed\?/i.test(promptText);
}

// Gemini's prompt renders the requested command in a box above the Yes/No menu, e.g.
// "Shell  Get-ChildItem -Path "...""; this is a best-effort extraction, not a parser --
// if it can't confidently find the command, evaluate() escalates rather than guessing.
function extractRequestedCommand(promptText) {
  const match = promptText.match(/Shell\s{1,4}(.+)/i);
  return match ? match[1].trim() : null;
}

// Edit confirmations print "Target: <fileName>" alongside the diff.
function extractEditTarget(promptText) {
  const match = promptText.match(/Target:\s*([^\n\r]+)/i);
  return match ? match[1].trim() : null;
}

function extractSkillName(promptText) {
  const match = promptText.match(/Activate Skill\s+"([^"]+)"/i);
  return match ? match[1].trim() : null;
}

function normalizeForCompare(p) {
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

function fileMatchesExpected(fileName, expectedFiles) {
  if (!fileName || !Array.isArray(expectedFiles) || expectedFiles.length === 0) return null;
  const norm = normalizeForCompare(fileName);
  return expectedFiles.find((ef) => {
    const efNorm = normalizeForCompare(ef);
    return norm === efNorm || norm.endsWith('/' + efNorm) || efNorm.endsWith('/' + norm);
  }) || null;
}

// sleepMode is the user-controlled "Sleep Mode" toggle (see server.js / the workbench
// header button): an opt-in, explicitly logged widening of shell auto-approval for
// unattended stretches (e.g. overnight). It only widens the SAFE_CATEGORIES allowlist
// below -- the untrusted-input-marker check and DANGEROUS_PATTERNS veto above are NOT
// affected by it and stay in force unconditionally. It never applies to edit or skill
// prompts, only shell execution prompts.
function evaluateShellPrompt(promptText, sleepMode = false) {
  if (containsUntrustedMarker(promptText)) {
    return { isPrompt: true, decision: 'ESCALATE', reason: 'untrusted-input-marker' };
  }

  const command = extractRequestedCommand(promptText);
  if (!command) {
    return { isPrompt: true, decision: 'ESCALATE', reason: 'command-not-parsed' };
  }

  if (hasChainingOrPiping(command) || DANGEROUS_PATTERNS.some((p) => p.test(command))) {
    return { isPrompt: true, decision: 'ESCALATE', reason: 'matches-dangerous-pattern', command };
  }

  const matched = SAFE_CATEGORIES.find((c) => c.test(command.trim()));
  if (matched) {
    return { isPrompt: true, decision: 'AUTO_APPROVE', reason: matched.name, command };
  }

  if (sleepMode) {
    return { isPrompt: true, decision: 'AUTO_APPROVE', reason: 'sleep-mode-all-shell', command };
  }

  return { isPrompt: true, decision: 'ESCALATE', reason: 'no-safe-category-match', command };
}

function evaluateEditPrompt(promptText, context) {
  if (containsUntrustedMarker(promptText)) {
    return { isPrompt: true, decision: 'ESCALATE', reason: 'untrusted-input-marker' };
  }

  const fileName = extractEditTarget(promptText);
  if (!fileName) {
    return { isPrompt: true, decision: 'ESCALATE', reason: 'edit-target-not-parsed' };
  }

  if (SENSITIVE_FILE_PATTERNS.some((p) => p.test(fileName))) {
    return { isPrompt: true, decision: 'ESCALATE', reason: 'sensitive-file', command: fileName };
  }

  const claimedTasks = (context && context.claimedClaudeDelegatedTasks) || [];
  for (const task of claimedTasks) {
    const matchedEntry = fileMatchesExpected(fileName, task.expectedFiles);
    if (matchedEntry) {
      return {
        isPrompt: true,
        decision: 'AUTO_APPROVE',
        reason: `claude-delegated-task:${task.correlationId}`,
        command: fileName
      };
    }
  }

  return { isPrompt: true, decision: 'ESCALATE', reason: 'no-matching-claude-delegated-task', command: fileName };
}

function evaluateSkillActivationPrompt(promptText) {
  if (containsUntrustedMarker(promptText)) {
    return { isPrompt: true, decision: 'ESCALATE', reason: 'untrusted-input-marker' };
  }

  // Activating a skill means reading a file the user already installed on disk
  // themselves (e.g. C:\Users\<user>\.agents\skills\<name>\SKILL.md) -- a local read,
  // not a shell execution or a write -- so it's auto-approved categorically, the same
  // way Claude Code itself doesn't ask per-use before loading a locally installed
  // skill. Always answers "1. Allow once" (least standing privilege) rather than
  // "Allow for this session", so each activation is re-evaluated fresh.
  const skillName = extractSkillName(promptText);
  return { isPrompt: true, decision: 'AUTO_APPROVE', reason: 'skill-activation', command: skillName };
}

/**
 * @param {string} promptText - a quiet-output snapshot of the Gemini terminal's raw
 *   PTY output (may include ANSI escape sequences).
 * @param {{claimedClaudeDelegatedTasks?: Array<{correlationId: string, expectedFiles: string[]}>, sleepMode?: boolean}} [context]
 *   - claimedClaudeDelegatedTasks: currently CLAIMED/RUNNING tasks where fromAgent === 'claude'
 *     and toAgent === 'gemini', used only to scope edit-prompt auto-approval to files Claude
 *     already declared.
 *   - sleepMode: user-controlled toggle that widens shell-prompt auto-approval beyond
 *     SAFE_CATEGORIES to any command that isn't dangerous/untrusted. Has no effect on edit
 *     or skill-activation prompts.
 * @returns {{isPrompt: boolean, decision?: 'AUTO_APPROVE'|'ESCALATE', reason?: string, command?: string}}
 */
export function evaluate(promptText, context = {}) {
  promptText = stripAnsi(promptText);
  if (isEditApprovalPrompt(promptText)) {
    return evaluateEditPrompt(promptText, context);
  }
  if (isShellApprovalPrompt(promptText)) {
    return evaluateShellPrompt(promptText, !!context.sleepMode);
  }
  if (isSkillActivationPrompt(promptText)) {
    return evaluateSkillActivationPrompt(promptText);
  }
  return { isPrompt: false };
}
