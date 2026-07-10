; Inno Setup script for Rezident — per-user installer wrapping the PyInstaller
; onedir output (dist\Rezident\).  Build the exe first, then:
;   iscc packaging\Rezident.iss     ->  packaging\Output\Rezident-Setup.exe
;
; Per-user (no admin): installs to {localappdata}\Programs\Rezident, adds Start
; Menu + Desktop shortcuts, optionally installs the Edge WebView2 runtime, and
; uninstalls cleanly with an option to keep your data in %LOCALAPPDATA%\Rezident.

#define AppName "Rezident"
#define AppVersion "0.1.2"
#define AppPublisher "Rezident"
#define AppExe "Rezident.exe"

[Setup]
AppId={{B3D47A22-9C61-4E8B-A54D-C2E1D5F00001}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
; Per-user install — no elevation, writes only under the user profile.
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
DefaultDirName={localappdata}\Programs\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
UninstallDisplayIcon={app}\{#AppExe}
OutputDir=Output
OutputBaseFilename=Rezident-Setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesInstallIn64BitMode=x64compatible
; Self-update: the running app is closed and its files freed for replacement, but
; the installer NEVER relaunches it — the update swap helper owns the relaunch, so
; there's exactly one Rezident afterwards. AppMutex must match the single-instance
; mutex the desktop shell holds (desktop/app.py: "Local\Rezident-SingleInstance").
CloseApplications=yes
RestartApplications=no
AppMutex=Local\Rezident-SingleInstance

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Additional icons:"
Name: "startup"; Description: "Start Rezident when I sign in"; GroupDescription: "Startup:"; Flags: unchecked

[Files]
; The entire PyInstaller onedir tree (Rezident.exe + _internal\).
Source: "..\dist\Rezident\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion
; Optional: ship the Edge WebView2 Evergreen bootstrapper next to this .iss to
; chain-install it when the runtime is missing (safe no-op if not present).
Source: "MicrosoftEdgeWebview2Setup.exe"; DestDir: "{tmp}"; Flags: dontcopy skipifsourcedoesntexist

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExe}"
Name: "{userdesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon
Name: "{userstartup}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: startup

[Run]
; Install WebView2 only if it's absent AND we shipped the bootstrapper.
Filename: "{tmp}\MicrosoftEdgeWebview2Setup.exe"; Parameters: "/silent /install"; \
  Check: WebView2Missing and WebView2SetupPresent; StatusMsg: "Installing Edge WebView2 runtime..."; Flags: waituntilterminated
Filename: "{app}\{#AppExe}"; Description: "Launch {#AppName}"; Flags: nowait postinstall skipifsilent

[Code]
function WebView2Missing(): Boolean;
var
  pv: String;
begin
  { Evergreen runtime registers 'pv' under EdgeUpdate\Clients\<GUID>. }
  Result := True;
  if RegQueryStringValue(HKLM, 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', pv) then
    if (pv <> '') and (pv <> '0.0.0.0') then Result := False;
  if Result and RegQueryStringValue(HKCU, 'Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', pv) then
    if (pv <> '') and (pv <> '0.0.0.0') then Result := False;
end;

function WebView2SetupPresent(): Boolean;
begin
  { ExtractTemporaryFile only if it was actually packaged. }
  Result := False;
  try
    ExtractTemporaryFile('MicrosoftEdgeWebview2Setup.exe');
    Result := True;
  except
    Result := False;
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  DataDir: String;
  ResultCode: Integer;
begin
  if CurUninstallStep = usUninstall then
  begin
    { Stop a running instance so its files can be removed. }
    Exec('taskkill.exe', '/IM {#AppExe} /F', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    { Offer to remove user data (%LOCALAPPDATA%\Rezident). }
    DataDir := ExpandConstant('{localappdata}\Rezident');
    if DirExists(DataDir) then
      if MsgBox('Also delete your Rezident data (database, memory, worktrees, logs)?' + #13#10 +
                DataDir + #13#10#13#10 + 'Choose No to keep it for a future reinstall.',
                mbConfirmation, MB_YESNO) = IDYES then
        DelTree(DataDir, True, True, True);
  end;
end;
