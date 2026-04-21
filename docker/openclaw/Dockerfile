FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates python3 make g++ && rm -rf /var/lib/apt/lists/*

# Configure git to use HTTPS instead of git+ssh
RUN git config --global url."https://github.com/".insteadOf "git+https://github.com/" && \
    git config --global url."https://github.com/".insteadOf "git://github.com/"

# Install OpenClaw only. The plugin handles auth itself, so the container
# does not need a host-built local CLI to start correctly.
RUN npm install -g openclaw@latest

# Copy and build the owletto plugin
WORKDIR /plugin
COPY packages/owletto-openclaw/package.json packages/owletto-openclaw/tsconfig.json ./
COPY packages/owletto-openclaw/src ./src
COPY packages/owletto-openclaw/openclaw.plugin.json ./
RUN npm install && npm run build

# Seed defaults outside mounted directories so first compose startup can
# populate ~/.openclaw even when the bind mounts start empty.
RUN mkdir -p /usr/local/share/openclaw/openclaw-owletto/dist \
    && cp -R /plugin/dist/. /usr/local/share/openclaw/openclaw-owletto/dist/ \
    && cp /plugin/openclaw.plugin.json /usr/local/share/openclaw/openclaw-owletto/openclaw.plugin.json
COPY docker/openclaw/openclaw.json /usr/local/share/openclaw/openclaw.json
COPY docker/openclaw/start.sh /usr/local/bin/openclaw-start
RUN chmod +x /usr/local/bin/openclaw-start

# Set up openclaw home
RUN useradd -m -s /bin/bash openclaw
USER openclaw
WORKDIR /home/openclaw
ENV HOME=/home/openclaw

EXPOSE 18789

CMD ["openclaw-start"]
