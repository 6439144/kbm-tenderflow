# TenderFlow (KBM) — container image for OpenShift / Podman / Docker.
#
#   podman build -f Containerfile -t tenderflow:1.0.0-rc3 \
#     --build-arg TF_VERSION=1.0.0-rc3 --build-arg TF_COMMIT=$(git rev-parse HEAD) \
#     --build-arg TF_BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ) .
#
# Stage 1 (ubi9/nodejs-22) installs every dependency and builds the web app + API.
# Stage 2 (ubi9/nodejs-22-minimal) installs production dependencies only and runs as a non-root user. It works with
# OpenShift's arbitrary UIDs: the process runs with group 0, which owns and can write /data (database for the demo,
# filesystem content store, evidence reports). Everything else is read-only at runtime.
# See deploy/openshift/README.md and docs/INSTALLATION-AND-OPERATIONS.md.

ARG BUILDER_IMAGE=registry.access.redhat.com/ubi9/nodejs-22:latest
ARG RUNTIME_IMAGE=registry.access.redhat.com/ubi9/nodejs-22-minimal:latest

# ---------------------------------------------------------------------------------------------------------- build
FROM ${BUILDER_IMAGE} AS build
WORKDIR /opt/app-root/src
# Manifests first so the dependency layer is cached until package*.json change.
COPY --chown=1001:0 package.json package-lock.json ./
COPY --chown=1001:0 services/api/package.json services/api/package.json
COPY --chown=1001:0 apps/web/package.json apps/web/package.json
RUN npm ci --no-audit --no-fund
COPY --chown=1001:0 tsconfig.base.json ./
COPY --chown=1001:0 scripts scripts
COPY --chown=1001:0 services/api services/api
COPY --chown=1001:0 apps/web apps/web
RUN npm run build

# -------------------------------------------------------------------------------------------------------- runtime
FROM ${RUNTIME_IMAGE}
ARG TF_VERSION=1.0.0-rc3
ARG TF_COMMIT=
ARG TF_BUILD_TIME=

LABEL name="kbm/tenderflow" \
      version="${TF_VERSION}" \
      release="${TF_VERSION}" \
      vendor="KBM" \
      maintainer="KBM (Khorafi Business Machines)" \
      summary="TenderFlow - government e-tendering (API + web)" \
      description="TenderFlow e-tendering platform: sealed bids, approval chains, IBM FileNet content, IBM watsonx Orchestrate advisory agents." \
      io.k8s.display-name="TenderFlow" \
      io.k8s.description="TenderFlow e-tendering platform (API + web) by KBM" \
      io.openshift.tags="tenderflow,e-tendering,nodejs" \
      io.openshift.expose-services="4000:http" \
      org.opencontainers.image.title="TenderFlow" \
      org.opencontainers.image.vendor="KBM" \
      org.opencontainers.image.version="${TF_VERSION}" \
      org.opencontainers.image.revision="${TF_COMMIT}" \
      org.opencontainers.image.created="${TF_BUILD_TIME}"

WORKDIR /opt/app-root/src
COPY --chown=1001:0 package.json package-lock.json ./
COPY --chown=1001:0 services/api/package.json services/api/package.json
COPY --chown=1001:0 apps/web/package.json apps/web/package.json
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=build --chown=1001:0 /opt/app-root/src/services/api/dist services/api/dist
COPY --from=build --chown=1001:0 /opt/app-root/src/apps/web/dist apps/web/dist
COPY --chown=1001:0 services/api/migrations services/api/migrations
# Demo seed files (SEED_DEMO=true only) and the Orchestrate agent definitions used by `verify:ai` / `evals`.
COPY --chown=1001:0 seed seed
COPY --chown=1001:0 agents agents

# /data: writable by group 0 (OpenShift runs the container with an arbitrary UID in group 0).
USER 0
RUN mkdir -p /data/evidence && chown -R 1001:0 /data && chmod -R g=u /data
USER 1001

ENV NODE_ENV=production \
    PORT=4000 \
    DATA_DIR=/data \
    TF_EVIDENCE_DIR=/data/evidence \
    NPM_CONFIG_CACHE=/tmp/.npm \
    TF_VERSION=${TF_VERSION} \
    TF_COMMIT=${TF_COMMIT} \
    TF_BUILD_TIME=${TF_BUILD_TIME}

EXPOSE 4000
# Docker / Podman (--format docker) only; OpenShift uses the Deployment's startup/readiness/liveness probes.
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

# node as PID 1 (not npm): SIGTERM reaches the app, which drains and exits within the grace period.
CMD ["node", "services/api/dist/server.js"]
