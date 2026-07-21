# Review loop — design spec

Status: **design / in progress**. Companion to [`agent-contract.md`](./agent-contract.md)
(the session-output artifacts this loop consumes). Grounded against the as-built
recorder (in `csandbox`) and `csandbox-review/cli.js` (`csreview`).

## Purpose

A single diff → review → feedback loop, shared by **both** the human reviewer
and agents. The human's window is [diffx](https://github.com/wong2/diffx) (a diff
*renderer*); an agent reads `git diff` natively and doesn't need the rendering.
What's shared is not the UI but the **loop and its data**: take a worktree
branch, diff it against its fork base, emit structured comments, feed those
comments back to a fresh (ephemeral) agent continuing that branch.

The driving insight: the reviewe*r* role isn't human-only. The top-level agent
that fans out to subagents is the natural *first* reviewer of each subagent's
branch, and should use the same loop, writing to the same place a human would.

## Roles (reviewee vs reviewer) — resolves an apparent contradiction

`agent-contract.md` says "agent → reviewer feedback is summary-only, never
line-level." That is the **reviewee** rule and still holds: an agent reporting
*its own* work does so via the summary, not inline code comments.

The **reviewer** role is different and may be played by a human *or* an agent.
A reviewer emits line-anchored comments into the log below. So "an agent writes
line-level comments" is not a contract violation — it's the agent acting as
reviewer of *someone else's* (or a prior self's) branch. The two never cross:
reviewee → summary; reviewer → comment log.

## Unit of review: the branch (not the session)

Sessions are ephemeral and mint a **new** `session_id` on every resume turn
(`csreview resume` launches a fresh `csandbox --live <wt> -p …`). The **branch**
is the stable identity across turns. So:

- comments key on **`{repo, branch}`**, never on session id;
- the review UI must **group session rows by branch** (one branch accretes many
  session rows over its resume history);
- `{repo, branch}` — not `branch` alone — because `csbox-enter-repo` and `linker`
  both create a `worktree-<sid>` branch **in multiple repos**, so the branch name
  is only unique within a repo.

## Data model

Two stores, split by write-frequency and audience.

### `tasks.db` — session metadata (SQLite, host-side)

`~/.local/share/csandbox/tasks.db`, **outside** the bind mount (agent can't see
or mutate it). As-built `sessions` row:
`session_id, name, dir, branch, base_sha, head_sha, status, summary_path,
created_at, updated_at`. Deliberately lean. **Not** for comments.

Recorder derives, on exit, from the session's own `*.jsonl` transcript +
`worktrees.jsonl`: work branch (last branch ≠ base), `base_sha` (manifest
`fork_sha` preferred, else `merge-base`), `status` (`ready` if there's a diff,
else `summary_only`; `blocked` reserved for an unbuilt transcript scan). Plus
**`artifacts_dir`** (BUILT) — the session's scratch dir, the one pointer
`csreview` needs to reach that session's `worktrees.jsonl` + `comments.jsonl`.

**Subagent branches (RESOLVED, BUILT).** The recorder still writes only the
top-level session row, but `csreview` now reads that session's
`worktrees.jsonl` **live** and presents each worktree branch as an independently
reviewable node (with its `fork_sha` base + open-comment count). No `worktrees`
table — the manifest is the single source of truth. Chosen over a table to keep
SQL lean and avoid sync drift; fine at our scale (few sessions).

### Per-session scratch — append-only event logs

`scratch/sessions/<id>/` (host `~/.claude-sandbox/scratch/...`, container
`/home/node/scratch/...` — same files, both sides writable):

| file | env var | shape | writer |
|------|---------|-------|--------|
| `summary.md` | `$CSANDBOX_SUMMARY` | markdown | agent (reviewee) |
| `worktrees.jsonl` | `$CSANDBOX_MANIFEST` | `{path,branch,fork_sha,created_at}` | post-checkout hook |
| `snapshot.json` | `$CSANDBOX_SNAPSHOT` | `{repo:{branch,sha}}` frozen at spawn | launcher |
| **`comments.jsonl`** (NEW) | `$CSANDBOX_COMMENTS` (TBD) | event, below | human (diffx/csreview) + agent (skill) |

**One `comments.jsonl` per session.** A session's subagent-branch reviews append
to the *same* file (subagents inherit `CSANDBOX_SESSION_ID`, so they share the
scratch dir), distinguished by `{repo, branch}` — exactly as `worktrees.jsonl`
holds every worktree of the session in one file.

## `comments.jsonl` — an event log, not a comment table

Append-only means we never mutate a line; **state is folded from events** at read
time (event-sourced). Three event types:

