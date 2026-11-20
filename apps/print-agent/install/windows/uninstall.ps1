$ErrorActionPreference = 'SilentlyContinue'

Get-Process 'bikri-print-agent' | Stop-Process -Force
Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'BikriPrintAgent'
Remove-Item -Force (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Bikri Print Agent.lnk')
Remove-Item -Recurse -Force (Join-Path $env:LOCALAPPDATA 'Bikri\PrintAgent')
# os.UserConfigDir() is %AppData%\bikri-print-agent; the pairing hash and port
# must not survive an uninstall.
Remove-Item -Recurse -Force (Join-Path $env:APPDATA 'bikri-print-agent')
Write-Host 'Bikri Print Agent removed.'
