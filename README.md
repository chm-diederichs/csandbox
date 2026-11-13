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
csandbox . --continue          # unknown args are passed to `claude`
csandbox --profile dev .       # allow npm + git + pypi for this session
csandbox --tenant work .       # a second Claude account: own config dir, login, proxy port
csandbox --help                # every flag, and the env var each one defaults from
```

The sandbox has its **own login**, stored in `~/.claude-sandbox` (copying the
host credentials doesn't survive: OAuth refresh tokens rotate, so a seeded copy
dies as soon as the host client refreshes). First run only:

```bash
csandbox --profile login .     # then /login inside
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
2. **`--profile`** (`CSANDBOX_PROFILE`) — one or more comma-separated profiles (default `minimal`).
3. **`--allow`** (`CSANDBOX_EXTRA_DOMAINS`) — comma-separated one-off additions, repeatable.

The resolved allowlist is printed at launch, and any hosts **blocked during the
session are reported on exit**, with the exact `--allow …` needed to allow them
next time.

### Profiles

| Profile   | Adds                                                                                     |
| --------- | ---------------------------------------------------------------------------------------- |
| `minimal` | *(nothing beyond the base)* — for running / testing / analyzing already-installed code   |
| `node`    | `registry.npmjs.org`, `registry.yarnpkg.com`                                              |
| `git`     | `github.com`, `codeload.github.com`, `raw.githubusercontent.com`, `objects.githubusercontent.com`, `gist.githubusercontent.com` |
| `python`  | `pypi.org`, `files.pythonhosted.org`                                                      |
| `dev`     | `node` + `git` + `python` (general coding with installs)                                  |
| `login`   | `claude.ai`, for the `/login` browser flow - a tenant's first run only                    |
| `open`    | every hostname, through the proxy. TCP only: UDP/P2P (Hyperswarm, QUIC) is a separate switch - see `--udp` below |

Profiles combine: `--profile node,git`.

```bash
csandbox .                                 # minimal: Anthropic only
csandbox --profile node .                  # + npm/yarn
csandbox --profile dev .                   # + npm/yarn/github/pypi
csandbox --allow example.com .             # one-off host
```

Why isn't npm/github in the default? They live on **shared CDNs** (Cloudflare /
Fastly) that a hostname-only proxy cannot make front-proof, so they are opt-in per
workflow rather than always-on. `minimal` is genuinely fronting-resistant; broader
profiles trade some of that for convenience.

`open` drops hostname filtering altogether (the launch line says so loudly): use
it for a one-off that needs arbitrary HTTPS hosts. It is still **TCP through the
proxy** - a UDP or holepunched P2P socket has no hostname to allow and never
reaches the proxy, so Hyperswarm-style traffic needs `--udp`, not a profile.

### UDP (`--udp local|open`, bwrap only)

UDP is blocked by default and no profile changes that. `--udp` launches the
session into a child slice of `csandbox.slice` that has one extra nft accept;
every TCP restriction still applies.

| Mode    | Allows                                                                 | Use for |
| ------- | ---------------------------------------------------------------------- | ------- |
| `local` | UDP to loopback (`127.0.0.0/8`, `::1`) except port 53, so the resolver stub can't be used to tunnel out through DNS | local DHT testnets, brittle tests |
| `open`  | all outbound UDP - **bypasses the proxy and the hostname allowlist**   | joining a real swarm, holepunching |

```bash
csandbox --udp local .     # testnets on localhost; nothing leaves the machine
csandbox --udp open .      # real P2P; the launch line warns
```

The slices and rules come from `bwrap-setup`; csandbox refuses `--udp` until it
has been re-run since this was added. Dropped UDP never reaches the proxy, so it
is not in the blocked-hosts report on exit.

---

## Flags and environment variables

Per-invocation choices are flags. Every flag has an environment variable as its
default, so a shell profile can pin a preference, and the variable is what hooks
and subprocesses inside the sandbox see. Flags are recognised anywhere in the
argument list; anything else passes through to `claude`. `csandbox --help`
prints the same table.

| Flag                      | Env var                   | Effect                                                                                  |
| ------------------------- | ------------------------- | --------------------------------------------------------------------------------------- |
| `--profile <p[,p]>`       | `CSANDBOX_PROFILE`        | Egress profile(s). Default `minimal` (`node` / `git` / `python` / `dev` / `login` / `open`).               |
| `--allow <host[,host]>`   | `CSANDBOX_EXTRA_DOMAINS`  | Extra hosts to allow on top of the profile(s); repeatable.                              |
| `--udp <local\|open>`     | `CSANDBOX_UDP`            | Allow UDP: `local` = loopback minus DNS, `open` = all outbound. bwrap only.             |
| `--root <dir>`            | `CSANDBOX_ROOT`           | Workspace root to mount; **remembered per tenant** in `<config>/root` and applied to every later run of that tenant (delete the file to forget). Default: `~/hyper` when the project is under it, else the project dir. A run started outside the root with no project dir lands at the root. |
| `--readonly`              | `CSANDBOX_READONLY=1`     | Mount the workspace read-only.                                                          |
| `--tenant <name>`         | `CSANDBOX_TENANT`         | Second Claude account: config dir `~/.claude-sandbox-<name>`, own login and proxy port. |
| `--config-dir <dir>`      | `CSANDBOX_CONFIG_DIR`     | Explicit config dir (wins over the tenant name). Pair with `--proxy-port`.              |
| `--proxy-port <n>`        | `CSANDBOX_PROXY_PORT`     | This tenant's egress proxy port. Default tenant 8888; named tenants are allocated one from the range `bwrap-setup` opened. |
| `--edit-gate`             | `CSANDBOX_EDIT_GATE=1`    | Opt-in hook: the first edit to an existing source file is refused once with a fact request. Off by default. |
| `--shell`                 | `CSANDBOX_SHELL=1`        | Drop into `bash` inside the sandbox instead of launching `claude`.                      |
| `--dry-run`               | `CSANDBOX_DRYRUN=1`       | Print the resolved config (mounts, allowlist) and exit without launching.               |
| `down` (subcommand)       | `CSANDBOX_DOWN=1`         | Stop this tenant's egress proxy, then exit.                                             |

