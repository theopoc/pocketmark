package capture

import (
	"fmt"
	"io"
	"runtime"
	"strings"
	"testing"
)

func TestPreviewAttributeFloodUsesBoundedMemory(t *testing.T) {
	var input strings.Builder
	input.WriteString("<a ")
	for i := 0; i < 100000; i++ {
		fmt.Fprintf(&input, "a%d=a ", i)
	}
	input.WriteString(">Saved</a>")
	src := strings.NewReader(input.String())
	runtime.GC()
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	err := Preview(src, io.Discard)
	runtime.ReadMemStats(&after)
	if err != nil {
		t.Fatal(err)
	}
	if allocated := after.TotalAlloc - before.TotalAlloc; allocated > 1<<20 {
		t.Fatalf("preview allocated %d bytes for an attribute flood; budget 1 MiB", allocated)
	}
}

func TestPreviewPreservesLargeEmbeddedContentAndRejectsOversize(t *testing.T) {
	for _, body := range []string{
		`<img src="data:image/png;base64,` + strings.Repeat("A", 3<<20) + `">`,
		`<style>` + strings.Repeat(" ", 3<<20) + `</style>`,
		strings.Repeat(" ", 20<<20),
	} {
		var dst strings.Builder
		if err := Preview(strings.NewReader(body), &dst); err != nil {
			t.Fatal(err)
		}
		if dst.String() != body {
			t.Fatal("preview changed saved bytes")
		}
	}
	if err := Preview(strings.NewReader(strings.Repeat(" ", (20<<20)+1)), io.Discard); err == nil {
		t.Fatal("oversized preview accepted")
	}
}
