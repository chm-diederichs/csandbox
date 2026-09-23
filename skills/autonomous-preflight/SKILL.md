---
name: autonomous-preflight
description: Checklist to run BEFORE starting an autonomous run - a long unattended task, a worktree fan-out, a retry loop, or picking a task off a queue. Produces a short preflight block (goal, done-criterion, boundary, verification, settled clarifications) and refuses to launch a loop that will misfire. Use when about to work unattended for more than a few steps, or when briefing subagents. Do not use for a single interactive edit the user is watching.
---

# Autonomous preflight

An unattended agent has no one to catch it mid-run. Every failure mode below
was observed, not imagined, and each has a cheap antibody that must be in place
*before* the run starts - clarifying "at runtime" never happens: the agent does
not ask, it runs the wrong answer to the end.

## 1. Should this be a loop at all?

Run a loop (retry-until-green, watch-and-fix, batch over many items) only if
**all four** hold. Missing any one, do the work once by hand and stop.

- The step repeats (many items, or the same check over and over).
- Verification can be **automated** - a command with an exit code, a diff
  against a reference, a count that must reach zero. Not "looks right".
- There is a token/time budget and a hard iteration cap.
- The agent has tools that actually run the thing and *see the result* -
  not a description of the result.

## 2. Write the goal so a machine can judge it

1. **Decidable exit.** "All tests in test/replicate.js pass and no test was
   deleted or skipped" - not "make replication solid".
2. **Reconciliation over assertion.** Prefer checks that compare against a
   reference (fixture diff, byte-equality, a count) over checks the agent can
   satisfy by loosening: "all tests pass" is gamed by editing asserts,
   swallowing exceptions, or deleting tests; "output equals fixture" is not.
3. **Done-criterion + boundary, always together.** The boundary says what
   must NOT change: test files, lint/config files, public API signatures,
   package.json deps, files outside the named directory. A done-criterion
   without a boundary is the Goodhart trap.
4. **Front-load every clarification.** List each ambiguity and settle it now
   with a stated assumption. Anything left as "ask if unclear" will be decided
   silently mid-run.
5. **Fresh inputs.** Name the docs/findings the run relies on and check they
   are current (`findings recall` first; a ⚠ verify flag means re-check).

## 3. Plan / build / judge stay separate

- The judge is not the builder. Verification is a command or a fresh
  reviewer subagent, never the same context re-reading its own diff.
- The judge is deterministic where possible; an LLM judge gets a fixed rubric
  and the same inputs every round.
- The builder may not edit the acceptance conditions (tests, fixtures,
  thresholds). If they are wrong, stop and report - do not adjust and continue.

## 4. Five ways loops misfire - a hit on any row means redesign

| # | Failure | Review question (a hit = red) | Antibody |
|---|---|---|---|
| 1 | Goal is a platitude → spins, burns budget | Can the exit be judged yes/no by a command? | Decidable result condition (§2.1) |
| 2 | "Verify" = "check it looks ok" → agent says fine and stops | Is the judge the defendant? | Reconcile + exit codes + independent judge (§3) |
| 3 | Gates only on "tests pass" → agent deletes or weakens tests | Is there a boundary, or only a done-criterion? | Done-criterion **+ boundary** (§2.3) |
| 4 | Counts on asking mid-run → it won't, it finishes the wrong thing | Any "clarify at runtime" point left? | Settle it now (§2.4) |
| 5 | Stale CLAUDE.md / findings → faster loop, more errors | Are the inputs current? Who maintains them? | Recall + verify flags (§2.5) |

## 5. Red lines - never automated

- **Authority does not transfer.** No push, no PR merge, no publish, no
  deleting branches, no spending - the loop proposes, a human flips "done".
- **Irreversible outside the worktree.** Anything not undone by discarding
  the worktree branch needs the user, not a retry loop.
- **Self-modifying loops need stricter review, not looser.** A loop that
  rewrites its own rules/prompts/config is reviewed before it acts, every time.

## Output: the preflight block

Write this before the first action (in the worktree or the scratch dir), and
put it at the top of every subagent brief:

```
GOAL:        <one sentence, what changes>
DONE WHEN:   <command(s) + expected result>
MUST NOT:    <files/APIs/deps/tests that stay untouched>
VERIFY BY:   <who/what judges - command, fixture diff, reviewer subagent>
ASSUMED:     <each ambiguity → the assumption taken>
BUDGET:      <max iterations / time; what happens at the cap: stop + report>
```

If a line cannot be filled, the run is not ready.
