# Findings memory — design

Status: **design; not built. Trimmed to a CORE to build first + DEFERRED
machinery kept below** (see "Build scope"). An external, queryable memory so
sessions can be **ephemeral** (small, focused, cheap) instead of long-lived
multi-repo transcripts. Each session records distilled findings; later sessions
retrieve the relevant slice on demand (via a per-worktree `PLANNING.md` index +
`recall`).

Motivation: long-lived sessions spanning several repos bloat context, hit
(lossy) compaction, and degrade. External memory moves cost from *carrying
everything* to *retrieving the slice you need* — a win for long/broad work,
provided retrieval recall is good and findings don't rot. Generalizes the
per-conversation memory system + `summary.md` + the catch-up staleness marker,
scaled with real retrieval.

The metric that matters is **not tokens** (those favor this) but **miss-rate**
(retrieval failed → re-derivation) and **dup-rate** (record-after-recall failed
→ store rots). Build the thinnest version and instrument those two.

## A finding is a durable assertion the agent should carry forward

A distilled assertion + its evidence + where it applies — not transcript dumps
or speculation. Three **kinds**, one schema; they differ only in anchoring /
staleness (the rule that falls out: **only observations code-stale; everything
else is supersede-only**):

- **Observation** (descriptive): *how the code is* — verifiable against code;
  anchored to `sha` + `files`; **stales when those `files` change**;
  corroboration = re-checked against code. (bug | mechanism | gotcha | perf.)
- **Decision** (normative / ADR): *how the code should be / why it's built this
  way* — rationale + **alternatives rejected**. Anchors to time/context, not a
  sha; **never code-stales**; only ever `superseded`. (decision | howto |
  convention.)
- **Memory**: an assertion *not about the code* — the user (preferences,
  feedback, working style), the workflow, the environment, external references.
  **No `sha`/`files`**; `repo` optional (global vs project-scoped); never
  code-stales — superseded (or a soft time-expiry for context-bound ones like
  "current priority is X"). Often **user-authored** ("remember X"), which makes
  it authoritative — high trust without corroboration.

**Promotion (memory → observation):** a memory that is actually a *code claim*
(the user says "the parser is recursive-descent") is a **potential observation** —
when a session verifies it against the code it promotes to an `observation`
(gains a `sha` anchor, becomes code-staled). Non-code memories stay memories.

Greenfield especially needs *decisions* (no external doc; the "why" evaporates;
an ephemeral agent re-proposes rejected options). This generalizes the
per-conversation **memory system** — same CLAUDE.md boundary applies: a *few*
must-always-know items stay in-context; the *growing body* lives here, on demand.

**Record what's not recoverable from the code** — decisions, rejected
alternatives, invariants, conventions, gotchas. The code + commit messages are
the "what"; findings are the "why / what-not-to-repeat". (And: a *few*
load-bearing conventions belong in CLAUDE.md — always in context; the *growing
body* belongs here — retrieved on demand.)

## Schema

Single SQLite store; a finding is a **mutable row** (the access CLI is the only
writer, so no event-sourcing needed here — unlike the review-loop comment log,
which is jsonl because host + container append the same file).

```
finding
  id            pk
  kind                     -- observation | decision | memory   (primary flavor)
  repo                     -- filter facet (nullable for global memories)
  category                 -- freeform sub-facet within kind (bug/mechanism/howto/user/…)
  area                     -- one coarse topical tag (freeform)
  claim                    -- the one-line assertion (required; what ranks + lists)
  report                   -- full markdown evidence/detail (free-form)
  files         json[]     -- observations only: paths the claim concerns (staleness + scope)
  thread                   -- investigation/exploration grouping; a resolution absorbs it
  role                     -- normal | resolution
  status                   -- open | confirmed | absorbed | superseded | stale
  superseded_by            -- id (nullable)
  expires_ts               -- optional soft expiry (context-bound memories)
  created_ts / updated_ts

corroboration              -- 1..N per finding; a set, never overwritten
  finding_id    fk
  origin                   -- session id, or `user` (user-asserted = authoritative)
  sha                      -- observations: the code state they saw it true at (else null)
  ts
  verified      bool       -- observations only: true = re-checked vs code at `sha`

FTS5(claim, report)        -- external-content virtual table, BM25 ranking
```

