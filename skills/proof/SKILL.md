---
name: proof
description: Says whether work is done, an executed proof in hand, or NOT DONE with what remains unproven. Use it before announcing that a task, a batch or a fix is finished, before docking a branch or delivering, and whenever you report a result. French triggers include « c'est fini ? », « preuve » and « rends compte ».
---

# Say the proof

Work is done when an executed proof shows it. While a gap stays open, it is **NOT DONE**. Reply in the person's language (in French: **PAS FINI**).

## The rule

- A successful command proves only what it checks. Green tests on a partial scope do not prove the journey.
- No simulated success: no test that skips what it should play, no threshold set to pass, no guessed result.
- Say first what is not proven, then what is.

## The report

1. **Not proven**: what did not run, what ran on a copy or a fake, what depends on a workstation setting you did not see. One line each.
2. **Proven**: each proof with the exact command or journey that played it, and its result ("101 guards pass", "push refused by the Project tests step").
3. **Verdict**: done, or **NOT DONE** with what remains.

## What counts as proof

- A guard that was executed, with its output read.
- A journey played in the real application, on a copy of its data, with a real provider. It stops on a gap, and its report is always written.
- A push verified by the hook, or a train that went up.

These do not count: a compilation alone for a behaviour, a test that only passes on someone else's machine, a "should work".
