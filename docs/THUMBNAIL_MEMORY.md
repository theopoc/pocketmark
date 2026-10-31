# Thumbnail memory analysis

Measured 2026-10-31 on the development host, Linux amd64, Go 1.26.10,
CGO SQLite with `sqlite_fts5 sqlite_omit_load_extension` and `-O2 -g0`.
This is a deterministic storage microbenchmark, not live-network qualification,
a container memory measurement, or a worst-case server guarantee.

Run with a compiled, non-race store test binary and `/usr/bin/time -v`:

```sh
go test -tags 'sqlite_fts5 sqlite_omit_load_extension' -c -o /tmp/thumbnail-store.test ./internal/store
/usr/bin/time -v /tmp/thumbnail-store.test -test.run '^$' -test.bench '^BenchmarkThumbnailCache/metadata$' -test.benchtime=100x -test.benchmem
/usr/bin/time -v /tmp/thumbnail-store.test -test.run '^$' -test.bench '^BenchmarkThumbnailCache/images$' -test.benchtime=100x -test.benchmem
```

Each scenario creates 40 bookmarks. The image scenario stores 512 KiB per link
(20 MiB total) and reads every image on each iteration, bypassing HTTP/browser
cache. Synthetic payloads exercise storage, not image decoding. Each run uses a
separate process; RSS includes setup and Go/CGO/SQLite overhead.

| Scenario | Peak process RSS | Allocated bytes per iteration | Time per iteration |
| --- | ---: | ---: | ---: |
| Metadata page only | 15,852 KiB (15.48 MiB) | 88,828 | 0.210 ms |
| Metadata + 40 maximal images | 29,648 KiB (28.95 MiB) | 42,056,108 | 8.985 ms |

Peak RSS rose 13.47 MiB in these runs. Allocation totals are cumulative churn,
not simultaneous live memory. The SQL driver copies each returned blob; 40
maximum images account for about 40 MiB of allocations per iteration. The
observed RSS does not imply the server keeps the entire 20 MiB library in RAM.

The cache lives in SQLite and grows on disk, at most 512 KiB per link plus DB
overhead. SQLite retains its existing 2 MiB page-cache target. No new resident
process, in-memory image index or cache is introduced. Downloads share the
existing eight-request server gate; payload bytes can therefore occupy about
8 MiB transiently for eight maximal images including driver copies, before
response/HTTP/runtime overhead. Capture fetches one image at a time through the
existing worker and checks dimensions without allocating a full pixel buffer.

The browser decodes images. A one-million-pixel image commonly needs about
4 MiB for an RGBA surface, independently of compressed file size. Lazy grid
loading reduces initial work; total decoded browser memory depends on scroll,
viewport and browser reclamation. Browser/GPU memory, parallel HTTP download
RSS, full application RSS and whole-container memory were not measured here.
The 128 MiB deployment budget must not be inferred from this microbenchmark.
