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
└── egress-proxy/
    ├── Dockerfile       # tiny node:alpine image for the proxy
    └── proxy.js         # allowlist-enforcing forward proxy (no deps)
```

State lives outside this dir in `~/.claude-sandbox/` — the container's `~/.claude`
config dir (credentials, session history). It's created automatically; the login
inside it is the sandbox's own (see Quick start).

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
  use `CSANDBOX_ROOT` to narrow it for a one-off.
- Claude Code's *own* inner bash-sandbox is disabled in `~/.claude-sandbox/settings.json`
  (`sandbox.enabled: false`), because the container is the real isolation boundary and
  running both layers was redundant and caused spurious approval gates.
- `--dangerously-skip-permissions` does **not** bypass everything: Claude Code has
  several built-in, hardcoded checks that survive it — a heuristic that always asks
  before `awk`/`perl`/regex-addressed `sed` (any general text-processing tool capable
  of in-place edits), a shell-AST hook that blocks unquoted `$var`/`$(...)` expansions
  in constructs like `for` loops (`Contains simple_expansion`), and first-use
  network-domain approval. A bare `Bash(*)` allow rule is special-cased and suppresses
  all of these (verified empirically — narrower rules like `Bash(sed:*)` or
  `Bash(for *)` do **not**). `csandbox` seeds `permissions.allow: ["Bash(*)"]` into
  `~/.claude-sandbox/settings.json` automatically on every launch. This is safe here
  specifically because the Docker layer, not Claude's permission engine, is the actual
  security boundary.
- A fresh `npm install` from GitHub Packages won't work in-sandbox: the auth token
  lives in the host `~/.npmrc`, which is intentionally not mounted. Install on the
  host first, or provide the token explicitly (which reopens authenticated GitHub
  egress — decide per task).
