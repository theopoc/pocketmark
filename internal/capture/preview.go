package capture

import (
	"errors"
	"io"
)

// Preview stages untrusted HTML without parsing it. Tokenizing even a bounded
// document can amplify a single tag's attributes beyond the server RAM budget.
// The caller MUST use attachment disposition and the opaque, scriptless nested
// blob viewer whose parent CSP restricts frame-src to blob:. This is not a sanitizer.
func Preview(src io.Reader, dst io.Writer) error {
	const limit = 20 << 20
	n, err := io.Copy(dst, io.LimitReader(src, limit+1))
	if err != nil {
		return err
	}
	if n > limit {
		return errors.New("HTML preview exceeds 20 MiB")
	}
	return nil
}
