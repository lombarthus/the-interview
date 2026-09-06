; The Interview — Inno-Setup-Skript. Wird in GitHub Actions gebaut (release.yml):
;   ISCC.exe /DAppVersion=1.2.3 installer\TheInterview.iss
; Installation pro Benutzer, ohne Adminrechte, nach %LOCALAPPDATA%\Programs\TheInterview.
; Runtimes (node.exe, uv.exe) liegen vor dem Build unter runtime\ (aus dem Workflow, SHA-256 geprüft).

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#define AppName "The Interview"
#define AppExeName "TheInterview.cmd"
#define SourceRoot ".."

[Setup]
AppId={{7B0C1F6A-2E7D-4A7C-9E3B-5C1D8F0A9E11}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher=The Interview (Open Source)
AppPublisherURL=https://github.com/lombarthus/the-interview
AppSupportURL=https://github.com/lombarthus/the-interview/issues
DefaultDirName={localappdata}\Programs\TheInterview
DisableProgramGroupPage=yes
DisableDirPage=no
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#SourceRoot}\dist
OutputBaseFilename=TheInterview-Setup-{#AppVersion}
SetupIconFile={#SourceRoot}\app\assets\icon.ico
UninstallDisplayIcon={app}\app\assets\icon.ico
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
LicenseFile={#SourceRoot}\LICENSE
MinVersion=10.0.17763
CloseApplications=yes

[Languages]
Name: "de"; MessagesFile: "compiler:Languages\German.isl"
Name: "en"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "{#SourceRoot}\TheInterview.cmd"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceRoot}\LICENSE"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceRoot}\THIRD_PARTY.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceRoot}\README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceRoot}\README.de.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceRoot}\app\*"; DestDir: "{app}\app"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#SourceRoot}\engine\*"; DestDir: "{app}\engine"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#SourceRoot}\runtime\*"; DestDir: "{app}\runtime"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExeName}"; WorkingDir: "{app}"; IconFilename: "{app}\app\assets\icon.ico"; Flags: runminimized
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExeName}"; WorkingDir: "{app}"; IconFilename: "{app}\app\assets\icon.ico"; Tasks: desktopicon; Flags: runminimized

[Run]
Filename: "{app}\{#AppExeName}"; Description: "{#AppName} jetzt starten (Einrichtung im Browser)"; Flags: postinstall nowait skipifsilent runminimized

[Code]
// Bei der Deinstallation fragen, ob der Datenordner (Archiv, Stimmen, Modelle, venv) mitgelöscht wird.
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  DataDir: string;
begin
  if CurUninstallStep = usPostUninstall then begin
    DataDir := ExpandConstant('{localappdata}\TheInterview');
    if DirExists(DataDir) then begin
      if MsgBox('Auch die Daten von The Interview löschen?' + #13#10 + DataDir + #13#10#13#10 +
                'Enthält Archiv, Stimmen, Einstellungen, API-Keys (verschlüsselt), Modelle und die Python-Umgebung. ' +
                '„Nein“ behält alles für eine spätere Installation.', mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
        DelTree(DataDir, True, True, True);
    end;
  end;
end;
