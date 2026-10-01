; Instalador del agente de medición.
;
; Produce UN solo .exe que ya trae dentro otelcol-contrib, así que no hay binarios
; que copiar a mano ni PowerShell que ejecutar.
;
; Se compila con Inno Setup 6:
;   iscc /DAgentVersion=1.0.0 /DCollectorDir=build\collector installer\medicion-agent.iss
;
; El workflow .github/workflows/installer.yml lo hace en CI, para que el binario que
; se reparte a los PCs sea reproducible y no salga del portátil de nadie.
;
; Instalación silenciosa (Intune, GPO por script de inicio):
;   MedicionAgent-Setup.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /CLAVE=xxxx

#ifndef AgentVersion
  #define AgentVersion "0.0.0-dev"
#endif
#ifndef CollectorDir
  #define CollectorDir "..\build\collector"
#endif

#define AppName "Medición interna - Agente"
#define ServiceName "MedicionOtelCollector"
#define AgentHome "{commonappdata}\MedicionAgent"

[Setup]
AppId={{8F3C21A4-6D5E-4B72-9E10-5A7C4D2F1B93}
AppName={#AppName}
AppVersion={#AgentVersion}
AppPublisher=Medición interna
DefaultDirName={autopf}\MedicionAgent
DefaultGroupName=Medición interna
; No hay nada que abrir: es un servicio. Una carpeta en el menú de inicio solo
; confundiría.
DisableProgramGroupPage=yes
DisableDirPage=yes
OutputDir=..\dist
OutputBaseFilename=MedicionAgent-Setup-{#AgentVersion}
Compression=lzma2/max
SolidCompression=yes
; Escribe en Program Files y registra un servicio: hace falta elevación.
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
; Necesario para que el sistema vea las variables de máquina sin reiniciar sesión.
ChangesEnvironment=yes
WizardStyle=modern
UninstallDisplayName={#AppName}
LicenseFile=aviso.txt

[Languages]
Name: "spanish"; MessagesFile: "compiler:Languages\Spanish.isl"

[Files]
; El collector va empaquetado dentro del .exe.
Source: "{#CollectorDir}\otelcol-contrib.exe"; DestDir: "{#AgentHome}"; Flags: ignoreversion
Source: "..\agent\otelcol\config.yaml"; DestDir: "{#AgentHome}"; Flags: ignoreversion
Source: "..\agent\windows\managed-settings.json"; DestDir: "{app}\plantillas"; Flags: ignoreversion
Source: "..\agent\windows\codex-config.toml"; DestDir: "{app}\plantillas"; Flags: ignoreversion
Source: "scripts\configure.ps1"; DestDir: "{app}\scripts"; Flags: ignoreversion
Source: "scripts\revert.ps1"; DestDir: "{app}\scripts"; Flags: ignoreversion
Source: "..\PRIVACY.md"; DestDir: "{app}"; Flags: ignoreversion

[Dirs]
Name: "{#AgentHome}\queue"

[Run]
; Configura Claude Code y Codex, y registra el servicio. Se espera a que termine
; (`waituntilterminated`): sin ese flag Inno Setup sigue adelante sin comprobar nada
; y el instalador diría "listo" aunque el servicio no arrancara.
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\scripts\configure.ps1"" -Clave ""{code:GetClave}"" -DeviceName ""{code:GetDeviceName}"" -AgentHome ""{#AgentHome}"" -Templates ""{app}\plantillas"""; \
  StatusMsg: "Configurando Claude Code, Codex y el servicio..."; \
  Flags: runhidden waituntilterminated

[UninstallRun]
; RunOnceId hace que cada comando se ejecute una sola vez aunque se desinstale
; varias veces.
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\scripts\revert.ps1"" -AgentHome ""{#AgentHome}"""; \
  Flags: runhidden waituntilterminated; RunOnceId: "RevertirMedicion"

[Code]
var
  PaginaClave: TInputQueryWizardPage;

procedure InitializeWizard;
begin
  PaginaClave := CreateInputQueryPage(wpWelcome,
    'Clave de instalación',
    'Pega la clave que te dio quien administra el sistema.',
    'La clave contiene la dirección del servidor y el permiso para enviar datos.' + #13#10 +
    'Qué se mide y qué no está en PRIVACY.md, que se instala junto al agente.');
  PaginaClave.Add('Clave de instalación:', False);
  PaginaClave.Add('Nombre de este equipo (opcional):', False);
  // Por defecto el nombre del PC. Es la clave de atribución del sistema.
  PaginaClave.Values[1] := GetComputerNameString();
end;

function GetClave(Param: String): String;
begin
  // El parámetro de línea de comandos gana: así la instalación silenciosa no
  // necesita que nadie escriba nada.
  Result := ExpandConstant('{param:CLAVE|}');
  if Result = '' then
    Result := Trim(PaginaClave.Values[0]);
end;

function GetDeviceName(Param: String): String;
begin
  Result := ExpandConstant('{param:EQUIPO|}');
  if Result = '' then
    Result := Trim(PaginaClave.Values[1]);
  if Result = '' then
    Result := GetComputerNameString();
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := False;
  // Si la clave llegó por parámetro, no se pregunta.
  if (PageID = PaginaClave.ID) and (ExpandConstant('{param:CLAVE|}') <> '') then
    Result := True;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if CurPageID = PaginaClave.ID then
  begin
    if Trim(PaginaClave.Values[0]) = '' then
    begin
      MsgBox('Hace falta la clave de instalación para continuar.', mbError, MB_OK);
      Result := False;
    end;
  end;
end;
