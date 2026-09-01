$ErrorActionPreference = 'Stop'
$projectPath = Split-Path -Parent $MyInvocation.MyCommand.Path
$pythonCommand = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $pythonCommand) { $pythonCommand = (Get-Command py -ErrorAction SilentlyContinue).Source }
if (-not $pythonCommand) { throw 'Python no está instalado. Instala Python 3.11 o superior.' }

$safeProjectPath = $projectPath.Replace("'", "''")
$backendCheck = $null
try { $backendCheck = Invoke-RestMethod -Uri 'http://127.0.0.1:8787/api/health' -TimeoutSec 1 } catch { }
if (-not $backendCheck) {
  $backendCommand = "`$env:PHOTO_EDITOR_ORIGIN='http://127.0.0.1:4173'; Set-Location -LiteralPath '$safeProjectPath'; & '$pythonCommand' -m backend.server"
  Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $backendCommand)
}

$staticCheck = $null
try { $staticCheck = Invoke-WebRequest -Uri 'http://127.0.0.1:4173/index.html' -TimeoutSec 1 -UseBasicParsing } catch { }
if (-not $staticCheck) {
  Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', "Set-Location -LiteralPath '$safeProjectPath'; & '$pythonCommand' -m http.server 4173")
}

# El modelo puede tardar unos segundos en cargar; espera hasta que la API
# confirme que está lista para evitar que el editor arranque en modo offline.
for ($attempt = 0; $attempt -lt 30; $attempt++) {
  try {
    $backendCheck = Invoke-RestMethod -Uri 'http://127.0.0.1:8787/api/health' -TimeoutSec 1
    if ($backendCheck.ok -and $backendCheck.model_available) { break }
  } catch { }
  Start-Sleep -Seconds 1
}

Start-Process 'http://127.0.0.1:4173/?api=http://127.0.0.1:8787/api'
