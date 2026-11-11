# Bikri Print Agent — Windows

## Installer

Run `bikri-print-agent-setup.exe` as your normal Windows user (no administrator
required). It installs under `%LOCALAPPDATA%\Bikri\PrintAgent`, creates Start
Menu shortcuts (including the log folder), starts the agent and adds the
sign-in autostart entry. Use **Apps & features** to uninstall it.

## Portable ZIP

If you downloaded the portable ZIP instead, run:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

Remove it with `uninstall.ps1`.

## Logs

```text
%LOCALAPPDATA%\Bikri\PrintAgent\logs\agent.log
%LOCALAPPDATA%\Bikri\PrintAgent\logs\crash.log
```

`agent.log` is JSON, rotated at 5 MB with one previous file. `crash.log`
contains fatal Go panics. The agent page also shows the exact log path.

The build is **not Authenticode-signed** yet. Windows SmartScreen may warn the
first time. Verify the download against `SHA256SUMS` and only use builds from
the official Algovyn/Bikri release page.
