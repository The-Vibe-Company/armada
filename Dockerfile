# The remote MCP server is a standalone binary; the CLI bundle carries no server runtime.
FROM oven/bun:1.4.2 AS build
WORKDIR /src
COPY . .
# Install both Linux architectures; cross-compile without executing foreign binaries.
RUN bun install --frozen-lockfile --os linux --cpu '*' \
  && bun scripts/publish-runtime-artifacts.ts \
  && bun run build

FROM debian:bookworm-slim
# openssh-client: golden create's pinned SSH stdin checkout transport shells out to ssh-keygen and ssh.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates openssh-client \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/dist/armada-server /usr/local/bin/armada-server
COPY --from=build /src/dist/runtime-artifacts /opt/armada/runtime-artifacts
COPY --from=build /src/dist/runtime-manifests /opt/armada/runtime-manifests
USER nobody
ENV ARMADA_RUNTIME_ARTIFACT_DIR=/opt/armada/runtime-artifacts
ENV PORT=8080
EXPOSE 8080
CMD ["armada-server"]
