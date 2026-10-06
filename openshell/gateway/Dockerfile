# syntax=docker/dockerfile:1
# OpenShell gateway + microVM driver for gwarestrin (GWARESTRIN_RUNTIME=openshell).
# Runs the gateway, the VM driver and the per-sandbox host supervisor in one
# container, so sandbox egress leaves from this container's network namespace
# (compose DNS by name; reach limited to the networks it is attached to).

ARG OPENSHELL_VERSION=0.1.2

FROM node:22-bookworm-slim AS fetch
ARG OPENSHELL_VERSION
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
WORKDIR /dl
RUN set -eu; \
    base="https://github.com/NVIDIA/OpenShell/releases/download/v${OPENSHELL_VERSION}"; \
    for f in openshell-x86_64-unknown-linux-musl.tar.gz \
             openshell-gateway-x86_64-unknown-linux-gnu.tar.gz \
             openshell-driver-vm-x86_64-unknown-linux-gnu.tar.gz \
             openshell-checksums-sha256.txt \
             openshell-gateway-checksums-sha256.txt; do \
      curl -fsSLO "$base/$f"; \
    done; \
    cat openshell-checksums-sha256.txt openshell-gateway-checksums-sha256.txt \
      | grep -E ' (openshell-x86_64-unknown-linux-musl|openshell-gateway-x86_64-unknown-linux-gnu|openshell-driver-vm-x86_64-unknown-linux-gnu)\.tar\.gz$' \
      > wanted.sha256; \
    test "$(wc -l < wanted.sha256)" -eq 3; \
    sha256sum -c wanted.sha256; \
    for t in *.tar.gz; do tar -xzf "$t"; done

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=fetch /dl/openshell /dl/openshell-gateway /usr/local/bin/
COPY --from=fetch /dl/openshell-driver-vm /usr/local/libexec/openshell/
COPY entrypoint.sh /usr/local/bin/openshell-gateway-entrypoint
RUN chmod 755 /usr/local/bin/openshell /usr/local/bin/openshell-gateway \
      /usr/local/libexec/openshell/openshell-driver-vm /usr/local/bin/openshell-gateway-entrypoint \
 # a named volume mounted here inherits this ownership on first use
 && mkdir -p /state && chown node:node /state
ENV OPENSHELL_TELEMETRY_ENABLED=false \
    OPENSHELL_DB_URL=sqlite:/state/gateway.db?mode=rwc
USER node
ENTRYPOINT ["openshell-gateway-entrypoint"]
