package capture

import (
	"bufio"
	"bytes"
	"io"
	"mime"
	"strings"

	"golang.org/x/net/html"
	"golang.org/x/net/html/charset"
)

type htmlEncoding struct {
	name string
	bom  int
}

// Use HTML's BOM, transport, meta precedence and keep UTF-8 as the fallback,
// even when all characters in the first 1024 bytes are ASCII.
func detectHTMLEncoding(body []byte, contentType string) htmlEncoding {
	prolog := body[:min(len(body), 1024)]
	for _, mark := range []struct{ prefix, name string }{{"\xef\xbb\xbf", "utf-8"}, {"\xff\xfe", "utf-16le"}, {"\xfe\xff", "utf-16be"}} {
		if bytes.HasPrefix(prolog, []byte(mark.prefix)) {
			return htmlEncoding{mark.name, len(mark.prefix)}
		}
	}
	_, params, _ := mime.ParseMediaType(contentType)
	if enc, name := charset.Lookup(params["charset"]); enc != nil {
		return htmlEncoding{name: name}
	}
	z := html.NewTokenizer(bytes.NewReader(prolog))
	for {
		switch z.Next() {
		case html.ErrorToken:
			return htmlEncoding{name: "utf-8"}
		case html.StartTagToken, html.SelfClosingTagToken:
			t := z.Token()
			if t.Data != "meta" {
				continue
			}
			label := attr(t, "charset")
			if label == "" && strings.EqualFold(attr(t, "http-equiv"), "content-type") {
				_, p, _ := mime.ParseMediaType(attr(t, "content"))
				label = p["charset"]
			}
			if enc, name := charset.Lookup(label); enc != nil {
				// A meta declaration cannot select UTF-16.
				if strings.HasPrefix(name, "utf-16") {
					name = "utf-8"
				}
				return htmlEncoding{name: name}
			}
		}
	}
}

func (enc htmlEncoding) decoder(src io.Reader) io.Reader {
	if enc.name == "utf-8" {
		return src
	}
	codec, _ := charset.Lookup(enc.name)
	return codec.NewDecoder().Reader(src)
}

func decodedHTML(src io.Reader, contentType string) io.Reader {
	input := bufio.NewReaderSize(src, 1024)
	prolog, _ := input.Peek(1024)
	enc := detectHTMLEncoding(prolog, contentType)
	_, _ = input.Discard(enc.bom)
	return enc.decoder(input)
}

func (enc htmlEncoding) utf8Body(body []byte) ([]byte, error) {
	body = body[enc.bom:]
	if enc.name == "utf-8" {
		return body, nil
	}
	// Upstream bytes have already passed the 2 MiB response limit. Decoding
	// a legacy byte into UTF-8 can expand it to a multi-byte code point.
	return io.ReadAll(enc.decoder(bytes.NewReader(body)))
}

// Transport headers do not accompany a downloaded reading copy. Persist a
// canonical declaration only when the archived bytes would decode differently.
// Its small fixed overhead is independent of the 2 MiB acquisition budget.
func selfDescribingArticle(original, reading []byte, contentType string) []byte {
	declared := detectHTMLEncoding(original, contentType)
	if declared.name == detectHTMLEncoding(original, "").name {
		return reading
	}
	if reading == nil {
		reading = original
	}
	var marker string
	switch declared.name {
	case "utf-8":
		marker = "\xef\xbb\xbf"
	case "utf-16le":
		marker = "\xff\xfe"
	case "utf-16be":
		marker = "\xfe\xff"
	default:
		marker = `<meta charset="` + declared.name + `">`
	}
	copy := make([]byte, 0, len(marker)+len(reading))
	copy = append(copy, marker...)
	return append(copy, reading...)
}
