package store

import (
	"context"
	"strings"
	"testing"
)

func TestSecurityXMLAndRollback(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	id := createLink(t, s, Link{URL: "https://example.test/keep", Title: "keep"})
	payloads := map[string]string{
		"external-entity":  `<!DOCTYPE xbel [<!ENTITY xxe SYSTEM "file:///audit-no-such-file">]><xbel><bookmark href="https://example.test/x"><title>&xxe;</title></bookmark></xbel>`,
		"entity-expansion": `<!DOCTYPE xbel [<!ENTITY a "EXPAND"><!ENTITY b "&a;&a;&a;&a;">]><xbel><bookmark href="https://example.test/x"><title>&b;</title></bookmark></xbel>`,
		"second-document":  `<xbel></xbel><xbel></xbel>`, "unknown-entity": `<xbel><title>&unknown;</title></xbel>`,
		"deep-folders":        "<xbel>" + strings.Repeat("<folder>", 100) + strings.Repeat("</folder>", 100) + "</xbel>",
		"active-url":          `<xbel><bookmark href="javascript:alert(1)"/></xbel>`,
		"invalid-after-valid": `<xbel><bookmark href="https://example.test/new"/><bookmark href="file:///etc/passwd"/></xbel>`,
	}
	for name, payload := range payloads {
		t.Run(name, func(t *testing.T) {
			if err := s.ReplaceXBEL(ctx, strings.NewReader(payload), ""); err == nil {
				t.Fatal("malicious import accepted")
			}
			if got, err := s.Get(ctx, id); err != nil || got.Title != "keep" {
				t.Fatal("rollback failed", err)
			}
		})
	}
}
func FuzzSecurityXBEL(f *testing.F) {
	for _, s := range []string{"<xbel/>", "<xbel><unknown><x/></unknown></xbel>", "<!DOCTYPE xbel [<!ENTITY a 'a'>]><xbel>&a;</xbel>", "<xbel><bookmark href='https://example.test'/></xbel>"} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, s string) {
		if len(s) > 65536 {
			return
		}
		readXBEL(strings.NewReader(s))
	})
}
