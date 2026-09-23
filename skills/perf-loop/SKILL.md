---
name: perf-loop
description: Bounded measure → variant → promote loop for making a hot path faster without breaking it. Fixes the correctness gate, metric, baseline and budget before any variant; one hypothesis per variant; promotes only on a re-measured delta above noise. Use when asked to speed something up, reduce allocations, cut latency, or compare implementations. Do not use without a runnable correctness gate (the repo's tests for that path).
---

# Perf loop

Optimization without a fixed gate turns into "it feels faster and the tests
mostly pass". Everything below exists to stop that.

## 0. Baseline - required before the first variant

```
OPERATION:   <the exact function / path, e.g. Core.append batch of 1k blocks>
GATE:        <command that must stay green, e.g. node test/core.js && node test/replicate.js>
METRIC:      <what + how: ops/s via bench/append.js, median of 5 runs, N=10k>
BASELINE:    <the number, with the run-to-run spread>
NOISE:       <spread across 5 identical baseline runs - deltas inside this are nothing>
BUDGET:      <max variants, max wall time; at the cap: report best so far, stop>
```

If there is no benchmark script, write one first (in `bench/`, not `test/`),
run it five times, and record the spread as NOISE. If the gate is not green
at baseline, stop - fix that first, on its own commit.

## 1. The loop

For each variant:

1. **One hypothesis.** "Avoid the intermediate Buffer.concat" - not "clean up
   the write path". Two changes in one variant cannot be attributed.
2. Implement on its own branch or stash; keep the diff minimal.
3. Run the **gate**. Red → discard the variant, note why in the ledger.
4. Measure: same script, same N, median of the same number of runs as the
   baseline.
5. Compare against the **prior accepted winner**, not the previous attempt.
6. Accept only if the delta exceeds NOISE. Inside noise = no change, discard.
7. Re-run baseline *and* winner back to back once before promoting - drift in
   the machine's state is the usual source of phantom wins.

Stop when: the budget is spent, two consecutive variants land inside noise,
or the gate keeps going red for the remaining hypotheses.

## 2. Ledger - record every variant, kept or not

A parallel session (or you, after compaction) must not re-test the same idea.
Record each as a findings observation on the files touched:

```
findings record --kind observation --area perf --file lib/core.js \
  --claim "<hypothesis>: <+12% / no change / gate red>, <metric> <before>→<after> (noise ±<n>)" \
  --report "<what changed, why it did/didn't help, the numbers>"
```

`findings recall perf <operation>` at the start of the loop shows what was
already tried.

## 3. Promotion gate

Promote a variant into the branch only when all hold:

- Gate green on the promoted state (run it again, whole suite for the repo).
- Delta re-measured after re-basing on the current branch.
- The diff is readable without the benchmark - a reviewer can see *why* it is
  faster. If it is faster for a reason you cannot name, do not promote it.
- No new dependency, no widened public API, no changed on-disk or wire format
  (those are separate decisions, recorded as such).

## Report

End with the table, not an adjective:

```
| variant | hypothesis | gate | metric | delta vs winner | kept |
|---------|------------|------|--------|-----------------|------|
BASELINE ... NOISE ... FINAL ... (re-measured back-to-back)
```
