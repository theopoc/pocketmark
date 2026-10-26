package server

import (
	"fmt"
	"net/http"
	"net/netip"
	"strings"
	"time"
)

type loginWindow struct {
	at    time.Time
	count int
}

// SetTrustedProxies must be called before serving. Forwarded addresses are only
// used when the immediate peer belongs to an explicitly configured proxy CIDR.
func (a *Server) SetTrustedProxies(raw string) error {
	var prefixes []netip.Prefix
	if strings.TrimSpace(raw) != "" {
		for _, part := range strings.Split(raw, ",") {
			prefix, err := netip.ParsePrefix(strings.TrimSpace(part))
			if err != nil {
				return fmt.Errorf("POCKETMARK_TRUSTED_PROXIES must contain comma-separated CIDRs: %w", err)
			}
			prefixes = append(prefixes, prefix.Masked())
		}
	}
	a.trustedProxies = prefixes
	return nil
}

func (a *Server) trustedProxy(addr netip.Addr) bool {
	for _, prefix := range a.trustedProxies {
		if prefix.Contains(addr) {
			return true
		}
	}
	return false
}

func (a *Server) clientSource(r *http.Request) netip.Addr {
	peer, err := netip.ParseAddrPort(r.RemoteAddr)
	if err != nil {
		return netip.Addr{}
	} // Unknown peers share one bounded bucket.
	addr := peer.Addr().Unmap()
	if a.trustedProxy(addr) {
		forwarded := strings.Join(r.Header.Values("X-Forwarded-For"), ",")
		hops := strings.Split(forwarded, ",")
		if len(forwarded) <= 2048 && len(hops) <= 32 {
			for i := len(hops) - 1; i >= 0 && a.trustedProxy(addr); i-- {
				next, err := netip.ParseAddr(strings.TrimSpace(hops[i]))
				if err != nil || next.Zone() != "" {
					addr = peer.Addr().Unmap()
					break
				}
				addr = next.Unmap()
			}
		}
	}
	// One IPv6 client cannot evade its limit by rotating interface addresses.
	if addr.Is6() {
		addr = netip.PrefixFrom(addr, 64).Masked().Addr()
	}
	return addr
}

func (a *Server) allowLogin(r *http.Request) bool {
	source := a.clientSource(r)
	now := time.Now()
	a.loginMu.Lock()
	defer a.loginMu.Unlock()
	// Full capacity fails closed instead of evicting active limits that a caller
	// could then repeatedly reset with spoofed identities. The map stays bounded.
	for key, window := range a.loginAttempts {
		if now.Sub(window.at) >= time.Minute {
			delete(a.loginAttempts, key)
		}
	}
	window, exists := a.loginAttempts[source]
	if !exists {
		if len(a.loginAttempts) >= 256 {
			return false
		}
		window.at = now
	}
	if window.count >= 10 {
		return false
	}
	window.count++
	a.loginAttempts[source] = window
	return true
}
