FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates python3 make g++ && rm -rf /var/lib/apt/lists/*

# Configure git to use HTTPS instead of git+ssh
RUN git config --global url."https://github.com/".insteadOf "git+https://github.com/" && \
    git config --global url."https://github.com/".insteadOf "git://github.com/"

RUN npm install -g openclaw@latest

# Install the prebuilt local Owletto CLI so the container matches the repo's OpenClaw flow.
WORKDIR /owletto-cli
COPY packages/cli/package.json ./
COPY packages/cli/dist ./dist
RUN npm install -g .

# Copy and build the owletto plugin
WORKDIR /plugin
COPY packages/owletto-openclaw/package.json packages/owletto-openclaw/tsconfig.json ./
COPY packages/owletto-openclaw/src ./src
COPY packages/owletto-openclaw/openclaw.plugin.json ./
RUN npm install && npm run build

# Set up openclaw home
RUN useradd -m -s /bin/bash openclaw
USER openclaw
WORKDIR /home/openclaw
ENV HOME=/home/openclaw

# Openclaw config
RUN mkdir -p .openclaw
COPY --chown=openclaw:openclaw docker/openclaw/openclaw.json .openclaw/openclaw.json

EXPOSE 18789

CMD ["openclaw", "gateway", "--port", "18789"]
