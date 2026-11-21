import assert from 'node:assert/strict';
import { test } from 'node:test';

import { failureClass, missingTool, refusal, transientCause } from './outcome.mjs';

const failed = (text, extra = {}) => ({ status: 1, signal: null, missing: false, text, ...extra });

test('an incident of the workstation is read from what real trains printed', () => {
  assert.match(transientCause(failed('error: could not compile `engine`\nThe paging file is too small for this operation to complete. (os error 1455)\n')), /os error 1455/);
  assert.match(transientCause(failed('LINK : fatal error LNK1102: out of memory\n')), /LNK1102/);
  assert.match(transientCause(failed("Error: EBUSY: resource busy or locked, rename 'a' -> 'b'\n")), /EBUSY/);
  assert.match(transientCause(failed('npm ERR! network ECONNRESET\n')), /ECONNRESET/);
  assert.equal(transientCause({ status: null, signal: 'SIGKILL', text: '' }), 'signal SIGKILL', 'a killed process');
  assert.equal(transientCause({ status: 0xc0000017, signal: null, text: '' }), 'exit 0xc0000017', 'Windows out of memory');
  assert.equal(transientCause(failed('test a ... FAILED\nassertion failed: left == right\n')), null, 'a failed test is not an incident');
  assert.match(transientCause(failed('the device is not ready\n'), ['device is not ready']), /device is not ready/, 'a project adds its own');
});

test('a missing tool is read from the first line only', () => {
  assert.equal(missingTool(failed("error: no such command: `deny`\n\n\tView all installed commands with `cargo --list`\n")), true);
  assert.equal(missingTool(failed("'pnpm' is not recognized as an internal or external command,\n")), true);
  assert.equal(missingTool({ status: null, missing: true, text: '' }), true, 'the program could not start');
  assert.equal(missingTool(failed('running 3 tests\nsh: 1: frobnicate: command not found\n')), false, 'a test that prints these words later is not a missing tool');
});

test('each failure gets its class', () => {
  assert.equal(failureClass('rules', failed('  [lines] a.rs: 701 lines for 700 at most\n')), 'violation');
  assert.equal(failureClass('check', failed('(os error 1455)\n')), 'transient');
  assert.equal(failureClass('check', failed('error: no such command: `deny`\n')), 'incomplete');
  assert.equal(failureClass('check', failed('test a ... FAILED\n')), 'defect');
});

test('a refusal names its rule, its paths, and what to do next', () => {
  const r = refusal({ cls: 'violation', step: 'Rules', text: 'Rules: 2 finding(s)\n  [lines] crates/big.rs: 701 lines for 700 at most\n  [secret] web/a.mjs: machine path detected\n', error: '[lines] crates/big.rs: 701 lines', log: '/l.log', commit: 'abc1234def', base: 'f00', train: 't1' });
  assert.equal(r.class, 'violation');
  assert.equal(r.rule, 'lines');
  assert.deepEqual(r.files, ['crates/big.rs', 'web/a.mjs']);
  assert.equal(r.next, 'fix_and_redock');
  assert.equal(r.commit, 'abc1234def');
  assert.equal(refusal({ cls: 'conflict', files: ['a.rs'] }).next, 'rebase_and_redock');
  assert.deepEqual(refusal({ cls: 'conflict', files: ['a.rs'] }).files, ['a.rs']);
});
