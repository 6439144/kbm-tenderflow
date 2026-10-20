# TenderFlow - deploy (or update) the demo on Azure App Service, FREE (F1) plan only.
#
# Put this script, release.json and the part.NN files of ONE release in one folder, then from that folder run
# (Windows PowerShell 5.1 or PowerShell 7):
#   powershell -ExecutionPolicy Bypass -File .\deploy-tenderflow-azure-free.ps1
# Optional parameters:
#   -AppName kbm-tenderflow          (gives https://kbm-tenderflow.azurewebsites.net)
#   -ResourceGroup rg-kbm-tenderflow   -Location westeurope   -Entity moi   (moi | kea | gcia)
#   -EphemeralData                   database on the container's local disk; demo data is re-created after each restart
#   -VerifyOnly                      run the post-deployment checks only (no change to Azure)
#
# What it does
#   1. Joins the parts into tenderflow-azure-package.zip and checks the SHA-256 recorded in release.json.
#   2. Signs in to Azure if needed. Refuses to continue if the app is on a paid plan (it never upgrades or scales).
#   3. First deployment: reuses an existing FREE Linux plan (Azure allows one per region) or creates one, then
#      creates the web app (Node 22). Existing app: keeps its plan, keys and demo password.
#   4. Sets the TenderFlow settings, uploads the prebuilt package (no build on Azure).
#   5. Waits until the NEW version answers, then runs the release checks and prints PASS/FAIL for each.
#      Exit code 0 = deployed and every check passed.
# Secrets: BID_MASTER_KEY, AUDIT_SIGNING_KEY and DEMO_PASSWORD are generated once, kept only as App Service
# settings and never changed on an existing app. The demo password is printed once, on first deployment only.
# All data in this demo is fictitious.

param(
  [string]$AppName = 'kbm-tenderflow',
  [string]$ResourceGroup = 'rg-kbm-tenderflow',
  [string]$Location = 'westeurope',
  [ValidateSet('moi', 'kea', 'gcia')][string]$Entity = 'moi',
  [switch]$EphemeralData,
  [switch]$VerifyOnly,
  [string]$BaseUrl = ''   # checks only: test a different address (for example a local smoke run of the package)
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

function Step([string]$text) { Write-Host ''; Write-Host "==> $text" -ForegroundColor Cyan }
function Check([string]$what) { if ($LASTEXITCODE -ne 0) { throw "FAILED: $what (exit code $LASTEXITCODE)" } }
function RandomBytes([int]$n) { $b = New-Object byte[] $n; [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); return $b }

# ---------------------------------------------------------------- 1. package
$releaseFile = Join-Path $here 'release.json'
if (-not (Test-Path -LiteralPath $releaseFile)) { throw "release.json is missing. Copy the whole release folder (release.json, part.NN files and this script)." }
$release = Get-Content -Raw -LiteralPath $releaseFile | ConvertFrom-Json
$version = [string]$release.version
$expectedSha = ([string]$release.sha256).ToUpperInvariant()
$zip = Join-Path $here ([string]$release.package)
Write-Host "TenderFlow $version (commit $($release.commit), built $($release.builtAt))"

if (-not $VerifyOnly) {
  $haveZip = (Test-Path -LiteralPath $zip) -and ((Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash -eq $expectedSha)
  if (-not $haveZip) {
    Step "Joining $(@($release.parts).Count) package parts"
    $parts = @($release.parts) | ForEach-Object { Join-Path $here $_ }
    foreach ($p in $parts) { if (-not (Test-Path -LiteralPath $p)) { throw "Missing $p - copy every part listed in release.json next to this script." } }
    $out = [System.IO.File]::Create($zip)
    try { foreach ($p in $parts) { $in = [System.IO.File]::OpenRead($p); try { $in.CopyTo($out) } finally { $in.Close() } } } finally { $out.Close() }
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash -ne $expectedSha) {
      Remove-Item -LiteralPath $zip
      throw "The joined package does not match release.json (SHA-256 mismatch). The parts are damaged or from another release; copy them again."
    }
  }
  Write-Host "Package checked: SHA-256 matches release $version."
}

# ---------------------------------------------------------------- 2. Azure sign-in and guard rails
if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
  Write-Host 'Azure CLI is not installed. Install it with:  winget install -e --id Microsoft.AzureCLI' -ForegroundColor Yellow
  Write-Host 'then close and reopen PowerShell and run this script again.'
  exit 1
}
Step 'Azure sign-in'
az account show --only-show-errors 1>$null 2>$null
if ($LASTEXITCODE -ne 0) { az login --only-show-errors 1>$null; Check 'az login' }
$sub = az account show --query id -o tsv; Check 'az account show'
Write-Host "Subscription: $(az account show --query name -o tsv)"

