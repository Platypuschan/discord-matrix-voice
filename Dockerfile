# glibc base: @snazzah/davey (Discord DAVE) ships prebuilt -gnu binaries.
FROM docker.io/library/node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM docker.io/library/node:24-bookworm-slim
# Links the GHCR package to the (public) source repository.
LABEL org.opencontainers.image.source="https://github.com/Platypuschan/discord-matrix-voice"
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
CMD ["node", "dist/index.js"]
