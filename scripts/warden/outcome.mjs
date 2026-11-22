// What a result means, and what follows from it without a person. Every failed step gets one class:
//
//   violation   a repository rule is broken                               the author fixes; never replayed
//   defect      a check that ran fails with the branch, not without it     the author fixes
//   conflict    the branch does not stack on the main branch               the author rebases; with a sibling, it waits
//   transient   the failure comes from the workstation, not from the code  replayed once
//   incomplete  a check asked for could not run                            never counted as passed
//   baseline    the main branch fails on its own                           the train halts until something changes
//
// The contract stays Git and exit codes: 1 for a gap, EXIT_INCOMPLETE when everything that ran passed but something
// asked for did not run, EXIT_HALTED when the train waits on a condition and blamed nobody.

export const EXIT_INCOMPLETE = 3;
// EX_TEMPFAIL: try again later.
export const EXIT_HALTED = 75;

// Workstation incidents, as real trains met them: memory exhausted (os error 1455, LNK1102, 19 November), a file held
// by another process, a full disk, a network that drops. Kept short on purpose; a project adds its own in
// `verify.transient_patterns`. A pattern is read line by line.
export const TRANSIENT_PATTERNS = [
  /os error (1455|12|28|32|112)\b/i,
  /\bLNK1102\b|\bC1060\b/,
  /memory allocation of \d+ bytes failed/i,
  /JavaScript heap out of memory/i,
  /\b(ENOMEM|ENOSPC|EBUSY)\b/,
  /No space left on device/i,
  /being used by another process/i,
  /\b(ECONNRESET|ETIMEDOUT|EAI_AGAIN|ERR_SOCKET_TIMEOUT)\b/,
  /Could not resolve host|spurious network error/i,
];

// Windows ends a process out of memory with an NTSTATUS code: STATUS_NO_MEMORY, STATUS_COMMITMENT_LIMIT.
const TRANSIENT_EXITS = new Set([0xc0000017, 0xc000012d]);

// A tool that is not on the workstation says so in its first words: Cargo for a missing subcommand, the shells for a
// missing program. Only the first line is read: a test that prints these words later is not a missing tool.
const MISSING_PATTERNS = [
  /^error: no such command: /i,
  /is not recognized as an internal or external command/i,
  /: command not found$/,
  /^spawn \S+ ENOENT$/,
];

const asPattern = (p) => (p instanceof RegExp ? p : new RegExp(p, 'i'));

// The incident behind a failure, or null: a signal, a Windows memory exit code, or a line matching a pattern.
// `result`: `{ status, signal, text }` as a step returns it.
export function transientCause(result, extra = []) {
  if (result.signal) return `signal ${result.signal}`;
  if (Number.isInteger(result.status) && TRANSIENT_EXITS.has(result.status >>> 0)) return `exit 0x${(result.status >>> 0).toString(16)}`;
  const patterns = [...TRANSIENT_PATTERNS, ...extra.map(asPattern)];
  const line = (result.text ?? '').split(/\r?\n/).find((l) => patterns.some((p) => p.test(l)));
  return line ? cut(line.trim()) : null;
}

// Whether the program asked for could not run at all.
export function missingTool(result) {
  if (result.missing) return true;
  const first = (result.text ?? '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? '';
  return MISSING_PATTERNS.some((p) => p.test(first));
}

// The class of a failed step. `kind`: `rules` for the repository rules, anything else for a check.
export function failureClass(kind, result, extra = []) {
  if (kind === 'rules' && !result.signal) return 'violation';
  if (transientCause(result, extra)) return 'transient';
  if (missingTool(result)) return 'incomplete';
  return 'defect';
}

const cut = (l) => (l.length > 200 ? `${l.slice(0, 197)}...` : l);

// What a failed step says first, so that its author knows what to fix without the log: a compiler error, a rule
// finding, a failed test, with the summary line of a Warden step when there is one (the cause used to be one generic
// sentence, 21 November). Each part is cut to 200 characters.
export function firstError(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const summary = lines.findLast((l) => l.startsWith('✖'));
  const specific = lines.find((l) => /^error(\[\w+\])?:/.test(l) && !/^error: (test failed|could not compile|aborting)/.test(l))
    ?? lines.find((l) => /^\[[a-z][\w-]*\] \S+: /.test(l))
    ?? lines.find((l) => /^test \S+ \.\.\. FAILED$/.test(l))
    ?? lines.find((l) => /^✖ (?!failing tests:)/.test(l) && l !== summary)
    ?? lines.find((l) => /^not ok \d/.test(l));
  const parts = [summary, specific].filter(Boolean).map(cut);
  return parts.length ? parts.join(' — ') : cut(lines.at(-1) ?? '');
}

// What the author does next, read without interpreting a sentence.
export const NEXT = { violation: 'fix_and_redock', defect: 'fix_and_redock', conflict: 'rebase_and_redock' };

// A structured refusal: the class, the step, the rule and the paths when a rule is broken, the first error, the log,
// the refused commit and the base it was verified on, the train, and what to do next. The refused deposit leaves again
// on its own once it names another commit.
export function refusal({ cls, step = null, text = '', error = null, files = null, log = null, commit = null, base = null, train = null, at = new Date().toISOString() }) {
  const findings = [...text.matchAll(/^\s*\[([a-z][\w-]*)\] (\S+?): /gm)];
  return {
    class: cls,
    step,
    rule: findings[0]?.[1] ?? null,
    files: files ?? [...new Set(findings.map((m) => m[2]))].slice(0, 20),
    first_error: error,
    log,
    commit,
    base,
    train,
    at,
    next: NEXT[cls] ?? 'fix_and_redock',
  };
}
