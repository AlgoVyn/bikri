; Inno Setup 6 script for the Bikri Print Agent (per-user install, no admin).
; Build the executable first: scripts/build.sh (dist/bikri-print-agent.exe).
; The release workflow passes /DMyAppVersion=<version>.

#define AppName "Bikri Print Agent"
#ifndef MyAppVersion
  #define MyAppVersion "0.1.2"
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
Name: "{app}\logs"

[Icons]
Name: "{group}\Bikri Print Agent"; Filename: "{app}\{#AppExe}"
Name: "{group}\Open Bikri Print Agent"; Filename: "http://127.0.0.1:17890/"
Name: "{group}\Bikri Print Agent logs"; Filename: "{app}\logs"
Name: "{autodesktop}\Bikri Print Agent"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "BikriPrintAgent"; ValueData: """{app}\{#AppExe}"""; Flags: uninsdeletevalue; Tasks: autostart

[Run]
Filename: "{app}\{#AppExe}"; Description: "Start Bikri Print Agent now"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "{sys}\taskkill.exe"; Parameters: "/IM {#AppExe} /F"; Flags: runhidden; RunOnceId: "StopAgent"

[UninstallDelete]
Type: filesandordirs; Name: "{app}\logs"
Type: filesandordirs; Name: "{userappdata}\bikri-print-agent"

[Code]
function StopAgent(): Boolean;
var
  ResultCode: Integer;
begin
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/IM {#AppExe} /F', '', SW_HIDE,
    ewWaitUntilTerminated, ResultCode);
  Result := True;
end;

function InitializeSetup(): Boolean;
begin
  Result := StopAgent();
end;

function InitializeUninstall(): Boolean;
begin
  Result := StopAgent();
end;
