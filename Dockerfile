FROM golang:1.27.3-alpine AS build
RUN apk add --no-cache gcc musl-dev
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
RUN CGO_ENABLED=1 go build -tags 'sqlite_fts5 sqlite_omit_load_extension' -trimpath -ldflags='-s -w -linkmode external -extldflags "-static"' -o /pocketmark ./cmd/pocketmark

FROM alpine:3.24
RUN apk add --no-cache ca-certificates && addgroup -g 10001 pocketmark && adduser -D -H -u 10001 -G pocketmark pocketmark && mkdir /data && chown pocketmark:pocketmark /data
COPY --from=build /pocketmark /usr/local/bin/pocketmark
USER 10001:10001
ENV POCKETMARK_DATA=/data POCKETMARK_LISTEN=0.0.0.0:8090 GOMEMLIMIT=32MiB
EXPOSE 8090
VOLUME /data
HEALTHCHECK --interval=30s --timeout=3s CMD wget -q -O /dev/null http://127.0.0.1:8090/healthz || exit 1
ENTRYPOINT ["pocketmark"]
