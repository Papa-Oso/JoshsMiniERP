param(
  [Parameter(Mandatory = $true)]
  [string]$ProjectId,

  [string]$Region = "us-central1",
  [string]$SqlInstance = "joshs-mini-erp",
  [string]$ErpDatabase = "erp",
  [string]$ShopifyDatabase = "shopify_sessions",
  [string]$ErpDatabaseUser = "erp_user",
  [string]$ShopifyDatabaseUser = "shopify_user",
  [string]$ErpService = "joshs-erp-api",
  [string]$ShopifyService = "joshs-shopify-app",
  [string]$ShopDomain = "aqrqyf-uw.myshopify.com",
  [string]$ShopifyApiVersion = "2026-07",

  [Parameter(Mandatory = $true)]
  [string]$ShopifyClientId,

  [Parameter(Mandatory = $true)]
  [string]$ShopifyClientSecret,

  [string]$ErpDatabasePassword,
  [string]$ShopifyDatabasePassword,
  [string]$ErpApiToken,
  [switch]$ReleaseShopifyConfig
)

$ErrorActionPreference = "Stop"
$env:Path = "$env:LOCALAPPDATA\Google\Cloud SDK\google-cloud-sdk\bin;$env:Path"
$gcloudCommand = Join-Path $env:LOCALAPPDATA "Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd"
if (-not (Test-Path $gcloudCommand)) {
  $gcloudCommand = "gcloud"
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$shopifyAppRoot = Join-Path $repoRoot "shopify-app\joshs-mini-erp"
$shopifyConfigPath = Join-Path $shopifyAppRoot "shopify.app.toml"

function Invoke-Native {
  param(
    [string]$FilePath,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Arguments
  )

  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    $summary = ($Arguments | Select-Object -First 4) -join " "
    throw "Command failed: $FilePath $summary ..."
  }
}

function Test-Gcloud {
  param([string[]]$Arguments)

  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    & $gcloudCommand @Arguments 1>$null 2>$null
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  return $exitCode -eq 0
}

function Read-PlainSecret {
  param([string]$Prompt)

  $secure = Read-Host $Prompt -AsSecureString
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
  }
}

function New-Token {
  $bytes = New-Object byte[] 32
  $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $generator.GetBytes($bytes)
  } finally {
    $generator.Dispose()
  }
  return [Convert]::ToBase64String($bytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")
}

function Escape-DatabasePassword {
  param([string]$Value)
  return [uri]::EscapeDataString($Value)
}

function Read-DotEnv {
  param([string]$Path)

  $values = @{}
  if (-not (Test-Path $Path)) {
    return $values
  }

  foreach ($line in Get-Content $Path) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith("#")) {
      continue
    }

    $separator = $trimmed.IndexOf("=")
    if ($separator -lt 1) {
      continue
    }

    $key = $trimmed.Substring(0, $separator).Trim()
    if ($key -notmatch "^[A-Za-z_][A-Za-z0-9_]*$") {
      continue
    }

    $value = $trimmed.Substring($separator + 1).Trim()
    if ($value.Length -ge 2) {
      $first = $value.Substring(0, 1)
      $last = $value.Substring($value.Length - 1, 1)
      if (($first -eq '"' -and $last -eq '"') -or ($first -eq "'" -and $last -eq "'")) {
        $value = $value.Substring(1, $value.Length - 2)
      }
    }

    $values[$key] = $value
  }

  return $values
}

function Read-JsonFile {
  param([string]$Path)

  if (-not (Test-Path $Path)) {
    return $null
  }

  return Get-Content $Path -Raw | ConvertFrom-Json
}

function Add-OptionalEnvVars {
  param(
    [hashtable]$Target,
    [hashtable]$Source,
    [string[]]$Keys
  )

  foreach ($key in $Keys) {
    if ($Source.ContainsKey($key) -and -not [string]::IsNullOrWhiteSpace($Source[$key])) {
      $Target[$key] = $Source[$key]
    }
  }
}

function Write-EnvVarsFile {
  param([hashtable]$Values)

  $lines = @()
  foreach ($key in $Values.Keys) {
    $escaped = ([string]$Values[$key]).Replace("'", "''")
    $lines += "${key}: '$escaped'"
  }

  $file = New-TemporaryFile
  Set-Content -Path $file.FullName -Value ($lines -join [Environment]::NewLine) -Encoding UTF8
  return $file.FullName
}

function Get-RunUrl {
  param([string]$ServiceName)

  $url = & $gcloudCommand run services describe $ServiceName --project $ProjectId --region $Region --format "value(status.url)"
  if ($LASTEXITCODE -ne 0 -or -not $url) {
    throw "Unable to read Cloud Run URL for $ServiceName."
  }
  return $url.Trim()
}

