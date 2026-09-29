<#
.SYNOPSIS
  Configura el agente. Lo ejecuta el instalador; no hace falta llamarlo a mano.

.DESCRIPTION
  Hace cuatro cosas:
    1. Descifra la clave de instalación en endpoint + token.
    2. Escribe la configuración del collector con esos valores YA DENTRO del
       archivo, no en variables de entorno. El motivo es concreto: un servicio de
       Windows toma una foto del entorno al arrancar, así que cambiar una variable
       no le afecta hasta reiniciarlo. Un archivo se lee siempre.
    3. Escribe el managed-settings.json de Claude Code con el nombre de este equipo,
       que es la clave de atribución del sistema.
    4. Añade la sección [otel] al config.toml de Codex, respetando lo que ya hubiera.
  Y registra y arranca el servicio.

  Si algo falla, sale con código distinto de cero para que el instalador lo note.
#>

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string] $Clave,
  [Parameter(Mandatory = $true)] [string] $DeviceName,
  [Parameter(Mandatory = $true)] [string] $AgentHome,
  [Parameter(Mandatory = $true)] [string] $Templates
)

$ErrorActionPreference = 'Stop'
$ServiceName = 'MedicionOtelCollector'

function Write-Log([string] $Message) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
  Write-Host $line
  Add-Content -Path (Join-Path $AgentHome 'instalacion.log') -Value $line -Encoding UTF8
}

