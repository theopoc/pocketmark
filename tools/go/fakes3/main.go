// Command fakes3 serves a disposable in-memory S3 API for browser tests.
//
// It creates one bucket, accepts requests signed with one access key ID and
// answers any other signed request with InvalidAccessKeyId, so a journey can
// exercise both outcomes of the backup connection test. Signatures are not
// verified. Unsigned requests are let through so the test can list objects.
// The first stdout line is the endpoint URL.
//
//	go -C tools/go run ./fakes3 -bucket pocketmark-e2e -access-key AKID
package main

import (
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"regexp"

	"github.com/johannesboyne/gofakes3"
	"github.com/johannesboyne/gofakes3/backend/s3mem"
)

var credential = regexp.MustCompile(`Credential=([^/,\s]+)/`)

func main() {
	listen := flag.String("listen", "127.0.0.1:0", "listen address")
	bucket := flag.String("bucket", "pocketmark-e2e", "bucket to create")
	accessKey := flag.String("access-key", "", "only accepted access key ID")
	flag.Parse()
	if *accessKey == "" {
		log.Fatal("fakes3: -access-key is required")
	}
	backend := s3mem.New()
	if err := backend.CreateBucket(*bucket); err != nil {
		log.Fatal(err)
	}
	s3 := gofakes3.New(backend, gofakes3.WithIntegrityCheck(true)).Server()
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if auth := r.Header.Get("Authorization"); auth != "" {
			if m := credential.FindStringSubmatch(auth); m == nil || m[1] != *accessKey {
				w.Header().Set("Content-Type", "application/xml")
				w.WriteHeader(http.StatusForbidden)
				fmt.Fprint(w, `<?xml version="1.0" encoding="UTF-8"?><Error><Code>InvalidAccessKeyId</Code><Message>The access key ID does not exist.</Message></Error>`)
				return
			}
		}
		s3.ServeHTTP(w, r)
	})
	listener, err := net.Listen("tcp", *listen)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Fprintf(os.Stdout, "http://%s\n", listener.Addr())
	log.Fatal(http.Serve(listener, handler))
}
