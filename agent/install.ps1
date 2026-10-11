<#
  Install the SnippyCode agent on Windows as a scheduled task running as SYSTEM.
  Run in an elevated PowerShell:

    & ([scriptblock]::Create((irm https://snippycode.example/agent/install.ps1))) `
      -Url https://snippycode.example -Token sc_enroll_...

  Options: -Name NAME  -AllowHttp  -Uninstall
  Update an installed agent in place (keeps its enrollment):
    & ([scriptblock]::Create((irm https://snippycode.example/agent/install.ps1))) -Upgrade
#>
param(
  [string]$Url,
  [string]$Token,
  [string]$Name = $env:COMPUTERNAME,
  [switch]$AllowHttp,
  [switch]$Uninstall,
  [switch]$Upgrade
)

$ErrorActionPreference = 'Stop'
$AgentVersion = '1.3.0'
$TaskName = 'SnippyCode Agent'
$Root = Join-Path $env:ProgramData 'SnippyCode'
$Agent = Join-Path $Root 'snippycode-agent.ps1'

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run this in an elevated (Administrator) PowerShell.'
}

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Remove-Item $Root -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host 'SnippyCode agent removed. Revoke the device in SnippyCode too.'
  return
}

if ($Upgrade) {
  $existing = Get-Content (Join-Path $Root 'agent.json') -Raw | ConvertFrom-Json
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Invoke-WebRequest -UseBasicParsing -Uri "$($existing.Url)/agent/snippycode-agent.ps1" -OutFile $Agent
  Start-ScheduledTask -TaskName $TaskName
  Write-Host 'Agent updated. The device keeps its enrollment.'
  return
}

if (-not $Url -or -not $Token) { throw 'Usage: install.ps1 -Url https://snippycode.example -Token sc_enroll_...' }
$Url = $Url.TrimEnd('/')

if ($Url -notmatch '^https://' -and $Url -notmatch '^http://(localhost|127\.)' -and -not $AllowHttp) {
  throw 'Jobs can contain secrets, so the agent only talks HTTPS. Use -AllowHttp to override.'
}

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
New-Item -ItemType Directory -Force -Path $Root | Out-Null

Write-Host "Downloading the agent from $Url"
Invoke-WebRequest -UseBasicParsing -Uri "$Url/agent/snippycode-agent.ps1" -OutFile $Agent

Write-Host "Enrolling $env:COMPUTERNAME"
$arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
$enrolled = Invoke-RestMethod -Method Post -Uri "$Url/api/agent/enroll" -Body @{
  token    = $Token
  hostname = $env:COMPUTERNAME
  name     = $Name
  os       = 'windows'
  arch     = $arch
  version  = $AgentVersion
}

@{ Url = $Url; DeviceToken = $enrolled.data.token; AllowHttp = [bool]$AllowHttp } |
  ConvertTo-Json | Set-Content -Path (Join-Path $Root 'agent.json') -Encoding UTF8

# Only SYSTEM and Administrators can read the device token
& icacls.exe $Root /inheritance:r /grant:r 'SYSTEM:(OI)(CI)F' 'Administrators:(OI)(CI)F' | Out-Null

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$Agent`""
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
  -User 'SYSTEM' -RunLevel Highest -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName

Write-Host "Installed. This device is enrolled at site '$($enrolled.data.site)' and the agent is running."
Write-Host "Log: $Root\agent.log"
