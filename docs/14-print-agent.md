# 14 — Print agent

**Status:** Phase 1 implemented, 11 Nov 2026. Core agent, Windows/CUPS backends, GitHub-release packages and the Bikri `agent` transport are in `apps/print-agent` and the PWA. Authenticode signing/notarization, auto-update and direct TCP remain release tasks. See §18.

**Related:** [06-printing](06-printing.md), [01-architecture](01-architecture.md), [10-testing](10-testing.md), [11-roadmap](11-roadmap.md), [13-multi-tenancy](13-multi-tenancy.md), [screens/17](screens/17-settings.md#printer), [decisions](decisions.md).

## 1. Summary

A small local service — **Bikri Print Agent** — installed once per till. It accepts print jobs from Bikri over a loopback-only HTTP API and prints them through the operating system's existing print queue.

It has two backends:

1. **Raw ESC/POS** through the OS spooler (Windows spooler `RAW`, CUPS `lp -o raw`). This preserves the features Bikri already generates: drawer kick, cut, QR, logo and raster Urdu.
2. **Driver-rendered image** (a receipt PNG) through the OS driver (Windows GDI, CUPS on Linux/macOS). This is the compatibility fallback for printers that do not accept raw ESC/POS.

Bikri gains a new `agent` transport. There are **no Worker, API, D1, sync or tenancy changes**. The agent is local, works offline, and never sends shop data to Algovyn.

## 2. Why

The current transports each have a painful edge:

| Current transport | Pain |
|---|---|
| WebUSB | On Windows the vendor driver owns the USB interface, so Chrome cannot claim it. Fixing it means replacing the driver with WinUSB (Zadig), which removes the printer from Windows printing. |
| Web Serial | Depends on a COM port driver; many USB-only printers do not expose one. |
| System printing | Works everywhere but always opens a dialog (unless `--kiosk-printing`), prints to the Windows default printer, cannot choose a named queue, cannot open the drawer or control the cut, and reports "done" even when the user cancels. |
| Network printers | Not supported in v1; a browser cannot open `printerIP:9100`. |

The OS already has the driver, queue and port. The agent uses them instead of replacing them:

- **No Zadig / WinUSB** for the raw path.
- **Silent printing** to a **named queue**, not the default printer.
- **Real spooler status**, so a cancelled or failed job is not marked "printed".
- **Drawer and cut** for ESC/POS printers.
- **Network and shared printers** through the OS queue.
- One installation works for USB, serial, Ethernet, Wi-Fi and shared printers once the OS queue exists.

## 3. Goals and non-goals

### Goals

- One codebase for **Windows 10/11, Linux and macOS**.
- Use installed OS print queues; never replace a printer driver.
- Raw ESC/POS first, driver-rendered bitmap as a fallback.
- Silent, named-printer printing with job status and idempotent retries.
- Loopback-only, paired, offline-first, no server dependency.
- One installer per till; Bikri auto-detects the agent and falls back if it is absent.
- `transport: 'agent'` fits the existing `PrinterKv` and `print_jobs` model without a D1 or Dexie migration.
- No receipt contents in agent logs; no tenant data leaves the till.

### Non-goals (v1)

- Replacing or configuring printer drivers.
- Writing printer NVRAM (density, speed, paper-width memory switches).
- Vendor SDKs or vendor-specific command languages.
- Bluetooth/BLE transports (Classic SPP can be added later as a serial backend).
- Cloud printing, vendor cloud services, or a cloud relay.
- Mobile agents (Android/iOS tills keep WebUSB/system printing).
- Direct ZPL/TSPL label commands (roadmap T-104).
- Fleet management, remote configuration or central monitoring.
- A4 invoice layout beyond what the existing HTML/bitmap renderer produces.

## 4. Architecture

```
┌──────────────────────────────┐
│ Bikri PWA                    │
│ https://algovyn.com/bikri    │
└──────────────┬───────────────┘
               │ HTTP/JSON on 127.0.0.1:17890
               │ Bearer token, Origin allowlist
┌──────────────▼───────────────┐
│ Bikri Print Agent            │
│  ├─ HTTP API + local UI      │
│  ├─ pairing / auth           │
│  ├─ printer registry         │
│  ├─ job queue + idempotency  │
│  └─ platform backend         │
└───────┬──────────────────────┘
        │
        ├─ Windows: winspool RAW or GDI → print queue → USB/TCP/shared port
        ├─ Linux/macOS: CUPS `lp -o raw` or `lp` → queue → USB/TCP
        └─ Phase 2: direct TCP 9100 (network printers)
```

Components:

- **API** — HTTP/1.1 + JSON on `127.0.0.1:17890`. Optional SSE for job events; polling is enough for v1.
- **Auth/pairing** — one-time code, long-lived bearer token, origin and Host checks.
- **Printer registry** — enumerates installed queues (Windows `EnumPrinters`, CUPS `lpstat -e`), reports names, driver/port where available, and the default queue.
- **Job queue** — per-printer FIFO, bounded, with idempotency by `jobId`, cancellation and status polling.
- **Platform backend** — raw or image printing, status and cancellation for the host OS.
- **Local UI** — embedded HTML page at `/` for status, pairing code, printer list, version and logs; no external assets.
- **Config/logs** — local files, metadata only.

## 5. Print backends

### 5.1 Raw ESC/POS (preferred for thermal printers)

Bikri sends the exact bytes it already produces in `packages/printer` — text, raster Urdu, logo, QR, cut and drawer commands. The agent does **not** rewrite or append commands.

**Windows**

- `OpenPrinter` → `StartDocPrinter` with a `DOC_INFO_1` whose `pDatatype` is `"RAW"` → `StartPagePrinter` → `WritePrinter` → `EndPagePrinter` → `EndDocPrinter` → `ClosePrinter`.
- The spooler sends the bytes to the queue's port. The vendor driver is installed but not used for rendering; this is the standard POS raw-print path.
- Some drivers/ports do not accept RAW. The agent must detect this, remember `supportsRaw=false` for that queue, and fall back to image mode or report `RAW_UNSUPPORTED`.
- This path avoids WinUSB/Zadig because it uses the installed queue.

**Linux / macOS**

- `lp -d <queue> -o raw -t "Bikri <jobId>" <file>` (or IPP `Print-Job` with `application/vnd.cups-raw`).
- The queue must be a raw queue or accept raw documents. Document `lpadmin -p <queue> -E -v <device-uri> -m raw` as the one-time admin step.
- The agent runs as the logged-in user; no root. CUPS policy controls who may print.

**Features:** drawer, cut, QR, logo, Urdu raster, exact dots, no dialog.
**Status:** spooler-reported (accepted/printing/completed/error). Physical paper-out is only visible if the driver/spooler reports it; raw USB via the spooler usually does not provide bidirectional status.

### 5.2 Driver-rendered image (compatibility fallback)

Bikri renders the receipt to a PNG at the printer's dot width (the existing `renderReceiptBitmap` path used for Urdu) and sends it with `paperMm` and `widthDots`. The agent prints it 1:1 through the OS driver.

**Windows**

- GDI: `CreateDC("WINSPOOL", printerName, …)` → `StartDoc` → `StartPage` → `StretchDIBits`/`SetDIBitsToDevice` → `EndPage` → `EndDoc` → `DeleteDC`.
- Use a per-job custom page size (height from the image) where the driver supports it; otherwise use the queue's configured receipt media and let the driver feed/cut.
- The agent can read the queue's supported media via `DeviceCapabilities`/`DEVMODE` and apply `dmPaperSize`/`dmPaperWidth`/`dmPaperLength` and margins **per job** (or via a `PrintTicket` on the XPS path). It must not silently change the machine-wide default; that is an explicit "save as default" action.
- No drawer/cut commands; the driver may have its own options, but Bikri cannot control them.

**Linux / macOS**

- Write the PNG/PDF to a temp file and `lp -d <queue> -o media=Custom.<w>x<h>mm <file>`.
- CUPS renders through the queue's driver. Media names and cut options vary by driver; the agent reports what `lpoptions -p <queue> -l` exposes.
- This mode allows any installed printer (A4, label, non-ESC/POS thermal, PDF).

**Features:** logo, QR and Urdu are baked into the image; no dialog.
**Limits:** no drawer/cut control, text is rasterized, page-size quirks must be tested per driver.

### 5.3 Direct TCP 9100 (phase 2)

For network printers without an OS queue: `net.DialTimeout("tcp", host:9100, 5s)`, write the raw ESC/POS bytes, close. No driver, no spooler status; `done` after the write succeeds. Useful for Ethernet/Wi-Fi printers and avoids Windows driver setup entirely.

### 5.4 Serial COM/tty (phase 2, optional)

The agent can own a serial port (`go.bug.st/serial`) and send raw ESC/POS when browser Web Serial is unavailable or unreliable. On Linux the user needs `dialout`; on Windows the COM port must exist. This is lower priority because Bikri already supports Web Serial.

### Backend comparison

| | Raw ESC/POS via spooler/CUPS | Driver image | Direct TCP 9100 |
|---|---|---|---|
| Uses installed driver | Queue/port only | Yes | No |
| Drawer / cut | Yes | No | Yes |
| QR / logo / Urdu | Exact raster | In the image | Exact raster |
| Named printer | Yes | Yes | IP:port |
| Job status | Spooler | Spooler | Write-only |
| No WinUSB/Zadig | Yes | Yes | Yes |
| Network printer | Via OS queue | Via OS queue | Direct |
| Best for | ESC/POS thermal | Any printer | ESC/POS network |

## 6. Protocol

Base URL: `http://127.0.0.1:17890/v1`. JSON is UTF-8; binary payloads are base64. Request body limit 5 MiB, job timeout 30 s. All timestamps are epoch milliseconds UTC.

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | App name, protocol version, agent version, platform, `paired`, printer count |
| `POST` | `/pair` | Exchange a 6-digit code for a bearer token |
| `POST` | `/unpair` | Revoke the current token (bearer required) |
| `GET` | `/printers` | Installed queues; `{name, driver?, port?, isDefault, supportsRaw?}` |
| `POST` | `/jobs` | Submit a job (bearer required) |
| `GET` | `/jobs/{id}` | Job status |
| `DELETE` | `/jobs/{id}` | Cancel a queued/spooled job if the OS allows it |
| `GET` | `/diagnostics` | Version, platform, printers, recent job metadata (no payloads) |
| `GET` | `/events` | Optional SSE stream of job status changes |

### Job request

```json
{
  "jobId": "01J0000000000000000000000",
  "printer": "BIXOLON SRP-350III",
  "mode": "raw",
  "paperMm": 80,
  "widthDots": 512,
  "copies": 1,
  "encoding": "escpos",
  "data": "base64..."
}
```

- `mode`: `"raw"` or `"driver"`.
- `encoding`: `"escpos"` (raw) or `"png"` (driver).
- `data`: complete document. For raw, Bikri already includes cut/drawer commands; the agent must not append its own.
- `printer`: exact name returned by `/printers`.
- `copies`: 1–3; the agent repeats the job, not Bikri.
- `jobId` is the idempotency key. The agent remembers recent ids for 24 h and returns the same result on a duplicate without printing again.

### Job response and states

```json
{ "jobId": "01J...", "status": "queued", "spoolJobId": 42 }
```

States: `received → queued → spooled → printing → done | failed | canceled`.

- Windows: poll `GetJob`/`EnumJobs` and map `JOB_STATUS_PRINTED`, `JOB_STATUS_ERROR`, `JOB_STATUS_OFFLINE`, `JOB_STATUS_PAPEROUT`, `JOB_STATUS_USER_INTERVENTION`.
- CUPS: parse `lpstat -W not-completed`/`lpstat -W completed` or use IPP `Get-Job-Attributes`; map `job-state` and `job-state-reasons`.
- Direct TCP: `done` after the write; `failed` on a socket error; no physical confirmation.

### Error codes

`UNAUTHORIZED`, `FORBIDDEN_ORIGIN`, `FORBIDDEN_HOST`, `NOT_PAIRED`, `UNKNOWN_PRINTER`, `RAW_UNSUPPORTED`, `SPOOL_ERROR`, `PRINTER_OFFLINE`, `PAPER_OUT`, `TIMEOUT`, `BUSY`, `PAYLOAD_TOO_LARGE`, `UNSUPPORTED_VERSION`, `CANCELED`.

### Versioning

`/health` returns `protocol: 1` and `version`. Bikri requires a minimum protocol and agent version; an older agent is reported in the UI instead of being used silently. `/v1` stays backward compatible within a major protocol.

## 7. Security

### Threat model

| Threat | Control |
|---|---|
| Malicious website reaches the local agent (DNS rebinding/CSRF) | Bind `127.0.0.1`; validate `Origin` and `Host`; require bearer token; no cookies |
| Another local user prints or pairs | OS account boundary; pairing code; token per Bikri installation; local UI shows status only |
| Network attacker | No LAN bind, no remote endpoint |
| Malicious receipt payload | Size/time limits; JSON schema validation; no HTML/script execution in the agent |
| Token theft from a backup/export | Token lives in `kv` (local-only, not exported); never in diagnostics or logs |
| Malicious update | Signed installers and a signed update manifest; manual update in v1 |

### Controls

- **Bind to `127.0.0.1:17890` only.** No `0.0.0.0`, no firewall rule, no mDNS advertisement.
- **Origin allowlist:** `https://algovyn.com` (production), `http://localhost:5173` and `http://127.0.0.1:5173` (development). Echo only an allowed Origin; `Vary: Origin`.
- **CORS:** allow `Authorization`, `Content-Type`, `Idempotency-Key`; methods `GET, POST, DELETE, OPTIONS`; `Access-Control-Allow-Private-Network: true` for the Private Network Access preflight.
- **Host check:** accept only `127.0.0.1:17890` and `localhost:17890`; reject anything else (DNS rebinding).
- **Pairing:** 6-digit code, 2-minute TTL, 5 attempts, constant-time compare. On success return a 32-byte random token (base64url); store only its SHA-256 hash. Rotate on unpair.
- **Bearer only:** `Authorization: Bearer <token>`; no cookies, no token in URLs.
- **Rate limits:** pairing 5/min/IP, jobs 60/min/token, diagnostics 10/min.
- **Limits:** 5 MiB body, 30 s job timeout, 100 queued jobs, 1 concurrent job per printer, 24 h idempotency window.
- **No receipt contents in logs.** Log job id, printer, mode, byte count, duration, status and error code only. Rotate logs at 10 MB, keep 7 days.
- **Local UI:** serves an embedded page with no external scripts, strict CSP, pairing code only while unpaired. It is reachable only on loopback; any local process on the same account could read it, which is accepted for a single-user till (see open questions). `/v1/health` returns the same short-lived code to an allowed Origin while unpaired so Bikri can pair without opening the page; it is not returned after pairing.

### Browser constraints to validate in Phase 0

- The PWA Content Security Policy allowlists `connect-src http://127.0.0.1:17890 http://localhost:17890` (`packages/core/src/securityHeaders.ts`); without that the browser blocks the agent before CORS is reached.
- From `https://algovyn.com/bikri`, a `fetch` to `http://127.0.0.1:17890` is expected to be allowed because loopback is potentially trustworthy, but **Private Network Access** may show a "Local network access" permission prompt in current Chrome/Edge. Test the exact versions used by shops.
- If loopback HTTP is blocked, fall back to **WSS on `127.0.0.1` with a locally-trusted certificate** (the QZ Tray model) or a **Chrome extension + Native Messaging** bridge. Do not ship until one path is proven.
- Chrome/Edge only; Firefox/Safari are not supported for the agent transport in v1.

## 8. Platform backends

### 8.1 Windows

- Go `golang.org/x/sys/windows` + `syscall.NewLazyDLL("winspool.drv")` for `OpenPrinter`, `StartDocPrinter`, `WritePrinter`, `EndDocPrinter`, `EnumPrinters`, `GetJob`, `SetJob`.
- GDI (`gdi32.dll`) for image mode: `CreateDC`, `StartDoc`, `StartPage`, `StretchDIBits`, `EndPage`, `EndDoc`, `DeleteDC`.
- Installer: per-user Inno Setup or MSI; Start Menu shortcut; optional `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` autostart. A Windows service (`x/sys/windows/svc`) is a later option for unattended/multi-user tills.
- Code signing: Authenticode (OV/EV) to avoid SmartScreen warnings.
- Ports: loopback only; no firewall rule.

### 8.2 Linux

- CUPS: `lpstat -e` for queues, `lpstat -p -d` for default, `lpoptions -p <queue> -l` for media/options.
- Raw: `lp -d <queue> -o raw -t "Bikri <jobId>" <tempfile>`; parse the request id.
- Image: `lp -d <queue> -o media=Custom.<w>x<h>mm <png>`.
- Status: `lpstat -W not-completed -o <queue>`, `lpstat -W completed -o <queue>`, or IPP.
- No root, no udev rules; the user must be permitted to print (CUPS policy / `lp` group).
- systemd user unit for autostart; `.deb`/`.rpm`/tarball. A system service is optional for kiosk tills.
- SELinux/AppArmor: the agent only executes `lp`/`lpstat`/`lpoptions` and writes temp files; document any confinement exceptions.

### 8.3 macOS

- CUPS is the system print system; the same `lp`/`lpstat` backend works.
- LaunchAgent for autostart; signed and notarized `.pkg`/`.dmg`.
- Gatekeeper requires notarization; print permissions follow the user's CUPS access.

### 8.4 Out of scope

Android, iOS, ChromeOS. Those continue with WebUSB (Android), system printing, or vendor apps.

## 9. Language choice: Go vs Rust

| Criterion | Go | Rust |
|---|---|---|
| Cross-compilation (Windows/Linux/macOS, amd64/arm64) | Excellent, `CGO_ENABLED=0` | Good but needs native targets/toolchains; macOS notarization per host |
| HTTP/JSON/queue | Standard library + small deps | `axum`/`tokio`/`serde`, excellent |
| Windows spooler APIs | `x/sys/windows` + LazyDLL; straightforward | `windows` crate; typed and safe, also good |
| GDI image printing | Verbose but doable via syscalls | `windows` crate GDI bindings are cleaner |
| CUPS integration | `os/exec` (`lp`, `lpstat`) | `std::process::Command`, same |
| Binary size | ~10–20 MB static | ~3–8 MB stripped |
| Memory safety | GC; no manual memory bugs | No GC; strongest safety |
| Development speed | Fast; small language | Slower; steeper learning curve |
| Team/ecosystem fit | Simple deployment, easy CI | Better if the team already writes Rust |

**Recommendation: Go for v1.**

- The hard parts are OS integration and distribution, not raw performance; Go's cross-compilation, single binary and standard HTTP stack make the agent easy to ship.
- Raw ESC/POS through the spooler is the primary path and is straightforward in Go. Image/GDI mode is the most awkward part; if it becomes too costly, ship raw-only first and add driver mode in Phase 2, or use a tiny platform helper.
- Keep the protocol and platform backends isolated so a Rust implementation remains possible if the agent later needs a smaller binary or stricter memory safety.

Suggested layout (monorepo, built by its own CI job; not a pnpm package):

```
apps/print-agent/
  cmd/bikri-print-agent/main.go
  internal/api/          # HTTP, CORS, health, jobs
  internal/auth/         # pairing, tokens, rate limits
  internal/jobs/         # queue, idempotency, state machine
  internal/platform/windows/
  internal/platform/cups/ # linux + darwin
  internal/ui/           # embedded HTML/CSS
  internal/config/       # file, logging
  testdata/
  go.mod
```

Build matrix: `windows/amd64`, `windows/arm64` (optional), `linux/amd64`, `linux/arm64`, `darwin/amd64`, `darwin/arm64`. CI: `ubuntu-latest`, `windows-latest`, `macos-latest`; `go test ./...`, cross-builds, signing only on Windows/macOS release jobs.

## 10. Bikri client changes

### Data model

`PrinterKv` (device-local `kv`, no sync, no Dexie migration):

```ts
type PrinterKv = {
  transport?: 'usb' | 'serial' | 'system' | 'agent';
  agent?: {
    url: string;          // default http://127.0.0.1:17890
    token: string;        // local secret, never exported
    agentId: string;
    printerName: string;
    mode: 'raw' | 'driver';
  };
  paper_mm?: 58 | 80;
  chars_per_line?: number;
  dots?: number;
  // ... existing cut/drawer/logo/QR/copies fields
};
```

`kv` is already a `LOCAL_ONLY_TABLE`, so the token is excluded from shop exports and backups. Do not include it in diagnostics.

### Print service

- Add an `agent` branch in `apps/pos/src/print/printService.ts`:
  - build the existing blocks, encode ESC/POS (raw) or render the receipt bitmap (driver);
  - `POST /v1/jobs` with `jobId`, printer, mode, paper, copies;
  - poll `GET /v1/jobs/{id}` until `done`/`failed`/timeout;
  - store the agent job id in the local print job (optional field) for retry/cancel;
  - map agent errors to the existing `PrintErrorCode` (`PERMISSION`, `DISCONNECTED`, `TIMEOUT`, `UNSUPPORTED`, `FAILED`).
- Fallback chain:
  1. try the selected agent;
  2. if the agent is unreachable and the user allows it, use system printing;
  3. keep the job in `print_jobs` for retry; never lose the sale.
- Idempotency: use `print_jobs.id` as `jobId`; retries must not duplicate a spooled receipt.

### Wizard / Settings

- New connection option **"Print service (recommended)"** in `PrinterWizard`, visible on Windows/Linux/macOS.
- Flow: detect `/health` → install link if missing → pair (code from agent UI) → choose printer from `/printers` → choose raw/driver → test print → save.
- Settings → Printer shows agent status, version, selected queue and last job status; the separate agent page is only a fallback for recovery.
- Fallback message and a one-click "Switch to system printing" if the agent is unavailable.
- i18n keys in `en.json`, `ur.json`, `roman-ur.json`; unit tests with a fake agent; Playwright test against a mock agent; docs 06/17 updated.

### Server

No changes to `apps/api`, D1, sync, auth or tenancy. The agent is per-till infrastructure.

## 11. UX flows

### First setup

1. User opens **Settings → Printer → Set up printer**.
2. Selects **Print service (recommended)**.
3. Bikri probes `GET http://127.0.0.1:17890/v1/health` (500 ms timeout).
   - Not found: "Install Bikri Print Agent" (download for the current OS), "I've installed it — check again".
   - Found, unpaired: the wizard fetches the short-lived code from `/v1/health` and fills the pairing field automatically; the separate agent page is only a fallback for an older agent or troubleshooting.
4. Pair → Bikri stores the token.
5. Bikri lists installed queues; user picks the receipt printer.
6. Mode: **POS (raw ESC/POS)** default, **Compatibility (driver)** for non-ESC/POS.
7. Paper: 80 mm + 42/48 chars or 58 mm; test print; save.

### Failure states

| State | UI |
|---|---|
| Agent not installed | Install link + "Use system printing" |
| Agent stopped/unreachable | "Print agent is not running" + Retry + Switch to system printing |
| Not paired / token revoked | Pair again |
| No printers | Install the OS driver/queue; "Refresh" |
| Raw unsupported | Switch to driver mode for that queue |
| Printer offline / paper out | Spooler status/reason; retry when ready |
| Duplicate job | Agent returns the existing result; no second print |

## 12. Operations

- **Config:** `%LOCALAPPDATA%\Bikri\PrintAgent\agent.json` (per-user Windows) or `%ProgramData%\Bikri\PrintAgent\agent.json` (service), `~/.config/bikri-print-agent/config.json` (Linux), `~/Library/Application Support/BikriPrintAgent/config.json` (macOS). Token stored as a hash; file permissions restricted.
- **Logs:** Windows `%LOCALAPPDATA%\Bikri\PrintAgent\logs\agent.log` (plus `crash.log` for fatal panics), Linux `~/.local/state/bikri-print-agent/logs/agent.log`, macOS `~/Library/Logs/BikriPrintAgent/agent.log`; JSON lines, 5 MB rotation with one previous file; no receipt payloads.
- **Health:** `/health` and `/diagnostics` (token required). Bikri's "Copy printer info" combines agent version, platform, queues and last error.
- **Update:** signed `latest.json` with version, SHA-256 and minimum protocol; v1 notifies and links to the installer; auto-update only after signature verification is implemented.
- **Uninstall:** removes the app, autostart, shortcuts, logs and the per-user config; leaves OS queues and drivers untouched.
- **Support bundle:** metadata only; explicitly excludes receipt data, tokens and customer information.

## 13. Testing

- **Unit:** protocol validation, CORS/Origin/Host, pairing/rate limits, token hashing, idempotency, printer allowlist, state machine, error mapping, cancellation.
- **Integration:**
  - Windows: "Microsoft Print to PDF" for driver mode; a raw queue/file port for raw mode; `EnumPrinters`/`GetJob` against the real spooler.
  - Linux/macOS: CUPS-PDF queue; a raw queue to a file backend; `lpstat` parsing.
- **Hardware:** SRP-350III (USB queue and TCP), Epson TM-T20, a generic 58 mm printer; test 80/42 and 80/48 and 58/32, drawer, cut, QR, Urdu raster, reprint and retry.
- **E2E:** Bikri + mock agent server in Playwright; detection, pairing, printer selection, raw/driver, agent-down fallback, duplicate idempotency, token revocation.
- **Security:** malicious Origin, missing/incorrect Host, missing token, oversized payload, replayed job, rate limits, malformed base64/JSON.
- **Performance:** 80 mm Urdu receipt rendered and spooled in < 2.5 s; 20-job queue; memory/CPU idle use.
- **Cross-platform CI:** `go test`, `go vet`, cross-builds; signed release artifacts on Windows/macOS.

## 14. Rollout

**Phase 0 — spike (3–5 days)**

- Prove `https://algovyn.com` → `http://127.0.0.1` fetch in target Chrome/Edge, including the Private Network Access prompt.
- Prove RAW through the installed Bixolon queue on the SRP-350III (drawer, cut, QR, Urdu).
- Prove GDI bitmap printing at exact width on Windows.
- Prove CUPS raw/image on Linux and macOS.
- Decide: raw-first or driver-first; HTTP vs WSS/Native Messaging.

**Phase 1 — MVP (2–3 weeks)**

- Go agent core: HTTP, pairing, printers, jobs, status, idempotency, logging, local UI.
- Windows raw spooler; Linux/macOS CUPS raw.
- Bikri `agent` transport, detection, pairing, printer picker, mode, test print, fallback.
- Installer for Windows and Linux; basic macOS package.
- i18n, unit tests, mock-agent e2e, docs 06/14/17.
- Manual hardware checklist on the SRP-350III.

**Phase 2 — hardening**

- Driver bitmap mode (Windows GDI, CUPS image), direct TCP 9100.
- macOS notarized package; Windows service mode; auto-update with signature verification.
- Diagnostics/support bundle, multi-printer profiles, cancellation UI.

**Phase 3 — expansion**

- Bluetooth Classic SPP backend, label/ZPL/TSPL direct mode, fleet/version management, Linux packaging polish.

## 15. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Chrome/Edge blocks localhost HTTP or changes PNA policy | Phase 0 spike; fall back to WSS + pinned cert or Native Messaging; keep system printing as the last resort |
| Vendor queue rejects RAW | Detect and mark `supportsRaw=false`; fall back to driver image or direct TCP |
| GDI page-size/cut quirks | Keep raw as primary; test per driver; use per-job custom page sizes |
| Unsigned installer triggers SmartScreen/AV | Authenticode signing; publish SHA-256; clear install docs |
| Duplicate receipts on retry | `jobId` idempotency; never re-spool a `spooled` job |
| False "printed" status | Report spooler state; do not claim physical delivery beyond what the OS reports |
| Multi-user/RDP port conflicts | One agent per machine with per-user tokens or service mode; decide in Phase 1 |
| Agent/PWA version drift | Protocol version handshake; minimum version in Bikri; update notice |
| Support burden | Local UI, diagnostics, copyable info, clear fallback to system printing |
| Local service attacked by a website | Origin + Host + bearer token; loopback bind; no cookies |
| Token leaked in backup/export | `kv` is local-only; never export; redact diagnostics |

## 16. Open questions

1. Does `http://127.0.0.1` work from the production HTTPS origin in the Chrome/Edge versions shops use, without a blocking prompt? If not, which fallback (WSS with a locally-trusted certificate or Native Messaging)?
2. Does the Bixolon SRP-350III queue accept RAW documents on Windows? If not, is driver-image mode sufficient, or do we need direct TCP/WinUSB?
3. Is driver-image mode in Phase 1 or Phase 2? Raw covers the target printers; image mode adds compatibility but needs GDI work.
4. Per-user agent vs Windows service; how should multi-user/RDP tills behave?
5. Where are installers hosted and how are they signed? GitHub Releases vs `algovyn.com` download; certificate owner and renewal.
6. Should the local UI require a separate admin secret, or is loopback + OS account enough for a single-user till?
7. Should direct TCP 9100 be Phase 1 for network printers, since it avoids both the driver and the spooler?
8. Do we need a `print_jobs.agent_job_id` field, or can the agent id be kept in memory and re-derived on retry?
9. Is a separate repository preferable for the Go agent? The proposed layout is `apps/print-agent` in this monorepo with its own CI job.
10. Which platforms are release-blocking: Windows only, Windows + Linux, or all three?

## 17. Proposed decisions (to record after approval)

- **Print agent:** a local, loopback-only service uses the installed OS print queue; raw ESC/POS is the primary path, driver-rendered image is the fallback; no Worker/D1/sync changes.
- **Language:** Go for v1; Rust remains a viable rewrite if binary size/memory safety becomes a priority.
- **Transport:** `PrinterKv.transport: 'agent'` with a local-only token; automatic fallback to system printing.
- **Security:** Origin + Host + bearer token + pairing code; bind `127.0.0.1`; no receipt payloads in logs.

These are recorded as D-195 (and follow-ups) in [decisions](decisions.md).

## 18. Implementation status

Implemented in this repository (Phase 1):

- **Go agent** in `apps/print-agent`:
  - loopback HTTP API, pairing, bearer-token auth, rate limits, CORS/PNA headers, Host/Origin checks;
  - local status page with the pairing code and installed printers; `/v1/health` also returns the short-lived code while unpaired so the Bikri wizard can pair without opening the page;
  - job manager with idempotency, status polling, cancellation and 24 h in-memory retention;
  - Windows spooler `RAW` printing, printer enumeration, `GetJob` status and cancel;
  - Windows GDI image printing for compatibility mode;
  - CUPS `lp`/`lpstat`/`cancel` backend for Linux and macOS;
  - Go unit tests and cross-builds for Windows, Linux and macOS.
- **Bikri PWA**:
  - `transport: 'agent'` in `PrinterKv` (local-only `kv`, no sync/D1 change);
  - raw ESC/POS and driver-PNG jobs, polling, idempotency via `print_jobs.id`;
  - pairing/printer/mode UI in the printer wizard, agent status in Settings → Printer;
  - the wizard fetches the short-lived code from `/v1/health`, so pairing and unpairing happen inside Bikri; the separate agent page is only a fallback;
  - drawer kick refused in compatibility mode;
  - `PAPER_OUT` and `AGENT_AUTH` error codes and localized strings in `en`, `ur`, `roman-ur`.
- **Packaging:** `scripts/build.sh` creates Windows/Linux/macOS archives, `print-agent-release.yml` publishes them to a GitHub release, and the wizard links directly to the platform assets (no separate download page).
- **Tests:** Go unit tests, print-service tests with a fake agent, printer Playwright tests for raw and compatibility modes, docs and i18n checks.

Remaining release work:

- Authenticode signing for the Windows executable and notarization for macOS; the GitHub release workflow builds the unsigned archives (`print-agent-release.yml`);
- an auto-update manifest and signed updates;
- direct TCP 9100 and Bluetooth SPP backends;
- a Windows service mode for multi-user/RDP tills;
- live hardware validation on the SRP-350III (raw queue, drawer, cut, QR, 42/48 chars) and a second printer family;
- code signing certificate and download hosting (GitHub Releases is wired; a branded `algovyn.com` mirror can follow).

## Appendix A — API examples

### Health

```http
GET /v1/health
```

```json
{
  "app": "bikri-print-agent",
  "version": "0.1.1",
  "protocol": 1,
  "platform": "windows/amd64",
  "paired": true,
  "printers": 2
}
```

### Pair

```http
POST /v1/pair
Content-Type: application/json

{ "code": "483920", "clientName": "Bikri till 1" }
```

```json
{ "token": "…base64url…", "agentId": "01J…" }
```

### Print

```http
POST /v1/jobs
Authorization: Bearer …
Content-Type: application/json

{
  "jobId": "01J0000000000000000000000",
  "printer": "BIXOLON SRP-350III",
  "mode": "raw",
  "paperMm": 80,
  "widthDots": 512,
  "copies": 1,
  "encoding": "escpos",
  "data": "G0Aa…"
}
```

```json
{ "jobId": "01J0000000000000000000000", "status": "queued", "spoolJobId": 42 }
```

### Status

```json
{
  "jobId": "01J…",
  "status": "failed",
  "error": "PAPER_OUT",
  "detail": "The printer reports paper out.",
  "updatedAt": 1794300000000
}
```

## Appendix B — Windows raw print sketch

```go
// Pseudocode; real code uses x/sys/windows and winspool.drv.
h, err := OpenPrinter(printerName, nil, nil)
defer ClosePrinter(h)
doc := DOC_INFO_1{
    pDocName:  "Bikri receipt",
    pDatatype: "RAW",
}
jobID, err := StartDocPrinter(h, 1, &doc)
StartPagePrinter(h)
written, err := WritePrinter(h, data)
EndPagePrinter(h)
EndDocPrinter(h)
// Poll GetJob(jobID) for JOB_STATUS_PRINTED / error flags.
```

The `"RAW"` datatype sends bytes to the queue's port without driver rendering. Some drivers reject it; cache `supportsRaw` per queue and fall back.

## Appendix C — CUPS commands

```bash
# List queues
lpstat -e
lpstat -p -d

# Queue options (media, resolution, etc.)
lpoptions -p "BIXOLON_SRP350" -l

# Print raw ESC/POS
lp -d "BIXOLON_SRP350" -o raw -t "Bikri 01J..." /tmp/job.bin

# Job status
lpstat -W not-completed -o "BIXOLON_SRP350"
lpstat -W completed -o "BIXOLON_SRP350"

# Cancel
cancel "BIXOLON_SRP350-123"
```

Create a raw queue once (admin):

```bash
lpadmin -p "BIXOLON_SRP350" -E -v "usb://BIXOLON/SRP-350III" -m raw
```

The exact device URI comes from `lpinfo -v`.

## Appendix D — References

- WebUSB: <https://developer.chrome.com/docs/capabilities/usb>
- Web Serial: <https://developer.chrome.com/docs/capabilities/serial>
- Private Network Access: <https://developer.chrome.com/blog/private-network-access-preflight>
- Windows `StartDocPrinter`: <https://learn.microsoft.com/windows/win32/printdocs/startdocprinter>
- Windows `WritePrinter`: <https://learn.microsoft.com/windows/win32/printdocs/writeprinter>
- CUPS command-line tools: <https://www.cups.org/doc/options.html>
- Go `x/sys/windows`: <https://pkg.go.dev/golang.org/x/sys/windows>
- Rust `windows` crate: <https://microsoft.github.io/windows-docs-rs/>
