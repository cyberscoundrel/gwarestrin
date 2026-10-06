#!/bin/sh
# Deployment PKI for the OpenShell runtime, written to openshell/pki/ (gitignored):
#   ca.crt ca.key           deployment CA (keep ca.key off every container)
#   server/ client/ jwt/    gateway mTLS + sandbox JWT (openshell-gateway generate-certs)
#   registry/               TLS for the in-compose image registry, signed by the CA
# Idempotent: refuses to overwrite an existing PKI unless --force.
set -eu
cd "$(dirname "$0")/.."
PKI=pki
IMAGE=${OPENSHELL_GATEWAY_IMAGE:-gwarestrin-openshell-gateway:local}

if [ -f "$PKI/ca.crt" ] && [ "${1:-}" != "--force" ]; then
  echo "pki: $PKI already exists (use --force to regenerate; existing clients will stop authenticating)"
  exit 0
fi
rm -rf "$PKI"
mkdir -p "$PKI"
chmod 700 "$PKI"

docker run --rm -u "$(id -u):$(id -g)" -v "$PWD/$PKI:/out" --entrypoint openshell-gateway "$IMAGE" \
  generate-certs --output-dir /out \
  --server-san openshell-gateway --server-san localhost --server-san 127.0.0.1

mkdir -p "$PKI/registry"
umask 077
openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
  -keyout "$PKI/registry/tls.key" -subj /CN=registry -out "$PKI/registry/tls.csr" 2>/dev/null
printf 'subjectAltName=DNS:registry,DNS:openshell-registry\nextendedKeyUsage=serverAuth\n' > "$PKI/registry/ext.cnf"
openssl x509 -req -in "$PKI/registry/tls.csr" -CA "$PKI/ca.crt" -CAkey "$PKI/ca.key" -CAcreateserial \
  -days 825 -extfile "$PKI/registry/ext.cnf" -out "$PKI/registry/tls.crt" 2>/dev/null
rm -f "$PKI/registry/tls.csr" "$PKI/registry/ext.cnf" "$PKI/ca.srl"
openssl verify -CAfile "$PKI/ca.crt" "$PKI/registry/tls.crt" "$PKI/server/tls.crt" "$PKI/client/tls.crt"
echo "pki: written to openshell/$PKI"