```json
{"id":"a1b2","ts":1721200000,"type":"comment","repo":"/abs/repo","branch":"worktree-<sid>","path":"lib/foo.js","line":42,"context":"const x = go()","severity":"warn","body":"handle the reject","author":"human","in_reply_to":null}
{"ts":1721200500,"type":"resolved","id":"a1b2","by":"agent","note":"fixed in 9c1f"}
{"ts":1721200600,"type":"compiled","repo":"/abs/repo","branch":"worktree-<sid>","through_ts":1721200500}
```

- `type` defaults to `comment` if omitted. `id` is a short random tag on comments
  (so `resolved`/replies can reference them). `in_reply_to` threads replies
  (incl. an agent's "won't fix because…", which is legitimate reviewer↔reviewee
  line-level dialogue — distinct from the reviewee summary rule).
- `context`: a snippet of the commented line(s), so a resumed agent can relocate
  the comment after commits shift line numbers (line drift).
- `severity`: `blocker` | `warn` | `nit` | `note`. Whether `blocker` gates
  "done" is an open question.
- **A `comment` is *open* unless a later `resolved` event references its `id`.**
  The agent appends `resolved` when it addresses one; the human can re-open by
  posting a new comment.
- **`compiled` is the self-describing watermark.** When the compile step feeds a
  branch's open comments into a resume prompt, it appends a `compiled` marker.
  Next resume sends open comments with `ts > last compiled through_ts` (plus any
  re-opened). This lets the log record its own consumption — no external cursor.

### Why append-only jsonl, not SQL

`>> file` line-append is cheap and lets agents write heavily without touching the
metadata DB or growing its schema; writable from both host (diffx/csreview) and
container (agent) via the shared scratch mount; mirrors `worktrees.jsonl`. SQL
stays metadata; jsonl carries events (worktrees + comments).

**Atomicity caveat (must handle):** concurrent `O_APPEND` writes are only atomic
below `PIPE_BUF` (4096 B) on a local fs, and this file is bind-mounted with a
host writer and a container writer. Mitigation: (a) keep each event on one line
and bound `body`/`context` length; (b) serialize writes with an `flock` on a
sibling lockfile in the shared scratch; (c) a torn/unparseable line is skipped on
read (fold tolerates it). Decide (b) vs (a)-only. In practice host and container
rarely write the same instant, but we shouldn't rely on that.

## The loop

1. Agent works on a worktree branch, **commits**, writes `summary.md`.
2. A **reviewer** diffs the branch vs its `fork_sha` (from `worktrees.jsonl`) and
   appends `comment` events:
   - **human** — diffx/csreview, host-side;
   - **agent** — the `review` skill (self-review, or top-level reviewing a
     subagent branch), container-side.
3. On resume, the compile step folds the log, takes that branch's **open,
   un-compiled** comments, renders them into the prompt, appends a `compiled`
   marker, and launches a fresh ephemeral session on the branch's worktree.
4. Agent addresses them, appends `resolved` per comment, commits a new diff → 2.

## Session continuity: resume modes + catch-up (BUILT)

