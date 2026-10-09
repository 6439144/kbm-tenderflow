#!/usr/bin/env bash
# ==============================================================================
# watsonx Orchestrate ADK Automated Rebuild & Import Script
# Rebuilds and deploys the Procurement AI Advisor agent to IBM TechZone SaaS
# ==============================================================================
set -euo pipefail

echo "=========================================================="
echo " TenderFlow AI Advisor - Orchestrate Agent Import"
echo "=========================================================="

# Check ADK environment activation
if ! command -v orchestrate &> /dev/null; then
    echo "[ERROR] 'orchestrate' CLI (Agent Development Kit) is not installed."
    echo "Install via: pip install ibm-orchestrate-adk"
    exit 1
fi

echo "[1/4] Activating Orchestrate Environment..."
if [ -z "${ORCHESTRATE_ENV_NAME:-}" ]; then
    echo "Using default active environment..."
    orchestrate env activate
else
    orchestrate env activate "${ORCHESTRATE_ENV_NAME}"
fi

echo "[2/4] Validating OpenAPI Tool specifications..."
for tool in agents/tools/*.json; do
    echo "  - Validating $(basename "$tool")..."
    # Syntax check
    node -e "JSON.parse(require('fs').readFileSync('$tool'))"
done

echo "[3/4] Importing tools into watsonx Orchestrate..."
orchestrate tools import -f agents/tools/completeness-tool.json
orchestrate tools import -f agents/tools/clarification-tool.json
orchestrate tools import -f agents/tools/evaluation-tool.json

echo "[4/4] Deploying Agent definition: agents/agent.yaml..."
orchestrate agents apply -f agents/agent.yaml

echo "=========================================================="
echo " Procurement AI Advisor successfully deployed to TechZone."
echo " Advisory Rule 7 & Vendor-Neutral Naming Rule 8 Enforced."
echo "=========================================================="
