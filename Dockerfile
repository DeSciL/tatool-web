# Multi-stage build for tatool-web

# Node 26 is the 'current' line; it becomes Active LTS in October 2026. Until then, fall back with
# a single flag if anything misbehaves: docker build --build-arg NODE_VERSION=24 .
# (24 is today's Active LTS, i.e. what node:lts resolves to.)
ARG NODE_VERSION=26

# Stage 1: Build
FROM node:${NODE_VERSION}-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (including devDependencies for build).
# npm ci installs exactly what package-lock.json pins, so a rebuild of a given tag is reproducible.
RUN npm ci

# Copy source code
COPY . .

# Build the application
RUN npm run build

# Stage 2: Production
FROM node:${NODE_VERSION}-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install only production dependencies
RUN npm ci --omit=dev

# Copy built application from builder stage
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/app ./app
COPY --from=builder /app/controllers ./controllers
COPY --from=builder /app/models ./models
COPY --from=builder /app/views ./views
COPY --from=builder /app/server.js ./server.js
COPY --from=builder /app/projects.json ./projects.json
# Needed to provision the initial accounts in-cluster (kubectl exec / a one-shot Job),
# since self-registration is disabled.
COPY --from=builder /app/seed-users.js ./seed-users.js

# Create a non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 && \
    chown -R nodejs:nodejs /app

USER nodejs

# Expose the application port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start the application
CMD ["npm", "start"]
