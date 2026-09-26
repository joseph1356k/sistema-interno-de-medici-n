<#
.SYNOPSIS
  Instala el agente de medicion en un PC Windows.

.DESCRIPTION
  Hace tres cosas:
    1. Instala el OTel Collector como servicio de Windows, escuchando solo en
       loopback, con el filtro de privacidad y cola en disco.
    2. Escribe el managed-settings.json de Claude Code (no sobrescribible por el
       usuario).
    3. Anade la seccion [otel] al config.toml de Codex del usuario actual.

  ANTES DE EJECUTAR ESTO: el equipo tiene que haber recibido el documento de
  transparencia (docs/transparencia.md). El sistema esta disenado para ser
  declarado; instalarlo en silencio lo convierte en otra cosa.

  Para desinstalar: uninstall.ps1 (deja el PC como estaba).

.PARAMETER IngestEndpoint
  URL de la ruta de ingesta, por ejemplo https://medicion.empresa.com/api/ingest/otlp

.PARAMETER IngestToken
  Token que presenta el collector en la cabecera Authorization.

.PARAMETER DeviceName
  Nombre con el que este equipo aparece en el panel. Por defecto el del PC.

.PARAMETER SkipCodex
  No tocar el config.toml de Codex.

.EXAMPLE
  .\install.ps1 -IngestEndpoint https://medicion.empresa.com/api/ingest/otlp -IngestToken (Read-Host -AsSecureString)
#>

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string] $IngestEndpoint,
  [Parameter(Mandatory = $true)] [string] $IngestToken,
  [string] $DeviceName = $env:COMPUTERNAME,
  [switch] $SkipCodex
)

$ErrorActionPreference = 'Stop'

# --- Comprobaciones previas -------------------------------------------------