function Update-ShopifyConfigUrls {
  param([string]$ShopifyAppUrl)

  $config = Get-Content $shopifyConfigPath -Raw
  $config = $config -replace 'application_url = ".*"', "application_url = `"$ShopifyAppUrl`""
  $config = $config -replace 'redirect_urls = \[.*\]', "redirect_urls = [ `"$ShopifyAppUrl/api/auth`" ]"
  Set-Content -Path $shopifyConfigPath -Value $config -NoNewline
}

if (-not (Get-Command $gcloudCommand -ErrorAction SilentlyContinue)) {
  throw "gcloud was not found. Install Google Cloud CLI and open a fresh PowerShell."
}

$accounts = & $gcloudCommand auth list --format "value(account)"
if (-not $accounts) {
  throw "gcloud is not authenticated. Run: gcloud auth login"
}

if (-not $ErpDatabasePassword) {
  $ErpDatabasePassword = Read-PlainSecret "ERP database password for $ErpDatabaseUser"
}
if (-not $ShopifyDatabasePassword) {
  $ShopifyDatabasePassword = Read-PlainSecret "Shopify session database password for $ShopifyDatabaseUser"
}
if (-not $ErpApiToken) {
  $ErpApiToken = New-Token
}

$connectionName = "$ProjectId`:$Region`:$SqlInstance"
$erpDatabaseUrl = "postgresql://${ErpDatabaseUser}:$(Escape-DatabasePassword $ErpDatabasePassword)@localhost/$ErpDatabase`?host=/cloudsql/$connectionName"
$shopifyDatabaseUrl = "postgresql://${ShopifyDatabaseUser}:$(Escape-DatabasePassword $ShopifyDatabasePassword)@localhost/$ShopifyDatabase`?host=/cloudsql/$connectionName"

