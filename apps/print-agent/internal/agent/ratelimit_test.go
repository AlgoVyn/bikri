package agent

import (
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