Machine configuration is environment-only:

| Variable                 | Effect                                                                                  |
| ------------------------ | --------------------------------------------------------------------------------------- |
| `CSANDBOX_BACKEND`       | `bwrap` (Linux) or `seatbelt` (macOS); defaults by OS.                                  |


---

## File layout

```
claude-sandbox/
├── README.md            # this file
├── csandbox             # the launcher (symlinked into ~/.local/bin)
├── bwrap-setup          # one-time root setup (AppArmor profile, slice, nft rule)
├── docs/DESIGN.md       # architecture, decision log, what was removed and why
├── bin/
│   └── csbox-enter-repo # worktree a repo pinned to this session's snapshot
├── csbox-sessions       # searchable index over session transcripts (fzf picker)
├── claude-hooks/        # Claude Code lifecycle hooks, mounted + registered per launch
│   ├── edit-gate              # PreToolUse (opt-in, CSANDBOX_EDIT_GATE=1): first edit asks for importers/exports/formats once
├── skills/              # harness-level skills, copied into the sandbox config each launch (docs/DESIGN.md)
│   ├── autonomous-preflight/  # goal/done/boundary block before any unattended run or fan-out
│   ├── strict-review/         # reviewer brief: cite line + trigger or drop the finding
│   ├── hunt-silent-failures/  # swallowed errors, streams/emitters that drop them
│   ├── tdd-brittle/           # RED gate that must actually run and fail for the right reason
│   └── perf-loop/             # bounded measure→variant→promote loop
└── egress-proxy/
    └── proxy.js         # allowlist-enforcing forward proxy (no deps), run directly by bwrap
```

State lives outside this dir in `~/.claude-sandbox/` — the sandbox's `~/.claude`
config dir (credentials, session history). It's created automatically; the login
inside it is the sandbox's own (see Quick start). A named tenant gets its own
such dir, `~/.claude-sandbox-<name>` (see [Multiple accounts](#multiple-accounts-tenants)).
Per-user state the agent can never see lives in `~/.local/share/csandbox/`
(wrapper scripts, hook copies, per-port proxy state).

The agent also gets a persistent scratch dir: `~/.claude-sandbox/scratch` on the
host, bind-mounted at the same path inside the sandbox (bwrap reuses real host
paths rather than remapping them). A seeded global `CLAUDE.md` points the agent
there instead of at project `.claude/` dirs, whose writes always trigger Claude
Code's hardcoded self-config approval prompt (it survives even
`--dangerously-skip-permissions` + `Bash(*)`).

---

## Worktrees

csandbox has no worktree rule of its own: the agent works in your checked-out
tree and follows Claude Code's stock worktree behavior, creating one only when
you ask. `--worktree` is not a csandbox flag: put it after the project dir
(`csandbox . --worktree`) and it reaches Claude Code's own `--worktree`.
Before the dir it would swallow the dir as the worktree's name. When the agent does call `EnterWorktree`, the seeded
`worktree.baseRef: "head"` branches it from the current commit.

---

## Parallel worktree agents

The top-level agent can fan out to many subagents in parallel, each in its own
git worktree (`Agent(isolation: "worktree")`), all inside the one sandbox.
Worktrees don't inherit `node_modules` (it's gitignored), but the parallel phase
should be **network-quiet** — no subagent should hit the npm registry.

So csandbox seeds `worktree.symlinkDirectories: ["node_modules"]` into the
sandbox `settings.json`, and Claude Code symlinks `node_modules` from the main
checkout into every worktree it creates — instant, offline, and no disk cost.
This replaced a `post-checkout` git hook that copied `node_modules` per
worktree: its `cp --reflink=auto` is GNU-only, so on macOS it degraded to a
full 300-500MB copy each time. Worktrees now share one `node_modules`, which is
fine since nothing pins deps per worktree any more.

The one case that still needs the network is a subagent **adding a new
dependency** — that's a registry fetch, so it surfaces at the egress proxy
rather than happening silently. Keep the parallel phase to work that uses the
already-installed deps.

