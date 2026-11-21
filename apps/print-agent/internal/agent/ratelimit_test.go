package agent

import (
	"fmt"
	"testing"
	"time"
)

func TestRateLimiterWindow(t *testing.T) {
	now := time.Unix(0, 0)
	limiter := newRateLimiter(time.Minute)
	limiter.now = func() time.Time { return now }
	if !limiter.allow("pair:127.0.0.1", 2) {
		t.Fatal("first request was refused")
	}
	if !limiter.allow("pair:127.0.0.1", 2) {
		t.Fatal("second request was refused")
	}
	if limiter.allow("pair:127.0.0.1", 2) {
		t.Fatal("third request was allowed")
	}
	// A different bucket is independent.
	if !limiter.allow("jobs:token", 2) {
		t.Fatal("separate bucket was refused")
	}
	now = now.Add(time.Minute + time.Second)
	if !limiter.allow("pair:127.0.0.1", 2) {
		t.Fatal("request after the window was refused")
	}
	if got := remoteIP("127.0.0.1:54321"); got != "127.0.0.1" {
		t.Fatalf("remoteIP = %q", got)
	}
	if got := remoteIP("[::1]:54321"); got != "::1" {
		t.Fatalf("remoteIP = %q", got)
	}
}

func TestRateLimiterEvictsExpiredBuckets(t *testing.T) {
	now := time.Unix(0, 0)
	limiter := newRateLimiter(time.Minute)
	limiter.now = func() time.Time { return now }
	for i := 0; i < 300; i++ {
		limiter.allow(fmt.Sprintf("pair:10.0.0.%d", i), 10)
	}
	now = now.Add(2 * time.Minute)
	// The 512th call triggers a sweep; every old bucket has aged out.
	for i := 0; i < 300; i++ {
		limiter.allow("jobs:fresh", 1000)
	}
	limiter.mu.Lock()
	buckets := len(limiter.hits)
	limiter.mu.Unlock()
	if buckets != 1 {
		t.Fatalf("rateLimiter kept %d buckets after a sweep", buckets)
	}
}
