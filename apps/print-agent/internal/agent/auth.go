package agent

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"math/big"
	"sync"
	"time"
)

const (
	pairingTTL      = 2 * time.Minute
	pairingAttempts = 5
	tokenBytes      = 32
)

var (
	errAlreadyPaired = errors.New("already paired")
	errBadCode       = errors.New("bad or expired pairing code")
	errTooManyTries  = errors.New("too many pairing attempts")
)

// Auth owns the one-time pairing code and the long-lived bearer token hash.
type Auth struct {
	mu       sync.Mutex
	cfg      *Config
	code     string
	expires  time.Time
	attempts int
	now      func() time.Time
}

// NewAuth builds the pairing state for a config. A paired agent has no code.
func NewAuth(cfg *Config) *Auth {
	a := &Auth{cfg: cfg, now: time.Now}
	a.rotate()
	return a
}

// PairingCode returns the current code while the agent is unpaired.
func (a *Auth) PairingCode() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.cfg.Paired {
		return ""
	}
	if a.code == "" || a.now().After(a.expires) {
		a.rotateLocked()
	}
	return a.code
}

// Pair validates a one-time code and returns a new bearer token in memory. It
// is exposed for tests; the HTTP handlers use PairAndPersist so a failed write
// cannot publish a token that is gone after a restart.
func (a *Auth) Pair(code string) (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.pairLocked(code)
}

// PairAndPersist mutates memory and writes config.json under one lock. On a
// failed write the pairing state is rolled back, so the token returned to the
// caller is always the token the agent will accept after a restart.
func (a *Auth) PairAndPersist(path, code string) (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	prevPaired, prevHash := a.cfg.Paired, a.cfg.TokenHash
	prevCode, prevExpires, prevAttempts := a.code, a.expires, a.attempts
	token, err := a.pairLocked(code)
	if err != nil {
		return "", err
	}
	if err := SaveConfig(path, a.cfg); err != nil {
		a.cfg.Paired, a.cfg.TokenHash = prevPaired, prevHash
		a.code, a.expires, a.attempts = prevCode, prevExpires, prevAttempts
		return "", err
	}
	return token, nil
}

func (a *Auth) pairLocked(code string) (string, error) {
	if a.cfg.Paired {
		return "", errAlreadyPaired
	}
	if a.code == "" || a.now().After(a.expires) {
		a.rotateLocked()
		return "", errBadCode
	}
	if a.attempts >= pairingAttempts {
		return "", errTooManyTries
	}
	a.attempts++
	if subtle.ConstantTimeCompare([]byte(code), []byte(a.code)) != 1 {
		return "", errBadCode
	}
	token, err := newToken()
	if err != nil {
		return "", err
	}
	a.cfg.Paired = true
	a.cfg.TokenHash = hashToken(token)
	a.code = ""
	a.expires = time.Time{}
	a.attempts = 0
	return token, nil
}

// Verify checks a bearer token without leaking timing information.
func (a *Auth) Verify(token string) bool {
	if token == "" {
		return false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.cfg.TokenHash == "" {
		return false
	}
	got := hashToken(token)
	return subtle.ConstantTimeCompare([]byte(got), []byte(a.cfg.TokenHash)) == 1
}

// Paired reports the pairing state under the same lock as Pair/Unpair.
func (a *Auth) Paired() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.cfg.Paired
}

// Unpair revokes the token and starts a new pairing window in memory only. It
// is exposed for tests; the HTTP handlers use UnpairAndPersist.
func (a *Auth) Unpair() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.cfg.Paired = false
	a.cfg.TokenHash = ""
	a.rotateLocked()
}

// UnpairAndPersist revokes the token and writes the config under one lock. A
// failed write restores the old token in memory too: the alternative was a
// "revoked" agent whose old token came back on the next restart.
func (a *Auth) UnpairAndPersist(path string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	prevPaired, prevHash := a.cfg.Paired, a.cfg.TokenHash
	a.cfg.Paired = false
	a.cfg.TokenHash = ""
	if err := SaveConfig(path, a.cfg); err != nil {
		a.cfg.Paired, a.cfg.TokenHash = prevPaired, prevHash
		return err
	}
	a.rotateLocked()
	return nil
}

func (a *Auth) rotate() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.rotateLocked()
}

func (a *Auth) rotateLocked() {
	a.code = randomCode()
	a.expires = a.now().Add(pairingTTL)
	a.attempts = 0
}

func newToken() (string, error) {
	var b [tokenBytes]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b[:]), nil
}

func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func randomCode() string {
	n, err := rand.Int(rand.Reader, big.NewInt(1_000_000))
	if err != nil {
		panic(err)
	}
	return leftPad(n.Int64(), 6)
}

func leftPad(n int64, width int) string {
	s := make([]byte, width)
	for i := width - 1; i >= 0; i-- {
		s[i] = byte('0' + n%10)
		n /= 10
	}
	return string(s)
}
