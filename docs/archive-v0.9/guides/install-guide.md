# TenderFlow v0.9.0 — Installation & Deployment Guide

This guide describes how to deploy TenderFlow on a clean virtual machine (Ubuntu 22.04 LTS / RHEL 9) using the automated installer or Docker Compose.

---

## 1. System Requirements

- **Operating System**: Linux (Ubuntu 20.04+, RHEL 8/9, Rocky Linux) or macOS/Windows (Docker Desktop)
- **CPUs**: 4 vCPUs minimum (8 vCPUs recommended)
- **Memory**: 8 GB RAM minimum (16 GB recommended)
- **Disk Storage**: 50 GB available SSD space
- **Network**: Port 80 (HTTP Gateway), Port 4000 (API), Port 8080 (Keycloak), Port 8025 (Mailpit)

---

## 2. One-Command Quickstart (Recommended)

From a fresh clone of the repository, execute:

```bash
chmod +x deploy/install.sh
./deploy/install.sh
```

The installer performs the following automated steps:
1. Validates Docker and Docker Compose plugin installation.
2. Creates `.env` from `.env.example` if not present.
3. Builds container images (`deploy/Dockerfile.api`).
4. Starts PostgreSQL 16, Keycloak 24, Mailpit, TenderFlow API, and NGINX Reverse Proxy.
5. Polls the `/health` endpoint until the system is ready.

---

## 3. Manual Deployment via Docker Compose

```bash
cp .env.example .env
# Edit .env with your environment settings

docker compose -f deploy/docker-compose.yml up -d --build
```

---

## 4. Verification

Verify that all containers are healthy:
```bash
docker compose -f deploy/docker-compose.yml ps
```

Test API health probe:
```bash
curl -s http://localhost:4000/health | jq .
```
Expected output:
```json
{
  "status": "ok",
  "version": "0.9.0",
  "services": {
    "api": "healthy",
    "database": "connected",
    "contentAdapter": "ready"
  }
}
```

---

## 5. IBM TechZone Environment Provisioning

When connecting to IBM TechZone reservations:
1. **FileNet Content Manager**:
   Set `CONTENT_STORE_TYPE=filenet` and run:
   ```bash
   node services/content-adapter/provision/provision-classes.js
   ```
2. **watsonx Orchestrate**:
   Activate your ADK session and run:
   ```bash
   chmod +x agents/import.sh
   ./agents/import.sh
   ```
