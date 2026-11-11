# Bikri Print Agent — Windows installer (per-user)

This is a portable installer. It copies the agent to
`%LOCALAPPDATA%\Bikri\PrintAgent`, adds a Start Menu shortcut, starts it at
sign-in (HKCU Run) and launches it now.

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

Then open <http://127.0.0.1:17890/> to see the pairing code and printers.

The build is **not Authenticode-signed** yet. Windows SmartScreen may warn the
first time you run the executable. Verify the download against `SHA256SUMS` and
only run builds downloaded from the official Algovyn/Bikri release page.

To remove it:

```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
```
