<#
.SYNOPSIS
  Genera la clave de instalación a partir del endpoint y el token.

.DESCRIPTION
  La clave es simplemente base64 de "endpoint|token". Existe para que quien instala
  tenga que pegar UNA cosa en vez de dos, y para poder rotarla sin recompilar el
  instalador.
  
  No es cifrado: cualquiera que tenga la clave puede leer el token. Trátala como el
  token mismo.

.EXAMPLE
  .\nueva-clave.ps1 -Endpoint https://panel.empresa.com/api/ingest/otlp -Token abc123
#>

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string] $Endpoint,
  [Parameter(Mandatory = $true)] [string] $Token
)

$clave = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("$Endpoint|$Token"))

Write-Host ''
Write-Host 'Clave de instalación:' -ForegroundColor Cyan
Write-Host $clave
Write-Host ''
Write-Host 'Instalación silenciosa:'
Write-Host "  MedicionAgent-Setup.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /CLAVE=$clave"
Write-Host ''
