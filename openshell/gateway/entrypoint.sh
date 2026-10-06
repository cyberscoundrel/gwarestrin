#!/bin/sh
# Trust the deployment CA (the in-compose image registry's TLS) on top of the
# system roots. The VM driver's registry client uses the native root store,
# which honors SSL_CERT_FILE.
set -eu
if [ -f /etc/openshell/pki/ca.crt ]; then
  cat /etc/ssl/certs/ca-certificates.crt /etc/openshell/pki/ca.crt > /tmp/openshell-ca-bundle.crt
  export SSL_CERT_FILE=/tmp/openshell-ca-bundle.crt
fi
exec openshell-gateway --config /etc/openshell/gateway.toml "$@"
