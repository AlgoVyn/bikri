package agent

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/algovyn/bikri/apps/print-agent/internal/backend"
)

func testServer(t *testing.T) (*Server, *fakeBackend) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.json")
	cfg, err := LoadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	fake := &fakeBackend{
		spoolID: "42",
		status:  backend.Status{State: "done"},
		printers: []backend.Printer{
			{Name: "Bixolon", IsDefault: true},
			{Name: "Office"},
		},
	}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	auth := NewAuth(cfg)
	return NewServer(cfg, path, auth, NewManager(fake), fake, log, "test", "/tmp/agent.log"), fake
}

func TestHealthAndUI(t *testing.T) {
	s, _ := testServer(t)
	httpServer := httptest.NewServer(s.Handler())
	defer httpServer.Close()

	res, err := http.Get(httpServer.URL + "/v1/health")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("health status = %d", res.StatusCode)
	}
	var health healthResponse
	if err := json.NewDecoder(res.Body).Decode(&health); err != nil {
		t.Fatal(err)
	}
	if health.Paired || health.Printers != 2 || health.Protocol != Protocol {
		t.Fatalf("health = %+v", health)
	}
	if health.PairingCode == "" {
		t.Fatal("unpaired health did not expose the pairing code")
	}

	ui, err := http.Get(httpServer.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	defer ui.Body.Close()
	body, _ := io.ReadAll(ui.Body)
	if !bytes.Contains(body, []byte("Bikri Print Agent")) || !bytes.Contains(body, []byte("Not paired")) {
		t.Fatalf("unexpected UI: %s", body)
	}
	if !bytes.Contains(body, []byte(s.auth.PairingCode())) {
		t.Fatal("UI did not show the pairing code")
	}
}

func TestPairThenPrint(t *testing.T) {
	s, fake := testServer(t)
	httpServer := httptest.NewServer(s.Handler())
	defer httpServer.Close()

	code := s.auth.PairingCode()
	pairBody, _ := json.Marshal(map[string]string{"code": code, "clientName": "test"})
	req, _ := http.NewRequest(http.MethodPost, httpServer.URL+"/v1/pair", bytes.NewReader(pairBody))
	req.Header.Set("Origin", "https://algovyn.com")
	pairRes, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer pairRes.Body.Close()
	if pairRes.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(pairRes.Body)
		t.Fatalf("pair status = %d: %s", pairRes.StatusCode, body)
	}
	var pair struct {
		Token   string `json:"token"`
		AgentID string `json:"agentId"`
	}
	if err := json.NewDecoder(pairRes.Body).Decode(&pair); err != nil {
		t.Fatal(err)
	}
	if pair.Token == "" || pair.AgentID == "" {
		t.Fatalf("pair response = %+v", pair)
	}

	// Once paired, health must not expose a pairing code.
	res, err := http.Get(httpServer.URL + "/v1/health")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var pairedHealth healthResponse
	if err := json.NewDecoder(res.Body).Decode(&pairedHealth); err != nil {
		t.Fatal(err)
	}
	if !pairedHealth.Paired || pairedHealth.PairingCode != "" {
		t.Fatalf("paired health = %+v", pairedHealth)
	}

	noAuth, _ := http.Get(httpServer.URL + "/v1/printers")
	if noAuth.StatusCode != http.StatusUnauthorized {
		t.Fatalf("printers without token = %d", noAuth.StatusCode)
	}
	noAuth.Body.Close()

	printers := authGet(t, httpServer.URL+"/v1/printers", pair.Token)
	var list []backend.Printer
	if err := json.Unmarshal(printers, &list); err != nil {
		t.Fatal(err)
	}
	if len(list) != 2 || !list[0].IsDefault {
		t.Fatalf("printers = %+v", list)
	}

	jobBody, _ := json.Marshal(validRequest())
	jobReq, _ := http.NewRequest(http.MethodPost, httpServer.URL+"/v1/jobs", bytes.NewReader(jobBody))
	jobReq.Header.Set("Authorization", "Bearer "+pair.Token)
	jobReq.Header.Set("Content-Type", "application/json")
	jobRes, err := http.DefaultClient.Do(jobReq)
	if err != nil {
		t.Fatal(err)
	}
	defer jobRes.Body.Close()
	if jobRes.StatusCode != http.StatusAccepted {
		body, _ := io.ReadAll(jobRes.Body)
		t.Fatalf("job status = %d: %s", jobRes.StatusCode, body)
	}
	var job JobStatus
	if err := json.NewDecoder(jobRes.Body).Decode(&job); err != nil {
		t.Fatal(err)
	}
	if job.Status != "spooled" || job.JobID != "job-1" {
		t.Fatalf("job = %+v", job)
	}

	status := authGet(t, httpServer.URL+"/v1/jobs/job-1", pair.Token)
	if !strings.Contains(string(status), `"status":"done"`) {
		t.Fatalf("status = %s", status)
	}
	if fake.printCalls != 1 {
		t.Fatalf("print calls = %d", fake.printCalls)
	}
}

