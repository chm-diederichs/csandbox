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

# the node image ships a "node" user with uid/gid 1000, matching the host
# user, so files written into the mounted workspace keep correct ownership
USER node
WORKDIR /workspace

ENV CLAUDE_CONFIG_DIR=/home/node/.claude
# the image's global npm dir is root-owned; self-update can't work anyway
ENV DISABLE_AUTOUPDATER=1

CMD ["bash"]
