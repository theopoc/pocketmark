package capture

import (
	"context"
	"errors"
	"io"
	"net"
	"net/netip"
	"strings"
	"testing"
)

func TestSecurityDNSAndIPVariants(t *testing.T) {
	blockedIPs := []string{"127.0.0.2", "127.255.255.254", "10.255.255.254", "172.16.0.1", "172.31.255.254", "192.168.255.254", "169.254.169.254", "169.254.170.2", "100.100.100.200", "198.19.255.254", "0.0.0.1", "240.0.0.1", "::ffff:127.0.0.1", "::ffff:169.254.169.254", "64:ff9b::a9fe:a9fe", "64:ff9b:1::a9fe:a9fe", "2002:7f00:1::", "2001::a9fe:a9fe", "fe80::1%lo0", "fd00:ec2::254", "::127.0.0.1", "100::1", "3fff:fff::1"}
	for _, raw := range blockedIPs {
		t.Run(raw, func(t *testing.T) {
			ip := netip.MustParseAddr(raw)
			if isPublic(ip) {
				t.Fatal("unsafe address accepted")
			}
			called := false
			dial := publicDial(func(context.Context, string, string) ([]netip.Addr, error) {
				return []netip.Addr{netip.MustParseAddr("8.8.8.8"), ip}, nil
			}, func(context.Context, string, string) (net.Conn, error) { called = true; return nil, errors.New("stub") })
			if _, err := dial(context.Background(), "tcp", "audit.invalid:443"); err == nil || called {
				t.Fatal("mixed DNS was dialed")
			}
		})
	}
	// Ambiguous numeric host spellings are still checked after resolution.
	for _, host := range []string{"2130706433", "0177.0.0.1", "0x7f000001", "127.1", "localhost.", "example.test."} {
		dial := publicDial(func(context.Context, string, string) ([]netip.Addr, error) {
			return []netip.Addr{netip.MustParseAddr("127.0.0.1")}, nil
		}, func(context.Context, string, string) (net.Conn, error) {
			t.Fatal("private alias dialed")
			return nil, nil
		})
		if _, err := dial(context.Background(), "tcp", net.JoinHostPort(host, "80")); err == nil {
			t.Fatal("private alias accepted")
		}
	}
	calls := 0
	lookups := 0
	dial := publicDial(func(context.Context, string, string) ([]netip.Addr, error) {
		lookups++
		if lookups > 1 {
			return []netip.Addr{netip.MustParseAddr("127.0.0.1")}, nil
		}
		return []netip.Addr{netip.MustParseAddr("8.8.8.8")}, nil
	}, func(_ context.Context, _, addr string) (net.Conn, error) {
		calls++
		if addr != "8.8.8.8:443" {
			t.Fatal(addr)
		}
		return nil, errors.New("stub")
	})
	dial(context.Background(), "tcp", "rebinding.test:443")
	if calls != 1 || lookups != 1 {
		t.Fatal("DNS not pinned")
	}
}
func FuzzSecurityPreview(f *testing.F) {
	for _, s := range []string{"<noscript><a href=/probe>x</a></noscript>", "<svg><style><a href=/probe>x</a></style></svg>", "<math><mtext></style><img src=x onerror=alert(1)>", strings.Repeat("<div>", 100), "\x00\xff"} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, s string) {
		if len(s) > 65536 {
			return
		}
		Preview(strings.NewReader(s), io.Discard)
		Reader(strings.NewReader(s), io.Discard, "https://example.test/")
	})
}
