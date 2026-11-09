ARG BINARY_SOURCE=build

FROM node:24.14.0-alpine AS frontend
WORKDIR /src
COPY frontend/package.json frontend/package-lock.json ./frontend/
RUN npm ci --prefix frontend --ignore-scripts --no-audit --no-fund
COPY frontend ./frontend
COPY internal/webui/static ./internal/webui/static
RUN npm run build --prefix frontend

FROM golang:1.26.10-alpine AS build
RUN apk add --no-cache gcc musl-dev
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
COPY --from=frontend /src/internal/webui/static ./internal/webui/static
RUN CGO_ENABLED=1 go build -tags 'sqlite_fts5 sqlite_omit_load_extension' -trimpath -ldflags='-s -w -linkmode external -extldflags "-static"' -o /pocketmark ./cmd/pocketmark

# Release CI supplies its validated executable in a minimal build context.
FROM scratch AS prebuilt
COPY --chmod=0755 pocketmark /pocketmark

FROM ${BINARY_SOURCE} AS binary

FROM alpine:3.24 AS runtime
# CVE-2026-4738 is fixed in Alpine's zlib 1.4-r0.
RUN apk add --no-cache --upgrade ca-certificates 'zlib>=1.4-r0' && addgroup -g 10001 pocketmark && adduser -D -H -u 10001 -G pocketmark pocketmark && mkdir /data && chown pocketmark:pocketmark /data
COPY --from=binary /pocketmark /usr/local/bin/pocketmark
USER 10001:10001
ENV POCKETMARK_DATA=/data POCKETMARK_LISTEN=0.0.0.0:8090 GOMEMLIMIT=32MiB
EXPOSE 8090
VOLUME /data
HEALTHCHECK --interval=30s --timeout=3s CMD wget -q -O /dev/null http://127.0.0.1:8090/healthz || exit 1
ENTRYPOINT ["pocketmark"]
