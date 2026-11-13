# Release-only, linux/amd64. Never copy the checkout into the final image.
FROM oven/bun:1.4.2 AS build
WORKDIR /src
COPY . .
RUN bun install --frozen-lockfile --os linux --cpu x64 \
    && bun scripts/publish-runtime-artifacts.ts

FROM buildpack-deps@sha256:58021c2a0204361b62a23d2e0244d144d74c29af2d678e2a1f7e6611885d6949
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git gh python3 nodejs npm \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1000 user \
    && useradd --uid 1000 --gid 1000 --create-home --shell /bin/bash user
COPY --from=build /usr/local/bin/bun /usr/local/bin/bun
COPY --from=build /src/dist/runtime-artifacts /opt/armada/runtime-artifacts
COPY --from=build /src/dist/runtime-manifests /opt/armada/runtime-manifests
# The release contains the compiled runtime and pinned harness archives; later
# launch integration seeds the per-sandbox verified caches from these public bytes.
ENV HOME=/home/user
WORKDIR /home/user
USER 1000:1000
CMD ["sleep", "infinity"]