Push-Location $repoRoot
try {
  Invoke-Native $gcloudCommand config set project $ProjectId

  Invoke-Native $gcloudCommand services enable `
    run.googleapis.com `
    sqladmin.googleapis.com `
    cloudbuild.googleapis.com `
    artifactregistry.googleapis.com `
    secretmanager.googleapis.com `
    --project $ProjectId

  Start-Sleep -Seconds 45

  if (-not (Test-Gcloud @("sql", "instances", "describe", $SqlInstance, "--project", $ProjectId))) {
    Invoke-Native $gcloudCommand sql instances create $SqlInstance `
      --project $ProjectId `
      --database-version POSTGRES_16 `
      --edition ENTERPRISE `
      --region $Region `
      --tier db-f1-micro
  }

  foreach ($database in @($ErpDatabase, $ShopifyDatabase)) {
    if (-not (Test-Gcloud @("sql", "databases", "describe", $database, "--instance", $SqlInstance, "--project", $ProjectId))) {
      Invoke-Native $gcloudCommand sql databases create $database --instance $SqlInstance --project $ProjectId
    }
  }

  $existingUsers = & $gcloudCommand sql users list --instance $SqlInstance --project $ProjectId --format "value(name)"
  if ($existingUsers -notcontains $ErpDatabaseUser) {
    Invoke-Native $gcloudCommand sql users create $ErpDatabaseUser --instance $SqlInstance --project $ProjectId "--password=$ErpDatabasePassword"
  } else {
    Invoke-Native $gcloudCommand sql users set-password $ErpDatabaseUser --instance $SqlInstance --project $ProjectId "--password=$ErpDatabasePassword"
  }
  if ($existingUsers -notcontains $ShopifyDatabaseUser) {
    Invoke-Native $gcloudCommand sql users create $ShopifyDatabaseUser --instance $SqlInstance --project $ProjectId "--password=$ShopifyDatabasePassword"
  } else {
    Invoke-Native $gcloudCommand sql users set-password $ShopifyDatabaseUser --instance $SqlInstance --project $ProjectId "--password=$ShopifyDatabasePassword"
  }

  $erpEnv = @{
    HOST = "0.0.0.0"
    STORE_DRIVER = "postgres"
    DATABASE_URL = $erpDatabaseUrl
    ERP_API_TOKEN = $ErpApiToken
    SHOPIFY_SHOP_DOMAIN = $ShopDomain
    SHOPIFY_CLIENT_ID = $ShopifyClientId
    SHOPIFY_CLIENT_SECRET = $ShopifyClientSecret
    SHOPIFY_API_VERSION = $ShopifyApiVersion
  }

  $localEnv = Read-DotEnv (Join-Path $repoRoot ".env")
  Add-OptionalEnvVars $erpEnv $localEnv @(
    "ETSY_KEYSTRING",
    "ETSY_SHARED_SECRET",
    "ETSY_API_KEY",
    "ETSY_CLIENT_ID",
    "ETSY_REDIRECT_URI",
    "ETSY_ACCESS_TOKEN",
    "ETSY_REFRESH_TOKEN",
    "ETSY_TOKEN_FILE",
    "EBAY_ENVIRONMENT",
    "EBAY_ACCESS_TOKEN",
    "EBAY_REFRESH_TOKEN",
    "EBAY_CLIENT_ID",
    "EBAY_CLIENT_SECRET",
    "EBAY_RUNAME",
    "EBAY_REDIRECT_URI",
    "EBAY_MARKETPLACE_ID",
    "EBAY_TOKEN_FILE"
  )

  if (-not $erpEnv.ContainsKey("ETSY_REFRESH_TOKEN")) {
    $etsyTokenFile = if ($localEnv.ContainsKey("ETSY_TOKEN_FILE") -and $localEnv["ETSY_TOKEN_FILE"]) {
      $localEnv["ETSY_TOKEN_FILE"]
    } else {
      "data/etsy-auth.json"
    }
    if (-not [System.IO.Path]::IsPathRooted($etsyTokenFile)) {
      $etsyTokenFile = Join-Path $repoRoot $etsyTokenFile
    }
    $etsyToken = Read-JsonFile $etsyTokenFile
    if ($etsyToken -and $etsyToken.refreshToken) {
      $erpEnv["ETSY_REFRESH_TOKEN"] = $etsyToken.refreshToken
    }
  }

  $erpEnvFile = Write-EnvVarsFile $erpEnv
  try {
    Invoke-Native $gcloudCommand run deploy $ErpService `
      --project $ProjectId `
      --source . `
      --region $Region `
      --allow-unauthenticated `
      --add-cloudsql-instances $connectionName `
      --env-vars-file $erpEnvFile
  } finally {
    Remove-Item $erpEnvFile -Force -ErrorAction SilentlyContinue
  }

  $erpUrl = Get-RunUrl $ErpService

  Push-Location $shopifyAppRoot
  try {
    $shopifyEnv = @{
      SHOPIFY_API_KEY = $ShopifyClientId
      SHOPIFY_API_SECRET = $ShopifyClientSecret
      SHOPIFY_APP_URL = "https://placeholder.example.com"
      SCOPES = "read_inventory,write_inventory,read_products,read_locations"
      DATABASE_URL = $shopifyDatabaseUrl
      ERP_API_BASE_URL = "$erpUrl/api"
      ERP_API_TOKEN = $ErpApiToken
      NODE_ENV = "production"
    }

    $shopifyEnvFile = Write-EnvVarsFile $shopifyEnv
    try {
      Invoke-Native $gcloudCommand run deploy $ShopifyService `
        --project $ProjectId `
        --source . `
        --region $Region `
        --allow-unauthenticated `
        --add-cloudsql-instances $connectionName `
        --env-vars-file $shopifyEnvFile
    } finally {
      Remove-Item $shopifyEnvFile -Force -ErrorAction SilentlyContinue
    }
  } finally {
    Pop-Location
  }

  $shopifyUrl = Get-RunUrl $ShopifyService
  Invoke-Native $gcloudCommand run services update $ShopifyService `
    --project $ProjectId `
    --region $Region `
    --update-env-vars "SHOPIFY_APP_URL=$shopifyUrl"

  Update-ShopifyConfigUrls $shopifyUrl

  if ($ReleaseShopifyConfig) {
    Push-Location $shopifyAppRoot
    try {
      Invoke-Native npm run deploy
    } finally {
      Pop-Location
    }
  }

  Write-Host ""
  Write-Host "Deployment complete."
  Write-Host "ERP API:     $erpUrl"
  Write-Host "Shopify app: $shopifyUrl"
  Write-Host "ERP token:   $ErpApiToken"
  Write-Host ""
  Write-Host "Next:"
  Write-Host "1. If not already released, run: cd shopify-app/joshs-mini-erp; npm run deploy"
  Write-Host "2. Install/open the app for $ShopDomain from the Shopify Dev Dashboard."
  Write-Host "3. Test authenticated health:"
  Write-Host "   Invoke-WebRequest $erpUrl/api/health -Headers @{ Authorization = 'Bearer $ErpApiToken' }"
} finally {
  Pop-Location
}