$isAdmin = ([Security.Principal.WindowsPrincipal] `
  [Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
  throw 'Hay que ejecutarlo como Administrador: escribe en C:\Program Files.'
}

if ($IngestEndpoint -notmatch '^https://') {
  # En pruebas locales se puede usar http, pero conviene que duela un poco.
  Write-Warning "El endpoint no es HTTPS: $IngestEndpoint"
}

$hostKey = $DeviceName.Trim().ToLower()
if ($hostKey -notmatch '^[a-z0-9][a-z0-9._-]{0,127}$') {
  throw "DeviceName no tiene forma de hostname valido: '$DeviceName'"
}

$repoRoot   = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$agentHome  = Join-Path $env:ProgramData 'MedicionAgent'
$queueDir   = Join-Path $agentHome 'queue'
$claudeDir  = Join-Path ${env:ProgramFiles} 'ClaudeCode'
$serviceName = 'MedicionOtelCollector'

Write-Host "Equipo             : $hostKey"
Write-Host "Endpoint de ingesta: $IngestEndpoint"
Write-Host ''

# --- 1. OTel Collector ------------------------------------------------------

New-Item -ItemType Directory -Force -Path $agentHome, $queueDir | Out-Null

$collectorExe = Join-Path $agentHome 'otelcol-contrib.exe'
if (-not (Test-Path $collectorExe)) {
  throw @"
Falta $collectorExe.

Descarga otelcol-contrib para windows_amd64 desde
https://github.com/open-telemetry/opentelemetry-collector-releases/releases
y ponlo en esa ruta. Se deja como paso manual a proposito: conviene revisar el
binario que se instala en todos los PCs en vez de bajarlo a ciegas.
"@
}

Copy-Item (Join-Path $repoRoot 'agent\otelcol\config.yaml') `
          (Join-Path $agentHome 'config.yaml') -Force

# El servicio lee endpoint y token del entorno de maquina, no del config, para
# que el token no quede en un archivo de configuracion legible.
[Environment]::SetEnvironmentVariable('INGEST_ENDPOINT', $IngestEndpoint, 'Machine')
[Environment]::SetEnvironmentVariable('INGEST_TOKEN', $IngestToken, 'Machine')

if (Get-Service -Name $serviceName -ErrorAction SilentlyContinue) {
  Write-Host 'Servicio ya existente: se detiene para actualizarlo.'
  Stop-Service -Name $serviceName -Force
  sc.exe delete $serviceName | Out-Null
  Start-Sleep -Seconds 2
}

New-Service -Name $serviceName `
  -DisplayName 'Medicion interna - OTel Collector' `
  -Description 'Recoge telemetria local de Claude Code y Codex, filtra el contenido sensible y la envia agregada al servidor interno.' `
  -BinaryPathName "`"$collectorExe`" --config=`"$(Join-Path $agentHome 'config.yaml')`"" `
  -StartupType Automatic | Out-Null

Start-Service -Name $serviceName
Write-Host "[ok] Servicio $serviceName instalado y arrancado."

# --- 2. Claude Code ---------------------------------------------------------

New-Item -ItemType Directory -Force -Path $claudeDir | Out-Null

$managedPath = Join-Path $claudeDir 'managed-settings.json'
$template    = Join-Path $repoRoot 'agent\windows\managed-settings.json'

if (Test-Path $managedPath) {
  $backup = "$managedPath.bak-$(Get-Date -Format yyyyMMddHHmmss)"
  Copy-Item $managedPath $backup
  Write-Warning "Ya habia managed-settings.json. Copia de seguridad en $backup"
  Write-Warning 'Si tenia otros ajustes de la empresa, hay que fusionarlos a mano.'
}

(Get-Content $template -Raw).Replace('{{HOSTNAME}}', $hostKey) |
  Set-Content -Path $managedPath -Encoding UTF8

Write-Host "[ok] Claude Code configurado en $managedPath"

# Aviso honesto sobre el alcance real de esto.
$legacy = Join-Path $env:ProgramData 'ClaudeCode\managed-settings.json'
if (Test-Path $legacy) {
  Write-Warning "Existe la ruta antigua $legacy. Ya no se lee (eliminada en v2.1.75); conviene borrarla para no confundir."
}

# --- 3. Codex ---------------------------------------------------------------

if (-not $SkipCodex) {
  $codexDir  = Join-Path $env:USERPROFILE '.codex'
  $codexFile = Join-Path $codexDir 'config.toml'
  New-Item -ItemType Directory -Force -Path $codexDir | Out-Null

  $otelSection = (Get-Content (Join-Path $repoRoot 'agent\windows\codex-config.toml') -Raw)

  if (Test-Path $codexFile) {
    $existing = Get-Content $codexFile -Raw
    if ($existing -match '(?m)^\s*\[otel\]') {
      Write-Warning @"
$codexFile ya tiene una seccion [otel]. No se toca.
Revisala a mano: si apunta a otro endpoint, este PC no reportara aqui.
"@
    } else {
      Copy-Item $codexFile "$codexFile.bak-$(Get-Date -Format yyyyMMddHHmmss)"
      Add-Content -Path $codexFile -Value "`r`n$otelSection" -Encoding UTF8
      Write-Host "[ok] Seccion [otel] anadida a $codexFile"
    }
  } else {
    Set-Content -Path $codexFile -Value $otelSection -Encoding UTF8
    Write-Host "[ok] Creado $codexFile"
  }

  Write-Host ''
  Write-Warning @'
Codex en Windows no se puede forzar: el usuario puede sobrescribir esta config.
Es cooperativo por diseno de Codex, no por diseno nuestro. Vigila la vista
v_device_health del panel para ver si algun equipo deja de reportar.
'@
}

# --- Cierre -----------------------------------------------------------------

Write-Host ''
Write-Host '--- Instalacion terminada ---'
Write-Host "Registra este equipo en el panel con el hostname: $hostKey"
Write-Host 'Reinicia las terminales y los IDE abiertos para que lean la nueva config.'
Write-Host 'Para revertirlo todo: uninstall.ps1'
