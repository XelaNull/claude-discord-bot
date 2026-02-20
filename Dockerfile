FROM node:22-slim

# Install git (needed for repo cloning) and other useful tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Configure git
RUN git config --global user.name "Claude Discord Bot" \
    && git config --global user.email "bot@claude-discord-bot"

WORKDIR /app

# Install dependencies first (cache layer)
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev

# Copy source code
COPY . .

# Create scratch space
RUN mkdir -p /tmp/claude-scratch

ENV NODE_ENV=production
ENV SCRATCH_DIR=/tmp/claude-scratch
ENV BOT_SOURCE_DIR=/app

CMD ["node", "src/index.js"]
