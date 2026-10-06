# build context: repo root (the OpenShell SDK is vendored in ./vendor)
FROM node:22-alpine
WORKDIR /app/provisioner
COPY vendor /app/vendor
COPY provisioner/package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY provisioner/*.mjs ./
CMD ["node", "index.mjs"]
