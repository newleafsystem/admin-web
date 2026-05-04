param(
  [switch]$Ports,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$logDir = Join-Path $repoRoot ".dev-logs"
$statePath = Join-Path $logDir "dev-servers.json"
$currentProcessId = $PID
$protectedProcessIds = New-Object 'System.Collections.Generic.HashSet[int]'

function Add-ProtectedProcessChain {
  param([int]$ProcessId)

  while ($ProcessId) {
    [void]$protectedProcessIds.Add($ProcessId)
    try {
      $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction Stop
      $parentProcessId = 0
      if ($processInfo.ParentProcessId) {
        $parentProcessId = [int]$processInfo.ParentProcessId
      }
      if (!$parentProcessId -or $protectedProcessIds.Contains($parentProcessId)) {
        return
      }
      $ProcessId = $parentProcessId
    } catch {
      return
    }
  }
}

Add-ProtectedProcessChain -ProcessId $currentProcessId

function Get-ProcessInfo {
  param([int]$TargetProcessId)

  try {
    return Get-CimInstance Win32_Process -Filter "ProcessId=$TargetProcessId" -ErrorAction Stop
  } catch {
    return $null
  }
}

function Test-NewLeafDevProcess {
  param(
    [int]$TargetProcessId,
    [object]$ExpectedService = $null
  )

  if (!$TargetProcessId -or $protectedProcessIds.Contains($TargetProcessId)) {
    return $false
  }

  $processInfo = Get-ProcessInfo -TargetProcessId $TargetProcessId
  if (!$processInfo) {
    return $false
  }

  $commandLine = ""
  if ($processInfo.CommandLine) {
    $commandLine = [string]$processInfo.CommandLine
  }
  $executablePath = ""
  if ($processInfo.ExecutablePath) {
    $executablePath = [string]$processInfo.ExecutablePath
  }
  $expectedCommand = ""
  if ($ExpectedService -and $ExpectedService.command) {
    $expectedCommand = [string]$ExpectedService.command
  }

  $commandExecutable = ""
  if ($commandLine.Trim()) {
    $commandExecutable = $commandLine.Split(" ")[0].Trim('"')
  }
  $isNode = [IO.Path]::GetFileName($executablePath).ToLowerInvariant() -eq "node.exe" -or
    [IO.Path]::GetFileName($commandExecutable).ToLowerInvariant() -eq "node.exe"
  $looksLikeApi = $commandLine -match '(^|\s|")src[\\/]+server\.js($|\s|")'
  $looksLikeVite = $commandLine -match 'vite[\\/]+bin[\\/]+vite\.js' -or $commandLine -match '(^|\s|")vite($|\s|")'
  $mentionsRepo = $commandLine -like "*$repoRoot*" -or $expectedCommand -like "*$repoRoot*"
  $matchesExpectedCommand = $expectedCommand -and (
    $commandLine -like "*src/server.js*" -or
    $commandLine -like "*src\server.js*" -or
    $commandLine -like "*vite/bin/vite.js*" -or
    $commandLine -like "*vite\bin\vite.js*"
  )

  return $isNode -and ($looksLikeApi -or $looksLikeVite -or $mentionsRepo -or $matchesExpectedCommand)
}

function Stop-ProcessTree {
  param(
    [int]$TargetProcessId,
    [object]$ExpectedService = $null
  )

  if (!$TargetProcessId) {
    return
  }
  if ($protectedProcessIds.Contains($TargetProcessId)) {
    Write-Host "Skipped protected process $TargetProcessId"
    return
  }
  if (!(Test-NewLeafDevProcess -TargetProcessId $TargetProcessId -ExpectedService $ExpectedService)) {
    Write-Host "Skipped unrecognized process $TargetProcessId"
    return
  }

  $children = Get-CimInstance Win32_Process -Filter "ParentProcessId=$TargetProcessId" -ErrorAction SilentlyContinue
  foreach ($child in $children) {
    Stop-ProcessTree -TargetProcessId ([int]$child.ProcessId)
  }

  try {
    if ($DryRun) {
      Write-Host "Would stop process $TargetProcessId"
    } else {
      Stop-Process -Id $TargetProcessId -Force -ErrorAction Stop
      Write-Host "Stopped process $TargetProcessId"
    }
  } catch {
    Write-Host "Process $TargetProcessId is not running"
  }
}

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

function Stop-PortListeners {
  param([int[]]$PortsToStop)

  foreach ($port in $PortsToStop) {
    $pids = @()

    try {
      $connections = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop
      $pids += $connections | ForEach-Object { [int]$_.OwningProcess }
    } catch {
      $netstatOutput = netstat -ano | Select-String ":$port\s+.*LISTENING"
      foreach ($line in $netstatOutput) {
        $parts = ($line.Line -split '\s+') | Where-Object { $_ }
        $pidText = $parts[-1]
        if ($pidText -match '^\d+$') {
          $pids += [int]$pidText
        }
      }
    }

    foreach ($listenerProcessId in ($pids | Sort-Object -Unique)) {
      Stop-ProcessTree -TargetProcessId $listenerProcessId
    }
  }
}

$state = Read-DevState

if ($state) {
  foreach ($serviceName in @("admin", "api")) {
    $service = $state.$serviceName
    if ($service) {
      Stop-ProcessTree -TargetProcessId ([int]$service.pid) -ExpectedService $service
    }
  }

  if (!$DryRun) {
    Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue
    Write-Host "Removed dev server state file."
  } else {
    Write-Host "Would remove dev server state file."
  }
} else {
  Write-Host "No tracked NewLeaf dev server state file found."
}

if ($Ports) {
  Stop-PortListeners -PortsToStop @(8080, 5173)
}

Write-Host "NewLeaf dev server stop complete."
