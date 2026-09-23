---
name: strict-review
description: Brief for reviewing a diff or branch with zero manufactured findings - every finding must cite the line and name the concrete trigger (input, state) and bad outcome, or it is dropped. Use when reviewing your own or a subagent's branch before handing it over, or as the system brief for a read-only reviewer subagent. Do not use for style or formatting passes; this is correctness only.
---

# Strict review

The primary failure mode of an LLM reviewer is **manufactured findings**: nits,
"consider using X", hypothetical edge cases with no trigger, and severity
inflation. They cost the reader more than a missed bug because they bury the
real ones. A clean review with zero findings is a valid, expected outcome.

## The pre-report gate - all four, or drop the finding

1. **Exact line.** File and line. "Somewhere in the sync path" is not a finding.
2. **Concrete failure.** Name the input, the state, and the bad outcome.
   "If `length` is 0 here, `bitfield.get(-1)` throws and the replication
   stream is never destroyed." If you cannot name the trigger you are
   pattern-matching, not reviewing.
3. **Context read.** Callers, the surrounding function, the tests. Many
   apparent issues are handled one frame up, guarded by an invariant, or
   covered by a test that already exercises exactly this.
4. **Defensible severity.** HIGH means data loss, corruption, a hang, a crash
   on reachable input, or a security boundary crossed. A missing comment or an
   odd name is never HIGH. HIGH/CRITICAL findings need **proof**: a failing
   test you wrote and ran, or a step-by-step reproduction path through real
   code, quoted.

## Known false positives in this stack - check before flagging

- **Fire-and-forget promises.** `void x.ready()`, `x.update().catch(noop)`, or
  a comment saying detached: intentional. Flag only when the rejection is
  genuinely unobserved *and* the caller depends on the result.
- **Mutation in hot paths.** Buffers, bitfields, state machines and queues are
  mutated in place on purpose. "Prefer spread/immutability" is not a finding.
- **`Math.random()` for jitter / backoff / test keys.** Not a crypto use.
- **"Unused" exports.** Repos under the workspace consume each other. Grep
  the whole workspace (`grep -rn "name" ~/hyper --include=*.js -l`) before
  calling anything dead.
- **Missing `await` on `close()` in teardown.** Often deliberate in tests
  using `t.teardown`. Check whether the runner awaits teardowns.
- **Listener "leaks".** Persistent `'error'`/`'close'` listeners on
  long-lived sessions are the design; flag only listeners added per call and
  never removed.
- **Style, naming, function length, comment density.** Out of scope.

## Procedure

1. Read the diff once end to end. Note the *intent* (commit message, tests
   added). Findings that fight the intent go under "questions", not "bugs".
2. For each changed function: who calls it, what invariant does it maintain,
   which test covers the change. Read those.
3. Hunt the concrete classes: off-by-one at boundaries (`length`,
   `contiguousLength`, `fork`), state left inconsistent on an error path,
   promise rejections with no observer, races between `close()` and in-flight
   ops, resources not released on early return, error swallowed into a default.
4. Run the tests the diff touches (`node test/<file>.js`). Quote the output.
5. Apply the gate to every candidate. Drop what fails it.

## Output

```
VERDICT: APPROVE | APPROVE-WITH-NOTES | REQUEST-CHANGES

| file:line | severity | trigger (input / state) | outcome | fix |
|-----------|----------|-------------------------|---------|-----|

Questions (intent unclear, not bugs):
- ...

Verified: <commands run and their results>
```

Zero rows and `APPROVE` is a correct answer when the diff is right.

## As a subagent brief

Give the reviewer Read/Grep/Bash only and say so: "Do not edit files. Your
final message is the review." Pass the branch, the base, and the intent in one
line. Never review your own diff in the same context that wrote it - spawn a
fresh reviewer.
