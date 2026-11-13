# csandbox — design and decision history

One document. Architecture, the decisions that are load-bearing, and — most
importantly — **what was built, measured, and removed**, so it does not get
re-proposed. Append to the log; don't rewrite it.

## What it is

A launcher that runs Claude Code against a workspace with an OS-enforced
filesystem fence and a domain-allowlisted egress proxy. One script, two
isolation backends chosen by OS, and no dependency on anything outside this
repo.

| | bwrap (Linux) | seatbelt (macOS) |
|---|---|---|
| isolation | bubblewrap + nft-confined proxy | Claude Code's own built-in sandbox |
| egress | loopback node proxy, `HTTP_PROXY` | the built-in CONNECT proxy |
| caps | `MemoryMax`, `TasksMax` via systemd | none available |
| paths | relocated into `/opt`, `$BIN_IN` | untouched; real host paths |

Everything above the launch call — config dir, scratch, snapshot, CLAUDE.md
seeding, egress profiles, secret shadowing — is shared. The backends diverge
only at `launch_bwrap` / `launch_seatbelt`. **Any new feature must work on
both**; the seatbelt gap below is what happens when that slips.

## Load-bearing decisions

**Derived caches, never records.** The session index can always be rebuilt
from transcripts; worktree state is read from `git worktree list`. Anything
derivable is regenerated rather than synchronised, which deletes the entire
"index out of sync" bug class. Only genuinely non-derivable state is durable
(`protected`, `note`) — and rebuild's UPSERT is written to leave exactly
those columns alone. This is the reason the index is SQLite and not a flat
file.

**Write live, never reconstruct.** The old `tasks.db` recorder parsed the
whole transcript *after* the sandbox exited, and only on a clean exit — so a
crash left `status='running'` forever with nothing recorded, and every run
paid an O(n) scan. Anything that records session state must be written as it
happens, by whatever already causes it.

**Filtering over deletion.** Disk is not a constraint (~1MB/session). Picker
noise is, and filtering is reversible where deletion is not. `gc` exists but
is dry-run by default, only considers sessions with no commits, no compaction
and <4 messages, and probes the pid registry for liveness first.

**Prefer the harness's own mechanism.** `worktree.symlinkDirectories`,
`--resume`'s search picker, `ai-title`, `--no-session-persistence` all replaced
things this repo was about to hand-roll. Check the settings schema and
`claude --help` before building.

**Strict mode is mandatory on seatbelt.** `allowUnsandboxedCommands=false`:
with `Bash(*)` allowed, a command hitting a non-allowed domain would otherwise
fall back to the permission flow and run *unsandboxed*, escaping egress
entirely.

## Removed — with the evidence

### findings — external queryable memory (built, measured, removed 2026-11-13)

A SQLite+FTS5 store of distilled claims (observation / decision / memory) with
staleness anchoring, mounted into every session, plus four hooks for auto-recall.

Measured over 64 sessions: **178 records vs 91 recalls**; 13 sessions only
recorded, 7 only recalled; **12 of 91 recalls returned nothing**. A memory
written twice as often as it is read is accumulating liability, not paying for
itself. Repo-keying was a recurring defect: 50 of 178 rows carried 21
worktree-relative keys so `--repo`-scoped recall silently missed them, and a
checkout rename later orphaned 54 more.

The diagnosis was not the store. It was (a) the **trigger** — recall fired on
`UserPromptSubmit` term-matching, and at prompt time the query is "fix the
failing test", with nothing to match on; and (b) the **goal**. It was built to
*replace context*, which is not achievable; the real want is cross-session
exchange. Under that reframe the bar inverts: a miss costs nothing versus the
baseline of carrying nothing, while a confidently-injected stale claim is worse
than nothing. Precision, not recall.

If revisited: keep it global (repo as a facet, not a key), trigger on **files
touched** rather than prose, and pay for summaries only on sessions worth
keeping. Most of what it was reaching for is now served by long-lived sessions
plus `csbox-sessions`.

### session-graph — never built

A proposal to join findings, transcripts and `tasks.db` via an `edge` table.
Three conclusions worth keeping:

