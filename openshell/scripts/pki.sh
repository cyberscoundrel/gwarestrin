#!/bin/sh
# Deployment PKI for the OpenShell runtime, written to openshell/pki/ (gitignored):
#   ca.crt ca.key           deployment CA (keep ca.key off every container)
#   server/ client/ jwt/    gateway mTLS + sandbox JWT (openshell-gateway generate-certs)
#   registry/               TLS for the in-compose image registry, signed by the CA
#   authentik/              TLS for authentik's internal HTTPS listener (the OIDC
#                           issuer the gateway validates tokens against)
# Idempotent: keeps an existing CA and only issues missing leaf certificates;
# --force regenerates everything (existing clients stop authenticating).
set -eu
cd "$(dirname "$0")/.."
PKI=pki
IMAGE=${OPENSHELL_GATEWAY_IMAGE:-gwarestrin-openshell-gateway:local}

if [ "${1:-}" = "--force" ]; then
  rm -rf "$PKI"
fi
mkdir -p "$PKI"
chmod 700 "$PKI"

if [ ! -f "$PKI/ca.crt" ]; then
  docker run --rm -u "$(id -u):$(id -g)" -v "$PWD/$PKI:/out" --entrypoint openshell-gateway "$IMAGE" \
    generate-certs --output-dir /out \
    --server-san openshell-gateway --server-san localhost --server-san 127.0.0.1
fi

# leaf <dir> <cn> <san,...>: server certificate signed by the deployment CA
leaf() {
  dir=$PKI/$1
  [ -f "$dir/tls.crt" ] && return 0
  mkdir -p "$dir"
  sans=$(printf '%s' "$3" | sed 's/[^,]*/DNS:&/g')
  (
    umask 077
    openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
      -keyout "$dir/tls.key" -subj "/CN=$2" -out "$dir/tls.csr" 2>/dev/null
    printf 'subjectAltName=%s\nextendedKeyUsage=serverAuth\n' "$sans" > "$dir/ext.cnf"
    openssl x509 -req -in "$dir/tls.csr" -CA "$PKI/ca.crt" -CAkey "$PKI/ca.key" -CAcreateserial \
      -days 825 -extfile "$dir/ext.cnf" -out "$dir/tls.crt" 2>/dev/null
  )
  rm -f "$dir/tls.csr" "$dir/ext.cnf" "$PKI/ca.srl"
  echo "pki: issued $1 ($3)"
}

leaf registry registry registry,openshell-registry
leaf authentik authentik-server authentik-server

openssl verify -CAfile "$PKI/ca.crt" "$PKI/server/tls.crt" "$PKI/client/tls.crt" \
  "$PKI/registry/tls.crt" "$PKI/authentik/tls.crt"
echo "pki: openshell/$PKI ready"
