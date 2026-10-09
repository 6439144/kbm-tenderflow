#!/usr/bin/env bash
# TenderFlow - import the nine watsonx Orchestrate agents into an Orchestrate (IBM Cloud) instance:
# the eight specialist (collaborator) agents first, then the supervisor tenderflow_assistant, whose
# `collaborators:` list refers to them by name.
# Usage (repo root): bash agents/import.sh
# Reads WXO_INSTANCE_URL / WXO_API_KEY from the repo .env (process environment wins).
# Optional: WXO_LLM (model id from `orchestrate models list`), WXO_ENV_NAME (default techzone),
#           WXO_AUTH_TYPE (default ibm_iam for IBM Cloud instances).
# Stops on the first failing step. The API key is never printed.
set -euo pipefail

AGENTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$AGENTS_DIR")"
ENV_FILE="$REPO_ROOT/.env"
# Order matters: collaborators first, supervisor (tenderflow_assistant) last.
AGENT_NAMES=(tenderflow_pack_checker tenderflow_clarification_assistant tenderflow_compliance_screener tenderflow_request_classifier tenderflow_notice_drafter tenderflow_relevance_matcher tenderflow_evaluation_narrator tenderflow_grade_reviewer tenderflow_assistant)
AGENT_FILES=()
for n in "${AGENT_NAMES[@]}"; do AGENT_FILES+=("$n.yaml"); done

# Read one KEY from .env without sourcing it (no code execution); process env wins.
setting() {
  local name="$1" default="${2:-}" val=""
  val="${!name:-}"
  if [[ -z "$val" && -f "$ENV_FILE" ]]; then
    val="$(grep -E "^[[:space:]]*(export[[:space:]]+)?${name}[[:space:]]*=" "$ENV_FILE" | tail -n 1 | sed -E "s/^[[:space:]]*(export[[:space:]]+)?${name}[[:space:]]*=[[:space:]]*//" | tr -d '\r')" || val=""
    if [[ "$val" =~ ^\"(.*)\"$ || "$val" =~ ^\'(.*)\'$ ]]; then val="${BASH_REMATCH[1]}"; else val="$(printf '%s' "$val" | sed -E 's/[[:space:]]+#.*$//; s/[[:space:]]+$//')"; fi
  fi
  printf '%s' "${val:-$default}"
}

step() { echo; echo "==> $1"; }

URL="$(setting WXO_INSTANCE_URL)"; URL="${URL%/}"
API_KEY="$(setting WXO_API_KEY)"
ENV_NAME="$(setting WXO_ENV_NAME techzone)"
AUTH_TYPE="$(setting WXO_AUTH_TYPE ibm_iam)"
LLM="$(setting WXO_LLM)"

[[ -n "$URL" ]] || { echo "WXO_INSTANCE_URL is not set (add it to $ENV_FILE)" >&2; exit 1; }
[[ -n "$API_KEY" ]] || { echo "WXO_API_KEY is not set (add it to $ENV_FILE)" >&2; exit 1; }
command -v orchestrate >/dev/null 2>&1 || { echo "orchestrate CLI not found: pip install --upgrade ibm-watsonx-orchestrate (Python 3.11+)" >&2; exit 1; }
if [[ "$AUTH_TYPE" == "ibm_iam" && "$URL" != *".cloud.ibm.com"* ]]; then
  echo "WARNING: WXO_INSTANCE_URL does not look like an IBM Cloud instance; for AWS-hosted instances set WXO_AUTH_TYPE=mcsp." >&2
fi

echo "Instance:    $URL"
echo "API key:     set (hidden)"
echo "Environment: $ENV_NAME ($AUTH_TYPE)"

step "orchestrate env add -n $ENV_NAME -u <instance> --type $AUTH_TYPE"
# 'env add' asks to confirm updating an existing environment; answer y so re-runs are idempotent.
echo y | orchestrate env add -n "$ENV_NAME" -u "$URL" --type "$AUTH_TYPE"

step "orchestrate env activate $ENV_NAME --api-key <hidden>"
orchestrate env activate "$ENV_NAME" --api-key "$API_KEY"

IMPORT_DIR="$AGENTS_DIR"
if [[ -n "$LLM" ]]; then
  IMPORT_DIR="$(mktemp -d)"
  trap 'rm -rf "$IMPORT_DIR"' EXIT
  for f in "${AGENT_FILES[@]}"; do
    LLM="$LLM" awk '{ if ($0 ~ /^llm:/) print "llm: " ENVIRON["LLM"]; else print }' "$AGENTS_DIR/$f" > "$IMPORT_DIR/$f"
  done
  echo "Using model override WXO_LLM=$LLM"
fi

for f in "${AGENT_FILES[@]}"; do
  step "orchestrate agents import -f $f"
  orchestrate agents import -f "$IMPORT_DIR/$f"
done

step "orchestrate agents list"
orchestrate agents list

LISTING="$(orchestrate agents list -v)"
for n in "${AGENT_NAMES[@]}"; do
  grep -q -- "$n" <<<"$LISTING" || { echo "FAILED: agent $n not found after import" >&2; exit 1; }
done

echo
echo "OK: imported ${#AGENT_NAMES[@]} agents: ${AGENT_NAMES[*]}"
echo "Next: npm run build && npm run verify:ai"
