package backup

import (
	"bytes"
	"errors"
	"testing"
)

func TestLibraryZIPCannotExceedRestoreLimit(t *testing.T) {
	var buf bytes.Buffer
	z := limitedZIP{&buf, 3}
	if n, err := z.Write([]byte("zip")); n != 3 || err != nil {
		t.Fatal(n, err)
	}
	if n, err := z.Write([]byte("!")); n != 0 || !errors.Is(err, ErrLibrarySize) || buf.String() != "zip" {
		t.Fatal(n, err)
	}
}
