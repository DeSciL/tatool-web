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

# Create the runtime user before any COPY, so that COPY --chown can resolve it below.
#
# This used to be a trailing `chown -R nodejs:nodejs /app`, which rewrote the ownership of every
# file it touched and therefore duplicated all of them into a new layer - 246 MB of the image was
# a second copy of node_modules and the task batteries. Setting ownership at copy time costs
# nothing.
# -G nodejs is load-bearing: without it the user's primary group defaults to nogroup (65533), which
# does not match COPY --chown or the manifest's runAsGroup: 1001.
RUN addgroup -g 1001 -S nodejs && \
    adduser -S -G nodejs -u 1001 nodejs

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install only production dependencies. Left root-owned on purpose: node_modules is only ever read
# at runtime, so the runtime user does not need to own it.
RUN npm ci --omit=dev

# Copy built application from builder stage
COPY --chown=nodejs:nodejs --from=builder /app/dist ./dist
COPY --chown=nodejs:nodejs --from=builder /app/app ./app
COPY --chown=nodejs:nodejs --from=builder /app/controllers ./controllers
COPY --chown=nodejs:nodejs --from=builder /app/models ./models
COPY --chown=nodejs:nodejs --from=builder /app/views ./views
COPY --chown=nodejs:nodejs --from=builder /app/server.js ./server.js
COPY --chown=nodejs:nodejs --from=builder /app/projects.json ./projects.json
# Needed to provision the initial accounts in-cluster (kubectl exec / a one-shot Job),
# since self-registration is disabled. seed-content.js does the same for projects and modules — a
# fresh database shows nothing in the UI until it has run.
COPY --chown=nodejs:nodejs --from=builder /app/seed-users.js ./seed-users.js
COPY --chown=nodejs:nodejs --from=builder /app/seed-content.js ./seed-content.js

# Participant CSVs are written to the relative path uploads/<mode>/<moduleId>/, so this must exist
# and be writable by the runtime user. In Kubernetes it is a mounted volume and this is redundant,
# but plain `docker run` without a volume depends on it.
RUN mkdir -p uploads && chown nodejs:nodejs uploads

USER nodejs

# Build version, surfaced at /healthz so the running version is verifiable from outside without
# cluster access. docker-ci.yml already passes --build-arg VERSION=<tag>. Declared this late so it
# does not invalidate the dependency layers above.
ARG VERSION=dev
ENV APP_VERSION=${VERSION}

# Expose the application port
EXPOSE 3000

# Health check. Note this probes '/', which returns 200 even when the database is unreachable, so
# it is not a real readiness signal - it only exists for plain `docker run`. Kubernetes ignores
# Docker healthchecks; the manifests use /healthz and /readyz instead.
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/healthz', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start node directly rather than via `npm start`, so node is PID 1.
#
# With npm as PID 1, SIGTERM reached npm, npm forwarded it, node died of the signal, and npm then
# reported its child's signal death as a failure - emitting "npm error signal SIGTERM" on stderr and
# exiting non-zero on every single rollout. Log collection tagged that as error level, so the only
# signal this workload reliably produced was a false-positive error per restart. Shutdown timing was
# never the problem; the exit code and the noise were.
#
# Being PID 1 is also what makes the SIGTERM handler in server.js behave predictably.
CMD ["node", "server.js", "server", "prod"]
