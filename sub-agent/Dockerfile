FROM oven/bun:1

RUN apt-get update && apt-get install -y \
    git \
    default-jdk \
    maven \
    && rm -rf /var/lib/apt/lists/*

RUN bun install -g @mariozechner/pi-coding-agent

RUN git config --system credential.helper "store --file /run/secrets/git-credentials"

RUN mkdir -p /workspace /pi-agent && chown bun:bun /workspace /pi-agent

WORKDIR /workspace

ENV PI_CODING_AGENT_DIR=/pi-agent

USER bun

ENTRYPOINT ["pi", "--rpc"]
