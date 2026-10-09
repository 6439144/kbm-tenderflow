#!/usr/bin/env bash
# ==============================================================================
# TenderFlow v0.9.0 - VM One-Command Automated Installation Script
# Takes a clean Linux VM (Ubuntu/RHEL/Debian) to a fully running TenderFlow stack.
# ==============================================================================
set -euo pipefail

echo "=========================================================="
echo " Starting TenderFlow v0.9.0 Clean VM Deployment"
echo "=========================================================="

# 1. Check prerequisites
echo "[1/6] Checking prerequisites..."
if ! command -v docker &> /dev/null; then
    echo "Docker not found. Installing Docker..."
    curl -fsSL https://get.docker.com -o get-docker.sh
    sh get-docker.sh
    rm get-docker.sh
fi

if ! docker compose version &> /dev/null; then
    echo "Docker Compose plugin required."
    exit 1
fi

# 2. Environment Configuration
echo "[2/6] Initializing environment configuration..."
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

if [ ! -f "${REPO_ROOT}/.env" ]; then
    echo "Creating .env from .env.example..."
    cp "${REPO_ROOT}/.env.example" "${REPO_ROOT}/.env"
fi

# 3. Pull or Build Containers
echo "[3/6] Building TenderFlow services..."
cd "${SCRIPT_DIR}"
docker compose build

# 4. Launch Stack
echo "[4/6] Starting Docker Compose services..."
docker compose up -d

# 5. Wait for Health Check
echo "[5/6] Waiting for services to become healthy..."
MAX_ATTEMPTS=30
ATTEMPT=0
API_URL="http://localhost:4000/health"

until curl -s "${API_URL}" | grep -q '"status":"ok"'; do
    ATTEMPT=$((ATTEMPT + 1))
    if [ ${ATTEMPT} -ge ${MAX_ATTEMPTS} ]; then
        echo "[ERROR] API service failed to become healthy within timeout."
        docker compose logs api
        exit 1
    fi
    echo "Waiting for API readiness... (${ATTEMPT}/${MAX_ATTEMPTS})"
    sleep 3
done

# 6. Verify Deployment
echo "[6/6] Verifying deployment..."
curl -s "${API_URL}" | grep -q '"status":"ok"'

echo "=========================================================="
echo " TenderFlow v0.9.0 Stack is UP and HEALTHY!"
echo " - Core API & Health: http://localhost:4000/health"
echo " - Mailpit Web UI:     http://localhost:8025"
echo " - Keycloak Realm:     http://localhost:8080"
echo " - Reverse Proxy:      http://localhost"
echo " Acceptance test script: docs/review-demo.md"
echo "=========================================================="
