#!/usr/bin/env bash

set -euo pipefail

OUT_DIR="${1:-.dev/tls}"
CA_KEY="$OUT_DIR/ca.key.pem"
CA_CERT="$OUT_DIR/ca.cert.pem"
SERVER_KEY="$OUT_DIR/server.key.pem"
SERVER_CSR="$OUT_DIR/server.csr.pem"
SERVER_CERT="$OUT_DIR/server.cert.pem"
SERVER_EXT="$OUT_DIR/server.ext"

mkdir -p "$OUT_DIR"

openssl genrsa -out "$CA_KEY" 2048 >/dev/null 2>&1
openssl req -x509 -new -nodes -key "$CA_KEY" -sha256 -days 3650 -out "$CA_CERT" -subj "/CN=ACL Dev Local CA" >/dev/null 2>&1

openssl genrsa -out "$SERVER_KEY" 2048 >/dev/null 2>&1
openssl req -new -key "$SERVER_KEY" -out "$SERVER_CSR" -subj "/CN=localhost" >/dev/null 2>&1

cat > "$SERVER_EXT" <<'EOF'
subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1
basicConstraints=CA:FALSE
keyUsage=digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
EOF

openssl x509 -req -in "$SERVER_CSR" -CA "$CA_CERT" -CAkey "$CA_KEY" -CAcreateserial -out "$SERVER_CERT" -days 825 -sha256 -extfile "$SERVER_EXT" >/dev/null 2>&1

echo "Generated local CA and server certificate in $OUT_DIR"
echo "CA certificate: $CA_CERT"
echo "Server certificate: $SERVER_CERT"
echo "Server key: $SERVER_KEY"
