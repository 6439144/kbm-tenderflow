#!/usr/bin/env bash
# ==============================================================================
# TenderFlow v0.9.0 - TLS Reverse Proxy Certificate Generator
# ==============================================================================
set -euo pipefail

CERT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "${CERT_DIR}"

if [ ! -f "${CERT_DIR}/tls.crt" ] || [ ! -f "${CERT_DIR}/tls.key" ]; then
    echo "Generating self-signed TLS certificates for TenderFlow..."
    openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
        -keyout "${CERT_DIR}/tls.key" \
        -out "${CERT_DIR}/tls.crt" \
        -subj "/C=KW/ST=Capital/L=KuwaitCity/O=TenderFlow/OU=Platform/CN=localhost" \
        -addext "subjectAltName=DNS:localhost,DNS:review.tenderflow.local,IP:127.0.0.1"
    echo "TLS certificates generated in ${CERT_DIR}."
else
    echo "TLS certificates already exist in ${CERT_DIR}."
fi
