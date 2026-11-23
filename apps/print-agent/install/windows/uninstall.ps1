$ErrorActionPreference = 'SilentlyContinue'

Get-Process 'bikri-print-agent' | Stop-Process -Force
# Stop-Process returns before the process has released its image and log files.
# Removing the directory immediately failed on a locked exe and left the agent
# installed; wait for the process to actually exit.
Get-Process 'bikri-print-agent' | Wait-Process -Timeout 10
Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'BikriPrintAgent'
Remove-Item -Force (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Bikri Print Agent.lnk')
Remove-Item -Recurse -Force (Join-Path $env:LOCALAPPDATA 'Bikri\PrintAgent')
# os.UserConfigDir() is %AppData%\bikri-print-agent; the pairing hash and port
# must not survive an uninstall (docs/14-print-agent.md §12), or a reinstall
# starts "already paired" with a token the till no longer has.
Remove-Item -Recurse -Force (Join-Path $env:APPDATA 'bikri-print-agent')
Write-Host 'Bikri Print Agent removed.'
