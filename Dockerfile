FROM node:22-slim

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
# mcp-use's listen() defaults to localhost; in a container we must
# bind to all interfaces so the port mapping reaches the process.
ENV HOST=0.0.0.0

COPY package.json package-lock.json ./
RUN npm ci && npm cache clean --force

COPY tsconfig.json ./
COPY src ./src

RUN chown -R node:node /app
USER node

EXPOSE 3000

CMD ["npm", "start"]
