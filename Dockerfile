# syntax=docker/dockerfile:1

# ---- build stage -----------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN npm ci

# gondolin-vm extension is versioned outside the npm workspaces
COPY packages/pi-extensions/gondolin-vm/package.json packages/pi-extensions/gondolin-vm/package.json
COPY packages/pi-extensions/gondolin-vm/package-lock.json packages/pi-extensions/gondolin-vm/package-lock.json
RUN npm ci --prefix packages/pi-extensions/gondolin-vm

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/server packages/server
COPY packages/web packages/web
COPY packages/pi-extensions/provider-bridge packages/pi-extensions/provider-bridge
COPY packages/pi-extensions/gondolin-vm/index.ts packages/pi-extensions/gondolin-vm/index.ts
RUN npm run build

# prune to production dependencies for the runtime stage
RUN npm prune --omit=dev

# ---- runtime stage ---------------------------------------------------------
# qemu for the gondolin microvm backend; node 22 pinned (gondolin QEMU HTTP
# bridge is broken on node >= 24.17, upstream earendil-works/gondolin#134)
FROM node:22-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends qemu-system-x86 qemu-utils ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production \
    PI_OFFLINE=1 \
    HOME=/home/node \
    GWARESTRIN_STATE=/var/lib/gwarestrin \
    GWARESTRIN_PROVIDERS_FILE=/etc/gwarestrin/providers.json

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/packages/server/dist ./packages/server/dist
COPY --from=build /app/packages/web/dist ./packages/web/dist
# pi extensions loaded explicitly via -e by the agent manager
COPY --from=build /app/packages/pi-extensions ./packages/pi-extensions

# state root + gondolin guest-asset cache, writable by the node user;
# /dev/kvm access comes from compose `devices` + `group_add` (host kvm gid)
RUN mkdir -p /var/lib/gwarestrin /home/node/.cache/gondolin \
  && chown -R node:node /var/lib/gwarestrin /home/node/.cache

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "packages/server/dist/index.js"]