func TestSecurityChecks(t *testing.T) {
	s, _ := testServer(t)
	httpServer := httptest.NewServer(s.Handler())
	defer httpServer.Close()

	// A website that is not on the allowlist cannot read the API.
	req, _ := http.NewRequest(http.MethodGet, httpServer.URL+"/v1/health", nil)
	req.Header.Set("Origin", "https://evil.example")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("bad origin status = %d", res.StatusCode)
	}

	// DNS rebinding protection: a non-loopback Host is refused.
	req, _ = http.NewRequest(http.MethodGet, httpServer.URL+"/v1/health", nil)
	req.Host = "evil.example"
	res, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("bad host status = %d", res.StatusCode)
	}

	// A loopback name on a different local port is still a rebinding vector:
	// only the port this process is listening on is accepted (14 §7).
	req, _ = http.NewRequest(http.MethodGet, httpServer.URL+"/v1/health", nil)
	req.Host = "127.0.0.1:9"
	res, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("bad host port status = %d", res.StatusCode)
	}

	// CORS preflight for the Bikri origin.
	req, _ = http.NewRequest(http.MethodOptions, httpServer.URL+"/v1/jobs", nil)
	req.Header.Set("Origin", "https://algovyn.com")
	req.Header.Set("Access-Control-Request-Method", "POST")
	res, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusNoContent {
		t.Fatalf("preflight status = %d", res.StatusCode)
	}
	if res.Header.Get("Access-Control-Allow-Origin") != "https://algovyn.com" {
		t.Fatalf("missing CORS origin: %v", res.Header)
	}
	if res.Header.Get("Access-Control-Allow-Private-Network") != "true" {
		t.Fatalf("missing private-network header: %v", res.Header)
	}
}

