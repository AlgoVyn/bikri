package agent

import (
	"net"
	"sync"
	"time"
)

// rateLimiter is a small fixed-window limiter for the loopback API. Keys are
// namespaced ("pair:<ip>", "jobs:<token hash>") so one limit cannot consume
// another's budget.
type rateLimiter struct {
	mu     sync.Mutex
	hits   map[string][]time.Time
	now    func() time.Time
	window time.Duration
}

func newRateLimiter(window time.Duration) *rateLimiter {
	return &rateLimiter{hits: map[string][]time.Time{}, now: time.Now, window: window}
}

func (l *rateLimiter) allow(key string, limit int) bool {
	if limit <= 0 {
		return false
	}
	now := l.now()
	cutoff := now.Add(-l.window)
	l.mu.Lock()
	defer l.mu.Unlock()
	recent := l.hits[key]
	first := 0
	for first < len(recent) && !recent[first].After(cutoff) {
		first++
	}
	recent = recent[first:]
	if len(recent) >= limit {
		l.hits[key] = recent
		return false
	}
	l.hits[key] = append(recent, now)
	return true
}

func remoteIP(addr string) string {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return addr
	}
	return host
}
