<#
.SYNOPSIS
  Revierte todo lo que hizo el agente. Lo ejecuta el desinstalador.

.DESCRIPTION
  Que se pueda quitar en un clic es parte del trato con el equipo, no una cortesía.
  Quita el servicio, la telemetría de Claude Code y la sección [otel] de Codex, y
  borra la cola de datos pendientes.

  No falla si algo ya no está: un desinstalador que se atasca deja el PC a medias.
#>

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string] $AgentHome
)

$ErrorActionPreference = 'Continue'
$ServiceName = 'MedicionOtelCollector'

function Write-Log([string] $Message) {
  Write-Host ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $Message)
}

# 1. Servicio
if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
  Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
  & "$env:SystemRoot\System32\sc.exe" delete $ServiceName | Out-Null
  Write-Log 'Servicio eliminado.'
} else {
  Write-Log 'El servicio no estaba instalado.'
}

# 2. Variables de máquina de versiones anteriores del agente.
foreach ($name in 'INGEST_ENDPOINT', 'INGEST_TOKEN') {
  [Environment]::SetEnvironmentVariable($name, $null, 'Machine')
}

# 3. Claude Code
$managedPath = Join-Path $env:ProgramFiles 'ClaudeCode\managed-settings.json'
if (Test-Path $managedPath) {
  $backup = "$managedPath.removed-$(Get-Date -Format yyyyMMddHHmmss)"
  Move-Item $managedPath $backup -ErrorAction SilentlyContinue
  Write-Log "managed-settings.json retirado (copia en $backup)."
}

# 4. Codex: quitar SOLO nuestra sección [otel], respetando el resto del archivo.
$codexFile = Join-Path $env:USERPROFILE '.codex\config.toml'
if (Test-Path $codexFile) {
  $lines  = Get-Content $codexFile
  $output = New-Object System.Collections.Generic.List[string]
  $inOtel = $false

  foreach ($line in $lines) {
    if ($line -match '(?m)^\s*\[otel\]') { $inOtel = $true; continue }
    # Cualquier otra cabecera de sección cierra la nuestra.
    if ($inOtel -and $line -match '(?m)^\s*\[') { $inOtel = $false }
    if (-not $inOtel) { $output.Add($line) }
  }

  Copy-Item $codexFile "$codexFile.bak-$(Get-Date -Format yyyyMMddHHmmss)" -ErrorAction SilentlyContinue
  $output | Set-Content -Path $codexFile -Encoding UTF8
  Write-Log 'Sección [otel] retirada del config.toml de Codex.'
}

# 5. Cola de datos pendientes y configuración local.
if (Test-Path $AgentHome) {
  Remove-Item $AgentHome -Recurse -Force -ErrorAction SilentlyContinue
  Write-Log 'Directorio del agente y cola pendiente eliminados.'
}

Write-Log 'Desinstalación terminada. Reinicia terminales e IDE abiertos.'
Write-Log 'Los datos ya enviados siguen en el servidor: para borrarlos, pídelo a quien administre el panel.'
exit 0