// The local page shows the CSRF nonce, the OS printer list and the log path. It
// is not an API resource: no Origin other than the loopback page itself may read
// it, and no CORS header may be emitted for it (PRT-H3).
func TestUINeverEmitsCORSAndRejectsCrossOrigin(t *testing.T) {
	s, _ := testServer(t)
	httpServer := httptest.NewServer(s.Handler())
	defer httpServer.Close()

	get := func(origin string) (*http.Response, []byte) {
		t.Helper()
		req, _ := http.NewRequest(http.MethodGet, httpServer.URL+"/", nil)
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		body, _ := io.ReadAll(res.Body)
		return res, body
	}
	for _, origin := range []string{"https://algovyn.com", "https://evil.example"} {
		res, _ := get(origin)
		if res.StatusCode != http.StatusForbidden {
			t.Fatalf("GET / with Origin %q = %d, want 403", origin, res.StatusCode)
		}
		if got := res.Header.Get("Access-Control-Allow-Origin"); got != "" {
			t.Fatalf("GET / with Origin %q leaked Access-Control-Allow-Origin %q", origin, got)
		}
		if got := res.Header.Get("Access-Control-Allow-Private-Network"); got != "" {
			t.Fatalf("GET / with Origin %q leaked the private-network header %q", origin, got)
		}
	}

	// The page on its own loopback origin still loads and never emits CORS.
	res, body := get(httpServer.URL)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("same-origin GET / = %d", res.StatusCode)
	}
	if got := res.Header.Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("same-origin GET / emitted Access-Control-Allow-Origin %q", got)
	}
	if !strings.Contains(string(body), "Bikri Print Agent") {
		t.Fatalf("unexpected UI: %s", body)
	}
	if csp := res.Header.Get("Content-Security-Policy"); !strings.Contains(csp, "form-action 'self'") {
		t.Fatalf("UI CSP does not pin the form action: %q", csp)
	}

	// The API keeps its CORS contract.
	req, _ := http.NewRequest(http.MethodGet, httpServer.URL+"/v1/health", nil)
	req.Header.Set("Origin", "https://algovyn.com")
	api, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer api.Body.Close()
	if api.StatusCode != http.StatusOK {
		t.Fatalf("GET /v1/health = %d", api.StatusCode)
	}
	if got := api.Header.Get("Access-Control-Allow-Origin"); got != "https://algovyn.com" {
		t.Fatalf("API Access-Control-Allow-Origin = %q", got)
	}
	if got := api.Header.Get("Access-Control-Allow-Private-Network"); got != "true" {
		t.Fatalf("API Access-Control-Allow-Private-Network = %q", got)
	}
	if got := api.Header.Get("Vary"); !strings.Contains(got, "Origin") {
		t.Fatalf("API Vary = %q, want Origin", got)
	}
}

func authGet(t *testing.T, url, token string) []byte {
	t.Helper()
	req, _ := http.NewRequest(http.MethodGet, url, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(res.Body)
		t.Fatalf("GET %s = %d: %s", url, res.StatusCode, body)
	}
	body, _ := io.ReadAll(res.Body)
	return body
}

func TestUIUnpairResetsPairing(t *testing.T) {
	s, _ := testServer(t)
	httpServer := httptest.NewServer(s.Handler())
	defer httpServer.Close()

	token, err := s.auth.Pair(s.auth.PairingCode())
	if err != nil {
		t.Fatal(err)
	}
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}}
	nonce := uiNonce(t, httpServer.URL)
	post := func(origin, site, csrf string) *http.Response {
		t.Helper()
		form := strings.NewReader("csrf=" + csrf)
		req, _ := http.NewRequest(http.MethodPost, httpServer.URL+"/ui/unpair", form)
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		if site != "" {
			req.Header.Set("Sec-Fetch-Site", site)
		}
		res, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		return res
	}
	if res := post(httpServer.URL, "same-origin", ""); res.StatusCode != http.StatusForbidden {
		t.Fatalf("missing nonce status = %d", res.StatusCode)
	}
	if res := post("https://evil.example", "same-origin", nonce); res.StatusCode != http.StatusForbidden {
		t.Fatalf("bad origin status = %d", res.StatusCode)
	}
	if res := post(httpServer.URL, "cross-site", nonce); res.StatusCode != http.StatusForbidden {
		t.Fatalf("cross-site status = %d", res.StatusCode)
	}
	// A refused request must not have unpaired the agent.
	if !s.auth.Verify(token) {
		t.Fatal("token stopped working after refused unpair requests")
	}
	if res := post(httpServer.URL, "same-origin", nonce); res.StatusCode != http.StatusSeeOther {
		t.Fatalf("unpair status = %d", res.StatusCode)
	}
	if s.auth.Verify(token) {
		t.Fatal("token still works after the local reset")
	}
	if s.cfg.Paired {
		t.Fatal("config still says paired")
	}
}

