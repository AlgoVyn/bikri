# Bikri Print Agent

The local companion service described in [docs/14-print-agent.md](../../docs/14-print-agent.md). It prints through the operating system's installed print queues, so Bikri does not need WinUSB/Zadig and the browser print dialog is not used.

- **POS mode (raw ESC/POS):** Windows spooler `RAW`, or CUPS `lp -o raw`. Keeps drawer, cut, QR, logo and Urdu raster.
- **Compatibility mode:** renders a receipt PNG and prints it through the OS driver. Works with A4/label/non-ESC-POS printers; no drawer/cut control.
- **Loopback-only:** `127.0.0.1:17890`, bearer token, origin/Host checks. It never sends shop data to Algovyn.

## Build

```bash
cd apps/print-agent
go test ./...
go vet ./...
go build -o bikri-print-agent ./cmd/bikri-print-agent
```

Cross-builds used by CI:

```bash
GOOS=windows GOARCH=amd64 go build ./...
GOOS=darwin  GOARCH=arm64 go build ./...
GOOS=linux   GOARCH=arm64 go build ./...
```

## Packages

`scripts/build.sh` creates one archive per platform in `dist/`:

- `bikri-print-agent-windows-amd64.zip` — `bikri-print-agent.exe`, `install.ps1`, `uninstall.ps1`;
- `bikri-print-agent-linux-{amd64,arm64}.tar.gz` — binary, `install.sh`, systemd user unit;
- `bikri-print-agent-darwin-{amd64,arm64}.tar.gz` — binary, `install.sh`;
- `SHA256SUMS`.

The public download page is `apps/pos/public/print-agent/index.html`; it links to the GitHub release assets. Pushing a tag `print-agent-v*` runs `.github/workflows/print-agent-release.yml`, builds the archives and publishes the release.

Windows:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

Linux/macOS:

```bash
tar -xzf bikri-print-agent-*.tar.gz
./install.sh
```

The archives are unsigned until the Authenticode/notarization certificate is added; verify `SHA256SUMS` and expect a SmartScreen/Gatekeeper warning.
The script writes binaries to `dist/` and a `SHA256SUMS` file. Windows builds hide the console window (`-H=windowsgui`); logs go to the config directory.

## Run (development)

```bash
go run ./cmd/bikri-print-agent --config /tmp/bikri-print-agent.json
```

Open <http://127.0.0.1:17890/> to see the pairing code and installed printers. In Bikri:

1. **Settings → Printer → Set up printer**
2. **Print service (recommended)**
3. **Open print service**, copy the 6-digit code, enter it in Bikri
4. Pick the OS printer queue and **POS (drawer and cut)** mode
5. **Test print** → **Save printer**

The config file lives in the OS user config directory:

- Windows: `%AppData%\bikri-print-agent\config.json`
- Linux: `~/.config/bikri-print-agent/config.json`
- macOS: `~/Library/Application Support/bikri-print-agent/config.json`

The pairing token is stored only as a SHA-256 hash. The agent does not persist receipt data; jobs are kept in memory for 24 hours for idempotency/status. If the Bikri-side token is lost, open the local page and use **Unpair this computer** to start a new pairing window.

## HTTP API

All routes are under `http://127.0.0.1:17890/v1`.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/health` | — | version, protocol, platform, paired, printer count |
| `POST` | `/pair` | pairing code | exchange the code for a bearer token |
| `POST` | `/unpair` | bearer | revoke the token |
| `GET` | `/printers` | bearer | installed queues |
| `POST` | `/jobs` | bearer | submit a job |
| `GET` | `/jobs/{id}` | bearer | job status |
| `DELETE` | `/jobs/{id}` | bearer | cancel |
| `GET` | `/diagnostics` | bearer | version, printers, recent job metadata |

Job body:

```json
{
  "jobId": "01J...",
  "printer": "BIXOLON SRP-350III",
  "mode": "raw",
  "paperMm": 80,
  "widthDots": 512,
  "copies": 1,
  "encoding": "escpos",
  "data": "base64..."
}
```

`mode` is `raw` (with `encoding: "escpos"`) or `driver` (with `encoding: "png"`). `jobId` is the idempotency key. The agent returns a job with `status` (`received`, `spooled`, `printing`, `done`, `failed`, `canceled`) and an error code such as `PAPER_OUT` or `RAW_UNSUPPORTED`.

## Windows notes

- **POS mode** uses the installed print queue with the `RAW` datatype. It avoids replacing the driver and keeps the drawer/cut commands. Some queues reject raw jobs; the agent caches `RAW_UNSUPPORTED` for that queue and Bikri can switch to compatibility mode.
- **Compatibility mode** uses GDI to print the rendered PNG. The queue's paper size/roll setting controls the page; the agent does not change the machine-wide default.
- The current Windows build is a per-user background app; a Windows service mode is a release task.

## Linux / macOS notes

The agent runs as the logged-in user and shells out to CUPS:

```bash
lpstat -e                       # queues
lpstat -p -d                    # default
lpoptions -p "<queue>" -l       # media/options
lp -d "<queue>" -o raw job.bin  # POS mode
lp -d "<queue>" receipt.png     # compatibility mode
```

For POS mode, create a raw queue once (admin):

```bash
lpadmin -p "BIXOLON_SRP350" -E -v "usb://BIXOLON/SRP-350III" -m raw
```

The user must be allowed to print by CUPS policy; no udev rule or root is needed by the agent.

## Security

- Bind `127.0.0.1` only; no LAN listener or firewall rule.
- Origin allowlist (`https://algovyn.com` plus local development), Host check for DNS rebinding, CORS/PNA preflight headers.
- 6-digit pairing code with a 2-minute TTL and 5 attempts; 32-byte bearer token stored hashed.
- 5 MiB body limit, job timeout, idempotency and in-memory retention.
- No receipt contents in logs. Logs go to the config directory (`agent.log`), metadata only.

## Tests

```bash
cd apps/print-agent
go test ./...
```

Windows-specific code is compiled in CI with `GOOS=windows`; CUPS parsing is unit-tested on Linux/macOS. Hardware validation (SRP-350III, drawer, cut, QR, 42/48 chars) is a release checklist item in the design doc.
