; Inno Setup 6 script for the Bikri Print Agent (per-user install, no admin).
; Build the executable first: scripts/build.sh (dist/bikri-print-agent.exe).
; The release workflow passes /DMyAppVersion=<version>.

#define AppName "Bikri Print Agent"
#ifndef MyAppVersion
  #define MyAppVersion "0.1.9"
#endif
#define AppPublisher "Algovyn"
#define AppExe "bikri-print-agent.exe"

[Setup]
AppId={{7E9B2A3C-4B8E-4C2A-9A18-6C5D3F1B8A21}
AppName={#AppName}
AppVersion={#MyAppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={localappdata}\Bikri\PrintAgent
DefaultGroupName=Bikri
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=..\..\dist
OutputBaseFilename=bikri-print-agent-setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
CloseApplications=yes
RestartApplications=no
SetupLogging=yes
UninstallDisplayName={#AppName}
UninstallDisplayIcon={app}\{#AppExe}

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "autostart"; Description: "Start Bikri Print Agent when I sign in"; GroupDescription: "Startup:"; Flags: checkedonce
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional icons:"; Flags: unchecked

[Files]
Source: "..\..\dist\bikri-print-agent.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "README.txt"; DestDir: "{app}"; Flags: ignoreversion

[Dirs]
Name: "{localappdata}\Bikri\PrintAgent\logs"

[Icons]
Name: "{group}\Bikri Print Agent"; Filename: "{app}\{#AppExe}"
Name: "{group}\Open Bikri Print Agent"; Filename: "http://127.0.0.1:17890/"
Name: "{group}\Bikri Print Agent logs"; Filename: "{localappdata}\Bikri\PrintAgent\logs"
Name: "{autodesktop}\Bikri Print Agent"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "BikriPrintAgent"; ValueData: """{app}\{#AppExe}"""; Flags: uninsdeletevalue; Tasks: autostart

[Run]
; Do not add skipifsilent: PrepareToInstall stops the running agent, so a silent
; upgrade must start the new binary again or the till loses its print service.
Filename: "{app}\{#AppExe}"; Description: "Start Bikri Print Agent now"; Flags: nowait postinstall

[UninstallRun]
; Only this user's agent: another user on a shared PC may run their own copy on
; a different port, and taskkill without the filter fails or needs admin rights.
; taskkill /F returns before the exe releases its files; wait for this session's
; process so the uninstaller can delete the directory cleanly.
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command ""$n='{#AppExe}'; & (Join-Path $env:SystemRoot 'System32\taskkill.exe') /IM $n /F /FI ('USERNAME eq ' + $env:USERNAME) | Out-Null; $sid=(Get-Process -Id $PID).SessionId; Get-Process -Name 'bikri-print-agent' -ErrorAction SilentlyContinue | Where-Object SessionId -eq $sid | Wait-Process -Timeout 10 -ErrorAction SilentlyContinue"""; Flags: runhidden waituntilterminated; RunOnceId: "StopAgent"

[UninstallDelete]
Type: filesandordirs; Name: "{localappdata}\Bikri\PrintAgent\logs"
Type: filesandordirs; Name: "{userappdata}\bikri-print-agent"

[Code]
function StopAgent(): Boolean;
var
  ResultCode: Integer;
begin
  // Run through PowerShell so %USERNAME%/$env:USERNAME and the current session
  // are resolved without a cmd layer. taskkill /F only signals; wait briefly for
  // this session's agent to exit so an upgrade can replace the locked .exe and
  // an uninstall can remove the directory. Other users/sessions are untouched.
  Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    '-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command ' +
    '"$n=''{#AppExe}''; & (Join-Path $env:SystemRoot ''System32\taskkill.exe'') /IM $n /F /FI (''USERNAME eq '' + $env:USERNAME) | Out-Null; ' +
    '$sid=(Get-Process -Id $PID).SessionId; ' +
    'Get-Process -Name ''bikri-print-agent'' -ErrorAction SilentlyContinue | ' +
    'Where-Object SessionId -eq $sid | Wait-Process -Timeout 10 -ErrorAction SilentlyContinue"',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Result := True;
end;

// Stop the old process only after the user has confirmed the install. Calling
// this from InitializeSetup killed a working agent even when the wizard was
// cancelled. PrepareToInstall runs after "Ready to install" -> Install.
function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  StopAgent();
  Result := '';
end;

// Uninstall: the [UninstallRun] entry above stops the agent after the user
// confirms. InitializeUninstall ran before the prompt, so a cancelled uninstall
// left the till without a print service.
