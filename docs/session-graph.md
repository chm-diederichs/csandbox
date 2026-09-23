# Session graph — design

Status: **proposal; not built - and not being pursued for findings** (decided
2026-09-23: sessions are deliberately not a facet of a finding, see
`findings-memory.md` "Built"; the `tasks.db` recorder this cites has since been
removed from csandbox). Kept for the mechanism notes. Connects three currently-disconnected stores
- `findings.db`, `tasks.db`, and Claude Code's own per-session transcripts -
into one traversable graph, so "what did this session do" and "where did
this finding come from" are sparse lookups instead of full-file scans.

## Motivation

Two concrete problems in the current setup, both already observed rather
than hypothetical:

- **`tasks.db`'s real record is reconstructed, not recorded.** The row a
  session gets in `tasks.db` (branch, base_sha, status, summary path, ...) is
  built in a post-run block, *after* the sandbox exits, by parsing the
  entire transcript `.jsonl` for `gitBranch`/`cwd` transitions - an O(n) scan
  of every message, every time. Worse: this only runs on a clean exit. A
  hard crash leaves the row stuck at `status='running'` forever, with none of
  the branch/base_sha/summary detail ever recorded, because nothing durable
  is written *during* the session - only reconstructed after.
- **Findings, sessions, and transcripts don't reference each other.** A
  finding recorded mid-session has no link back to the message that
  established it; a session has no durable, incrementally-written list of
  what it touched. Reconstructing "what happened in session X" today means
  re-deriving it from the transcript by hand - exactly the archaeology this
  is meant to replace.

## Why this is a graph, and why that doesn't mean a graph database

The natural shape is a graph: **findings**, **transcript messages**, and
**sessions/tasks** as node types, with edges like `session --recorded-->
finding` and `finding --derived_from--> message`. But the relationships in
play are shallow - one or two hops (session→finding, finding→message), not
variable-length path queries or graph algorithms (centrality, shortest-path,
clustering). SQL's relational model - and `WITH RECURSIVE` if a multi-hop
query ever turns out to be needed - covers this without a new storage engine.

Concretely, staying on SQL avoids sacrificing properties this toolchain
already fought for: `findings.db` is a single mounted SQLite file precisely
so a write is instantly visible to concurrent sessions with no daemon, no
port to allowlist, no reindex lag (the `linker` precedent - "mount, don't
bake"). A real graph database (Neo4j etc.) typically wants a server process,
which reintroduces exactly what was avoided. Embeddable graph engines exist,
but are far less proven than SQLite - and `findings.db`'s FTS5/BM25 text
search is a hard requirement no graph database does natively, so a move to
one would mean running SQL *and* a graph engine side by side, not replacing
SQL at all.

**Nodes map onto what already exists - no new node table needed for two of
the three:**

- **finding** - the existing `finding` table in `findings.db`. `id` = `f_...`.
- **session/task** - the existing `sessions` table in `tasks.db`. `id` =
  `session_id`.
- **transcript message** - NOT duplicated into SQL. Every message in a
  Claude Code transcript already carries a stable `uuid` (plus `parentUuid`
  for threading, `sessionId`, `cwd`, `gitBranch`) - confirmed directly
  against a real transcript file, not assumed. A message is referenced as
  `(session_id, uuid)`; the transcript file stays the one authoritative copy
  of its content. The file path is derivable the same way `tasks.db`'s
  existing recorder already does it (`projects_dir/<escaped-cwd>/<session_id>.jsonl`).

**Edges are one new table**, replacing the originally-floated
`session-id:action:id` flat-file oplog format:

```
edge
  from_type / from_id
  to_type   / to_id
  action                  -- recorded | derived_from | touched | ...
  created_ts
```

This directly resolves the flat-file question too: the original motivation
for a "WAL-style oplog" was crash durability - a record that survives even
if the session dies mid-write. SQLite's own WAL journal mode already gives
exactly that (a committed row survives a subsequent crash) for a fraction of
the design cost of a bespoke line format that would still need parsing back
into SQL later. Writing edges straight into this table, in WAL mode, gets
durability and queryability in the same write.

## What this fixes, mechanically

Same pattern `worktrees.jsonl` already proves works in this codebase: it's
written incrementally, *during* the session, by the post-checkout hook the
moment a worktree is created - not reconstructed afterward. Generalizing
that: each action type gets written live by whatever already causes it
(the post-checkout hook for worktree events, `findings record` for finding
events, a session-boundary hook for start/resume/exit), directly into the
`edge` table. `tasks.db`'s crash-durability gap and its full-transcript-scan
cost are both symptoms of *not* doing this already - this closes both at
once, for every action type it covers.

## Open questions - genuinely unresolved

- **Action vocabulary for v1.** Candidates raised but not settled:
  `worktree_created`/`removed`, `finding_recorded`, `session_start`/`resume`/
  `exit`, `commit_made`, `egress_blocked`. Needs a deliberately small starting
  set, not the full list at once.
- **Relationship to `tasks.db`'s existing recorder.** Does the edge table
  *replace* the current transcript-parsing post-run block, or run alongside
  it until proven out? Leaning replace (it's strictly better once live), but
  not decided.
- **Where does `edge` actually live?** `findings.db` is mounted read-write
  *into* sandboxes (agents write to it directly via the `findings` CLI).
  `tasks.db` is deliberately host-side only - explicitly kept outside the
  bind-mounted config dir so a sandboxed agent can never see or mutate it.
  Some actions naturally originate inside the sandbox (a finding being
  recorded); others are host-only today (session status, branch/base_sha).
  One `edge` table can't inherit both access postures at once - this needs
  an explicit decision, not just "put it somewhere."
- **Provenance wiring for `finding --derived_from--> message`.** Requires a
  change to the `findings` CLI itself (a separate repo, `~/dev/findings`) -
  e.g. a `--source-message <uuid>` argument on `record` - not just something
  addressable from `csandbox`.
- **Does staleness propagate?** Findings already have a staleness model
  (observations git-diff-checked; decisions/memories supersede-only). If a
  finding a session's edges point to gets superseded, do those edges need
  any handling, or do they just point at whatever the finding's current
  state is by nature of being an id reference? Not discussed at all yet.
- **Write volume / contention at scale.** Probably fine - `findings.db`
  already handles concurrent sandboxed writers today - but inherited, not
  freshly verified for a table that could see far more writes per session
  (potentially one edge per finding *and* per worktree *and* per session
  boundary, vs. today's much sparser finding-only writes).

## Build scope

Not yet split into core-vs-deferred the way `findings-memory.md` was before
it got built. Given how much this grew in-conversation - from "a session→
finding correlation log" to a three-system graph - the recommendation is to
resist building the full vocabulary/all three edge types at once. A
reasonable first slice: just `session --recorded--> finding` (the original,
narrowest framing), proven out end-to-end (written live, queried, survives a
crash), before adding `finding --derived_from--> message` provenance or any
other action type.

## Adjacent

`worktrees.jsonl` = the existing proof that live, incremental, per-action
writes work in this codebase. The findings-memory design doc's "Task queue
(future)" section already anticipated needing exactly this kind of
session→artifact linkage once a task queue exists - this is a plausible
foundation for that, not a separate concern.
