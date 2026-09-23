---
name: tdd-brittle
description: Test-first workflow for brittle-based Node repos with a strict RED gate - the failing test must actually run and fail for the intended reason before any production code changes. Use when fixing a bug, adding behavior, or when asked to "add a test for this". Do not use for pure refactors with no behavior change (there, keep the existing suite green and skip RED).
---

# TDD with brittle

The value of test-first is the RED gate, and the RED gate is where it is
usually faked: a test is *written* but not *run*, or it fails for a setup
reason and the failure is mistaken for the bug. Both make the later GREEN
meaningless.

## RED - a valid RED requires all of these

1. The test is **executed**: `node test/<file>.js` (whole file) or
   `npx brittle test/<file>.js -t "<name>"` for one test.
2. It **fails**, and the failure is the **intended one**: the assertion on the
   missing behavior, or the exception the bug throws. Quote the `not ok` line.
3. It does **not** fail for a different reason: syntax error, missing import,
   wrong fixture, a `t.plan` count off by one, a timeout from setup.
4. **Production code is untouched** until 1-3 hold.

A test that was only written is not RED. A test that fails in setup is not
RED. Fix the test until it fails *correctly*, then stop and commit it.

## GREEN

- Make the smallest production change that turns that test green.
- Run the **whole test file**, not just the one test - siblings share state
  through `t.teardown` and module-level fixtures.
- Timing-sensitive or replication tests: run **three times** before trusting
  green. A 2/3 pass is FLAKY, not GREEN (see test-triage if the repo has it).
- Quote the `# ok` summary line. Never report PASS for a command not run.

## Checkpoint commits

One commit per gate, so the branch reads as evidence:

```
test: <what the test pins down>            # after RED is confirmed
fix: <what changed> / feat: <behavior>     # after GREEN
refactor: <cleanup>                        # optional, suite still green
```

Do not squash them while the branch is under review; the RED commit is the
proof the test can fail.

## brittle specifics

- `t.plan(n)` when the test has async callbacks - an early exit then fails
  instead of passing silently.
- `t.teardown(() => core.close())` for every core/store/stream opened; a test
  that leaks handles hangs the file, and the hang looks like a timeout.
- `await t.exception(fn, /message/)` for expected throws; `t.alike` for deep
  equality, `t.is` for identity. Prefer asserting on data (`t.alike(await
  core.get(0), expected)`) over asserting "did not throw".
- Use real in-memory instances (`RAM` / `corestore` with RAM storage), not
  mocks - the bugs live in the real interaction.
- Timeouts: `test('x', { timeout: 60000 }, ...)` for replication; do not
  paper over a hang with a longer timeout without knowing why it hangs.

## Report

```
RED:   node test/foo.js -> not ok 3 - <name> (<assertion>)   [commit abc123]
GREEN: node test/foo.js -> # ok (12 passing) x3            [commit def456]
```