`csreview resume` implements this: `--warm`/`--cold` (default warm for the
session's own branch, forced cold for another/subagent branch), `-i` for the
interactive TUI, and a catch-up preamble on every resume. Verified by unit tests
+ dry-run; a *live* warm resume (`csandbox --resume`) is exercised end-to-end
once a real recorded session exists.

Two resume modes, both exposed by `csreview`; the split follows a *mechanical*
fact, not just taste:

- **cold (ephemeral).** A fresh session re-derives its state from the branch. The
  **only** option for a **subagent** branch — an `Agent(isolation:worktree)`
  subagent is a sub-invocation inside its parent session, so it has no standalone
  `csandbox` session/transcript to reload. Cheap, parallel-friendly.
- **warm.** `csandbox --resume <session-id>` reloads the session's own transcript,
  preserving its reasoning (plan, dead-ends, rationale). Only possible for a
  **top-level** (csandbox-launched) session, which has a transcript. **Default for
  top-level**; `--cold` forces a clean restart.

`-i/--interactive` is **orthogonal**: it selects the *claude terminal TUI* (you
drive the agent live) vs. headless `-p` (fire-and-forget). It is **not** diffx —
diffx is the human's *review* surface; `-i` is the *agent-chat* surface.
`csreview resume <id> --warm -i` is the "escape hatch": drop back into a live
terminal with the fully-contextful, caught-up agent.

**Why not lean on the warm transcript as the memory of record:** any long-lived
transcript hits (lossy) compaction and dies with its container. So durable memory
is **externalized** — the branch's commits, the summary, and comments — and warm
is a *convenience* (skip re-reading), not a crutch. Done right, cold ≈ warm.

### Catch-up (the staleness fix)

A resumed agent's view predates the current branch: while it was dormant, other
turns/subagents committed. **Every resume injects a catch-up preamble** computed
from the delta since the resuming session last exited.

- **Marker:** the session row's `head_sha` (its `last_seen_sha`) — the recorder
  writes it on *every* exit, and a warm resume reuses the same `session_id`, so
  the row updates each exit and the marker always tracks that session's latest
  exit. A fresh cold turn has no prior row → it catches up from the branch's
  `fork_sha` (the whole branch).
- **Substrate, in priority order:**
  1. **`git log --stat <last_seen>..HEAD`** (+ `-p` on demand) — the *primary*
     source. Commits are self-contained "what + why" (message = rationale), finer
     than session-level summaries. **Lean on this.**
  2. intervening **session summaries** on the branch (rows with `ts > updated_at`)
     — coarse backup, *summaries only*, never full transcripts.
  3. new **comments** (`comments.jsonl`, `ts > updated_at`) — feedback.
- Plus an explicit instruction: *"your cached view is stale as of `<last_seen>`;
  reconcile from the above before acting."*

This makes commit-message quality load-bearing (it is the catch-up substrate) —
reflected in the reviewee contract.

**Commit hygiene (option C — decided).** Verbose "why" in commit messages is fine
*on the worktree branch* — it's the WIP log and the catch-up substrate. It never
pollutes `main` because the human **squashes on land**. So: no commit-message
sidecar, no two-stage hook, no sha-keyed drift — the branch carries the context,
the squash cleans it. (Rejected alternatives: a per-commit sidecar log keyed by
sha — drifts under rebase/squash, though only gracefully; and title-only commits
+ relying on the session summary — loses per-commit granularity.)

### Concurrency invariant

**One active session per branch at a time.** Catch-up handles *temporal* overlap
(A exits → B resumes → B catches up on A's commits/comments). It does **not**
license *simultaneous* writers: git allows a branch in only one worktree, and two
agents on one checkout would clobber. Concurrent work = separate branches that
merge (the fan-out model), not two resumes of one branch. Open: enforce with a
lock, or leave as convention.

### Resolved by this design

which-transcript-to-warm-resume → the **original** (richest plan); catch-up
covers everything since. Fold intervening turns → **summaries only**.
`last_seen` marker → **`head_sha`** (sufficient). Default → **warm for top-level**.

## The `review` skill

Agent as an `author: agent` reviewer. **On-demand (a skill — progressive
disclosure), not CLAUDE.md** (which carries the always-on *reviewee* contract).
Given a branch/worktree:

1. resolve `fork_sha` (manifest `fork_sha` → `merge-base` fallback, matching the
   recorder), compute `git diff fork_sha..HEAD`;
2. evaluate against a rubric (correctness, scope creep vs the task, test
   coverage, secrets/leftover debug, obvious perf/regressions);
3. append `comment` events (with `context` snippets) for `{repo, branch}`.

**Highest-value use:** the top-level agent gating each subagent branch after a
fan-out, before results reach the human queue. This needs a *trigger*: the
"Parallel worktree subagents" `CLAUDE.md` section should instruct the top-level
agent to `review` each subagent branch before presenting.

## Changes required (by component)

**csandbox (launcher/hook) — BUILT:**
- `$CSANDBOX_COMMENTS` set per-session (like SUMMARY/MANIFEST) and exported into
  the container (inherited by subagents). *(Not set on a `--continue`/picker run
  with no id up front — same limitation as SUMMARY/MANIFEST.)*
- recorder: `artifacts_dir` column (+ migration) so `csreview` finds the log.
- *Not needed:* per-worktree recorder rows — `csreview` reads the manifest live.

**csandbox-review (`csreview`) — BUILT:**
- `csreview comment <id> [-b branch] [-f file -L line] [-s sev] -m …` → append a
  `comment` event (captures a `context` snippet from the file when `-f/-L` given);
- `compilePrompt` reads the branch's **undelivered** comments (folded from the
  log) + optional inline `-m`, and `resume` appends the `compiled` watermark;
- `open`/`resume`/`comment` take `-b/--branch` to target any worktree branch;
- `show` lists the session's worktree branches + open-comment counts; `list`
  gained a `CMT` (open comments) column;
- fold is keyed `{repo, branch}` (canonicalized repo), so same-named branches in
  different repos don't merge.

**diffx bridge — BUILT.** `diffx-cli` is a PR-style web review tool with its own
comment store (REST API on `:3433`; comment shape
`{id, filePath, side, lineNumber, body, status:open|resolved, replies}`). Rather
than run two comment stores, `csreview` treats `comments.jsonl` as canonical and
bridges diffx into it:
- `csreview review <id> [-b branch]` spawns `diffx --no-open` on the branch's
  diff (prints the URL so you can open it anywhere — e.g. a phone), waits, then
  pulls `/api/comments` and imports them as `author: human` events on Enter.
- import is idempotent (each event carries `src:"diffx"` + `src_id`); a diffx
  comment already `resolved` lands closed here too; `side`/`context` preserved.
- `csreview import-diffx <id>` imports a diffx JSON array from stdin (the
  testable core; also for piping a saved "Copy comments" export).

The full human loop is now wired: `review`/`comment` → `comments.jsonl` →
`resume` compiles → agent. diffx is the human's rich UI; the log is canonical.

**Still to build — the agent as reviewer:**
- the **`review` skill** (`author: agent` writer into the same log) — the
  human-side loop + storage is done; the agent-writes-comments side is not;
- **CLAUDE.md**: fan-out review trigger + an `author: agent` self-label note;
- an **agent-side append path** to `$CSANDBOX_COMMENTS` (container) matching
  csreview's canonical `{repo, branch}` keying + single-line append.

## Trust, visibility, retention

- **`author` is advisory, not a trust boundary.** `comments.jsonl` is in scratch
  (agent-visible, unlike `tasks.db`) — intended, since comments are *for* the
  agent. But a sandboxed agent can write `author:"human"`. In the autonomous
  threat model this is low-stakes (the agent already controls its own branch),
  but human-comment authenticity is **not** guaranteed. Non-goal to secure it.
- **Retention:** `scratch/sessions/<id>/` grows one dir per session
  (summary/manifest/snapshot/comments) and is never GC'd today — pre-existing,
  now with one more file. Needs a prune policy (age- or count-based).

## Decisions (recommended) vs open questions

**Decided & built:**
- comments in per-session append-only `comments.jsonl`, keyed `{repo, branch}`;
- event-sourced open/resolved/compiled model; `compiled` marker as watermark;
- SQL = metadata, jsonl = events; the branch is the review unit; reviewer vs
  reviewee role split;
- **subagent-tree shape:** read the manifest live in `csreview` (no table);
- **append serialization:** single-line JSON append (bounded-line mitigation).
  `flock` deferred until the agent writes concurrently with the host.

**Decided & built (Session continuity, above):**
- two resume modes: **cold** (forced for subagents) / **warm** (default for
  top-level, `--cold` to override); `-i` interactive is orthogonal;
- **catch-up** on every resume, primary substrate `git log <head_sha>..HEAD`,
  then intervening summaries; marker = `head_sha`;
- **commit hygiene = option C** (verbose on branch, squashed on land — no sidecar);
- externalize durable memory (commits + summary + comments), warm = convenience;
- invariant: one active session per branch (temporal overlap only), by convention.

**Open (need a call):**
- enforce the one-active-session-per-branch invariant with a lock, or convention;
- `blocker` severity gating "done" or purely advisory;
- line-anchoring: is the `context` snippet enough, or anchor comments to a
  blob/sha (survives line drift more robustly);
- `$CSANDBOX_COMMENTS` on a `--continue`/picker run with no id up front (shares
  the SUMMARY/MANIFEST no-per-session-path gap);
- scratch retention/prune policy (now one more file per session).

## Web app (BUILT — `csreview serve`)

A zero-build local web app (node `http` + a self-contained page; shared core
extracted to `csandbox-review/lib.js`, used by both the CLI and the server):

- **Session tree** — sessions grouped under their root repo (collapsible), each
  showing its worktree branches (subagent tree), read live from the tasks db +
  `worktrees.jsonl`, with open-comment counts.
- **Review** — click a diff line to add a comment (note/nit/warn/blocker);
  open comments render inline. Writes the same `comments.jsonl` as the CLI/diffx,
  so `resume` compiles them like any other. In-app commenting means diffx is
  optional, not required, for the human review path.
- **Land (squash-merge)** — the *land* PR, distinct from the *review* loop: show
  a branch's diff, edit a GitHub-style default message (session name + bulleted
  commit subjects), `git merge --squash` onto the main worktree's current branch,
  then **destroy the session** (worktrees + branches + scratch + db row; work is
  preserved in the squash commit). Non-interactive: refuses a dirty *tracked*
  tree, and on conflict backs the half-merge out and hands off to the terminal.

Deferred (design §UI): embedded terminal / live spawn, live tree updates (SSE),
in-app conflict resolution.

## Adjacent systems (built, separate)

- **Snapshot isolation** (`snapshot.json`, `csbox-enter-repo`) — freezes repo
  states at spawn.
- **linker** — declarative local-dep linking; wires `node_modules` to sha-pinned
  worktrees per-worktree via the post-checkout hook.

Independent of the review loop but share the per-session scratch and
worktree-branch conventions (and the `{repo, branch}` cross-repo ambiguity).
