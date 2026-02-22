FROM node:20-slim

RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Claude CLI when no API key is set (Max subscription routing)
ARG HAS_API_KEY=false
RUN if [ "$HAS_API_KEY" != "true" ]; then \
      npm install -g @anthropic-ai/claude-code && \
      npm cache clean --force; \
    fi

COPY package*.json ./
RUN npm ci --production

COPY . .

CMD ["node", "index.js"]