Derived (computed, not stored): **`confidence` = count(corroboration)**,
**`anchor_sha` = sha of the latest `verified` corroboration** (the "valid as-of"
for staleness), **`origins` = distinct corroboration origins**.

Link vocabulary is deliberately minimal — only where it drives lifecycle:
`thread` (grouping / absorb set), `role: resolution`, `supersedes`. No separate
`related`/`absorbs`/`keywords`: cross-links come from FTS over `report`;
resolution absorbs its whole `thread`; term-search is FTS, not hand-tagged keys.

## Lookup: structured filter + FTS (decided)

Filter by cols (repo, category, area) → candidate set; **FTS5/BM25** ranks over
(`claim`, `report`); rank adjusted by `confidence`, recency, and a penalty for
`stale`/`open`. **Two-stage:** return `claim`s (abstracts); the agent loads full
`report`s only for the ones it wants — bounds tokens even with in-depth reports.
Keys-alone rejected (vocabulary mismatch → silent misses; the costly failure for
ephemeral agents). Lexical FTS first + query-term expansion in the skill; **local**
embeddings only if miss-rate stays high (no runtime egress; adds a model +
inference — the vector index itself is light via `sqlite-vec`).

## Recording: per-insight, live, record-after-recall (decided)

Sessions record **each insight as it happens** (not a per-session dump), so a
session opened *mid* another immediately benefits. Before inserting, the write
skill **recalls first**: if a matching claim exists → `corroborate` or
`supersede` it; else insert. This is the dedup mechanism — without it, live
per-insight from many sessions produces cross-session duplicates.

## PLANNING.md — per-worktree recall index (core)

The DB is canonical, but agents shouldn't have to query it well every time. Each
worktree gets a **`PLANNING.md`** — a thin, worktree-scoped **index over the DB**
for this line of work: a list of relevant finding `id`s, each with a one-line
"why it matters here", plus minimal local task notes. It is **not** a source of
truth and does **not** duplicate finding content — it *references* it.

This is exactly the `MEMORY.md`→memory-files pattern at worktree scope. Its whole
job is to **cut miss-rate**: a session starts by reading `PLANNING.md` (the
pre-curated slice) rather than relying on a cold query, and falls back to
`recall` for anything not indexed.

Why this avoids the "in-repo doc rots" problem you get from a hand-maintained
design file:
- **pointers, not prose** — stays short; content lives in (and freshens from) the
  DB, so a superseded finding shows as superseded when you follow the link.
- **gitignored working file** — worktree-scoped, dies with the worktree, never
  reaches `main`, never bloats history.
- as findings are recorded, the agent adds a pointer here if it's relevant to
  this worktree — cheap, append-ish, low contention.

## Corroboration + confidence — self-reinforcing (DEFERRED)

`corroborate <id>` appends `{origin, sha, ts, verified}` — it does **not**
overwrite the anchor. `verified: true` (re-checked against code at that sha)
advances `anchor_sha`; `verified: false` (agreed/cited) bumps `confidence` only.
So a claim independently confirmed by N sessions ranks higher and reads as more
trustworthy, and staleness tracks the freshest *real* re-verification. Same claim
still true → corroborate; claim wrong/changed (incl. its `files` moved) →
supersede.

## Lifecycle + self-compacting graph (DEFERRED)

Live per-insight adds `open` (hypothesis) findings, many invalidated as a session
learns — but the graph collapses them:

```
thread T:  F1 open · F2 open · F3 confirmed   -- linked by thread=T
           bug fixed ->
           R (role=resolution) "root cause + fix.  · F1 ruled out  · F2 pointed here  · F3 cause"
              -> F1,F2,F3 set to `absorbed` (demoted from default retrieval, trace kept)
```

