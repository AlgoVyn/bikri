$ErrorActionPreference = 'Stop'

$source = Join-Path $PSScriptRoot 'bikri-print-agent.exe'
$dest = Join-Path $env:LOCALAPPDATA 'Bikri\PrintAgent'
$exe = Join-Path $dest 'bikri-print-agent.exe'

Get-Process 'bikri-print-agent' -ErrorAction SilentlyContinue | Stop-Process -Force
Get-Process 'bikri-print-agent' -ErrorAction SilentlyContinue | Wait-Process -Timeout 10 -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item -Force $source $exe
Unblock-File $exe

$programs = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
New-Item -ItemType Directory -Force -Path $programs | Out-Null
$shortcutPath = Join-Path $programs 'Bikri Print Agent.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $exe
$shortcut.WorkingDirectory = $dest
$shortcut.Description = 'Bikri Print Agent'
$shortcut.Save()

$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
# The Run key exists on every normal profile, but a stripped/roamed profile may
# not; create it instead of failing after the binary and shortcut are in place.
# Never use New-Item -Force on an existing registry key: the Registry provider
# replaces it with an empty key and wipes every other autostart entry.
if (-not (Test-Path -Path $runKey)) {
  New-Item -Path $runKey | Out-Null
}
New-ItemProperty -Path $runKey -Name 'BikriPrintAgent' -Value "`"$exe`"" -PropertyType String -Force | Out-Null

Start-Process -FilePath $exe
Write-Host 'Bikri Print Agent installed.'
Write-Host 'Open http://127.0.0.1:17890/ to pair this computer with Bikri.'
