# wt-hydrate / cross-repo deps — copy-on-write redesign

Status: **proposal; not built.** Replaces `wt-hydrate`'s per-worktree
`node_modules` copy and the `linker` cross-repo model's eager,
worktree-per-dependency creation with a single mechanism: worktrees share
`node_modules` by default (near-zero creation cost), and a specific package
only becomes a real, independent, writable copy when something actually
needs to edit it - at which point, and only then, a real worktree/branch/PR
gets created for its own repo.

## Motivation

Both of this week's disk incidents trace back to the same shape of mistake:
paying a real, non-trivial cost (a full `cp -a` of `node_modules`, or a full
`git worktree add` + hydration of a dependency repo) **eagerly, on every
worktree creation**, regardless of whether that cost was ever going to be
needed:

- `wt-hydrate` clones `node_modules` in full on every worktree creation
  (300-500M+ per worktree, no reflink on ext4 - a real copy every time).
- `linker` goes further: for a *locally-linked* cross-repo dependency, it
  creates an entire additional worktree of the dependency's own repo, pinned
  to a sha, wired in via symlink - so one worktree of repo A can silently
  fan out into worktrees of B, C, D (A's local deps), each independently
  hydrated the same expensive way, recursively for their own local deps.

Neither of those costs buys anything for the (common) case where nothing in
`node_modules` - vendored or locally-linked - actually needs to change.
**Reverse the default**: worktrees share everything until something is
touched, and only what's touched gets materialized.

## Mechanism

**Two verified facts this design rests on, not assumed:**

- A sandboxed process cannot create a new mount mid-session - `CAP_SYS_ADMIN`
  is unconditionally stripped inside bwrap regardless of uid mapping
  (confirmed empirically this week, in the overlayfs investigation). So
  anything that needs to happen *after* the agent decides, mid-session, which
  module to edit has to be a plain filesystem operation - not a bind-mount
  arranged at launch.
- Plain symlink + copy is exactly such an operation, and requires no special
  privilege at all - any unprivileged process can already do it.

**Sharing (near-zero cost, replaces `wt-hydrate`'s copy):** a worktree's
`node_modules` is a real, writable directory, populated with **symlinks**
- one per top-level package - pointing at the corresponding package inside
the *main* worktree's own `node_modules` (no separate "store" abstraction
needed; the main worktree's `node_modules`, kept exactly as it is today via
normal `npm install`, already **is** the canonical copy everything else
should point at). Creating a worktree now costs one symlink per top-level
package - not a byte of `node_modules` gets copied.

**Editing a module (the only point real cost is paid, bounded to what's
touched):** a new command - `wt-edit-module <name>`, run from inside the
worktree - does exactly what "explicitly copies that module" means
literally: `rm node_modules/<name>` (removes the symlink) then
`cp -a $MAIN/node_modules/<name> node_modules/<name>` (a real, independent,
writable copy, local to this worktree only). Nothing else in
`node_modules` is touched; every other package stays a symlink into the main
copy. `require()`/`import` resolution is unaffected either way - a symlinked
package and a real copy both resolve identically from the consumer's
perspective.

**Applying changes (a separate, later step, only for what was actually
edited):** once the hacking is done, `wt-apply-module <name>` diffs the
edited copy against the main worktree's pristine version, and - **for a
locally-linked cross-repo dependency specifically** - creates or reuses a
real worktree of that dependency's own repo, applies the diff there, commits,
and readies it for a PR. This directly replaces `linker`'s current eager,
always-on worktree creation: the dependency only ever gets a real worktree
if a module from it was actually edited, not for every consuming worktree
that merely depends on it.

## Open questions

- **Store-mutation safety.** Symlinking into the main worktree's own
  `node_modules` means every other worktree's shared packages are only
  read-only *by convention*, not enforced by the OS - a bug (an agent
  running plain `npm install` inside a worktree without realizing
  `node_modules` is symlink-based) could silently corrupt the shared copy for
  every worktree at once. Worth deciding whether to `chmod -R a-w` the main
  `node_modules` tree so an accidental write fails loudly (matching how the
  bind-mount test earlier this week showed read-only failing exactly the way
  you'd want - "Read-only file system," not silent corruption) rather than
  relying on discipline alone.
- **Scope: which packages get the apply-a-PR treatment?** The
  "hack on it, then apply to a branch and submit a PR" flow makes sense for
  locally-linked cross-repo dependencies (repos you actually own). It doesn't
  obviously apply to a genuine third-party npm package - there's no branch of
  a random registry package to apply a diff to. Is `wt-edit-module` meant to
  cover both (with the apply step only meaningful/offered for locally-linked
  ones), or is this design specifically about the cross-repo/linker case and
  third-party packages are out of scope entirely?
- **Nested locally-linked dependencies.** If an edited module itself has its
  own `node_modules` with a further locally-linked dependency inside, does
  `wt-edit-module` need to recursively set up the same symlink-into-main
  pattern one level down, or is one level assumed sufficient for now?
- **Main worktree as a single point of failure.** Every other worktree's
  symlinks point directly at the main worktree's `node_modules` - deleting or
  drastically changing it (a fresh `npm install` that removes/renames
  packages) breaks every other worktree's symlinks at once. Worth deciding if
  that's an acceptable tradeoff (the main worktree is already the thing
  nothing should be nesting under or deleting carelessly) or needs a guard.
- **What replaces `linker`'s current always-on wiring, exactly?** `linker`
  today wires a locally-linked dependency in unconditionally at worktree
  creation. This design replaces that with "wire it in as a shared symlink by
  default (via the main worktree's `node_modules`, same as any other
  package), only creating a real dependency worktree lazily via
  `wt-apply-module`." Worth confirming that's a full replacement of what
  `linker` does today, not a parallel mechanism running alongside it.

## What this doesn't try to solve

Nothing here brings back real filesystem-level CoW (the overlayfs route is a
confirmed dead end under bwrap) - this is CoW implemented entirely at the
tooling level, via ordinary symlink/copy operations. That's deliberate: it
needs no kernel privilege, and the cost model - free until touched, then a
real copy bounded to exactly what was touched - is the actual property that
mattered, not the mechanism used to get there.
