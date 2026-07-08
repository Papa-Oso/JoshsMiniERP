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

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$shopifyAppRoot = Join-Path $repoRoot "shopify-app\joshs-mini-erp"
$shopifyConfigPath = Join-Path $shopifyAppRoot "shopify.app.toml"

function Invoke-Native {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Command)

  & $Command[0] @($Command | Select-Object -Skip 1)
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed: $($Command -join ' ')"
  }
}

function Test-Gcloud {
  param([string[]]$Arguments)

  & gcloud @Arguments *> $null
  return $LASTEXITCODE -eq 0
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
  [Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
  return [Convert]::ToBase64String($bytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")
}

function Escape-DatabasePassword {
  param([string]$Value)
  return [uri]::EscapeDataString($Value)
}

function Join-EnvVars {
  param([hashtable]$Values)

  $delimiter = "|"
  $parts = @("^$delimiter^")
  foreach ($key in $Values.Keys) {
    $value = [string]$Values[$key]
    if ($value.Contains($delimiter)) {
      throw "Environment variable $key contains reserved delimiter '$delimiter'."
    }
    $parts += "$key=$value"
  }
  return ($parts -join $delimiter)
}

function Get-RunUrl {
  param([string]$ServiceName)

  $url = & gcloud run services describe $ServiceName --project $ProjectId --region $Region --format "value(status.url)"
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

if (-not (Get-Command gcloud -ErrorAction SilentlyContinue)) {
  throw "gcloud was not found. Install Google Cloud CLI and open a fresh PowerShell."
}

$accounts = & gcloud auth list --format "value(account)"
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
  Invoke-Native gcloud config set project $ProjectId

  Invoke-Native gcloud services enable `
    run.googleapis.com `
    sqladmin.googleapis.com `
    cloudbuild.googleapis.com `
    artifactregistry.googleapis.com `
    secretmanager.googleapis.com `
    --project $ProjectId

  if (-not (Test-Gcloud @("sql", "instances", "describe", $SqlInstance, "--project", $ProjectId))) {
    Invoke-Native gcloud sql instances create $SqlInstance `
      --project $ProjectId `
      --database-version POSTGRES_16 `
      --region $Region `
      --tier db-f1-micro
  }

  foreach ($database in @($ErpDatabase, $ShopifyDatabase)) {
    if (-not (Test-Gcloud @("sql", "databases", "describe", $database, "--instance", $SqlInstance, "--project", $ProjectId))) {
      Invoke-Native gcloud sql databases create $database --instance $SqlInstance --project $ProjectId
    }
  }

  $existingUsers = & gcloud sql users list --instance $SqlInstance --project $ProjectId --format "value(name)"
  if ($existingUsers -notcontains $ErpDatabaseUser) {
    Invoke-Native gcloud sql users create $ErpDatabaseUser --instance $SqlInstance --project $ProjectId --password $ErpDatabasePassword
  } else {
    Invoke-Native gcloud sql users set-password $ErpDatabaseUser --instance $SqlInstance --project $ProjectId --password $ErpDatabasePassword
  }
  if ($existingUsers -notcontains $ShopifyDatabaseUser) {
    Invoke-Native gcloud sql users create $ShopifyDatabaseUser --instance $SqlInstance --project $ProjectId --password $ShopifyDatabasePassword
  } else {
    Invoke-Native gcloud sql users set-password $ShopifyDatabaseUser --instance $SqlInstance --project $ProjectId --password $ShopifyDatabasePassword
  }

  $erpEnv = Join-EnvVars @{
    HOST = "0.0.0.0"
    STORE_DRIVER = "postgres"
    DATABASE_URL = $erpDatabaseUrl
    ERP_API_TOKEN = $ErpApiToken
    SHOPIFY_SHOP_DOMAIN = $ShopDomain
    SHOPIFY_CLIENT_ID = $ShopifyClientId
    SHOPIFY_CLIENT_SECRET = $ShopifyClientSecret
    SHOPIFY_API_VERSION = $ShopifyApiVersion
  }

  Invoke-Native gcloud run deploy $ErpService `
    --project $ProjectId `
    --source . `
    --region $Region `
    --allow-unauthenticated `
    --add-cloudsql-instances $connectionName `
    --set-env-vars $erpEnv

  $erpUrl = Get-RunUrl $ErpService

  Push-Location $shopifyAppRoot
  try {
    $shopifyEnv = Join-EnvVars @{
      SHOPIFY_API_KEY = $ShopifyClientId
      SHOPIFY_API_SECRET = $ShopifyClientSecret
      SHOPIFY_APP_URL = "https://placeholder.example.com"
      SCOPES = "read_inventory,write_inventory,read_products,read_locations"
      DATABASE_URL = $shopifyDatabaseUrl
      ERP_API_BASE_URL = "$erpUrl/api"
      ERP_API_TOKEN = $ErpApiToken
      NODE_ENV = "production"
    }

    Invoke-Native gcloud run deploy $ShopifyService `
      --project $ProjectId `
      --source . `
      --region $Region `
      --allow-unauthenticated `
      --add-cloudsql-instances $connectionName `
      --set-env-vars $shopifyEnv
  } finally {
    Pop-Location
  }

  $shopifyUrl = Get-RunUrl $ShopifyService
  Invoke-Native gcloud run services update $ShopifyService `
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
