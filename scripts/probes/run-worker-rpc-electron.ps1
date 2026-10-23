$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$archivePath = Join-Path $PSScriptRoot 'worker-rpc-probe.asar'
$resultPath = Join-Path $PSScriptRoot 'worker-rpc-electron-result.json'
$asarCli = Join-Path $repoRoot 'node_modules/@electron/asar/bin/asar.js'
$electron = Join-Path $repoRoot 'node_modules/electron/dist/electron.exe'
$fixtureDir = Join-Path $repoRoot 'tests/fixtures/worker-rpc'
$appDir = Join-Path $PSScriptRoot 'electron-worker-rpc-app'
$previousFixture = $env:WATCHTOWER_WORKER_RPC_FIXTURE
$previousLog = $env:WATCHTOWER_WORKER_RPC_LOG

try {
  & node $asarCli pack $fixtureDir $archivePath
  if ($LASTEXITCODE -ne 0) { throw 'Unable to package worker RPC fixtures.' }

  $env:WATCHTOWER_WORKER_RPC_FIXTURE = "$archivePath\runner.mjs"
  $env:WATCHTOWER_WORKER_RPC_LOG = $resultPath
  Remove-Item -LiteralPath $resultPath -Force -ErrorAction SilentlyContinue
  $probeProcess = Start-Process -FilePath $electron -ArgumentList ('"{0}"' -f $appDir) -WindowStyle Hidden -PassThru
  if (-not $probeProcess.WaitForExit(30000)) {
    Stop-Process -Id $probeProcess.Id -ErrorAction SilentlyContinue
    $diagnostic = if (Test-Path -LiteralPath $resultPath) { Get-Content -LiteralPath $resultPath -Raw } else { 'no result' }
    throw "Electron worker RPC probe exceeded its 30 second deadline: $diagnostic"
  }
  if ($probeProcess.ExitCode -ne 0) { throw "Electron worker RPC probe exited with code $($probeProcess.ExitCode)." }

  $result = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
  if (
    $result.result.echo.value -ne 'electron-worker-thread' -or
    $result.result.error -ne 'Failure' -or
    $result.result.stats.initialized -ne 'ledger-ready' -or
    $result.result.stats.cancelled -ne 1 -or
    $result.spawnCount -ne 1 -or
    $result.exitCount -ne 1
  ) { throw "Electron worker RPC probe returned an unexpected result: $($result | ConvertTo-Json -Compress -Depth 8)" }

  $result | ConvertTo-Json -Compress -Depth 8
}
finally {
  if ($null -eq $previousFixture) { Remove-Item Env:WATCHTOWER_WORKER_RPC_FIXTURE -ErrorAction SilentlyContinue }
  else { $env:WATCHTOWER_WORKER_RPC_FIXTURE = $previousFixture }
  if ($null -eq $previousLog) { Remove-Item Env:WATCHTOWER_WORKER_RPC_LOG -ErrorAction SilentlyContinue }
  else { $env:WATCHTOWER_WORKER_RPC_LOG = $previousLog }
  Remove-Item -LiteralPath $archivePath, $resultPath -Force -ErrorAction SilentlyContinue
}
