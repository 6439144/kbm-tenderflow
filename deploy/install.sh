#!/usr/bin/env bash
# ==============================================================================
# TenderFlow v0.9.0 - VM One-Command Automated Installation Script (Agent A6)
# Takes a clean Linux VM (Ubuntu/RHEL/Debian) to a fully running TenderFlow stack.
# ==============================================================================
set -euo pipefail

echo "=========================================================="
echo " Starting TenderFlow v0.9.0 Clean VM Deployment"
echo " Code Freeze Target: Wed 14 Oct 2026, 18:00 Kuwait Time"
echo "=========================================================="

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# 1. Check prerequisites
echo "[1/7] Checking prerequisites (Docker & Docker Compose)..."
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
echo "[2/7] Initializing environment configuration..."
if [ ! -f "${REPO_ROOT}/.env" ]; then
    echo "Creating .env from .env.example..."
    cp "${REPO_ROOT}/.env.example" "${REPO_ROOT}/.env"
fi

# 3. TLS Certificates Provisioning
echo "[3/7] Ensuring TLS certificates exist for reverse proxy..."
bash "${SCRIPT_DIR}/proxy/certs/generate-certs.sh"

# 4. Pull or Build Containers
echo "[4/7] Building TenderFlow multi-container stack..."
cd "${SCRIPT_DIR}"
docker compose build

# 5. Launch Stack
echo "[5/7] Starting Docker Compose services in background..."
docker compose up -d

# 6. Wait for Health Check
echo "[6/7] Waiting for API service readiness..."
MAX_ATTEMPTS=40
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

# 7. Verify Deployment over HTTPS Reverse Proxy
echo "[7/7] Verifying reverse proxy HTTPS readiness..."
if command -v curl &> /dev/null; then
    curl -k -s "https://localhost/health" | grep -q '"status":"ok"'
    echo "Verified HTTPS reverse proxy at https://localhost/health"
fi

echo "=========================================================="
echo " TenderFlow v0.9.0 Stack is UP and HEALTHY!"
echo " - TLS Gateway (Vendor Portal): https://localhost"
echo " - Procurement App:             https://localhost/procurement/"
echo " - Control Panel:               https://localhost/control-panel/"
echo " - Core API & Health:           https://localhost/health"
echo " - Keycloak IAM:                http://localhost:8080"
echo " - Mailpit Sandbox:             http://localhost:8025"
echo " - Acceptance Test:             npm run test:e2e"
echo "=========================================================="