try {
  New-Item -ItemType Directory -Force -Path $AgentHome, (Join-Path $AgentHome 'queue') | Out-Null

  # --- 1. Clave de instalación -----------------------------------------------
  # Formato: base64 de "endpoint|token". Una sola cadena para pegar, y se puede
  # rotar sin reeditar el instalador.
  try {
    $decoded = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Clave.Trim()))
  } catch {
    throw "La clave de instalación no es válida (no es base64). Pídela de nuevo a quien administra el sistema."
  }

  $parts = $decoded -split '\|', 2
  if ($parts.Count -ne 2 -or [string]::IsNullOrWhiteSpace($parts[0]) -or [string]::IsNullOrWhiteSpace($parts[1])) {
    throw "La clave de instalación no tiene el formato esperado."
  }

  $endpoint = $parts[0].Trim()
  $token    = $parts[1].Trim()

  if ($endpoint -notmatch '^https?://') {
    throw "La clave contiene una dirección que no parece una URL: $endpoint"
  }
  if ($endpoint -notmatch '^https://') {
    Write-Log "AVISO: el endpoint no usa HTTPS ($endpoint)."
  }

  # --- 2. Nombre del equipo ---------------------------------------------------
  $hostKey = $DeviceName.Trim().ToLowerInvariant()
  if ($hostKey -notmatch '^[a-z0-9][a-z0-9._-]{0,127}$') {
    throw "El nombre de equipo '$DeviceName' no tiene forma de hostname válido."
  }
  Write-Log "Equipo: $hostKey"

  # --- 3. Configuración del collector ----------------------------------------
  $configTemplate = Join-Path $AgentHome 'config.yaml'
  if (-not (Test-Path $configTemplate)) { throw "Falta $configTemplate" }

  $config = Get-Content $configTemplate -Raw
  # La plantilla del repositorio usa ${env:...} para poder ejecutarla a mano en el
  # piloto. Aquí se sustituyen por los valores reales.
  $config = $config.Replace('${env:INGEST_ENDPOINT}', $endpoint)
  $config = $config.Replace('${env:INGEST_TOKEN}', $token)
  $config = $config.Replace('${env:ProgramData}', $env:ProgramData)
  Set-Content -Path $configTemplate -Value $config -Encoding UTF8
  Write-Log "Configuración del collector escrita."

  # --- 4. Claude Code ---------------------------------------------------------
  # Ruta correcta en Windows. C:\ProgramData\ClaudeCode es la antigua: quedó
  # deprecada en la versión 2.1.2 y se eliminó en la 2.1.75.
  $claudeDir = Join-Path $env:ProgramFiles 'ClaudeCode'
  New-Item -ItemType Directory -Force -Path $claudeDir | Out-Null
  $managedPath = Join-Path $claudeDir 'managed-settings.json'

  if (Test-Path $managedPath) {
    $backup = "$managedPath.bak-$(Get-Date -Format yyyyMMddHHmmss)"
    Copy-Item $managedPath $backup
    Write-Log "Ya existía managed-settings.json; copia en $backup. Si tenía otros ajustes de la empresa, hay que fusionarlos a mano."
  }

  (Get-Content (Join-Path $Templates 'managed-settings.json') -Raw).Replace('{{HOSTNAME}}', $hostKey) |
    Set-Content -Path $managedPath -Encoding UTF8
  Write-Log "Claude Code configurado en $managedPath"

  $legacy = Join-Path $env:ProgramData 'ClaudeCode\managed-settings.json'
  if (Test-Path $legacy) {
    Write-Log "AVISO: existe la ruta antigua $legacy, que ya no se lee. Conviene borrarla para no confundir."
  }

  # --- 5. Codex ---------------------------------------------------------------
  # Cooperativo por diseño de Codex: en Windows el usuario puede sobrescribir esto
  # y no hay forma de forzarlo. La vista Salud del panel existe para vigilarlo.
  $codexDir  = Join-Path $env:USERPROFILE '.codex'
  $codexFile = Join-Path $codexDir 'config.toml'
  New-Item -ItemType Directory -Force -Path $codexDir | Out-Null
  $otelSection = Get-Content (Join-Path $Templates 'codex-config.toml') -Raw

  if (Test-Path $codexFile) {
    $existing = Get-Content $codexFile -Raw
    if ($existing -match '(?m)^\s*\[otel\]') {
      Write-Log "AVISO: $codexFile ya tenía una sección [otel]. No se toca. Revísala: si apunta a otro endpoint, este equipo no reportará aquí."
    } else {
      Copy-Item $codexFile "$codexFile.bak-$(Get-Date -Format yyyyMMddHHmmss)"
      Add-Content -Path $codexFile -Value "`r`n$otelSection" -Encoding UTF8
      Write-Log "Sección [otel] añadida a $codexFile"
    }
  } else {
    Set-Content -Path $codexFile -Value $otelSection -Encoding UTF8
    Write-Log "Creado $codexFile"
  }

  # --- 6. Servicio ------------------------------------------------------------
  $collectorExe = Join-Path $AgentHome 'otelcol-contrib.exe'
  if (-not (Test-Path $collectorExe)) { throw "Falta $collectorExe" }

  if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
    Write-Log "El servicio ya existía: se detiene para actualizarlo."
    Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
    & "$env:SystemRoot\System32\sc.exe" delete $ServiceName | Out-Null
    Start-Sleep -Seconds 2
  }

  $binPath = '"{0}" --config="{1}"' -f $collectorExe, $configTemplate
  New-Service -Name $ServiceName `
    -DisplayName 'Medición interna - OTel Collector' `
    -Description 'Recoge telemetría local de Claude Code y Codex, borra el contenido sensible antes de que salga del equipo, y envía solo contadores y duraciones al servidor interno.' `
    -BinaryPathName $binPath `
    -StartupType Automatic | Out-Null

  Start-Service -Name $ServiceName

  # Comprobar que sigue arriba: un servicio que arranca y se cae al instante es el
  # fallo más habitual, y sin esta comprobación el instalador diría "listo".
  Start-Sleep -Seconds 3
  $svc = Get-Service -Name $ServiceName
  if ($svc.Status -ne 'Running') {
    throw "El servicio se registró pero no está en ejecución (estado: $($svc.Status)). Revisa $AgentHome\instalacion.log"
  }

  Write-Log "Servicio $ServiceName en ejecución."
  Write-Log "Instalación completada. Reinicia las terminales y los IDE abiertos para que lean la nueva configuración."
  exit 0
}
catch {
  Write-Log "ERROR: $($_.Exception.Message)"
  exit 1
}
