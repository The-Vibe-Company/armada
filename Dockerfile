# The remote MCP server is a standalone binary; the CLI bundle carries no server runtime.
FROM oven/bun:1.4.2 AS build
WORKDIR /src
COPY . .
# Install only the packages required by the published x64 runtime.
RUN bun install --frozen-lockfile --os linux --cpu x64 \
  && bun scripts/publish-runtime-artifacts.ts \
  && bun run build

FROM debian:bookworm-slim
# openssh-client: golden create's pinned SSH stdin checkout transport shells out to ssh-keygen and ssh.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates openssh-client python3-venv \
  && python3 -m venv /opt/armada/modal \
  && /opt/armada/modal/bin/pip install --no-cache-dir modal==1.6.3 \
  && rm -rf /var/lib/apt/lists/*
COPY packages/mcp-server/src/modal-artifact-seed.py /opt/armada/modal-artifact-seed.py
COPY --from=build /src/dist/armada-server /usr/local/bin/armada-server
COPY --from=build /src/dist/runtime-artifacts /opt/armada/runtime-artifacts
COPY --from=build /src/dist/runtime-manifests /opt/armada/runtime-manifests
USER nobody
ENV ARMADA_RUNTIME_ARTIFACT_DIR=/opt/armada/runtime-artifacts
ENV PORT=8080
EXPOSE 8080
CMD ["armada-server"]
