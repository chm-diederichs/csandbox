# csandbox

A hardened Docker sandbox for running **Claude Code with `--dangerously-skip-permissions`
fully autonomously** — no approval prompts — while removing the "exfiltrate to an
arbitrary host" risk that skip-permissions + open network would otherwise create.

`csandbox` is the launcher. It runs Claude Code inside a container that:

- has **no direct route to the internet** — all egress is forced through a proxy
  sidecar that only allows an explicit domain allowlist;
- runs as a **non-root user** (uid 1000), no added capabilities;
- **never mounts the docker socket** (mounting it is a full host escape);
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
        ┌─────────────────────────────────────────────┐
        │  internal network  (no route to internet)    │
        │                                              │
        │   ┌────────────┐        ┌────────────────┐   │
        │   │  sandbox   │ ─────▶ │     proxy      │ ──┼──▶ internet
        │   │ (claude)   │  only  │ (allowlist     │   │    (allowlisted
        │   └────────────┘  path  │  CONNECT only) │   │     hosts only)
        │                  out    └────────────────┘   │
        └─────────────────────────────────────────────┘
                                   │
                        also on the `egress` network
```

The `sandbox` container is attached **only** to an `internal: true` Docker network,
so it cannot reach the internet directly. The `proxy` sidecar is the sole member of
both the internal network and an outward-facing `egress` network, so the only way
out is through it. The proxy (a small dependency-free Node script) permits `CONNECT`
tunnels and HTTP requests **only** to hostnames on the allowlist and returns `403`
for everything else.

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
| `CSANDBOX_DOWN=1`        | Stop the proxy sidecar and remove the networks, then exit.                              |

---

## File layout

```
claude-sandbox/
├── README.md            # this file
├── csandbox             # the launcher (symlinked into ~/.local/bin)
├── Dockerfile           # the sandbox image (node + build tools + claude code)
├── docker-compose.yml   # wires the sandbox + proxy + internal/egress networks
├── git-hooks/
│   ├── post-checkout   # fires on `git worktree add`; auto-hydrates node_modules
│   └── wt-hydrate      # clones node_modules from the main worktree (CoW), offline
└── egress-proxy/
    ├── Dockerfile       # tiny node:alpine image for the proxy
    └── proxy.js         # allowlist-enforcing forward proxy (no deps)
```

State lives outside this dir in `~/.claude-sandbox/` — the container's `~/.claude`
config dir (credentials, session history). It's created automatically; the login
inside it is the sandbox's own (see Quick start).

The agent also gets a persistent scratch dir: `~/.claude-sandbox/scratch` on the
host, mounted at `/home/node/scratch` in the container. A seeded global
`CLAUDE.md` points the agent there instead of at project `.claude/` dirs, whose
writes always trigger Claude Code's hardcoded self-config approval prompt (it
survives even `--dangerously-skip-permissions` + `Bash(*)`).

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
git worktree (`Agent(isolation: "worktree")`), all inside the one container.
Worktrees don't inherit `node_modules` (it's gitignored), but the parallel phase
should be **network-quiet** — no subagent should hit the npm registry.

So a system-wide `post-checkout` git hook (`git-hooks/`, installed via
`core.hooksPath` in the image) fires whenever a worktree is created and clones
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

---

## Setup / installation

Already installed on this machine. To reproduce elsewhere:

```bash
# 1. build the images
docker compose -f ~/hyper/claude-sandbox/docker-compose.yml -p claude-sandbox build

# 2. put the launcher on PATH
ln -sf ~/hyper/claude-sandbox/csandbox ~/.local/bin/csandbox
```

Requires: Docker with the Compose plugin. On first launch, log the sandbox in
with `CSANDBOX_EXTRA_DOMAINS=claude.ai csandbox .` then `/login` inside.

---

## Maintenance

- **Rebuild after changing the Dockerfile or proxy:**
  ```bash
  docker compose -f ~/hyper/claude-sandbox/docker-compose.yml -p claude-sandbox build
  ```
  (The launcher also builds quietly on each run, so a manual rebuild is only needed
  to force a fresh pull.)

- **Update the Claude Code version:** it's pinned at image build time (installed
  globally, autoupdater disabled). Rebuild the image to pick up a new release.

- **Tear down the running proxy:** `CSANDBOX_DOWN=1 csandbox`.

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
  (`sandbox.enabled: false`), because the container is the real isolation boundary and
  running both layers was redundant and caused spurious approval gates.
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
  because the Docker layer, not the permission engine, is the actual security
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
