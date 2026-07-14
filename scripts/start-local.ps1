param(
  [switch] $OpenBrowserOnly
)

$ErrorActionPreference = "Stop"
$appUrl = "http://127.0.0.1:5175"
$repositoryRoot = Split-Path -Parent $PSScriptRoot

function Test-AppAvailable {
  try {
    $response = Invoke-WebRequest -Uri $appUrl -Method Head -TimeoutSec 1 -UseBasicParsing
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 500
  }
  catch {
    return $false
  }
}

if ($OpenBrowserOnly) {
  $deadline = (Get-Date).AddSeconds(60)

  while ((Get-Date) -lt $deadline) {
    if (Test-AppAvailable) {
      Start-Process $appUrl
      exit 0
    }

    Start-Sleep -Milliseconds 500
  }

  exit 1
}

Set-Location $repositoryRoot

if (Test-AppAvailable) {
  Write-Host "Josh's Mini ERP is already running. Opening it in your browser..."
  Start-Process $appUrl
  exit 0
}

if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
  Write-Error "npm was not found. Install a supported Node.js version, then try again."
  exit 1
}

if (-not (Test-Path (Join-Path $repositoryRoot "node_modules"))) {
  Write-Error "Dependencies are not installed. Run 'npm install' in $repositoryRoot, then try again."
  exit 1
}

Write-Host "Starting Josh's Mini ERP..."
Write-Host "The browser will open when the app is ready. Press Ctrl+C to stop the servers."

$powerShellPath = (Get-Process -Id $PID).Path
$browserArguments = @(
  "-NoProfile",
  "-ExecutionPolicy", "Bypass",
  "-WindowStyle", "Hidden",
  "-File", ('"{0}"' -f $PSCommandPath),
  "-OpenBrowserOnly"
)

Start-Process -FilePath $powerShellPath -ArgumentList $browserArguments -WindowStyle Hidden | Out-Null

& npm.cmd run dev
exit $LASTEXITCODE
