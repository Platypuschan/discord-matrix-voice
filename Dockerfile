# glibc base: @snazzah/davey (Discord DAVE) ships prebuilt -gnu binaries.
# Build on the same Debian release (13) as the runtime image.
FROM docker.io/library/node:24-trixie-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build && npm prune --omit=dev

# Distroless Node.js 24 on Debian 13: glibc, libstdc++ and CA certificates,
# but no shell, package manager, npm or perl. The bridge only runs
# `node dist/index.js`, so the rest of a Debian image (and its CVEs) is
# dead weight. The entrypoint is node; it runs as the unprivileged user
# nonroot (65532). Pinned by digest; update it together with the tag.
FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:9eeb7f5887d0e239e78264b06f7f11d2e14be534050481803a9e4728fcdd278e
# Links the GHCR package to the (public) source repository.
LABEL org.opencontainers.image.source="https://github.com/Platypuschan/discord-matrix-voice"
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
CMD ["dist/index.js"]
