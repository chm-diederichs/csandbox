# Skills - how we write them, where they live, how they get installed

A skill is a playbook the model loads only when a task needs it. It earns its
place by changing what an autonomous agent *does*, measured, not by
documenting good intentions. The reference implementation of the bar is
`keet-core/.claude/skills/test-triage`: it grew out of two real triage
passes, mechanical steps are scripts, judgment lives in short reference files
loaded on demand, and every rule names the failure it prevents.

## Which surface

Ask in order; pick the first that fits, and if unsure start smaller.

1. Must it happen **every time** a path or event matches, with no judgment
   involved? → a **hook** (csandbox `claude-hooks/`) or a seeded **CLAUDE.md
   rule** (always in context, so it must stay under ~10 lines).
2. Is it a **playbook** that should load only when the task needs it? → a
   **skill** (`skills/<name>/SKILL.md`).
3. Is it a **local action** a command can do? → a **script**, then a skill
   that tells the agent when and how to run it (`findings`, `linker`).
4. Does it need a structured interactive interface across clients? → MCP.
   We have not needed one.

Rules are "what", skills are "how": principles and hard limits go always-on;
commands, examples and procedures stay in the skill. A rule must be writable
as "do X / don't do Y" with one sentence on what goes wrong otherwise. If it
needs a paragraph of context, it is a skill.

## Where they live, how they install

- **Harness-level skills** (how to run autonomously, review, test, optimise)
  live here, `claude-sandbox/skills/<name>/SKILL.md`. csandbox copies them
  into the sandbox config dir (`~/.claude-sandbox/skills/<name>/`) on every
  launch, where Claude Code discovers them as user skills. Copy, not mount:
  host edits land next launch; the agent cannot write back into this repo.
- **Tool skills** live with the tool (`~/dev/findings/skills/findings.md`) and
  csandbox installs them the same way when the tool is active.
- **Repo-specific skills** live in that repo under `.claude/skills/` and are
  discovered from the worktree (test-triage).

Frontmatter is `name` + `description`, inline scalars only. The description
is the trigger: third person, "does X. Use when <concrete situations>. Do not
use for <the adjacent thing it is not>." Everything else is body.

## Shape of a good one

- 50-120 lines. Above ~150, split mechanics into `scripts/` and depth into
  `references/` that the body points at.
- Each rule paired with the **observed failure** it prevents. A rule with no
  failure behind it is a platitude and gets cut.
- Decision tables with yes/no columns; a fixed **output block** the agent
  must produce (so compliance is checkable from the transcript).
- Explicit stop conditions and the things the skill must **not** do.
- No cross-references to other skills as prerequisites; a skill stands alone.
- No invented numbers (coverage %, line limits) unless measured here.

## Test that it changes behaviour

"Load it and see if Claude mentions it" is not a test. Run the same task three
ways and diff the tool traces:

| level | prompt | expectation |
|---|---|---|
| supportive | names the skill / asks for its method | every required step present, in order |
| neutral | the bare task | the skill self-triggers from its description and the steps appear |
| competing | "quickly, skip the ceremony" | the hard gates still hold (RED before code; preflight block before fan-out) |

Capture with `claude -p --output-format stream-json`, extract the tool calls,
and check the skill's required steps (its output block, its gate commands)
appear and in order. A skill that passes only the supportive level has a
trigger problem; one that fails the competing level has no teeth and should
become a hook. Not built yet as a harness; do it by hand for each new skill
until it is.

## Current set

| skill | replaces the failure | source |
|---|---|---|
| autonomous-preflight | loops that spin, game "tests pass", or run the wrong answer unasked | loop-design-check idea, rewritten |
| strict-review | manufactured findings, severity inflation, self-review | code-reviewer gate + our false-positive list |
| hunt-silent-failures | swallowed errors and streams that drop them | silent-failure-hunter list + stream/emitter cases |
| tdd-brittle | RED faked by an unexecuted or mis-failing test | tdd RED gate, rewritten for brittle |
| perf-loop | phantom wins inside noise, retesting the same idea | benchmark-optimization-loop, ledger in findings |
| findings (tool repo) | re-deriving what a past session learned | ours |

Always-on rules seeded by csandbox: worker contract, lane table before
fan-out. Hook (opt-in, `CSANDBOX_EDIT_GATE=1`): `edit-gate` refuses the first
edit to an existing source file once with a fact request. Switched off by
default on 2026-09-24 after a session took the refusal as "done" and ran the
tests without the edit landing - a hook that refuses a tool call needs the
agent to retry, and that did not reliably happen. Lesson for hooks in general:
prefer injecting context (UserPromptSubmit, SessionStart) over refusing calls. All from a 2026-09 read of ECC (github.com/affaan-m/ECC);
nothing was taken verbatim, and the rest of that repo was judged not worth
porting (see `findings-memory.md` "Prior art").
