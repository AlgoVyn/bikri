; Inno Setup 6 script for the Bikri Print Agent (per-user install, no admin).
; Build the executable first: scripts/build.sh (dist/bikri-print-agent.exe).

#define AppName "Bikri Print Agent"
#define AppVersion "1.0.0"
#define AppPublisher "Algovyn"
#define AppExe "bikri-print-agent.exe"

[Setup]
AppId={{7E9B2A3C-4B8E-4C2A-9A18-6C5D3F1B8A21}
AppName={#AppName}
AppVersion={#AppVersion}
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
UninstallDisplayName={#AppName}

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "autostart"; Description: "Start Bikri Print Agent when I sign in"; GroupDescription: "Startup:"

[Files]
Source: "..\..\dist\bikri-print-agent.exe"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\Bikri Print Agent"; Filename: "{app}\{#AppExe}"
Name: "{group}\Open Bikri Print Agent"; Filename: "http://127.0.0.1:17890/"

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "BikriPrintAgent"; ValueData: """{app}\{#AppExe}"""; Flags: uninsdeletevalue; Tasks: autostart

[Run]
Filename: "{app}\{#AppExe}"; Description: "Start Bikri Print Agent now"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "taskkill"; Parameters: "/IM {#AppExe} /F"; Flags: runhidden; RunOnceId: "StopAgent"
