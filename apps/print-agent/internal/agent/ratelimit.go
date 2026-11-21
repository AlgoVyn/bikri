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
	calls  uint64
}

func newRateLimiter(window time.Duration) *rateLimiter {
	return &rateLimiter{hits: map[string][]time.Time{}, now: time.Now, window: window}
}

// sweepLocked drops buckets whose entries have all aged out. Without it, a
// long-running agent keeps one map key per client IP and token it has ever seen.
func (l *rateLimiter) sweepLocked(cutoff time.Time) {
	for key, times := range l.hits {
		first := 0
		for first < len(times) && !times[first].After(cutoff) {
			first++
		}
		if first == len(times) {
			delete(l.hits, key)
			continue
		}
		if first > 0 {
			l.hits[key] = append([]time.Time(nil), times[first:]...)
		}
	}
}

func (l *rateLimiter) allow(key string, limit int) bool {
	if limit <= 0 {
		return false
	}
	now := l.now()
	cutoff := now.Add(-l.window)
	l.mu.Lock()
	defer l.mu.Unlock()
	l.calls++
	if l.calls%256 == 0 {
		l.sweepLocked(cutoff)
	}
	recent := l.hits[key]
	first := 0
	for first < len(recent) && !recent[first].After(cutoff) {
		first++
	}
	if first > 0 {
		// Copy instead of reslicing so the expired entries can be collected.
		recent = append([]time.Time(nil), recent[first:]...)
	}
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
