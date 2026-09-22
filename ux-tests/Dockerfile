FROM mcr.microsoft.com/playwright:v1.55.0-jammy

WORKDIR /tests
COPY package.json ./
RUN npm install --omit=dev

CMD ["sleep", "infinity"]
