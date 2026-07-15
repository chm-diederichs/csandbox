# Sandbox session-output contract

How a sandboxed agent reports its work so the review UI has something to show —
even when it wrote no code. This is the spec we build against; parts of it are
not implemented yet (see **Status** at the end).

## Context

csandbox runs an agent in an isolated container. On exit, csandbox records one
row per session in the tasks db (see the recorder in `csandbox`; schema below).
The review UI reads those rows and shows, per session: the **diff** (from git)
and a **summary** (from a file the agent writes). The human leaves feedback,
which is compiled into a prompt and the session is resumed (`--resume`). This
doc specifies what the *agent* must produce so that loop works.

Two artifacts come out of a session:

- **the diff** — the agent's committed work on its worktree branch (`base..head`).
  Optional: a fact-finding or stuck session may have none.
- **the summary** — a markdown file the agent always writes. This is the
  guaranteed review artifact; the diff is the sometimes-present one.

## The contract

The agent (told this via the seeded `CLAUDE.md`) must:

1. **Work on the session's worktree branch and commit its code.** A commit is
   what produces a reviewable diff (`base..head`). Uncommitted working-tree
   changes are invisible to branch-diff review, so finish by committing.
2. **Always write a summary** to the path in `$CSANDBOX_SUMMARY` — *even if it
   committed nothing* (got stuck, or was only fact-finding). The summary is how
   a no-diff session is still reviewable.
3. **Never put feedback in inline code comments.** They pollute the diff and
   would need stripping before commit. Session-level narrative goes in the
   summary; line-level feedback flows the *other* direction (see below).
4. **Leave the branch for the human.** Don't push, open a PR, or merge unless
   asked.

## The summary artifact

- **Location:** `$CSANDBOX_SUMMARY`, a per-session path csandbox provides,
  under the scratch dir — e.g. `/home/node/scratch/sessions/<session-id>/summary.md`
  (host: `~/.claude-sandbox/scratch/sessions/<session-id>/`). csandbox owns the
  path (keyed by the session id it mints) and exports it into the container.
- **Not committed.** It lives in scratch, outside the repo, so it never appears
  in the diff under review and survives even a no-commit session.
- **Schema** — defined headings so the UI can render and the stuck/fact-finding
  cases have a home:

  ```markdown
  ## Summary
  One-paragraph what-and-why.

  ## Changes
  What landed on the branch (files, key decisions). Empty if no commit.

  ## Open questions / needs attention
  Things the reviewer should decide or look at.

  ## Blocked on
  What stopped progress, if anything (empty when N/A).
  ```

## Two feedback channels (don't cross them)

- **agent → reviewer:** the summary `.md`. Session-level, not line-anchored —
  the diff already shows the lines; the summary explains the why and the caveats.
- **reviewer → agent:** line-anchored comments in the review UI (diffx), compiled
  into the resume prompt. This is where line-level precision lives, so the agent
  never needs to embed it in code.

## DB / status implications

The recorder's `sessions` row (currently `session_id, dir, branch, base_sha,
head_sha, status, created_at, updated_at`) gains:

- **`summary_path`** — where the summary was written.
- a **status taxonomy**:
  - `ready` — has a branch diff to review (`base..head`). A summary, when
    present, is recorded in `summary_path` alongside.
  - `summary_only` — no diff (fact-finding, `--live`, or nothing committed);
    review the summary.
  - `blocked` — stopped early; the summary's *Blocked on* says why. **Reserved** —
    set automatically by the transcript prompt-scan follow-up (not yet built)
    when a session stalled on a permission wall.

## Status

- **Built:** the recorder + base `sessions` schema (Phase 0).
- **Not built (this spec):** `$CSANDBOX_SUMMARY` env + the contract text in the
  seeded `CLAUDE.md`; `summary_path` column + status taxonomy in the recorder;
  the transcript prompt-scan that flags `blocked`; the review UI that consumes
  all of it.