- On a fix, the session records a **resolution** finding whose report carries a
  one-line digest of each precursor; the thread's others → `absorbed`.
- `absorbed`/`superseded` **demote** from default retrieval but are **kept**
  (soft-prune) — a resolution expands to its trace on demand.
- Default retrieval: `confirmed` (incl. resolutions); `open` shown-but-tentative;
  `stale` flagged "verify".

## Staleness (reuse the catch-up idea) — category-dependent

Applies to **observations only.** A claim is valid "as-of `anchor_sha`, in
`files`"; a querying session checks whether `files` changed since `anchor_sha`
(`git log <anchor_sha>..HEAD -- files`) and surfaces **"verify before trusting"**
if so — advisory, not hard invalidation (the agent judges; a mechanism/invariant
may survive a file edit a line-level detail wouldn't).

**Decisions and memories don't stale on file edits** — they stand until an
explicit later assertion `supersede`s them (memories may also carry a soft
`expires_ts` for context-bound facts). No `anchor_sha`; corroboration means
"reaffirmed / still in force" (`verified` is meaningful only for observations).
A decision's exploration→decision arc uses the same graph: option-analysis
`open` findings in a `thread` resolve into a `decision` (`role: resolution`) that
absorbs them. And a user-authored **memory that is a code claim** can be
*promoted* to an observation once a session verifies it (it then gains a `sha`
anchor and starts code-staling).

## Curation

Mostly the lifecycle (resolution absorbs; supersede replaces). Residual leak:
**abandoned threads** — `open` findings whose investigation never resolved.
Age-out by thread inactivity (demote after N days of no new events). Hard-prune
`absorbed`/`superseded`/aged only if size demands; default is soft.

## Storage + access

**One SQLite file (findings + FTS5) behind a mounted `findings` CLI** — the
`linker` precedent. A write is instantly visible to concurrent sessions (no
reindex lag → serves the live requirement), and the CLI is the single writer
path (WAL + `busy_timeout` serialize low-frequency writes). Caveat: relies on
SQLite file locking on the bind mount — fine on **native Linux Docker** (real
local FS); on Docker Desktop/virtiofs, fall back to append-only `findings.jsonl`
+ a host-maintained index.

**CLI verbs** (where the design lives, more than the columns):
- `record` — recall-first, then insert (with the author's first corroboration).
- `corroborate <id> [--unverified]` — append to the set.
- `supersede <id> --with <new>` — mark old superseded.
- `resolve <thread>` — record/flag a resolution, absorb the thread.
- `recall <query> [--repo --category --area]` — filter + FTS + expansions →
  ranked claims → load reports on demand → staleness flag.

## Build scope — core now, the rest deferred

The hard parts of agent memory are empirical; don't build machinery for
imagined failure modes. Build the thin core, **instrument miss-rate and
dup-rate**, and let observed failures earn each deferred piece.

**CORE (build now):**
- One SQLite store + a mounted `findings` CLI. Schema: `id, kind
  (observation|decision|memory), repo, area, claim, report, files, sha, status
  (current|superseded), superseded_by, created_ts, updated_ts` + `FTS5(claim,
  report)`.
- Verbs: `record` (recall-first, to dedup), `recall` (filter repo/kind/area +
  FTS + two-stage abstracts→reports), `supersede`.
- The one staleness rule: **observations** flag "verify" if `files` changed since
  `sha`; decisions/memories are supersede-only.
- **`PLANNING.md`** per-worktree recall index (above).

**DEFERRED (documented above; add when a metric demands it):**
- corroboration *set* + `verified` + confidence (self-reinforcing) — when
  dup-rate/trust shows the need.
- thread → resolution → `absorb` self-compacting graph, and the `open`/
  `confirmed`/`absorbed` lifecycle states — when `open`-finding rot appears.
- memory → observation **promotion**; memory `expires_ts`.
- local embeddings — if lexical miss-rate stays high.
- age-out curation for abandoned threads; bootstrap from existing `summary.md`.

**Still genuinely open:** CLI vs read-only mounted index for access; whether
*decisions* belong in the DB at all vs. staying nearer the code — worth
revisiting once the core is in use.

## Task queue (future — not now, just captured)

An obvious extension once the findings DB is in use: a **task queue** layered on
top. Observations/decisions go to the findings DB (durable context); *tasks* go
to a queue — either roll our own or use Linear (or a lighter-weight variant). A
task references a **worktree + a set of finding ids** (its context slice). Agents
then independently **pick up** a task, pull its referenced findings for context,
complete it, and record new findings back — closing the loop.

This is the piece that makes ephemeral sessions fully autonomous: **findings =
shared memory, tasks = shared work queue with pointers into that memory.**
`PLANNING.md` is the per-worktree precursor (a hand-curated index for one line of
work); a task queue generalizes it to cross-session, agent-dispatchable units.

Build order is unchanged: **findings DB core first, measure miss-rate/dup-rate,
then tasks.** The task layer only pays off once retrieval is good enough that an
agent picking up a *cold* task can actually reconstruct context from the findings
it references — otherwise every task pickup is a re-derivation. So the findings
miss-rate gates whether the task queue is even viable.

## Caching considerations (brief — don't re-derive)

The ephemeral-sessions + external-memory model interacts with Anthropic prompt
caching. The efficiency verdict is unchanged (a win for long/broad work;
**miss-rate**, not tokens, is the metric) — but a few mechanics shape how we
inject context, and they're easy to get wrong. Captured so we don't re-plan:

- **We don't own the cache — we only optimize for it.** Caching is a prefix
  match on the exact prompt bytes (render order `tools` → `system` →
  `messages`); the API owns the cache, we just shape the prompt to hit it. There
  is no findings "cache" — a finding is cached *only* by being in the prompt
  prefix.
- **Tool results ARE part of the cached prefix.** A finding the agent `recall`s
  mid-turn lands in the message history as a `tool_result` → cached for the rest
  of that turn's tool loop (read ≈0.1× input). We don't re-pay to hold it across
  loop steps.
- **Append-only wins; editing kills.** Any byte change *anywhere* in the prefix
  invalidates everything after it. So: keep the injected base (the `PLANNING.md`
  slice) **frozen for the session**; let new findings **append** (as tool
  results, or a `role:"system"` message appended to `messages[]` on Opus 4.8);
  persist `PLANNING.md` edits to disk for the **next** session, not the current
  prefix. Mutating injected context mid-session re-processes everything after the
  edit at full price.
- **DB ≠ cache — different layers, different timescales.** DB = durable,
  sovereign, indefinite memory. Cache = ephemeral cost trick (5-min default /
  1-hr option TTL) on repeated prefixes. Recording to the DB puts nothing in any
  cache; a finding is "cached for the next prompt" only if it's re-injected into
  a stable prefix within the TTL. Across a longer gap (or a fresh stateless call)
  you re-read from the DB and re-inject — full input price once, then it
  re-caches for that turn's loop.
- **Write premium → only cache *reused* prefixes.** Cache write ≈1.25× (5-min) /
  2× (1-hr) input; read ≈0.1×. Break-even is ~2 requests (5-min) / ~3 (1-hr).
  Cache the stable base every step re-reads; don't cache-mark one-shot
  injections (net loss).

Net: caching doesn't change the ephemeral verdict, but the injected-context
discipline — **frozen base + append-only** — is what keeps re-injection cheap
rather than a hidden per-turn tax.

## Adjacent / reuse

`summary.md` = the unstructured seed of a finding; `tasks.db` = session metadata;
the review-loop **catch-up marker** = the staleness mechanism; the
per-conversation **memory system** = the small-scale proof of the pattern.