The top-level agent is told all this via the seeded global `CLAUDE.md` (a
"Parallel worktree subagents" section), so it fans out correctly without
re-installing deps or reaching for the network mid-run.

## Multiple accounts (tenants)

A tenant is a separate Claude Code config dir, which is exactly the boundary
Claude Code draws around an account: with `CLAUDE_CONFIG_DIR` set it keeps the
OAuth login, the account/org ids, settings, sessions and the cached
server-managed org policy under that dir, and under bwrap the host `~/.claude`
is not mounted at all, so tenants can't see each other. Everything else is per
user and shared: the workspace mount, the systemd slice and nft rule, and the
wrapper scripts.

```bash
csandbox --tenant work --root ~/work .                    # ~/.claude-sandbox-work, scoped to ~/work from now on
csandbox --tenant work --profile login .                  # first run: /login inside
claude setup-token > ~/.claude-sandbox-work/oauth-token   # or: a one-year token, no login inside
csandbox --tenant work                                    # later: from anywhere, lands in ~/work
```

A tenant can be **scoped to a workspace root**: `--root` is remembered in the
tenant's config dir and applies to every later run, so a tenant for one
client's code only ever mounts that tree. `CSANDBOX_ROOT` in the environment
overrides it for a run without rewriting it; `--root` again replaces it.

Each tenant runs its **own egress proxy on its own loopback port**, so tenants
with different allowlists don't restart each other's proxy: the default tenant
uses 8888, a named tenant is allocated the next free port in the range
`bwrap-setup` opened in the nft rule (default `8888-8899`, recorded in
`/etc/csandbox/proxy-ports`) and remembers it in `<config>/proxy-port`.
A setup that predates this needs one re-run: `sudo ./bwrap-setup`
(`CSANDBOX_PROXY_PORTS=8888-8919` for more tenants). `csandbox down --tenant work`
stops that tenant's proxy only.

Two credentials paths: a browser `/login` inside the sandbox (refresh token
rotates, renew about monthly for unattended use), or a one-year token from
`claude setup-token` stored in `<config>/oauth-token` (mode 600), exported as
`CLAUDE_CODE_OAUTH_TOKEN` for that tenant only - model requests only, no Remote
Control or claude.ai connectors. Host-side `ANTHROPIC_API_KEY`,
`ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_PROFILE` are
stripped from every tenant's environment, since Claude Code ranks them above a
stored login. Note that server-managed org policy is per account, so two
tenants in different organizations can behave differently (e.g. bypass mode).

Two tenants running concurrently in the same repo edit the same working tree by
default; ask for a worktree (or run `csandbox . --worktree`) for concurrent
runs.

## Skills and rules

Harness-level skills live in `skills/<name>/SKILL.md` and are copied into the
sandbox config dir on every launch, where Claude Code discovers them
(`autonomous-preflight`, `strict-review`, `hunt-silent-failures`,
`tdd-brittle`, `perf-loop`). Three short
always-on rules are seeded into the sandbox `CLAUDE.md`: the worker contract
(final message is the deliverable, never end a turn with children running, one
task then stop), a lane table before fanning out (parallel only when write
surfaces don't collide). An opt-in edit gate (`CSANDBOX_EDIT_GATE=1`) adds a
`PreToolUse` hook that refuses the first edit to an existing source file once
per session until the agent lists the module's importers across the workspace,
the exports it touches and any formats involved. It is off by default: agents
were observed treating the refusal as done and moving on without the edit. How
skills are written, placed and tested: `docs/DESIGN.md`.

---

## Setup / installation

Already installed on this machine. To reproduce elsewhere:

```bash
# 1. one-time root setup: AppArmor profile, persistent systemd slice, nft rule
sudo ~/hyper/claude-sandbox/bwrap-setup

# 2. put the launcher on PATH
ln -sf ~/hyper/claude-sandbox/csandbox ~/.local/bin/csandbox

```

Requires: Linux, with `bubblewrap`, `nftables`, `apparmor`, and a systemd user
session (see `bwrap-setup`'s header for exactly why each is needed). `bwrap-setup`
opens loopback ports `8888-8899` for the sandbox slice (one per tenant); set
`CSANDBOX_PROXY_PORTS=MIN-MAX` when running it to change that. On first
launch, log the sandbox in with `csandbox --profile login .` then `/login`
inside.

---

## Maintenance

- **Changing the proxy:** there's no build step — `egress-proxy/proxy.js` runs
  directly via `node`. The launcher reuses a running proxy instance unless the
  resolved allowlist changed since it started, restarting it otherwise; to force
  a restart regardless (e.g. after editing `proxy.js`), tear it down first.

- **Update the Claude Code version:** it's whatever `claude` resolves to on the
  host `PATH` (bwrap bind-mounts the host's node/claude install read-only,
  autoupdater disabled inside the sandbox) — update it on the host as usual.

- **Tear down the running proxy:** `csandbox down` (add `--tenant <name>` for a tenant's).

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

- **`--udp open` is unfiltered.** UDP has no hostname to allowlist, so open mode
  lets the session send UDP anywhere, including DNS. Prefer `--udp local` when
  the peers are on this machine. Not available on the seatbelt (macOS) backend.

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
