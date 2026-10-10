# TenderFlow - import the eleven watsonx Orchestrate agents into an Orchestrate (IBM Cloud) instance:
# the nine specialist (collaborator) agents and the admin builder first, then the supervisor tenderflow_assistant, whose
# `collaborators:` list refers to them by name.
#
# Usage (from the repo root, in Windows PowerShell 5.1+ or PowerShell 7):
#   powershell -ExecutionPolicy Bypass -File agents\import.ps1
#
# Reads WXO_INSTANCE_URL and WXO_API_KEY from the repo .env (process environment wins).
# Optional: WXO_LLM (model id from `orchestrate models list`) overrides the llm in all eleven YAML files;
#           WXO_ENV_NAME (default "techzone"); WXO_AUTH_TYPE (default "ibm_iam" for IBM Cloud instances).
# Stops on the first failing step. The API key is never printed.

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$AgentsDir = $PSScriptRoot
$RepoRoot = Split-Path -Parent $AgentsDir
$EnvFile = Join-Path $RepoRoot '.env'
# Order matters: collaborators first, supervisor (tenderflow_assistant) last.
$AgentNames = @('tenderflow_pack_checker', 'tenderflow_clarification_assistant', 'tenderflow_compliance_screener', 'tenderflow_request_classifier', 'tenderflow_notice_drafter', 'tenderflow_relevance_matcher', 'tenderflow_evaluation_narrator', 'tenderflow_grade_reviewer', 'tenderflow_document_intelligence', 'tenderflow_admin_builder', 'tenderflow_assistant')
$AgentFiles = @($AgentNames | ForEach-Object { "$_.yaml" })

# ---- load .env (KEY=VALUE, comments, optional quotes) -----------------------------------------------
$DotEnv = @{}
if (Test-Path -LiteralPath $EnvFile) {
    foreach ($raw in [System.IO.File]::ReadAllLines($EnvFile, [System.Text.Encoding]::UTF8)) {
        $line = $raw.Trim()
        if ($line -eq '' -or $line.StartsWith('#')) { continue }
        if ($line -match '^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
            $key = $Matches[1]
            $val = $Matches[2].Trim()
            if ($val.Length -ge 2 -and (($val.StartsWith('"') -and $val.EndsWith('"')) -or ($val.StartsWith("'") -and $val.EndsWith("'")))) {
                $val = $val.Substring(1, $val.Length - 2)
            } else {
                $val = ($val -replace '\s+#.*$', '').Trim()
            }
            $DotEnv[$key] = $val
        }
    }
    Write-Host "Loaded settings from $EnvFile"
} else {
    Write-Host "No .env at $EnvFile - using process environment only"
}

function Get-Setting([string]$Name, [string]$Default = '') {
    $p = [Environment]::GetEnvironmentVariable($Name)
    if ($p) { return $p.Trim() }
    if ($DotEnv.ContainsKey($Name) -and $DotEnv[$Name]) { return $DotEnv[$Name] }
    return $Default
}

function Invoke-Step([string]$What, [scriptblock]$Command) {
    Write-Host ""
    Write-Host "==> $What"
    & $Command
    if ($LASTEXITCODE -ne 0) { throw "FAILED: $What (exit code $LASTEXITCODE)" }
}

$Url = (Get-Setting 'WXO_INSTANCE_URL').TrimEnd('/')
$ApiKey = Get-Setting 'WXO_API_KEY'
$EnvName = Get-Setting 'WXO_ENV_NAME' 'techzone'
$AuthType = Get-Setting 'WXO_AUTH_TYPE' 'ibm_iam'
$Llm = Get-Setting 'WXO_LLM'

if (-not $Url) { throw "WXO_INSTANCE_URL is not set (add it to $EnvFile)" }
if (-not $ApiKey) { throw "WXO_API_KEY is not set (add it to $EnvFile)" }
if (-not (Get-Command orchestrate -ErrorAction SilentlyContinue)) {
    # pip may have installed the CLI into a Python 'Scripts' folder that is not on PATH; look for it.
    foreach ($py in @('py', 'python', 'python3')) {
        if (Get-Command $py -ErrorAction SilentlyContinue) {
            $scripts = & $py -c "import sysconfig; print(sysconfig.get_path('scripts'))" 2>$null
            if ($scripts -and (Test-Path (Join-Path $scripts 'orchestrate.exe'))) { $env:Path = "$scripts;$env:Path"; Write-Host "Using orchestrate CLI from $scripts"; break }
            $userScripts = & $py -c "import sysconfig,os; print(sysconfig.get_path('scripts', os.name + '_user'))" 2>$null
            if ($userScripts -and (Test-Path (Join-Path $userScripts 'orchestrate.exe'))) { $env:Path = "$userScripts;$env:Path"; Write-Host "Using orchestrate CLI from $userScripts"; break }
        }
    }
}
if (-not (Get-Command orchestrate -ErrorAction SilentlyContinue)) {
    throw "The 'orchestrate' CLI was not found. Install it with: pip install --upgrade ibm-watsonx-orchestrate (Python 3.11+), then reopen PowerShell."
}
if ($AuthType -eq 'ibm_iam' -and $Url -notmatch '\.cloud\.ibm\.com') {
    Write-Warning "WXO_INSTANCE_URL does not look like an IBM Cloud instance (*.cloud.ibm.com). For AWS-hosted instances set WXO_AUTH_TYPE=mcsp."
}

Write-Host "Instance:    $Url"
Write-Host "API key:     set (hidden)"
Write-Host "Environment: $EnvName ($AuthType)"

# 'env add' asks "update existing environment? (Y/n)" when the name exists; answer y so re-runs are idempotent.
Invoke-Step "orchestrate env add -n $EnvName -u <instance> --type $AuthType" {
    'y' | orchestrate env add -n $EnvName -u $Url --type $AuthType
}
Invoke-Step "orchestrate env activate $EnvName --api-key <hidden>" {
    orchestrate env activate $EnvName --api-key $ApiKey
}

# Optional model override → patched copies in a temp folder (the repo YAML files are not modified).
$ImportDir = $AgentsDir
if ($Llm) {
    $ImportDir = Join-Path ([System.IO.Path]::GetTempPath()) ("tenderflow-agents-" + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $ImportDir | Out-Null
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    foreach ($f in $AgentFiles) {
        $text = [System.IO.File]::ReadAllText((Join-Path $AgentsDir $f), [System.Text.Encoding]::UTF8)
        $patched = [regex]::Replace($text, '(?m)^llm:.*$', "llm: $Llm")
        [System.IO.File]::WriteAllText((Join-Path $ImportDir $f), $patched, $utf8NoBom)
    }
    Write-Host "Using model override WXO_LLM=$Llm"
}

foreach ($f in $AgentFiles) {
    $path = Join-Path $ImportDir $f
    Invoke-Step "orchestrate agents import -f $f" { orchestrate agents import -f $path }
}

Invoke-Step "orchestrate agents list" { orchestrate agents list }

# Verify all eleven agents are really there (some CLI paths log an error without a non-zero exit).
$listing = (orchestrate agents list -v | Out-String)
if ($LASTEXITCODE -ne 0) { throw "FAILED: orchestrate agents list -v (exit code $LASTEXITCODE)" }
$missing = @($AgentNames | Where-Object { $listing -notmatch [regex]::Escape($_) })
if ($missing.Count -gt 0) { throw "FAILED: agents not found after import: $($missing -join ', ')" }

Write-Host ""
Write-Host "OK: imported $($AgentNames.Count) agents: $($AgentNames -join ', ')"
Write-Host "Next: npm run build ; npm run verify:ai"
