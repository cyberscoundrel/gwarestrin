#!/bin/sh
# Build the agent sandbox image and publish it to the in-compose registry as a
# single-platform OCI image manifest, which is what the VM driver can unpack
# (it rejects Docker v2 manifests and nested image indexes).
#   openshell/scripts/publish-agent.sh [tag]     -> registry:5443/gwarestrin-agent:<tag>
# Requires Docker's containerd image store (docker save then writes an OCI layout).
set -eu
cd "$(dirname "$0")/../.."
TAG=${1:-dev}
REGISTRY=${OPENSHELL_REGISTRY:-registry:5443}
NETWORK=${OPENSHELL_NETWORK:-gwarestrin_backend}
CRANE_IMAGE=${CRANE_IMAGE:-gcr.io/go-containerregistry/crane:latest}

docker build --network host --target agent -t "gwarestrin-agent:$TAG" .

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir "$work/oci"
docker save "gwarestrin-agent:$TAG" | tar -x -C "$work/oci"
if [ ! -f "$work/oci/index.json" ]; then
  echo "publish-agent: docker save did not produce an OCI layout; enable the containerd image store" >&2
  exit 1
fi
# crane runs as a non-root user and needs to read the layout and the CA (public)
cp openshell/pki/ca.crt "$work/ca.crt"
chmod -R a+rX "$work"

crane() {
  docker run --rm --network "$NETWORK" -v "$work:/w:ro" -e SSL_CERT_FILE=/w/ca.crt "$CRANE_IMAGE" "$@"
}
crane push --index /w/oci "$REGISTRY/gwarestrin-agent:$TAG-index"
crane copy --platform linux/amd64 "$REGISTRY/gwarestrin-agent:$TAG-index" "$REGISTRY/gwarestrin-agent:$TAG"
crane manifest "$REGISTRY/gwarestrin-agent:$TAG" | grep -q '"application/vnd.oci.image.manifest.v1+json"'
echo "publish-agent: $REGISTRY/gwarestrin-agent:$TAG"
