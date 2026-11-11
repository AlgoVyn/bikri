$ErrorActionPreference = 'SilentlyContinue'

Get-Process 'bikri-print-agent' | Stop-Process -Force
Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'BikriPrintAgent'
Remove-Item -Force (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Bikri Print Agent.lnk')
Remove-Item -Recurse -Force (Join-Path $env:LOCALAPPDATA 'Bikri\PrintAgent')
Write-Host 'Bikri Print Agent removed.'
