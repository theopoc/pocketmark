package store

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"strings"
)

// Finish receiving untrusted imports before acquiring SQLite's single connection.
// Staging also permits a bounded JSON preflight before decoding typed slices.
func (s *Store) stageImport(ctx context.Context, r io.Reader) (*os.File, error) {
	f, err := s.TemporaryFile(".import-*")
	if err != nil {
		return nil, err
	}
	n, err := io.Copy(f, io.LimitReader(r, (8<<20)+1))
	if err == nil && n > 8<<20 {
		err = errors.New("import exceeds 8 MiB")
	}
	if err == nil {
		err = ctx.Err()
	}
	if err == nil {
		_, err = f.Seek(0, io.SeekStart)
	}
	if err != nil {
		f.Close()
		os.Remove(f.Name())
		return nil, err
	}
	return f, nil
}

// Count before allocation, including case-insensitive and duplicate fields as
// accepted by encoding/json. Unknown legacy fields are traversed without keeping
// their values. Never Decode a trailing document into interface{}.
func preflightImport(r io.Reader) error {
	d := json.NewDecoder(r)
	d.UseNumber()
	collections, links, pins := 0, 0, 0
	var value func(string, int, *int, int) error
	value = func(shape string, depth int, count *int, limit int) error {
		if depth > 64 {
			return errors.New("JSON nesting exceeds 64")
		}
		token, err := d.Token()
		if err != nil {
			return err
		}
		switch token {
		case json.Delim('{'):
			tags := 0
			for d.More() {
				key, err := d.Token()
				if err != nil {
					return err
				}
				name, ok := key.(string)
				if !ok {
					return errors.New("expected JSON field name")
				}
				child, max := "", 0
				var counter *int
				switch {
				case shape == "root" && strings.EqualFold(name, "collections"):
					child, counter, max = "collection", &collections, 2000
				case (shape == "root" || shape == "collection") && strings.EqualFold(name, "links"):
					child, counter, max = "link", &links, 10000
				case shape == "root" && strings.EqualFold(name, "pinnedLinks"):
					child, counter, max = "link", &pins, 10000
				case shape == "link" && strings.EqualFold(name, "tags"):
					counter, max = &tags, 32
				}
				if err := value(child, depth+1, counter, max); err != nil {
					return err
				}
			}
			_, err = d.Token()
			return err
		case json.Delim('['):
			for d.More() {
				if count != nil {
					*count++
					if *count > limit {
						return errors.New("import exceeds collection, link, pinned link or tag limit")
					}
				}
				if err := value(shape, depth+1, nil, 0); err != nil {
					return err
				}
			}
			_, err = d.Token()
			return err
		}
		return nil
	}
	if err := value("root", 0, nil, 0); err != nil {
		return err
	}
	if _, err := d.Token(); err != io.EOF {
		return errors.New("expected a single JSON document")
	}
	return nil
}