func TestSameLoopbackOrigin(t *testing.T) {
	cases := []struct {
		origin string
		host   string
		want   bool
	}{
		{"http://127.0.0.1:17890", "127.0.0.1:17890", true},
		{"http://localhost:17890", "localhost:17890", true},
		{"http://[::1]:17890", "[::1]:17890", true},
		{"https://127.0.0.1:17890", "127.0.0.1:17890", false},
		{"http://127.0.0.1:5173", "127.0.0.1:17890", false},
		{"http://evil.example", "127.0.0.1:17890", false},
		{"", "127.0.0.1:17890", false},
	}
	for _, tc := range cases {
		if got := sameLoopbackOrigin(tc.origin, tc.host); got != tc.want {
			t.Fatalf("sameLoopbackOrigin(%q, %q) = %v, want %v", tc.origin, tc.host, got, tc.want)
		}
	}
}

func errorCode(t *testing.T, body []byte) string {
	t.Helper()
	var record map[string]string
	if err := json.Unmarshal(body, &record); err != nil {
		t.Fatalf("error body is not JSON: %s", body)
	}
	return record["error"]
}

func pairOnce(t *testing.T, s *Server, base string) string {
	t.Helper()
	code := s.auth.PairingCode()
	body, _ := json.Marshal(map[string]string{"code": code, "clientName": "test"})
	res, err := http.Post(base+"/v1/pair", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		payload, _ := io.ReadAll(res.Body)
		t.Fatalf("pair status = %d: %s", res.StatusCode, payload)
	}
	var pair struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(res.Body).Decode(&pair); err != nil {
		t.Fatal(err)
	}
	return pair.Token
}

func TestPairRateLimitUsesRateLimitedCode(t *testing.T) {
	s, _ := testServer(t)
	httpServer := httptest.NewServer(s.Handler())
	defer httpServer.Close()
	var last *http.Response
	for i := 0; i < 6; i++ {
		req, _ := http.NewRequest(http.MethodPost, httpServer.URL+"/v1/pair", strings.NewReader(`{"code":"!!!!!!"}`))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", "https://algovyn.com")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		if last != nil {
			last.Body.Close()
		}
		last = res
	}
	defer last.Body.Close()
	if last.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("sixth pair attempt = %d, want 429", last.StatusCode)
	}
	payload, _ := io.ReadAll(last.Body)
	if code := errorCode(t, payload); code != "RATE_LIMITED" {
		t.Fatalf("rate limit code = %q, want RATE_LIMITED", code)
	}
}

func TestOversizedBodiesArePayloadTooLarge(t *testing.T) {
	s, _ := testServer(t)
	httpServer := httptest.NewServer(s.Handler())
	defer httpServer.Close()

	bigPair := `{"code":"` + strings.Repeat("a", 9<<10) + `"}`
	req, _ := http.NewRequest(http.MethodPost, httpServer.URL+"/v1/pair", strings.NewReader(bigPair))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "https://algovyn.com")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	payload, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized pair body = %d: %s", res.StatusCode, payload)
	}
	if code := errorCode(t, payload); code != "PAYLOAD_TOO_LARGE" {
		t.Fatalf("oversized pair code = %q", code)
	}

	token := pairOnce(t, s, httpServer.URL)
	bigJob := `{"jobId":"job-1","printer":"Bixolon","mode":"raw","encoding":"escpos","data":"` +
		strings.Repeat("a", 5<<20) + `"}`
	req, _ = http.NewRequest(http.MethodPost, httpServer.URL+"/v1/jobs", strings.NewReader(bigJob))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	res, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	payload, _ = io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized job body = %d: %s", res.StatusCode, payload)
	}
	if code := errorCode(t, payload); code != "PAYLOAD_TOO_LARGE" {
		t.Fatalf("oversized job code = %q", code)
	}
}

func uiNonce(t *testing.T, base string) string {
	t.Helper()
	res, err := http.Get(base + "/")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	const marker = `name="csrf" value="`
	at := bytes.Index(body, []byte(marker))
	if at < 0 {
		t.Fatal("CSRF input not found")
	}
	rest := body[at+len(marker):]
	end := bytes.IndexByte(rest, '"')
	if end < 0 {
		t.Fatal("CSRF value is not terminated")
	}
	return string(rest[:end])
}
