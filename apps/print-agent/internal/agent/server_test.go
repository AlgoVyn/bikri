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
	req, _ := http.NewRequest(http.MethodPost, httpServer.URL+"/ui/unpair", nil)
	res, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusSeeOther {
		t.Fatalf("unpair status = %d", res.StatusCode)
	}
	if s.auth.Verify(token) {
		t.Fatal("token still works after the local reset")
	}
	if s.cfg.Paired {
		t.Fatal("config still says paired")
	}
}
