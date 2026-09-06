FROM node:20-bookworm-slim
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY test ./test
COPY scripts ./scripts
ENV ORION_CLEAN_ENV=1
ENV ORION_NO_SYMLINK=1
CMD ["node", "scripts/run-tests.js"]
