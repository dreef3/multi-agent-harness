FROM node:20.18-slim

RUN apt-get update && apt-get install -y \
    git \
    openjdk-17-jdk-headless \
    maven \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @mariozechner/pi-coding-agent

RUN git config --global credential.helper "store --file /run/secrets/git-credentials"

WORKDIR /workspace

ENTRYPOINT ["pi", "--rpc"]