$app = az webapp list --query "[?name=='$AppName'] | [0].{rg:resourceGroup, plan:appServicePlanId, state:state}" -o json | ConvertFrom-Json
Check 'az webapp list'
$exists = [bool]$app
if ($exists) {
  $appRg = $app.rg
  $planSku = az appservice plan show --ids $app.plan --query sku.name -o tsv; Check 'az appservice plan show'
  Write-Host "Existing app '$AppName' in $appRg on plan $(Split-Path -Leaf $app.plan) (SKU $planSku)."
  if ($planSku -ne 'F1') { throw "The app is on the $planSku plan, which is not the Free (F1) tier. This script never deploys to or changes a paid plan. Stop and ask." }
} elseif ($VerifyOnly) {
  throw "App '$AppName' does not exist in this subscription."
}

if (-not $VerifyOnly) {
  if (-not $exists) {
    Step "Checking the name $AppName"
    $bodyFile = Join-Path $env:TEMP 'tf-name-check.json'
    Set-Content -LiteralPath $bodyFile -Encoding ascii -Value ('{"name":"' + $AppName + '","type":"Microsoft.Web/sites"}')
    $avail = az rest --method post --uri "https://management.azure.com/subscriptions/$sub/providers/Microsoft.Web/checknameavailability?api-version=2022-03-01" --body "@$bodyFile" --query nameAvailable -o tsv
    Check 'name availability check'
    if ($avail -ne 'true') { throw "The name '$AppName' is already taken in Azure. Run again with -AppName <another-name>." }

    Step 'Resource group and free (F1) Linux plan'
    az group create -n $ResourceGroup -l $Location --only-show-errors 1>$null; Check 'az group create'
    $plans = @(az appservice plan list --query "[?sku.name=='F1' && reserved].{id:id, name:name, location:location}" -o json | ConvertFrom-Json)
    Check 'az appservice plan list'
    $plan = $plans | Where-Object { ($_.location -replace '\s', '').ToLower() -eq $Location.ToLower() } | Select-Object -First 1
    if (-not $plan) { $plan = $plans | Select-Object -First 1 }
    if ($plan) {
      $planId = $plan.id
      Write-Host "Reusing the free plan '$($plan.name)' ($($plan.location)). Apps on it share its 60 CPU-minutes/day quota."
    } else {
      az appservice plan create -g $ResourceGroup -n 'plan-kbm-tenderflow-free' --is-linux --sku F1 -l $Location --only-show-errors 1>$null
      Check 'az appservice plan create (F1)'
      $planId = az appservice plan show -g $ResourceGroup -n 'plan-kbm-tenderflow-free' --query id -o tsv
      Write-Host 'Created the free plan plan-kbm-tenderflow-free.'
    }
    Step 'Web app (Node 22)'
    az webapp create -g $ResourceGroup -n $AppName -p $planId --runtime 'NODE:22-lts' --only-show-errors 1>$null; Check 'az webapp create'
    $appRg = $ResourceGroup
  }

  # ---------------------------------------------------------------- 3. settings
  Step 'Settings'
  $current = az webapp config appsettings list -g $appRg -n $AppName -o json | ConvertFrom-Json; Check 'appsettings list'
  $names = @($current | ForEach-Object { $_.name })
  $settings = @(
    'TENANCY_MODE=dedicated', "ENTITY_ID=$Entity", "DEMO_ENTITY=$Entity", 'SEED_DEMO=true', 'DEMO_MODE=false',
    'CONTENT_STORE_TYPE=filesystem', 'TRUST_PROXY=1', "PUBLIC_BASE_URL=https://$AppName.azurewebsites.net",
    'LOWCODE_AUTOMATION_MS=60000', 'WEBSITE_RUN_FROM_PACKAGE=1', 'SCM_DO_BUILD_DURING_DEPLOYMENT=false', 'WEBSITE_NODE_DEFAULT_VERSION=~22'
  )
  if ($EphemeralData) { $settings += 'DATA_DIR=/tmp/tenderflow-data' }
  elseif ($names -notcontains 'DATA_DIR') { $settings += 'DATA_DIR=/home/data/tenderflow' }
  $newPassword = $null
  # Keys are created once: changing them later would make existing sealed bids and the audit chain unreadable.
  if ($names -notcontains 'BID_MASTER_KEY') { $settings += 'BID_MASTER_KEY=' + [Convert]::ToBase64String((RandomBytes 32)) }
  if ($names -notcontains 'AUDIT_SIGNING_KEY') { $settings += 'AUDIT_SIGNING_KEY=' + (-join ((RandomBytes 32) | ForEach-Object { $_.ToString('x2') })) }
  if ($names -notcontains 'DEMO_PASSWORD') {
    $chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'
    $newPassword = 'Tf-' + (-join ((RandomBytes 12) | ForEach-Object { $chars[$_ % $chars.Length] })) + '-26'
    $settings += "DEMO_PASSWORD=$newPassword"
  }
  az webapp config appsettings set -g $appRg -n $AppName --settings $settings --only-show-errors 1>$null; Check 'appsettings set'
  az webapp config set -g $appRg -n $AppName --startup-file 'node services/api/dist/server.js' --only-show-errors 1>$null; Check 'startup command'
  az webapp update -g $appRg -n $AppName --https-only true --only-show-errors 1>$null; Check 'https only'

  # ---------------------------------------------------------------- 4. upload
  Step "Uploading the package ($([math]::Round((Get-Item -LiteralPath $zip).Length / 1MB)) MB, a few minutes)"
  $tries = 0
  while ($true) {
    $tries++
    az webapp deploy -g $appRg -n $AppName --src-path $zip --type zip --timeout 1800000 --only-show-errors 1>$null
    if ($LASTEXITCODE -eq 0) { break }
    if ($tries -ge 3) { throw 'FAILED: az webapp deploy (3 attempts). A brand-new app may need a few minutes before its deployment (SCM) host resolves; run the script again.' }
    Write-Host "Upload attempt $tries failed (often DNS of a new app's SCM host still propagating). Retrying in 60 s..." -ForegroundColor Yellow
    Start-Sleep -Seconds 60
  }
}

