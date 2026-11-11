$ErrorActionPreference = 'Stop'

$source = Join-Path $PSScriptRoot 'bikri-print-agent.exe'
$dest = Join-Path $env:LOCALAPPDATA 'Bikri\PrintAgent'
$exe = Join-Path $dest 'bikri-print-agent.exe'

Get-Process 'bikri-print-agent' -ErrorAction SilentlyContinue | Stop-Process -Force
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
Set-ItemProperty -Path $runKey -Name 'BikriPrintAgent' -Value "`"$exe`""

Start-Process -FilePath $exe
Write-Host 'Bikri Print Agent installed.'
Write-Host 'Open http://127.0.0.1:17890/ to pair this computer with Bikri.'
