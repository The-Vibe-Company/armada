# The remote MCP server: the armada binary running `armada serve`.
FROM oven/bun:1.4.2 AS build
WORKDIR /src
COPY . .
RUN bun install --frozen-lockfile && bun run build

FROM debian:bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/dist/armada /usr/local/bin/armada
USER nobody
ENV PORT=8080
EXPOSE 8080
CMD ["armada", "serve"]