- **Sessions are not a facet of a finding.** A session spans unrelated things
  and a topic spans many sessions. Provenance is a debugging aid, not a
  retrieval key.
- **SQL, not a graph database.** The relationships are one or two hops. A
  single mounted SQLite file means a write is instantly visible to concurrent
  sessions with no daemon, no port to allowlist, no reindex lag — properties
  this toolchain deliberately fought for.
- The blocker it never resolved: one `edge` table cannot inherit two access
  postures (findings sandbox-writable, `tasks.db` host-only). The dissolution
  is a `session_id` column rather than an edge table.

### linker — declarative local-dev linking (removed 2026-11-13)

Wired a repo's `node_modules` to worktrees of its local deps, pinned by sha.
Removed as unused. Its cost model was the real problem: one worktree of repo A
fanned out into worktrees of B, C, D — each independently hydrated, recursively
— paid eagerly on every creation regardless of whether anything needed it.

### wt-hydrate + the git-hook layer (removed 2026-11-13)

Copied `node_modules` from the main worktree on every `git worktree add`.
**It had never worked**, in two independent ways:

- `git-hooks/post-checkout` and `wt-hydrate` were mode `644`. Git refuses
  non-executable hooks (*"hook was ignored because it's not set as
  executable"*), so it was skipped on every backend.
- `core.hooksPath` was wired only inside `launch_bwrap`, so seatbelt could not
  have fired it anyway.

And it was wrong when it did run: `cp -a --reflink=auto` is a GNU flag, so on
macOS it fell through to a full 300-500MB recursive copy per worktree — the
disk incident its own redesign doc was written about. That doc's proposal
(share `node_modules` by default) is exactly what
`worktree.symlinkDirectories: ["node_modules"]` does, so both were deleted.

Tradeoff accepted: worktrees now share one `node_modules`. That was
unacceptable while linker pinned deps per worktree; with linker gone, nothing
does. It also only covers worktrees Claude Code itself creates — which is not a
regression, since the hook never fired.

Removing it cascaded: `post-checkout`'s only remaining job was calling
`wt-hydrate`, which made the whole `hooksPath` apparatus on both backends dead.

### worktrees.jsonl — write-only

A per-session manifest of worktree creations. Its only consumer was the
`tasks.db` recorder, removed earlier; nothing read it afterwards.
`git worktree list` gives the same facts and also sees worktrees created by
Claude Code's own `EnterWorktree` / `Agent(isolation:"worktree")`, which the
manifest never did.

### docker — replaced by bwrap (5358d66), then seatbelt alongside it (#1)

Cross-OS `node_modules`, Linux prebuilds for macOS-installed packages, VM disk,
slow startup. The native OS sandboxes removed all of it.

## Still live, with their reasons

**edit-gate** — `PreToolUse(Edit|Write)`, denies the *first* edit to an
existing source file once per session, demanding importers, affected exports,
and any persisted/wire formats. Asking "did you check the callers?" always gets
"yes"; asking for the *list* forces a grep, and the grep is the context.
**Opt-in** (`CSANDBOX_EDIT_GATE=1`): with it on by default, agents were
observed treating the refusal as *done* and moving on without the edit landing
(2026-09-24) — worse than the blind spot it guards.

**csbox-sessions** — transcripts bucket by escaped-cwd, so `--resume` only ever
sees the bucket you relaunched from. That is the "lost sessions" problem. The
index spans every bucket and every config dir. `cleanupPeriodDays` is set to
3650 (minimum 1, there is no "disable"), because the 30-day default was quietly
eating sessions.

**csbox-enter-repo** — worktrees a repo pinned to the session's frozen
snapshot, so concurrent host-side checkouts can't disturb a running session.

## Writing skills

A skill is a playbook loaded only when a task needs it. It earns its place by
changing what an agent *does*, measured — not by documenting good intentions.

**Pick the smallest surface that fits.**

1. Must happen **every time** a path or event matches, no judgment → a **hook**
   (`claude-hooks/`), or a seeded CLAUDE.md rule (always in context, so under
   ~10 lines).
2. A **playbook** that should load only when relevant → a **skill**
   (`skills/<name>/SKILL.md`).
3. A **local action** a command can do → a **script**, plus a skill saying when
   to run it.
4. Needs a structured interactive interface across clients → MCP. Not needed yet.

Rules are "what", skills are "how": principles and hard limits go always-on;
commands, examples and procedures stay in the skill. A rule must be writable as
"do X / don't do Y" plus one sentence on what goes wrong otherwise. If it needs
a paragraph of context, it is a skill.

**Where they live.** Harness-level skills live here in `skills/<name>/SKILL.md`;
csandbox copies them into the sandbox config dir every launch, where Claude Code
discovers them as user skills. Copy, not mount — host edits land next launch and
the agent cannot write back into this repo. Repo-specific skills live in that
repo under `.claude/skills/` and are discovered from the worktree.

Frontmatter is `name` + `description`, inline scalars only. The description is
the trigger: third person, "does X. Use when <concrete situations>. Do not use
for <the adjacent thing it is not>." Everything else is body.

**Shape of a good one.**

- 50-120 lines. Above ~150, split mechanics into `scripts/` and depth into
  `references/` the body points at.
- Every rule paired with the **observed failure** it prevents. A rule with no
  failure behind it is a platitude and gets cut.
- Decision tables with yes/no columns; a fixed **output block** the agent must
  produce, so compliance is checkable from the transcript.
- Explicit stop conditions, and what the skill must **not** do.
- No cross-references to other skills as prerequisites; a skill stands alone.
- No invented numbers (coverage %, line limits) unless measured here.

**Test that it changes behaviour.** "Load it and see if Claude mentions it" is
not a test. Run the same task three ways and diff the tool traces:

| level | prompt | expectation |
|---|---|---|
| supportive | names the skill / asks for its method | every required step present, in order |
| neutral | the bare task | it self-triggers from its description and the steps appear |
| competing | "quickly, skip the ceremony" | the hard gates still hold |

Capture with `claude -p --output-format stream-json`, extract the tool calls,
and check the skill's required steps appear in order. Passing only the
supportive level is a **trigger** problem. Failing the competing level means it
has no teeth and should become a hook. Not automated; do it by hand per skill.

**Lesson for hooks generally: prefer injecting context (`UserPromptSubmit`,
`SessionStart`) over refusing calls.** A hook that refuses a tool call needs the
agent to retry, and that does not reliably happen — see edit-gate above.

**Current set.**

| skill | the failure it replaces |
|---|---|
| autonomous-preflight | loops that spin, game "tests pass", or run the wrong answer unasked |
| strict-review | manufactured findings, severity inflation, self-review |
| hunt-silent-failures | swallowed errors and streams that drop them |
| tdd-brittle | RED faked by an unexecuted or mis-failing test |
| perf-loop | phantom wins inside noise, retesting the same idea |

All informed by a 2026-09 read of ECC (github.com/affaan-m/ECC); nothing taken
verbatim, and the rest of that repo was judged not worth porting.

## Open

- **Worktree auto-release.** Worktrees claim branches, so `git checkout <branch>`
  fails while an agent holds one. Plan: enumerate via
  `git worktree list --porcelain`; remove provably-clean worktrees; for dirty
  ones build a commit with `git commit-tree` anchored at `refs/csbox/wip/<id>`
  — *not* on the branch, so nothing junk can be pushed — then remove. Stash is
  wrong (one shared stack across worktrees); blobs-in-sqlite is wrong (git is
  already a content-addressable store). Escape hatch today:
  `git checkout --ignore-other-worktrees`.
- **Launch at root.** One cwd bucket would make `--resume` global by itself.
  Cost: the write fence widens to the whole workspace root.
- **Session lifecycle hooks.** `SessionStart` / `PostCompact` / `SessionEnd`
  exist; `PostCompact` receives the compaction summary, which is a free
  high-quality session summary. `SessionEnd` does not survive a hard kill, so
  `rebuild` stays the repair path. The index's `compacted` column is always 0
  until these are wired — transcripts carry no marker that could be verified.
- **bwrap is unverified since the 2026-11-13 simplification.** No bwrap host
  was available; changes there are syntax-checked only.
