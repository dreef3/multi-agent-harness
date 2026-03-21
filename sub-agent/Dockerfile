FROM oven/bun:1

RUN apt-get update && apt-get install -y \
    git \
    default-jdk \
    maven \
    && rm -rf /var/lib/apt/lists/*

RUN bun install -g @mariozechner/pi-coding-agent

RUN git config --global credential.helper "store --file /run/secrets/git-credentials"

WORKDIR /workspace

ENTRYPOINT ["pi", "--rpc"]
