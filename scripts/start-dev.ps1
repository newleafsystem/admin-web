param(
  [switch]$Restart
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$logDir = Join-Path $repoRoot ".dev-logs"
$statePath = Join-Path $logDir "dev-servers.json"
$nodeExe = (Get-Command node -ErrorAction Stop).Source

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Read-DevState {
  if (!(Test-Path -LiteralPath $statePath)) {
    return $null
  }

  try {
    return Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Test-ProcessRunning {
  param([int]$ProcessId)

  if (!$ProcessId) {
    return $false
  }

  try {
    Get-Process -Id $ProcessId -ErrorAction Stop | Out-Null
    return $true
  } catch {
    return $false
  }
}

function Start-DevServer {
  param(
    [string]$Name,
    [string]$WorkingDirectory,
    [string[]]$ArgumentList,
    [string]$Timestamp
  )

  $stdoutPath = Join-Path $logDir "$Name-$Timestamp.out.log"
  $stderrPath = Join-Path $logDir "$Name-$Timestamp.err.log"

  $process = Start-Process `
    -FilePath $nodeExe `
    -ArgumentList $ArgumentList `
    -WorkingDirectory $WorkingDirectory `
    -WindowStyle Hidden `
    -PassThru `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath

  return [ordered]@{
    pid = $process.Id
    command = "$nodeExe $($ArgumentList -join ' ')"
    workingDirectory = $WorkingDirectory
    stdout = $stdoutPath
    stderr = $stderrPath
  }
}

$existingState = Read-DevState
$running = @()

if ($existingState) {
  foreach ($serviceName in @("api", "admin")) {
    $service = $existingState.$serviceName
    if ($service -and (Test-ProcessRunning -ProcessId ([int]$service.pid))) {
      $running += "$serviceName($($service.pid))"
    }
  }
}

if ($Restart) {
  & (Join-Path $PSScriptRoot "stop-dev.ps1") -Ports
} elseif ($running.Count -gt 0) {
  if (!$Restart) {
    Write-Host "Dev servers already appear to be running: $($running -join ', ')"
    Write-Host "Run npm run dev:stop first, or npm run dev:restart."
    exit 0
  }
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$api = Start-DevServer `
  -Name "api" `
  -WorkingDirectory (Join-Path $repoRoot "apps/api") `
  -ArgumentList @("src/server.js") `
  -Timestamp $timestamp
$admin = Start-DevServer `
  -Name "admin" `
  -WorkingDirectory (Join-Path $repoRoot "apps/admin") `
  -ArgumentList @((Join-Path $repoRoot "node_modules/vite/bin/vite.js"), "--host", "0.0.0.0") `
  -Timestamp $timestamp

$state = [ordered]@{
  startedAt = (Get-Date).ToString("o")
  repoRoot = $repoRoot
  api = $api
  admin = $admin
}

$state | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $statePath -Encoding UTF8

Write-Host "Started NewLeaf dev servers."
Write-Host "API:   http://localhost:8080  pid $($api.pid)"
Write-Host "Admin: http://localhost:5173  pid $($admin.pid)"
Write-Host "Logs:  $logDir"
Write-Host "Stop:  npm run dev:stop"