# ---------------------------------------------------------------- 5. checks
$url = if ($BaseUrl) { $BaseUrl.TrimEnd('/') } else { "https://$AppName.azurewebsites.net" }
Step "Waiting for $version ($($release.commit)) to answer (a cold start on the free plan can take up to 2 minutes)"
$live = $null
for ($i = 0; $i -lt 36; $i++) {
  try { $live = Invoke-RestMethod -TimeoutSec 30 "$url/api/v1/version"; if ($live.version -eq $version -and $live.commit -eq $release.commit) { break } } catch { }
  Start-Sleep -Seconds 10
}

$results = New-Object System.Collections.Generic.List[object]
function Result([string]$name, [bool]$ok, [string]$detail) { $results.Add([pscustomobject]@{ Check = $name; Result = $(if ($ok) { 'PASS' } else { 'FAIL' }); Detail = $detail }) }
function Status([string]$method, [string]$path, $headers = @{}) {
  try { return [int](Invoke-WebRequest -UseBasicParsing -TimeoutSec 60 -Method $method -Uri "$url$path" -Headers $headers -ContentType 'application/json' -Body $(if ($method -eq 'POST') { '{}' } else { $null })).StatusCode }
  catch { if ($_.Exception.Response) { return [int]$_.Exception.Response.StatusCode } else { return -1 } }
}

