<#
  Install the SnippyCode agent on Windows as a scheduled task running as SYSTEM.
  Run in an elevated PowerShell:

    & ([scriptblock]::Create((irm https://snippycode.example/agent/install.ps1))) `
      -Url https://snippycode.example -Token sc_enroll_...

  The token can be single-use or a reusable bulk enrolment token: run the
  same command on many machines and each gets its own device. Running it
  again on a machine reuses that machine's device (matched by MachineGuid).

  Options: -Name NAME  -AllowHttp  -Uninstall
    -ResetId  delete and regenerate this machine's agent ID (e.g. after
              cloning a disk image), so it enrols as a new device
  Update an installed agent in place (keeps its enrollment):
    & ([scriptblock]::Create((irm https://snippycode.example/agent/install.ps1))) -Upgrade
#>
param(
  [string]$Url,
  [string]$Token,
  [string]$Name = $env:COMPUTERNAME,
  [switch]$AllowHttp,
  [switch]$Uninstall,
  [switch]$Upgrade,
  [switch]$ResetId
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

# Stable per-machine ID, so re-running reuses this machine's device
$machineId = ''
try { $machineId = (Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Cryptography' -Name MachineGuid -ErrorAction Stop).MachineGuid } catch { }


# Stable random agent ID, created once, readable only by SYSTEM and admins
function Get-AgentId([string]$Dir) {
  $file = Join-Path $Dir 'agent-id'
  $id = ''
  if (Test-Path $file) { $id = ((Get-Content $file -Raw) -replace '[^a-fA-F0-9-]', '').ToLower() }
  if ($id.Length -ne 36) {
    $id = [guid]::NewGuid().ToString()
    New-Item -ItemType Directory -Force -Path $Dir | Out-Null
    Set-Content -Path $file -Value $id -Encoding ascii
    try { & icacls.exe $file /inheritance:r /grant:r 'SYSTEM:F' 'Administrators:F' | Out-Null } catch { }
  }
  return $id
}

function Set-AgentId([string]$Dir, [string]$Id) {
  $file = Join-Path $Dir 'agent-id'
  Set-Content -Path $file -Value $Id -Encoding ascii
  try { & icacls.exe $file /inheritance:r /grant:r 'SYSTEM:F' 'Administrators:F' | Out-Null } catch { }
}

# Hardware fingerprint: sha256 of MachineGuid, sorted physical MACs and the
# BIOS serial where available. Only the hash ever leaves this machine.
function Get-HardwareFingerprint {
  $guid = ''
  try { $guid = (Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Cryptography' -Name MachineGuid -ErrorAction Stop).MachineGuid } catch { }
  $macs = ''
  try {
    $macs = (@(Get-CimInstance Win32_NetworkAdapter -Filter 'PhysicalAdapter=True' -ErrorAction Stop |
      Where-Object { $_.MACAddress } | ForEach-Object { $_.MACAddress.ToLower().Replace('-', ':') }) |
      Sort-Object -Unique) -join ','
  } catch { }
  $serial = ''
  try { $serial = [string](Get-CimInstance Win32_BIOS -ErrorAction Stop).SerialNumber } catch { }
  $bytes = [Text.Encoding]::UTF8.GetBytes("$guid|$macs,|$($serial.Trim())")
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return (($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') }) -join '') } finally { $sha.Dispose() }
}
if ($ResetId) {
  Write-Host 'Resetting the agent ID'
  Remove-Item (Join-Path $Root 'agent-id') -Force -ErrorAction SilentlyContinue
}
$agentId = Get-AgentId $Root
$fingerprint = Get-HardwareFingerprint

Write-Host "Enrolling $env:COMPUTERNAME"
$arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
$enrolled = Invoke-RestMethod -Method Post -Uri "$Url/api/agent/enroll" -Headers @{ 'X-Agent-Fingerprint' = $fingerprint } -Body @{
  token    = $Token
  hostname = $env:COMPUTERNAME
  machineId = $machineId
  agentId  = $agentId
  name     = $Name
  os       = 'windows'
  arch     = $arch
  version  = $AgentVersion
}

# A clone gets a fresh agent ID from the server: keep it from now on
if ($enrolled.data.agentId -and $enrolled.data.agentId -ne $agentId) {
  Write-Host 'This machine looks like a clone; it was given its own agent ID.'
  Set-AgentId $Root ([string]$enrolled.data.agentId)
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
