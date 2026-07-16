FROM node:24-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    git-lfs \
    curl \
    ca-certificates \
    build-essential \
    python3 \
    pkg-config \
    cmake \
    ripgrep \
    jq \
    less \
    procps \
    openssh-client \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code

# --- auto-hydrate node_modules in new git worktrees ----------------------
# Parallel worktree subagents each need node_modules, but none of them should
# need npm egress. A post-checkout hook clones node_modules from the repo's
# main worktree (copy-on-write where the fs supports it) whenever a worktree is
# created. Installed via a system-wide core.hooksPath so it applies to every
# repo in the mounted workspace without touching per-repo .git/hooks or the
# host's ~/.gitconfig (which is bind-mounted read-only). Note: if your host
# ~/.gitconfig sets its own core.hooksPath, that global value wins over this
# system one and the hook won't run.
COPY git-hooks/post-checkout /usr/local/share/git-hooks/post-checkout
COPY git-hooks/wt-hydrate /usr/local/bin/wt-hydrate
COPY git-hooks/csbox-enter-repo /usr/local/bin/csbox-enter-repo
RUN chmod +x /usr/local/share/git-hooks/post-checkout /usr/local/bin/wt-hydrate \
      /usr/local/bin/csbox-enter-repo \
 && git config --system core.hooksPath /usr/local/share/git-hooks

# the node image ships a "node" user with uid/gid 1000, matching the host
# user, so files written into the mounted workspace keep correct ownership
USER node
WORKDIR /workspace

ENV CLAUDE_CONFIG_DIR=/home/node/.claude
# the image's global npm dir is root-owned; self-update can't work anyway
ENV DISABLE_AUTOUPDATER=1

CMD ["bash"]
