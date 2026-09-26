<#
.SYNOPSIS
  Quita el agente de medicion y deja el PC como estaba.

.DESCRIPTION
  Que se poder revertir en un comando es parte del trato con el equipo, no una
  cortesia: quita el servicio, la telemetria de Claude Code y la seccion [otel]
  de Codex, y borra la cola de datos pendientes.
#>

[CmdletBinding()]
param(
  [switch] $KeepQueue  # conservar los datos aun sin enviar, para depurar
)

$ErrorActionPreference = 'Continue'

$isAdmin = ([Security.Principal.WindowsPrincipal] `
  [Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) { throw 'Hay que ejecutarlo como Administrador.' }

$serviceName = 'MedicionOtelCollector'
$agentHome   = Join-Path $env:ProgramData 'MedicionAgent'

# 1. Servicio
if (Get-Service -Name $serviceName -ErrorAction SilentlyContinue) {
  Stop-Service -Name $serviceName -Force -ErrorAction SilentlyContinue
  sc.exe delete $serviceName | Out-Null
  Write-Host '[ok] Servicio eliminado.'
} else {
  Write-Host '[--] El servicio no estaba instalado.'
}

# 2. Variables de entorno de maquina
foreach ($name in 'INGEST_ENDPOINT', 'INGEST_TOKEN') {
  [Environment]::SetEnvironmentVariable($name, $null, 'Machine')
}
Write-Host '[ok] Variables de entorno eliminadas.'

# 3. Claude Code
$managedPath = Join-Path ${env:ProgramFiles} 'ClaudeCode\managed-settings.json'
if (Test-Path $managedPath) {
  $backup = "$managedPath.removed-$(Get-Date -Format yyyyMMddHHmmss)"
  Move-Item $managedPath $backup
  Write-Host "[ok] managed-settings.json retirado (copia en $backup)."
} else {
  Write-Host '[--] No habia managed-settings.json.'
}

# 4. Codex: quitar solo nuestra seccion [otel], respetando el resto del archivo.
$codexFile = Join-Path $env:USERPROFILE '.codex\config.toml'
if (Test-Path $codexFile) {
  $lines  = Get-Content $codexFile
  $output = New-Object System.Collections.Generic.List[string]
  $inOtel = $false

  foreach ($line in $lines) {
    if ($line -match '(?m)^\s*\[otel\]') { $inOtel = $true; continue }
    # Cualquier otra cabecera de seccion cierra la nuestra.
    if ($inOtel -and $line -match '(?m)^\s*\[') { $inOtel = $false }
    if (-not $inOtel) { $output.Add($line) }
  }

  Copy-Item $codexFile "$codexFile.bak-$(Get-Date -Format yyyyMMddHHmmss)"
  $output | Set-Content -Path $codexFile -Encoding UTF8
  Write-Host '[ok] Seccion [otel] retirada del config.toml de Codex.'
}

# 5. Cola de datos pendientes
if (Test-Path $agentHome) {
  if ($KeepQueue) {
    Write-Host "[--] Se conserva $agentHome por -KeepQueue."
  } else {
    Remove-Item $agentHome -Recurse -Force
    Write-Host '[ok] Directorio del agente y cola pendiente eliminados.'
  }
}

Write-Host ''
Write-Host 'Desinstalacion terminada. Reinicia terminales e IDE abiertos.'
Write-Host 'Los datos ya enviados siguen en el servidor: para borrarlos, pidelo a quien'
Write-Host 'administre el panel (retencion documentada en PRIVACY.md).'