Result 'Version' ($live -and $live.version -eq $version -and $live.commit -eq $release.commit) "live: $(if ($live) { "$($live.version) ($($live.commit))" } else { 'no answer' }), expected: $version ($($release.commit))"
try {
  $dep = Invoke-RestMethod -TimeoutSec 60 "$url/api/v1/public/deployment"
  Result 'Dedicated entity' ($dep.mode -eq 'dedicated' -and $dep.entity.id -eq $Entity) "mode $($dep.mode), entity $($dep.entity.id)"
} catch { Result 'Dedicated entity' $false $_.Exception.Message }
foreach ($p in @('/', '/login')) { $s = Status 'GET' $p; Result "Page $p" ($s -eq 200) "HTTP $s" }
$token = $null
try {
  # The password is read into memory only; it is never printed or written to disk.
  $pw = az webapp config appsettings list -g $appRg -n $AppName --query "[?name=='DEMO_PASSWORD'].value | [0]" -o tsv
  $body = @{ username = 'officer'; password = $pw } | ConvertTo-Json
  $res = Invoke-RestMethod -TimeoutSec 60 -Method Post -Uri "$url/api/v1/auth/login" -Body $body -ContentType 'application/json'
  $pw = $null; $body = $null
  $token = $res.token
  Result 'Sign-in (officer)' ($res.user.username -eq 'officer' -and [bool]$token) "user $($res.user.username), token $(if ($token) { 'issued' } else { 'missing' })"
} catch { $pw = $null; $body = $null; Result 'Sign-in (officer)' $false $_.Exception.Message }
if ($token) {
  $auth = @{ Authorization = "Bearer $token" }
  $s = Status 'POST' '/api/v1/demo/persona' $auth
  Result 'Presenter mode off' ($s -in 401, 403, 404) "POST /demo/persona -> HTTP $s"
  try { $st = Invoke-RestMethod -TimeoutSec 60 -Uri "$url/api/v1/demo/status" -Headers $auth; Result 'Demo status' ($st.enabled -eq $false) "enabled: $($st.enabled)" }
  catch { Result 'Demo status' $false $_.Exception.Message }
  $s = Status 'GET' '/api/v1/tenders' $auth
  Result 'Tenders API' ($s -eq 200) "GET /tenders -> HTTP $s"
}

Write-Host ''
foreach ($r in $results) {
  Write-Host ('{0,-20} {1,-5} {2}' -f $r.Check, $r.Result, $r.Detail) -ForegroundColor $(if ($r.Result -eq 'PASS') { 'Green' } else { 'Red' })
}
$failed = @($results | Where-Object { $_.Result -eq 'FAIL' }).Count
$report = [pscustomobject]@{ app = $AppName; url = $url; resourceGroup = $appRg; version = $version; commit = $release.commit; checkedAt = (Get-Date).ToString('o'); checks = $results }
$reportFile = Join-Path $here ("deploy-report-{0}.json" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
$report | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $reportFile -Encoding utf8
Write-Host "Report (no secrets): $reportFile"
Write-Host 'Demo accounts (fictitious): admin, officer, tenderdept, grader, director, undersecretary, auditor, vendor1..vendor5'
if ($newPassword) { Write-Host "Demo password (shown once; share it by Teams, not by email): $newPassword" -ForegroundColor Yellow }
else { Write-Host 'Demo password: unchanged (Azure portal > the app > Settings > Environment variables > DEMO_PASSWORD).' }
if ($failed -gt 0) {
  Write-Host "$failed check(s) FAILED. Log: az webapp log tail -g $appRg -n $AppName" -ForegroundColor Red
  exit 2
}
Write-Host "TenderFlow $version is live and verified: $url" -ForegroundColor Green
