# csandbox

A hardened sandbox for running **Claude Code with `--dangerously-skip-permissions`
fully autonomously** — no approval prompts — while removing the "exfiltrate to an
arbitrary host" risk that skip-permissions + open network would otherwise create.
Linux-only: native namespaces via [bubblewrap](https://github.com/containers/bubblewrap),
no daemon, no image, no build step.

`csandbox` is the launcher. It runs Claude Code inside a sandbox that:

- has **no direct route to the internet** — all egress is forced through a proxy
  that only allows an explicit domain allowlist, enforced by an nft rule scoped
  to a dedicated cgroup (see [Architecture](#architecture));
- runs as the **unprivileged host user**, no added capabilities;
- **shadows secret-shaped files** (`.env`, `*.pem`, `*.key`, `.npmrc`, ssh keys, …)
  under the mounted workspace with empty read-only files — the host files are
  never touched.

---

## Quick start

```bash
csandbox                       # sandbox the current directory (minimal egress)
csandbox ~/code/myapp          # sandbox a specific project
csandbox . --continue          # trailing args are passed to `claude`
csandbox --live .              # edit your working tree directly (see below)
CSANDBOX_PROFILE=dev csandbox . # allow npm + git + pypi for this session
```

The sandbox has its **own login**, stored in `~/.claude-sandbox` (copying the
host credentials doesn't survive: OAuth refresh tokens rotate, so a seeded copy
dies as soon as the host client refreshes). First run only:

```bash
CSANDBOX_EXTRA_DOMAINS=claude.ai csandbox .   # then /login inside
```

After that, launches need no extra domains — token refresh goes through
`platform.claude.com`, which is always allowed. Trailing arguments after the
project dir go straight to `claude`.

---

## Architecture

```
        ┌───────────────────────────────────────────────┐
        │  csandbox.slice  (nft-restricted cgroup)        │
        │                                                │
        │   ┌────────────┐  127.0.0.1:8888  ┌──────────┐ │
        │   │  bwrap ns  │ ────────────────▶ │  proxy   │ ┼──▶ internet
        │   │  (claude)  │   only path out    │ (allow-  │ │    (allowlisted
        │   └────────────┘                   │  list)   │ │     hosts only)
        │                                    └──────────┘ │
        └───────────────────────────────────────────────┘
              (everything else from this cgroup: dropped)
```

The sandboxed process stays in the host's normal network namespace — there's no
container network to configure — but it's launched via `systemd-run` into a
dedicated, persistent cgroup (`csandbox.slice`). A one-time root setup step
(`sudo ./bwrap-setup`) installs a single nft rule scoped to that cgroup's path:
accept traffic to the egress-proxy's loopback port, drop everything else. That
rule is the only thing standing between the sandboxed process and the network —
so the only way out is through the proxy. The proxy (a small dependency-free
Node script, `egress-proxy/proxy.js`) permits `CONNECT` tunnels and HTTP requests
**only** to hostnames on the allowlist and returns `403` for everything else.
See `bwrap-setup`'s header for the full mechanism and why each piece is needed.

> **Note:** the proxy filters by hostname and does **not** terminate TLS. See
> [Limitations](#limitations).

---

## Egress allowlist

The allowlist is built from three layers, unioned and deduplicated:

1. **base** — `api.anthropic.com` (inference) and `platform.claude.com`
   (OAuth token refresh — without it the login dies when the access token
   expires, a few hours in), always present. `api.anthropic.com` is
   single-tenant Anthropic space, not a shared CDN, so it is not a
   domain-fronting substrate.
2. **`CSANDBOX_PROFILE`** — one or more comma-separated profiles (default `minimal`).
3. **`CSANDBOX_EXTRA_DOMAINS`** — comma-separated one-off additions.

The resolved allowlist is printed at launch, and any hosts **blocked during the
session are reported on exit**, with the exact `CSANDBOX_EXTRA_DOMAINS=…` needed to
allow them next time.

### Profiles

| Profile   | Adds                                                                                     |
| --------- | ---------------------------------------------------------------------------------------- |
| `minimal` | *(nothing beyond the base)* — for running / testing / analyzing already-installed code   |
| `node`    | `registry.npmjs.org`, `registry.yarnpkg.com`                                              |
| `git`     | `github.com`, `codeload.github.com`, `raw.githubusercontent.com`, `objects.githubusercontent.com`, `gist.githubusercontent.com` |
| `python`  | `pypi.org`, `files.pythonhosted.org`                                                      |
| `dev`     | `node` + `git` + `python` (general coding with installs)                                  |

Profiles combine: `CSANDBOX_PROFILE=node,git`.

```bash
csandbox .                                        # minimal: Anthropic only
CSANDBOX_PROFILE=node csandbox .                  # + npm/yarn
CSANDBOX_PROFILE=dev csandbox .                   # + npm/yarn/github/pypi
CSANDBOX_EXTRA_DOMAINS=example.com csandbox .     # one-off host
```

Why isn't npm/github in the default? They live on **shared CDNs** (Cloudflare /
Fastly) that a hostname-only proxy cannot make front-proof, so they are opt-in per
workflow rather than always-on. `minimal` is genuinely fronting-resistant; broader
profiles trade some of that for convenience.

---

## Environment variables

| Variable                 | Effect                                                                                  |
| ------------------------ | --------------------------------------------------------------------------------------- |
| `CSANDBOX_PROFILE`       | Egress profile(s), comma-separated. Default `minimal`. (`node` / `git` / `python` / `dev`) |
| `CSANDBOX_EXTRA_DOMAINS` | Comma-separated extra hosts to allow, on top of the profile(s).                          |
| `CSANDBOX_ROOT`          | Workspace root to mount. Defaults to all of `~/hyper` when the project is under it (so cross-repo npm links resolve); otherwise the project dir. |
| `CSANDBOX_READONLY=1`    | Mount the workspace read-only.                                                           |
| `CSANDBOX_SHELL=1`       | Drop into `bash` inside the sandbox instead of launching `claude`.                       |
| `CSANDBOX_DRYRUN=1`      | Print the resolved config (mounts, allowlist) and exit without launching.               |
| `CSANDBOX_DOWN=1`        | Stop the egress proxy, then exit.                                                        |

---

## File layout

```
claude-sandbox/
├── README.md            # this file
├── csandbox             # the launcher (symlinked into ~/.local/bin)
├── bwrap-setup          # one-time root setup (AppArmor profile, slice, nft rule)
├── git-hooks/
│   ├── post-checkout   # fires on `git worktree add`; auto-hydrates node_modules
│   └── wt-hydrate      # clones node_modules from the main worktree (CoW), offline
└── egress-proxy/
    └── proxy.js         # allowlist-enforcing forward proxy (no deps), run directly by bwrap
```

State lives outside this dir in `~/.claude-sandbox/` — the sandbox's `~/.claude`
config dir (credentials, session history). It's created automatically; the login
inside it is the sandbox's own (see Quick start).

The agent also gets a persistent scratch dir: `~/.claude-sandbox/scratch` on the
host, bind-mounted at the same path inside the sandbox (bwrap reuses real host
paths rather than remapping them). A seeded global `CLAUDE.md` points the agent
there instead of at project `.claude/` dirs, whose writes always trigger Claude
Code's hardcoded self-config approval prompt (it survives even
`--dangerously-skip-permissions` + `Bash(*)`).

---

## Top-level session worktree

By default, the seeded `CLAUDE.md` tells the agent to `EnterWorktree` at the
start of every session in a git repo, so its edits land on a **disposable
branch off the current commit** (`worktree.baseRef: "head"`) rather than on your
checked-out tree — you're often hacking in the same repo concurrently and want it
left alone. When the agent finishes it keeps the branch and leaves it for you to
review and merge manually (it won't push, PR, or merge on its own). Note the
worktree carries committed history only, not your uncommitted/staged changes.

Pass **`--live`** to opt out: the agent then edits your working tree directly.
This is a launcher-side system-prompt override, so it works regardless of what's
in the seeded `CLAUDE.md`.

```bash
csandbox .          # default: agent works on its own throwaway branch
csandbox --live .   # agent edits your checked-out working tree
```

---

## Parallel worktree agents

The top-level agent can fan out to many subagents in parallel, each in its own
git worktree (`Agent(isolation: "worktree")`), all inside the one sandbox.
Worktrees don't inherit `node_modules` (it's gitignored), but the parallel phase
should be **network-quiet** — no subagent should hit the npm registry.

So a system-wide `post-checkout` git hook (`git-hooks/`, installed per-run via
`GIT_CONFIG_SYSTEM`) fires whenever a worktree is created and clones
`node_modules` from the repo's main worktree — copy-on-write where the host fs
supports it, offline always. It's guarded to run only on worktree creation (null
prev-SHA in a linked worktree), is idempotent, and is monorepo-aware (mirrors
`node_modules` at the repo root and each workspace package). Verified to fire on
the Agent tool's own worktree creation.

The one case that still needs the network is a subagent **adding a new
dependency** — that's a registry fetch, so it surfaces at the egress proxy
rather than happening silently. Keep the parallel phase to work that uses the
already-installed deps.

The top-level agent is told all this via the seeded global `CLAUDE.md` (a
"Parallel worktree subagents" section), so it fans out correctly without
re-installing deps or reaching for the network mid-run.

## Linked local dependencies (linker)

For poly-repos that link to each other locally (the `~/hyper` pattern), the
sandbox integrates [`linker`](../../dev/linker) — a declarative `npm link`
substitute. A repo's `links.json` pins each local dependency to a sha; the same
`post-checkout` hook that hydrates `node_modules` also runs
`linker load --worktree --branch <the-worktree's-branch>`, so every linked dep
becomes a **worktree pinned to its declared sha, isolated to that worktree's
branch**, symlinked into `node_modules`. Two parallel sessions therefore get
independent worktrees of a shared dep instead of fighting over one checkout, and
the whole thing stays offline (the deps are already under the mount).

`linker` isn't published yet, so it's **mounted in from the host** rather than
baked into the image: csandbox mounts the host `linker` package at `/opt/linker`
(with a wrapper on `PATH`) plus the host `~/.linker/registry.json` (name→path).
Host paths resolve in-container because the workspace mounts at the same path.
This is best-effort — if `linker` isn't on the host `PATH`, the sandbox just
skips it (no links wired). The agent is told it's automatic via a seeded
"Linked local dependencies" `CLAUDE.md` section (only added when linker is
active).

---

## Setup / installation

Already installed on this machine. To reproduce elsewhere:

```bash
# 1. one-time root setup: AppArmor profile, persistent systemd slice, nft rule
sudo ~/hyper/claude-sandbox/bwrap-setup

# 2. put the launcher on PATH
ln -sf ~/hyper/claude-sandbox/csandbox ~/.local/bin/csandbox

# 3. (optional) enable linked local deps: put linker on PATH, register repos
cd ~/dev/linker && npm install && npm link
linker register corestore ~/hyper/corestore   # once per local dep
```

Requires: Linux, with `bubblewrap`, `nftables`, `apparmor`, and a systemd user
session (see `bwrap-setup`'s header for exactly why each is needed). On first
launch, log the sandbox in with `CSANDBOX_EXTRA_DOMAINS=claude.ai csandbox .`
then `/login` inside.

---

## Maintenance

- **Changing the proxy:** there's no build step — `egress-proxy/proxy.js` runs
  directly via `node`. The launcher reuses a running proxy instance unless the
  resolved allowlist changed since it started, restarting it otherwise; to force
  a restart regardless (e.g. after editing `proxy.js`), tear it down first.

- **Update the Claude Code version:** it's whatever `claude` resolves to on the
  host `PATH` (bwrap bind-mounts the host's node/claude install read-only,
  autoupdater disabled inside the sandbox) — update it on the host as usual.

- **Tear down the running proxy:** `CSANDBOX_DOWN=1 csandbox`.

- **Re-run `bwrap-setup`:** safe any time (every step replaces its prior state);
  needed again only if the AppArmor profile, slice, or nft rule get reset
  (e.g. after certain system upgrades).

---

## Limitations

- **Domain fronting on shared CDNs.** The proxy allowlists by hostname and does not
  terminate/inspect TLS. Code inside the sandbox could open a tunnel to an allowed
  host on a shared CDN (e.g. `raw.githubusercontent.com` on Fastly, `registry.npmjs.org`
  on Cloudflare) and then speak to a *different* property on that same edge via the
  inner Host header. The `minimal` profile avoids this entirely (single-tenant
  Anthropic host only); broader profiles reintroduce some of it. The real fix is a
  TLS-terminating proxy with its own CA installed in the container that validates the
  inner Host/path — **not built here**; add it if your threat model needs defense
  against a genuinely adversarial in-sandbox process.

- **No `--open-egress` yet.** UDP/P2P traffic (Hyperswarm holepunch, QUIC, …) has
  no hostname to allowlist, so the HTTP `CONNECT` proxy can't serve it at all — it
  needs a genuinely wider network route for the session. That existed under the
  old docker backend; it hasn't been rebuilt for bwrap yet (would need a second
  pre-provisioned systemd slice + accept-all nft rule). Follow-up work, not
  currently available.

- **API quota.** The sandbox login lets the sandboxed agent spend your Anthropic
  quota — inherent to it being able to run Claude at all.

- **Secret scrubbing is pattern-based.** It shadows known secret-shaped filenames; a
  secret stored under an unusual name would not be caught. Keep genuinely sensitive
  material outside the mounted root.

---

## Notes for this machine

- The default mount root is all of `~/hyper` (when the project is under it) so that
  cross-repo npm links resolve — e.g. `keet-core-hyperdb` uses a locally-linked
  `brittle` fork at `~/hyper/brittle`. That also means `~/hyper` is the blast radius;
  use `CSANDBOX_ROOT` to narrow it for a one-off. The mount root is also seeded into
  `permissions.additionalDirectories` each launch, so reads/edits of sibling files
  inside the mount but outside the project dir don't trip the "outside working
  directory" trust prompt (Claude otherwise only trusts its launch dir).
- Claude Code's *own* inner bash-sandbox is disabled in `~/.claude-sandbox/settings.json`
  (`sandbox.enabled: false`), because the bwrap/nft layer is the real isolation boundary
  and running both layers was redundant and caused spurious approval gates.
- **Why not `bypassPermissions`?** This account carries an org-managed remote
  setting — `permissions.disableBypassPermissionsMode: "disable"` in
  `~/.claude-sandbox/remote-settings.json`, fetched from Anthropic's server — that
  disables bypass mode account-wide. `--dangerously-skip-permissions` and
  `defaultMode: bypassPermissions` are therefore refused, and Claude falls back to
  `default` mode. The policy can't be stripped from inside the sandbox: it rides the
  same `api.anthropic.com` connection Claude needs, and managed/remote settings
  outrank every local override by design.
- **How prompts are eliminated instead.** In `default` mode a *bare* tool-name allow
  rule auto-approves every use of that tool, so `csandbox` seeds an allow rule for
  each local state-changing tool on every launch —
  `Bash(*)`, `Edit`, `Write`, `WebFetch`, `WebSearch`, `NotebookEdit`, `Monitor`,
  `Workflow`, `Skill`. Each non-Bash tool needs its own rule (`Bash(*)` covers only
  the `Bash` tool), and this applies to subagents too. `Bash(*)` additionally
  suppresses Claude's built-in text-processing (`awk`/`perl`/`sed`) and
  shell-expansion heuristics. Read-only tools never prompt; outward-publishing tools
  (`Artifact`, `ShareOnboardingGuide`) are deliberately left to prompt. This is safe
  because the bwrap/nft layer, not the permission engine, is the actual security
  boundary.
- **Residual prompts that survive even this** (they only relax in true bypass mode,
  which is unavailable here): writes under protected dirs — `.claude`, `.git`,
  `.vscode`, etc. — and the `rm -rf /` / `rm -rf ~` circuit breakers. The protected-dir
  guard is why the agent gets a scratch dir and a `CLAUDE.md` steering it away from
  project `.claude/` dirs (see [File layout](#file-layout)); without bypass mode there
  is no rule that makes those writes prompt-free.
- A fresh `npm install` from GitHub Packages won't work in-sandbox: the auth token
  lives in the host `~/.npmrc`, which is intentionally not mounted. Install on the
  host first, or provide the token explicitly (which reopens authenticated GitHub
  egress — decide per task).
