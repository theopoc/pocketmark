package server

import (
	"bufio"
	"bytes"
	"io"
	"mime"
	"net/http"
	"os"
	"strings"

	"pocketmark/internal/store"
)

type stagedUpload struct {
	file            *os.File
	mediaType, kind string
}

func (u *stagedUpload) cleanup() {
	u.file.Close()
	os.Remove(u.file.Name())
}

// Stage the entire bounded upload before opening a SQLite transaction, so a
// slow client cannot occupy the sole database connection. noun only preserves
// the existing error messages for attachments and standalone files.
func (a *Server) stageUpload(w http.ResponseWriter, r *http.Request, noun string) (*stagedUpload, bool) {
	r.Body = http.MaxBytesReader(w, r.Body, store.MaxAssetSize)
	reader := bufio.NewReaderSize(r.Body, 512)
	prefix, err := reader.Peek(512)
	if err != nil && err != io.EOF {
		fail(w, 400, "cannot read "+noun)
		return nil, false
	}
	media := http.DetectContentType(prefix)
	if bytes.HasPrefix(prefix, []byte("%PDF-")) {
		media = "application/pdf"
	}
	declared, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
	// SingleFile may start with a long comment. Declared HTML remains untrusted
	// downloadable bytes and is never rendered on the application's origin.
	if declared == "text/html" && (media == "text/plain; charset=utf-8" || strings.HasPrefix(media, "text/html")) {
		media = "text/html"
	}
	if strings.HasPrefix(media, "text/html") {
		media = "text/html"
	}
	kind := ""
	switch media {
	case "application/pdf":
		kind = "pdf"
	case "image/png", "image/jpeg", "image/gif", "image/webp":
		kind = "image"
	case "text/html":
		kind = "html"
	default:
		fail(w, 415, "upload a PDF, PNG, JPEG, GIF, WebP or HTML/SingleFile document")
		return nil, false
	}
	f, err := a.Store.TemporaryFile(".upload-*")
	if err != nil {
		handleError(w, err)
		return nil, false
	}
	upload := &stagedUpload{file: f, mediaType: media, kind: kind}
	if _, err = io.Copy(f, reader); err != nil {
		upload.cleanup()
		fail(w, 400, noun+" exceeds 20 MiB or upload was interrupted")
		return nil, false
	}
	if _, err = f.Seek(0, io.SeekStart); err != nil {
		upload.cleanup()
		handleError(w, err)
		return nil, false
	}
	return upload, true
}
