FROM node:22-alpine

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
# the document store (a named volume takes this directory's owner)
RUN mkdir -p /app/documents && chown node:node /app/documents

USER node
EXPOSE 8000
CMD ["node", "src/server.js"]
