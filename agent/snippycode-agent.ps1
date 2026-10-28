<#
  SnippyCode agent for Windows.

  Polls SnippyCode for jobs queued for this device, runs them here, and sends
  back the output. Installed and started by install.ps1 as a scheduled task
  running as SYSTEM; settings live in C:\ProgramData\SnippyCode\agent.json.
#>
$ErrorActionPreference = 'Stop'
$AgentVersion = '1.5.0'
# Ed25519 public keys (base64 DER, space-separated), filled in when a release
# is signed. Kept for parity with the Linux agent; see Update-Agent.
$AgentUpdatePublicKeys = ''
$Root = Join-Path $env:ProgramData 'SnippyCode'
$Work = Join-Path $Root 'work'
$MaxOutputChars = 1000000

function Write-Log([string]$Message) {
  $line = "{0} {1}" -f (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'), $Message
  Add-Content -Path (Join-Path $Root 'agent.log') -Value $line
}

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$config = Get-Content (Join-Path $Root 'agent.json') -Raw | ConvertFrom-Json
$Url = $config.Url.TrimEnd('/')
$Headers = @{ Authorization = "Bearer $($config.DeviceToken)" }

if ($Url -notmatch '^https://' -and $Url -notmatch '^http://(localhost|127\.)' -and -not $config.AllowHttp) {
  Write-Log "Refusing to fetch jobs over plain HTTP from $Url. Use HTTPS or set AllowHttp."
  exit 1
}

New-Item -ItemType Directory -Force -Path $Work | Out-Null

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
$AgentId = Get-AgentId $Root

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
$Fingerprint = Get-HardwareFingerprint
$Headers['X-Agent-Fingerprint'] = $Fingerprint

# Health check used after an update: exit 0 when the server accepts our token on this hardware (the fingerprint header is checked)
if ($args -contains '-SelfTest') {
  try {
    Invoke-WebRequest -UseBasicParsing -Uri "$Url/api/agent/ping" -Headers $Headers -TimeoutSec 20 | Out-Null
    exit 0
  } catch { exit 1 }
}

# The server refused this token on this hardware (a cloned disk or VM).
# Swap it for a new device at the same site via clone self-enrol: no
# enrolment token is kept on disk. The original device is never touched.
function Invoke-Reenrol {
  try {
    $enrolled = Invoke-RestMethod -Method Post -Uri "$Url/api/agent/clone-enroll" -TimeoutSec 30 -Headers $script:Headers -Body @{
      agentId = $script:AgentId; hostname = $env:COMPUTERNAME; version = $AgentVersion
    }
  } catch {
    Write-Log "Clone enrolment was refused ($($_.Exception.Message)). Rerun install.ps1 -ResetId with an enrolment token."
    return $false
  }
  if ($enrolled.data.agentId) {
    $script:AgentId = [string]$enrolled.data.agentId
    Set-AgentId $Root $script:AgentId
  }
  $config.DeviceToken = $enrolled.data.token
  $config | ConvertTo-Json | Set-Content -Path (Join-Path $Root 'agent.json') -Encoding UTF8
  $script:Headers = @{ Authorization = "Bearer $($enrolled.data.token)"; 'X-Agent-Fingerprint' = $Fingerprint }
  Write-Log 'Enrolled this clone as its own device; it stays idle until an admin approves it'
  return $true
}

function Get-Capabilities {
  # pty: interactive terminal (ConPTY helper). One-shot jobs stay -NonInteractive.
  $found = @('powershell', 'cmd', 'pty')
  foreach ($bin in 'pwsh', 'python', 'node', 'bash') {
    if (Get-Command $bin -ErrorAction SilentlyContinue) { $found += $bin }
  }
  return ($found -join ',')
}

function Get-Runner([string]$Language) {
  switch ($Language) {
    'powershell' { return @{ Exe = 'powershell.exe'; Args = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}"'; Ext = 'ps1' } }
    'bat'        { return @{ Exe = 'cmd.exe'; Args = '/d /c "{0}"'; Ext = 'cmd' } }
    'batch'      { return @{ Exe = 'cmd.exe'; Args = '/d /c "{0}"'; Ext = 'cmd' } }
    'python'     { return @{ Exe = 'python'; Args = '"{0}"'; Ext = 'py' } }
    'javascript' { return @{ Exe = 'node'; Args = '"{0}"'; Ext = 'js' } }
    'js'         { return @{ Exe = 'node'; Args = '"{0}"'; Ext = 'js' } }
    { $_ -in 'bash', 'sh', 'shell' } { return @{ Exe = 'bash'; Args = '"{0}"'; Ext = 'sh' } }
    default      { return $null }
  }
}

# What this machine is, for the device card in SnippyCode
function Send-Facts {
  try {
    $os = Get-CimInstance Win32_OperatingSystem
    $cs = Get-CimInstance Win32_ComputerSystem
    $disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$($env:SystemDrive)'"
    $ip = (Get-NetIPConfiguration -ErrorAction SilentlyContinue |
      Where-Object { $_.IPv4DefaultGateway } | Select-Object -First 1).IPv4Address.IPAddress
    $body = @{
      osName         = $os.Caption
      kernel         = $os.Version
      cpus           = $cs.NumberOfLogicalProcessors
      memTotalMb     = [math]::Round($os.TotalVisibleMemorySize / 1024)
      memAvailableMb = [math]::Round($os.FreePhysicalMemory / 1024)
      diskTotalGb    = [math]::Round($disk.Size / 1GB, 1)
      diskUsedGb     = [math]::Round(($disk.Size - $disk.FreeSpace) / 1GB, 1)
      uptimeSeconds  = [int]((Get-Date) - $os.LastBootUpTime).TotalSeconds
      ip             = [string]$ip
      timezone       = (Get-TimeZone).Id
      cpuPercent     = [math]::Round((Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average)
      hostname       = $env:COMPUTERNAME
      version        = $AgentVersion
    }
    Invoke-RestMethod -Method Post -Uri "$Url/api/agent/facts" -Headers $Headers -Body $body -TimeoutSec 20 | Out-Null
  } catch {
    Write-Log "Could not send system facts: $($_.Exception.Message)"
  }
}

# Windows agents do not update themselves. Windows PowerShell/.NET has no
# built-in Ed25519 verifier, and trusting an openssl.exe found on PATH while
# running as SYSTEM would let a local user plant one (binary planting).
# Update Windows agents by re-running install.ps1 (or your RMM / GPO) until a
# native verifier ships. See docs/agent-updates.md.
$script:UpdateNoticeShown = $false
function Update-Agent([string]$Latest) {
  if (-not $script:UpdateNoticeShown) {
    Write-Log "Agent $Latest is available. Windows agents update by re-running install.ps1 (no self-update without a native signature check)."
    $script:UpdateNoticeShown = $true
  }
}

function Limit([string]$Text) {
  if ($null -eq $Text) { return '' }
  if ($Text.Length -gt $MaxOutputChars) { return $Text.Substring(0, $MaxOutputChars) + "`n...[truncated on the device]" }
  return $Text
}

function Invoke-Job($Id, [string]$Language, [int]$TimeoutMs, [string]$Code) {
  $runner = Get-Runner $Language
  $started = Get-Date
  $timedOut = $false
  $exitCode = $null
  $stdout = ''
  $stderr = ''

  if (-not $runner -or -not (Get-Command $runner.Exe -ErrorAction SilentlyContinue)) {
    $exitCode = 127
    $stderr = "This device cannot run $Language."
  } else {
    $file = Join-Path $Work "job-$Id.$($runner.Ext)"
    $out = Join-Path $Work "job-$Id.out"
    $err = Join-Path $Work "job-$Id.err"
    # BOM for PowerShell so non-ASCII survives Windows PowerShell 5.1
    $encoding = New-Object System.Text.UTF8Encoding ($runner.Ext -eq 'ps1')
    [IO.File]::WriteAllText($file, $Code, $encoding)

    $process = Start-Process -FilePath $runner.Exe -ArgumentList ($runner.Args -f $file) `
      -WorkingDirectory $Work -RedirectStandardOutput $out -RedirectStandardError $err `
      -NoNewWindow -PassThru

    if (-not $process.WaitForExit($TimeoutMs)) {
      $timedOut = $true
      & taskkill.exe /T /F /PID $process.Id | Out-Null
      $process.WaitForExit()
    }

    $exitCode = if ($timedOut) { $null } else { $process.ExitCode }
    $stdout = if (Test-Path $out) { Get-Content $out -Raw } else { '' }
    $stderr = if (Test-Path $err) { Get-Content $err -Raw } else { '' }
    if ($timedOut) { $stderr += "`nTimed out after $([math]::Round($TimeoutMs / 1000))s on the device." }
    Remove-Item $file, $out, $err -Force -ErrorAction SilentlyContinue
  }

  $body = @{
    exitCode   = $exitCode
    stdout     = (Limit $stdout)
    stderr     = (Limit $stderr)
    durationMs = [int]((Get-Date) - $started).TotalMilliseconds
    timedOut   = $timedOut
  } | ConvertTo-Json -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($body)

  foreach ($attempt in 1..5) {
    try {
      Invoke-RestMethod -Method Post -Uri "$Url/api/agent/jobs/$Id/result" -Headers $Headers `
        -ContentType 'application/json; charset=utf-8' -Body $bytes -TimeoutSec 60 | Out-Null
      break
    } catch {
      Write-Log "Could not send the result of job $Id (attempt $attempt): $($_.Exception.Message)"
      Start-Sleep -Seconds ($attempt * 5)
    }
  }

  Write-Log "Job $Id ($Language) finished with exit code $exitCode"
}

# Interactive terminal. The ConPTY bridge is a copy of agent/pty_session.ps1
# (base64, regenerate with scripts/embed-pty-helper.js). It runs in its own
# PowerShell process so one-shot jobs keep running while a session is open.
$PtyHelperB64 = @(
  'IyBTTklQUFlDT0RFX1BUWV9IRUxQRVIKPCMKICBDb25QVFkgYnJpZGdlIGZvciBvbmUgU25pcHB5Q29kZSB0ZXJtaW5hbCBzZXNz'
  'aW9uIG9uIFdpbmRvd3MuCgogIFRoZSBhZ2VudCBzdGFydHMgdGhpcyBpbiBpdHMgb3duIFBvd2VyU2hlbGwgcHJvY2VzcyBmb3Ig'
  'bGFuZ3VhZ2UgInB0eSIsIHNvCiAgb25lLXNob3Qgam9icyBrZWVwIHJ1bm5pbmcgd2hpbGUgYSBzZXNzaW9uIGlzIG9wZW4uIEl0'
  'IHBvc3RzIG91dHB1dCBhbmQKICBsb25nLXBvbGxzIGZvciBrZXlzdHJva2VzIG9uIC9hcGkvYWdlbnQvam9icy88aWQ+L3R0eS4K'
  'CiAgV2luZG93cyAxMCAxODA5KyAvIFNlcnZlciAyMDE5KyBnZXQgYSByZWFsIHBzZXVkbyBjb25zb2xlIChmdWxsLXNjcmVlbgog'
  'IHByb2dyYW1zLCBDdHJsK0MsIGNvbnNvbGUtb25seSBwcm9tcHRzKS4gT2xkZXIgYnVpbGRzIGZhbGwgYmFjayB0byByZWRpcmVj'
  'dGVkCiAgcGlwZXMuIFJ1bm5pbmcgYXMgU1lTVEVNLCBpdCBjYW4gb3BlbiB0aGUgc2hlbGwgYXMgYW55IHVzZXIgd2hvIGlzIHNp'
  'Z25lZCBpbgogIChjb25zb2xlIG9yIFJEUCkgdXNpbmcgdGhhdCBzZXNzaW9uJ3MgdG9rZW4sIHNvIG5vIHBhc3N3b3JkIGlzIG5l'
  'ZWRlZC4KIz4KcGFyYW0oW1BhcmFtZXRlcihNYW5kYXRvcnkgPSAkdHJ1ZSldW2ludF0kSm9iSWQsIFtQYXJhbWV0ZXIoTWFuZGF0'
  'b3J5ID0gJHRydWUpXVtzdHJpbmddJFNwZWNQYXRoKQokRXJyb3JBY3Rpb25QcmVmZXJlbmNlID0gJ1N0b3AnCgokVXJsID0gJGVu'
  'djpTTklQUFlDT0RFX1VSTC5UcmltRW5kKCcvJykKJEhlYWRlcnMgPSBAeyBBdXRob3JpemF0aW9uID0gIkJlYXJlciAkKCRlbnY6'
  'U05JUFBZQ09ERV9UT0tFTikiIH0KaWYgKCRlbnY6U05JUFBZQ09ERV9GSU5HRVJQUklOVCkgeyAkSGVhZGVyc1snWC1BZ2VudC1G'
  'aW5nZXJwcmludCddID0gJGVudjpTTklQUFlDT0RFX0ZJTkdFUlBSSU5UIH0KCkFkZC1UeXBlIC1UeXBlRGVmaW5pdGlvbiBAJwp1'
  'c2luZyBTeXN0ZW07CnVzaW5nIFN5c3RlbS5Db2xsZWN0aW9ucy5HZW5lcmljOwp1c2luZyBTeXN0ZW0uQ29tcG9uZW50TW9kZWw7'
  'CnVzaW5nIFN5c3RlbS5JTzsKdXNpbmcgU3lzdGVtLlJ1bnRpbWUuSW50ZXJvcFNlcnZpY2VzOwp1c2luZyBTeXN0ZW0uVGV4dDsK'
  'dXNpbmcgTWljcm9zb2Z0LldpbjMyLlNhZmVIYW5kbGVzOwoKcHVibGljIHNlYWxlZCBjbGFzcyBTbmlwcHlQdHkgOiBJRGlzcG9z'
  'YWJsZSB7CiAgW1N0cnVjdExheW91dChMYXlvdXRLaW5kLlNlcXVlbnRpYWwpXSBzdHJ1Y3QgQ09PUkQgeyBwdWJsaWMgc2hvcnQg'
  'WDsgcHVibGljIHNob3J0IFk7IH0KICBbU3RydWN0TGF5b3V0KExheW91dEtpbmQuU2VxdWVudGlhbCwgQ2hhclNldCA9IENoYXJT'
  'ZXQuVW5pY29kZSldCiAgc3RydWN0IFNUQVJUVVBJTkZPIHsKICAgIHB1YmxpYyBpbnQgY2I7IHB1YmxpYyBzdHJpbmcgbHBSZXNl'
  'cnZlZDsgcHVibGljIHN0cmluZyBscERlc2t0b3A7IHB1YmxpYyBzdHJpbmcgbHBUaXRsZTsKICAgIHB1YmxpYyBpbnQgZHdYOyBw'
  'dWJsaWMgaW50IGR3WTsgcHVibGljIGludCBkd1hTaXplOyBwdWJsaWMgaW50IGR3WVNpemU7IHB1YmxpYyBpbnQgZHdYQ291bnRD'
  'aGFyczsKICAgIHB1YmxpYyBpbnQgZHdZQ291bnRDaGFyczsgcHVibGljIGludCBkd0ZpbGxBdHRyaWJ1dGU7IHB1YmxpYyBpbnQg'
  'ZHdGbGFnczsgcHVibGljIHNob3J0IHdTaG93V2luZG93OwogICAgcHVibGljIHNob3J0IGNiUmVzZXJ2ZWQyOyBwdWJsaWMgSW50'
  'UHRyIGxwUmVzZXJ2ZWQyOyBwdWJsaWMgSW50UHRyIGhTdGRJbnB1dDsgcHVibGljIEludFB0ciBoU3RkT3V0cHV0OyBwdWJsaWMg'
  'SW50UHRyIGhTdGRFcnJvcjsKICB9CiAgW1N0cnVjdExheW91dChMYXlvdXRLaW5kLlNlcXVlbnRpYWwpXSBzdHJ1Y3QgU1RBUlRV'
  'UElORk9FWCB7IHB1YmxpYyBTVEFSVFVQSU5GTyBTdGFydHVwSW5mbzsgcHVibGljIEludFB0ciBscEF0dHJpYnV0ZUxpc3Q7IH0K'
  'ICBbU3RydWN0TGF5b3V0KExheW91dEtpbmQuU2VxdWVudGlhbCldIHN0cnVjdCBQUk9DRVNTX0lORk9STUFUSU9OIHsgcHVibGlj'
  'IEludFB0ciBoUHJvY2VzczsgcHVibGljIEludFB0ciBoVGhyZWFkOyBwdWJsaWMgaW50IGR3UHJvY2Vzc0lkOyBwdWJsaWMgaW50'
  'IGR3VGhyZWFkSWQ7IH0KICBbU3RydWN0TGF5b3V0KExheW91dEtpbmQuU2VxdWVudGlhbCldIHN0cnVjdCBTRUNVUklUWV9BVFRS'
  'SUJVVEVTIHsgcHVibGljIGludCBuTGVuZ3RoOyBwdWJsaWMgSW50UHRyIGxwU2VjdXJpdHlEZXNjcmlwdG9yOyBwdWJsaWMgaW50'
  'IGJJbmhlcml0SGFuZGxlOyB9CiAgW1N0cnVjdExheW91dChMYXlvdXRLaW5kLlNlcXVlbnRpYWwpXSBzdHJ1Y3QgV1RTX1NFU1NJ'
  'T05fSU5GTyB7IHB1YmxpYyBpbnQgU2Vzc2lvbklkOyBwdWJsaWMgSW50UHRyIHBXaW5TdGF0aW9uTmFtZTsgcHVibGljIGludCBT'
  'dGF0ZTsgfQoKICBjb25zdCB1aW50IEVYVEVOREVEX1NUQVJUVVBJTkZPX1BSRVNFTlQgPSAweDAwMDgwMDAwLCBDUkVBVEVfVU5J'
  'Q09ERV9FTlZJUk9OTUVOVCA9IDB4MDAwMDA0MDAsIENSRUFURV9OT19XSU5ET1cgPSAweDA4MDAwMDAwOwogIGNvbnN0IHVpbnQg'
  'Q1JFQVRFX05FV19QUk9DRVNTX0dST1VQID0gMHgwMDAwMDIwMDsKICBzdGF0aWMgcmVhZG9ubHkgSW50UHRyIFBST0NfVEhSRUFE'
  'X0FUVFJJQlVURV9QU0VVRE9DT05TT0xFID0gKEludFB0cikweDAwMDIwMDE2OwogIGNvbnN0IGludCBTVEFSVEZfVVNFU1RESEFO'
  'RExFUyA9IDB4MTAwOwoKICBbRGxsSW1wb3J0KCJrZXJuZWwzMi5kbGwiLCBTZXRMYXN0RXJyb3IgPSB0cnVlKV0gc3RhdGljIGV4'
  'dGVybiBpbnQgQ3JlYXRlUHNldWRvQ29uc29sZShDT09SRCBzaXplLCBTYWZlRmlsZUhhbmRsZSBoSW5wdXQsIFNhZmVGaWxlSGFu'
  'ZGxlIGhPdXRwdXQsIHVpbnQgZmxhZ3MsIG91dCBJbnRQdHIgcGhQQyk7CiAgW0RsbEltcG9ydCgia2VybmVsMzIuZGxsIiwgU2V0'
  'TGFzdEVycm9yID0gdHJ1ZSldIHN0YXRpYyBleHRlcm4gaW50IFJlc2l6ZVBzZXVkb0NvbnNvbGUoSW50UHRyIGhQQywgQ09PUkQg'
  'c2l6ZSk7CiAgW0RsbEltcG9ydCgia2VybmVsMzIuZGxsIiwgU2V0TGFzdEVycm9yID0gdHJ1ZSldIHN0YXRpYyBleHRlcm4gdm9p'
  'ZCBDbG9zZVBzZXVkb0NvbnNvbGUoSW50UHRyIGhQQyk7CiAgW0RsbEltcG9ydCgia2VybmVsMzIuZGxsIiwgU2V0TGFzdEVycm9y'
  'ID0gdHJ1ZSldIHN0YXRpYyBleHRlcm4gYm9vbCBDcmVhdGVQaXBlKG91dCBTYWZlRmlsZUhhbmRsZSByLCBvdXQgU2FmZUZpbGVI'
  'YW5kbGUgdywgcmVmIFNFQ1VSSVRZX0FUVFJJQlVURVMgc2EsIGludCBzaXplKTsKICBbRGxsSW1wb3J0KCJrZXJuZWwzMi5kbGwi'
  'LCBTZXRMYXN0RXJyb3IgPSB0cnVlKV0gc3RhdGljIGV4dGVybiBib29sIFNldEhhbmRsZUluZm9ybWF0aW9uKFNhZmVGaWxlSGFu'
  'ZGxlIGgsIGludCBtYXNrLCBpbnQgZmxhZ3MpOwogIFtEbGxJbXBvcnQoImtlcm5lbDMyLmRsbCIsIFNldExhc3RFcnJvciA9IHRy'
  'dWUpXSBzdGF0aWMgZXh0ZXJuIGJvb2wgSW5pdGlhbGl6ZVByb2NUaHJlYWRBdHRyaWJ1dGVMaXN0KEludFB0ciBsaXN0LCBpbnQg'
  'Y291bnQsIGludCBmbGFncywgcmVmIEludFB0ciBzaXplKTsKICBbRGxsSW1wb3J0KCJrZXJuZWwzMi5kbGwiLCBTZXRMYXN0RXJy'
  'b3IgPSB0cnVlKV0gc3RhdGljIGV4dGVybiBib29sIFVwZGF0ZVByb2NUaHJlYWRBdHRyaWJ1dGUoSW50UHRyIGxpc3QsIHVpbnQg'
  'ZmxhZ3MsIEludFB0ciBhdHRyLCBJbnRQdHIgdmFsdWUsIEludFB0ciBzaXplLCBJbnRQdHIgcHJldiwgSW50UHRyIHJldFNpemUp'
  'OwogIFtEbGxJbXBvcnQoImtlcm5lbDMyLmRsbCIsIFNldExhc3RFcnJvciA9IHRydWUpXSBzdGF0aWMgZXh0ZXJuIHZvaWQgRGVs'
  'ZXRlUHJvY1RocmVhZEF0dHJpYnV0ZUxpc3QoSW50UHRyIGxpc3QpOwogIFtEbGxJbXBvcnQoImtlcm5lbDMyLmRsbCIsIFNldExh'
  'c3RFcnJvciA9IHRydWUsIENoYXJTZXQgPSBDaGFyU2V0LlVuaWNvZGUpXSBzdGF0aWMgZXh0ZXJuIGJvb2wgQ3JlYXRlUHJvY2Vz'
  'c1coc3RyaW5nIGFwcCwgU3RyaW5nQnVpbGRlciBjbWQsIEludFB0ciBwYSwgSW50UHRyIHRhLCBib29sIGluaGVyaXQsIHVpbnQg'
  'ZmxhZ3MsIEludFB0ciBlbnYsIHN0cmluZyBjd2QsIHJlZiBTVEFSVFVQSU5GT0VYIHNpLCBvdXQgUFJPQ0VTU19JTkZPUk1BVElP'
  'TiBwaSk7CiAgW0RsbEltcG9ydCgiYWR2YXBpMzIuZGxsIiwgU2V0TGFzdEVycm9yID0gdHJ1ZSwgQ2hhclNldCA9IENoYXJTZXQu'
  'VW5pY29kZSldIHN0YXRpYyBleHRlcm4gYm9vbCBDcmVhdGVQcm9jZXNzQXNVc2VyVyhJbnRQdHIgdG9rZW4sIHN0cmluZyBhcHAs'
  'IFN0cmluZ0J1aWxkZXIgY21kLCBJbnRQdHIgcGEsIEludFB0ciB0YSwgYm9vbCBpbmhlcml0LCB1aW50IGZsYWdzLCBJbnRQdHIg'
  'ZW52LCBzdHJpbmcgY3dkLCByZWYgU1RBUlRVUElORk9FWCBzaSwgb3V0IFBST0NFU1NfSU5GT1JNQVRJT04gcGkpOwogIFtEbGxJ'
  'bXBvcnQoImtlcm5lbDMyLmRsbCIsIFNldExhc3RFcnJvciA9IHRydWUpXSBzdGF0aWMgZXh0ZXJuIGJvb2wgQ2xvc2VIYW5kbGUo'
  'SW50UHRyIGgpOwogIFtEbGxJbXBvcnQoImtlcm5lbDMyLmRsbCIsIFNldExhc3RFcnJvciA9IHRydWUpXSBzdGF0aWMgZXh0ZXJu'
  'IHVpbnQgV2FpdEZvclNpbmdsZU9iamVjdChJbnRQdHIgaCwgdWludCBtcyk7CiAgW0RsbEltcG9ydCgia2VybmVsMzIuZGxsIiwg'
  'U2V0TGFzdEVycm9yID0gdHJ1ZSldIHN0YXRpYyBleHRlcm4gYm9vbCBHZXRFeGl0Q29kZVByb2Nlc3MoSW50UHRyIGgsIG91dCB1'
  'aW50IGNvZGUpOwogIFtEbGxJbXBvcnQoImtlcm5lbDMyLmRsbCIsIFNldExhc3RFcnJvciA9IHRydWUpXSBzdGF0aWMgZXh0ZXJu'
  'IGJvb2wgVGVybWluYXRlUHJvY2VzcyhJbnRQdHIgaCwgdWludCBjb2RlKTsKICBbRGxsSW1wb3J0KCJ3dHNhcGkzMi5kbGwiLCBT'
  'ZXRMYXN0RXJyb3IgPSB0cnVlKV0gc3RhdGljIGV4dGVybiBib29sIFdUU0VudW1lcmF0ZVNlc3Npb25zKEludFB0ciBzZXJ2ZXIs'
  'IGludCByZXNlcnZlZCwgaW50IHZlcnNpb24sIG91dCBJbnRQdHIgaW5mbywgb3V0IGludCBjb3VudCk7CiAgW0RsbEltcG9ydCgi'
  'd3RzYXBpMzIuZGxsIiwgU2V0TGFzdEVycm9yID0gdHJ1ZSldIHN0YXRpYyBleHRlcm4gYm9vbCBXVFNRdWVyeVNlc3Npb25JbmZv'
  'cm1hdGlvbihJbnRQdHIgc2VydmVyLCBpbnQgc2Vzc2lvbiwgaW50IGluZm9DbGFzcywgb3V0IEludFB0ciBidWZmZXIsIG91dCBp'
  'bnQgYnl0ZXMpOwogIFtEbGxJbXBvcnQoInd0c2FwaTMyLmRsbCIpXSBzdGF0aWMgZXh0ZXJuIHZvaWQgV1RTRnJlZU1lbW9yeShJ'
  'bnRQdHIgcCk7CiAgW0RsbEltcG9ydCgid3RzYXBpMzIuZGxsIiwgU2V0TGFzdEVycm9yID0gdHJ1ZSldIHN0YXRpYyBleHRlcm4g'
  'Ym9vbCBXVFNRdWVyeVVzZXJUb2tlbihpbnQgc2Vzc2lvbiwgb3V0IEludFB0ciB0b2tlbik7CiAgW0RsbEltcG9ydCgiYWR2YXBp'
  'MzIuZGxsIiwgU2V0TGFzdEVycm9yID0gdHJ1ZSldIHN0YXRpYyBleHRlcm4gYm9vbCBEdXBsaWNhdGVUb2tlbkV4KEludFB0ciB0'
  'b2tlbiwgdWludCBhY2Nlc3MsIEludFB0ciBzYSwgaW50IGxldmVsLCBpbnQgdHlwZSwgb3V0IEludFB0ciBkdXApOwogIFtEbGxJ'
  'bXBvcnQoInVzZXJlbnYuZGxsIiwgU2V0TGFzdEVycm9yID0gdHJ1ZSldIHN0YXRpYyBleHRlcm4gYm9vbCBDcmVhdGVFbnZpcm9u'
  'bWVudEJsb2NrKG91dCBJbnRQdHIgZW52LCBJbnRQdHIgdG9rZW4sIGJvb2wgaW5oZXJpdCk7CiAgW0RsbEltcG9ydCgidXNlcmVu'
  'di5kbGwiLCBTZXRMYXN0RXJyb3IgPSB0cnVlKV0gc3RhdGljIGV4dGVybiBib29sIERlc3Ryb3lFbnZpcm9ubWVudEJsb2NrKElu'
  'dFB0ciBlbnYpOwogIFtEbGxJbXBvcnQoInVzZXJlbnYuZGxsIiwgU2V0TGFzdEVycm9yID0gdHJ1ZSwgQ2hhclNldCA9IENoYXJT'
  'ZXQuVW5pY29kZSldIHN0YXRpYyBleHRlcm4gYm9vbCBHZXRVc2VyUHJvZmlsZURpcmVjdG9yeVcoSW50UHRyIHRva2VuLCBTdHJp'
  'bmdCdWlsZGVyIGRpciwgcmVmIGludCBzaXplKTsKCiAgSW50UHRyIGhwYyA9IEludFB0ci5aZXJvLCBwcm9jZXNzID0gSW50UHRy'
  'Llplcm87CiAgcHVibGljIFN0cmVhbSBJbnB1dDsgcHVibGljIFN0cmVhbSBPdXRwdXQ7CiAgcHVibGljIGludCBQcm9jZXNzSWQ7'
  'CiAgcHVibGljIGJvb2wgUHNldWRvOwoKICBwdWJsaWMgc3RhdGljIGJvb2wgU3VwcG9ydGVkIHsKICAgIGdldCB7CiAgICAgIElu'
  'dFB0ciBrID0gTG9hZExpYnJhcnkoImtlcm5lbDMyLmRsbCIpOwogICAgICByZXR1cm4gayAhPSBJbnRQdHIuWmVybyAmJiBHZXRQ'
  'cm9jQWRkcmVzcyhrLCAiQ3JlYXRlUHNldWRvQ29uc29sZSIpICE9IEludFB0ci5aZXJvOwogICAgfQogIH0KICBbRGxsSW1wb3J0'
  'KCJrZXJuZWwzMi5kbGwiLCBDaGFyU2V0ID0gQ2hhclNldC5BbnNpKV0gc3RhdGljIGV4dGVybiBJbnRQdHIgTG9hZExpYnJhcnko'
  'c3RyaW5nIG5hbWUpOwogIFtEbGxJbXBvcnQoImtlcm5lbDMyLmRsbCIsIENoYXJTZXQgPSBDaGFyU2V0LkFuc2kpXSBzdGF0aWMg'
  'ZXh0ZXJuIEludFB0ciBHZXRQcm9jQWRkcmVzcyhJbnRQdHIgbSwgc3RyaW5nIG5hbWUpOwoKICAvLy8gU2Vzc2lvbiBpZCBvZiBh'
  'IHNpZ25lZC1pbiB1c2VyIChjb25zb2xlIG9yIFJEUCksIG9yIC0xLgogIHB1YmxpYyBzdGF0aWMgaW50IEZpbmRTZXNzaW9uKHN0'
  'cmluZyB1c2VyKSB7CiAgICBJbnRQdHIgaW5mbzsgaW50IGNvdW50OwogICAgaWYgKCFXVFNFbnVtZXJhdGVTZXNzaW9ucyhJbnRQ'
  'dHIuWmVybywgMCwgMSwgb3V0IGluZm8sIG91dCBjb3VudCkpIHJldHVybiAtMTsKICAgIHRyeSB7CiAgICAgIGludCBzaXplID0g'
  'TWFyc2hhbC5TaXplT2YodHlwZW9mKFdUU19TRVNTSU9OX0lORk8pKTsKICAgICAgaW50IGJlc3QgPSAtMTsKICAgICAgZm9yIChp'
  'bnQgaSA9IDA7IGkgPCBjb3VudDsgaSsrKSB7CiAgICAgICAgdmFyIHMgPSAoV1RTX1NFU1NJT05fSU5GTylNYXJzaGFsLlB0clRv'
  'U3RydWN0dXJlKG5ldyBJbnRQdHIoaW5mby5Ub0ludDY0KCkgKyBpICogc2l6ZSksIHR5cGVvZihXVFNfU0VTU0lPTl9JTkZPKSk7'
  'CiAgICAgICAgSW50UHRyIGJ1ZjsgaW50IGJ5dGVzOwogICAgICAgIGlmICghV1RTUXVlcnlTZXNzaW9uSW5mb3JtYXRpb24oSW50'
  'UHRyLlplcm8sIHMuU2Vzc2lvbklkLCA1IC8qIFdUU1VzZXJOYW1lICovLCBvdXQgYnVmLCBvdXQgYnl0ZXMpKSBjb250aW51ZTsK'
  'ICAgICAgICBzdHJpbmcgbmFtZSA9IE1hcnNoYWwuUHRyVG9TdHJpbmdBbnNpKGJ1Zik7IFdUU0ZyZWVNZW1vcnkoYnVmKTsKICAg'
  'ICAgICBpZiAoIXN0cmluZy5FcXVhbHMobmFtZSwgdXNlciwgU3RyaW5nQ29tcGFyaXNvbi5PcmRpbmFsSWdub3JlQ2FzZSkpIGNv'
  'bnRpbnVlOwogICAgICAgIGlmIChzLlN0YXRlID09IDAgLyogV1RTQWN0aXZlICovKSByZXR1cm4gcy5TZXNzaW9uSWQ7CiAgICAg'
  'ICAgaWYgKGJlc3QgPCAwKSBiZXN0ID0gcy5TZXNzaW9uSWQ7CiAgICAgIH0KICAgICAgcmV0dXJuIGJlc3Q7CiAgICB9IGZpbmFs'
  'bHkgeyBXVFNGcmVlTWVtb3J5KGluZm8pOyB9CiAgfQoKICBwdWJsaWMgc3RhdGljIEludFB0ciBVc2VyVG9rZW4oc3RyaW5nIHVz'
  'ZXIpIHsKICAgIGludCBzZXNzaW9uID0gRmluZFNlc3Npb24odXNlcik7CiAgICBpZiAoc2Vzc2lvbiA8IDApIHRocm93IG5ldyBJ'
  'bnZhbGlkT3BlcmF0aW9uRXhjZXB0aW9uKHVzZXIgKyAiIGlzIG5vdCBzaWduZWQgaW4gb24gdGhpcyBtYWNoaW5lIChjb25zb2xl'
  'IG9yIHJlbW90ZSBkZXNrdG9wKS4iKTsKICAgIEludFB0ciB0b2tlbiwgcHJpbWFyeTsKICAgIGlmICghV1RTUXVlcnlVc2VyVG9r'
  'ZW4oc2Vzc2lvbiwgb3V0IHRva2VuKSkgdGhyb3cgbmV3IFdpbjMyRXhjZXB0aW9uKE1hcnNoYWwuR2V0TGFzdFdpbjMyRXJyb3Io'
  'KSwgIkNvdWxkIG5vdCBnZXQgIiArIHVzZXIgKyAiJ3Mgc2Vzc2lvbiB0b2tlbiAodGhlIGFnZW50IG11c3QgcnVuIGFzIFNZU1RF'
  'TSkiKTsKICAgIHRyeSB7CiAgICAgIGlmICghRHVwbGljYXRlVG9rZW5FeCh0b2tlbiwgMHgwMjAwMDAwMCAvKiBNQVhJTVVNX0FM'
  'TE9XRUQgKi8sIEludFB0ci5aZXJvLCAyIC8qIGltcGVyc29uYXRpb24gKi8sIDEgLyogcHJpbWFyeSAqLywgb3V0IHByaW1hcnkp'
  'KQogICAgICAgIHRocm93IG5ldyBXaW4zMkV4Y2VwdGlvbihNYXJzaGFsLkdldExhc3RXaW4zMkVycm9yKCkpOwogICAgfSBmaW5h'
  'bGx5IHsgQ2xvc2VIYW5kbGUodG9rZW4pOyB9CiAgICByZXR1cm4gcHJpbWFyeTsKICB9CgogIHB1YmxpYyBzdGF0aWMgU25pcHB5'
  'UHR5IFN0YXJ0KHN0cmluZyBjb21tYW5kTGluZSwgc3RyaW5nIGN3ZCwgc2hvcnQgY29scywgc2hvcnQgcm93cywgSW50UHRyIHRv'
  'a2VuKSB7CiAgICB2YXIgcHR5ID0gbmV3IFNuaXBweVB0eSgpOwogICAgdmFyIHNhID0gbmV3IFNFQ1VSSVRZX0FUVFJJQlVURVMg'
  'eyBuTGVuZ3RoID0gTWFyc2hhbC5TaXplT2YodHlwZW9mKFNFQ1VSSVRZX0FUVFJJQlVURVMpKSwgYkluaGVyaXRIYW5kbGUgPSAx'
  'IH07CiAgICBTYWZlRmlsZUhhbmRsZSBpblJlYWQsIGluV3JpdGUsIG91dFJlYWQsIG91dFdyaXRlOwogICAgaWYgKCFDcmVhdGVQ'
  'aXBlKG91dCBpblJlYWQsIG91dCBpbldyaXRlLCByZWYgc2EsIDApIHx8ICFDcmVhdGVQaXBlKG91dCBvdXRSZWFkLCBvdXQgb3V0'
  'V3JpdGUsIHJlZiBzYSwgMCkpCiAgICAgIHRocm93IG5ldyBXaW4zMkV4Y2VwdGlvbihNYXJzaGFsLkdldExhc3RXaW4zMkVycm9y'
  'KCksICJDcmVhdGVQaXBlIik7CiAgICBwdHkuUHNldWRvID0gU3VwcG9ydGVkOwogICAgdmFyIHNpID0gbmV3IFNUQVJUVVBJTkZP'
  'RVgoKTsKICAgIHNpLlN0YXJ0dXBJbmZvLmNiID0gTWFyc2hhbC5TaXplT2YodHlwZW9mKFNUQVJUVVBJTkZPRVgpKTsKICAgIElu'
  'dFB0ciBhdHRycyA9IEludFB0ci5aZXJvOwogICAgdWludCBmbGFncyA9IENSRUFURV9VTklDT0RFX0VOVklST05NRU5UOwogICAg'
  'Ym9vbCBpbmhlcml0ID0gZmFsc2U7CiAgICBpZiAocHR5LlBzZXVkbykgewogICAgICBpbnQgaHIgPSBDcmVhdGVQc2V1ZG9Db25z'
  'b2xlKG5ldyBDT09SRCB7IFggPSBjb2xzLCBZID0gcm93cyB9LCBpblJlYWQsIG91dFdyaXRlLCAwLCBvdXQgcHR5LmhwYyk7CiAg'
  'ICAgIGlmIChociAhPSAwKSB0aHJvdyBuZXcgV2luMzJFeGNlcHRpb24oaHIsICJDcmVhdGVQc2V1ZG9Db25zb2xlIik7CiAgICAg'
  'IEludFB0ciBzaXplID0gSW50UHRyLlplcm87CiAgICAgIEluaXRpYWxpemVQcm9jVGhyZWFkQXR0cmlidXRlTGlzdChJbnRQdHIu'
  'WmVybywgMSwgMCwgcmVmIHNpemUpOwogICAgICBhdHRycyA9IE1hcnNoYWwuQWxsb2NIR2xvYmFsKHNpemUpOwogICAgICBpZiAo'
  'IUluaXRpYWxpemVQcm9jVGhyZWFkQXR0cmlidXRlTGlzdChhdHRycywgMSwgMCwgcmVmIHNpemUpKSB0aHJvdyBuZXcgV2luMzJF'
  'eGNlcHRpb24oTWFyc2hhbC5HZXRMYXN0V2luMzJFcnJvcigpKTsKICAgICAgaWYgKCFVcGRhdGVQcm9jVGhyZWFkQXR0cmlidXRl'
  'KGF0dHJzLCAwLCBQUk9DX1RIUkVBRF9BVFRSSUJVVEVfUFNFVURPQ09OU09MRSwgcHR5LmhwYywgKEludFB0cilJbnRQdHIuU2l6'
  'ZSwgSW50UHRyLlplcm8sIEludFB0ci5aZXJvKSkKICAgICAgICB0aHJvdyBuZXcgV2luMzJFeGNlcHRpb24oTWFyc2hhbC5HZXRM'
  'YXN0V2luMzJFcnJvcigpKTsKICAgICAgc2kubHBBdHRyaWJ1dGVMaXN0ID0gYXR0cnM7CiAgICAgIGZsYWdzIHw9IEVYVEVOREVE'
  'X1NUQVJUVVBJTkZPX1BSRVNFTlQ7CiAgICB9IGVsc2UgewogICAgICAvLyBQcmUtMTgwOSBmYWxsYmFjazogcGxhaW4gcGlwZXMs'
  'IG5vIGNvbnNvbGUuCiAgICAgIFNldEhhbmRsZUluZm9ybWF0aW9uKGluV3JpdGUsIDEsIDApOwogICAgICBTZXRIYW5kbGVJbmZv'
  'cm1hdGlvbihvdXRSZWFkLCAxLCAwKTsKICAgICAgc2kuU3RhcnR1cEluZm8uZHdGbGFncyA9IFNUQVJURl9VU0VTVERIQU5ETEVT'
  'OwogICAgICBzaS5TdGFydHVwSW5mby5oU3RkSW5wdXQgPSBpblJlYWQuRGFuZ2Vyb3VzR2V0SGFuZGxlKCk7CiAgICAgIHNpLlN0'
  'YXJ0dXBJbmZvLmhTdGRPdXRwdXQgPSBvdXRXcml0ZS5EYW5nZXJvdXNHZXRIYW5kbGUoKTsKICAgICAgc2kuU3RhcnR1cEluZm8u'
  'aFN0ZEVycm9yID0gb3V0V3JpdGUuRGFuZ2Vyb3VzR2V0SGFuZGxlKCk7CiAgICAgIGZsYWdzIHw9IENSRUFURV9OT19XSU5ET1cg'
  'fCBDUkVBVEVfTkVXX1BST0NFU1NfR1JPVVA7CiAgICAgIGluaGVyaXQgPSB0cnVlOwogICAgfQogICAgSW50UHRyIGVudiA9IElu'
  'dFB0ci5aZXJvOwogICAgUFJPQ0VTU19JTkZPUk1BVElPTiBwaTsKICAgIHRyeSB7CiAgICAgIGJvb2wgb2s7CiAgICAgIGlmICh0'
  'b2tlbiAhPSBJbnRQdHIuWmVybykgewogICAgICAgIENyZWF0ZUVudmlyb25tZW50QmxvY2sob3V0IGVudiwgdG9rZW4sIGZhbHNl'
  'KTsKICAgICAgICBpbnQgbGVuID0gMjYwOyB2YXIgZGlyID0gbmV3IFN0cmluZ0J1aWxkZXIobGVuKTsKICAgICAgICBpZiAoR2V0'
  'VXNlclByb2ZpbGVEaXJlY3RvcnlXKHRva2VuLCBkaXIsIHJlZiBsZW4pKSBjd2QgPSBkaXIuVG9TdHJpbmcoKTsKICAgICAgICBz'
  'aS5TdGFydHVwSW5mby5scERlc2t0b3AgPSAid2luc3RhMFxcZGVmYXVsdCI7CiAgICAgICAgb2sgPSBDcmVhdGVQcm9jZXNzQXNV'
  'c2VyVyh0b2tlbiwgbnVsbCwgbmV3IFN0cmluZ0J1aWxkZXIoY29tbWFuZExpbmUpLCBJbnRQdHIuWmVybywgSW50UHRyLlplcm8s'
  'IGluaGVyaXQsIGZsYWdzLCBlbnYsIGN3ZCwgcmVmIHNpLCBvdXQgcGkpOwogICAgICB9IGVsc2UgewogICAgICAgIG9rID0gQ3Jl'
  'YXRlUHJvY2Vzc1cobnVsbCwgbmV3IFN0cmluZ0J1aWxkZXIoY29tbWFuZExpbmUpLCBJbnRQdHIuWmVybywgSW50UHRyLlplcm8s'
  'IGluaGVyaXQsIGZsYWdzLCBJbnRQdHIuWmVybywgY3dkLCByZWYgc2ksIG91dCBwaSk7CiAgICAgIH0KICAgICAgaWYgKCFvaykg'
  'dGhyb3cgbmV3IFdpbjMyRXhjZXB0aW9uKE1hcnNoYWwuR2V0TGFzdFdpbjMyRXJyb3IoKSwgIkNyZWF0ZVByb2Nlc3MiKTsKICAg'
  'IH0gZmluYWxseSB7CiAgICAgIGlmIChlbnYgIT0gSW50UHRyLlplcm8pIERlc3Ryb3lFbnZpcm9ubWVudEJsb2NrKGVudik7CiAg'
  'ICAgIGlmIChhdHRycyAhPSBJbnRQdHIuWmVybykgeyBEZWxldGVQcm9jVGhyZWFkQXR0cmlidXRlTGlzdChhdHRycyk7IE1hcnNo'
  'YWwuRnJlZUhHbG9iYWwoYXR0cnMpOyB9CiAgICB9CiAgICBDbG9zZUhhbmRsZShwaS5oVGhyZWFkKTsKICAgIHB0eS5wcm9jZXNz'
  'ID0gcGkuaFByb2Nlc3M7CiAgICBwdHkuUHJvY2Vzc0lkID0gcGkuZHdQcm9jZXNzSWQ7CiAgICAvLyBUaGUgY29uc29sZSAob3Ig'
  'Y2hpbGQpIG93bnMgdGhlc2UgZW5kcyBub3cuCiAgICBpblJlYWQuRGlzcG9zZSgpOyBvdXRXcml0ZS5EaXNwb3NlKCk7CiAgICBw'
  'dHkuSW5wdXQgPSBuZXcgRmlsZVN0cmVhbShpbldyaXRlLCBGaWxlQWNjZXNzLldyaXRlLCAxLCBmYWxzZSk7CiAgICBwdHkuT3V0'
  'cHV0ID0gbmV3IEZpbGVTdHJlYW0ob3V0UmVhZCwgRmlsZUFjY2Vzcy5SZWFkLCAxLCBmYWxzZSk7CiAgICByZXR1cm4gcHR5Owog'
  'IH0KCiAgcHVibGljIHZvaWQgUmVzaXplKHNob3J0IGNvbHMsIHNob3J0IHJvd3MpIHsKICAgIGlmIChocGMgIT0gSW50UHRyLlpl'
  'cm8gJiYgY29scyA+IDAgJiYgcm93cyA+IDApIFJlc2l6ZVBzZXVkb0NvbnNvbGUoaHBjLCBuZXcgQ09PUkQgeyBYID0gY29scywg'
  'WSA9IHJvd3MgfSk7CiAgfQoKICBwdWJsaWMgYm9vbCBIYXNFeGl0ZWQgeyBnZXQgeyByZXR1cm4gcHJvY2VzcyA9PSBJbnRQdHIu'
  'WmVybyB8fCBXYWl0Rm9yU2luZ2xlT2JqZWN0KHByb2Nlc3MsIDApID09IDA7IH0gfQoKICBwdWJsaWMgaW50IEV4aXRDb2RlIHsg'
  'Z2V0IHsgdWludCBjOyByZXR1cm4gR2V0RXhpdENvZGVQcm9jZXNzKHByb2Nlc3MsIG91dCBjKSA/IChpbnQpYyA6IDE7IH0gfQoK'
  'ICBwdWJsaWMgdm9pZCBLaWxsKCkgeyBpZiAocHJvY2VzcyAhPSBJbnRQdHIuWmVybyAmJiAhSGFzRXhpdGVkKSBUZXJtaW5hdGVQ'
  'cm9jZXNzKHByb2Nlc3MsIDEpOyB9CgogIHB1YmxpYyB2b2lkIERpc3Bvc2UoKSB7CiAgICBLaWxsKCk7CiAgICBpZiAoaHBjICE9'
  'IEludFB0ci5aZXJvKSB7IENsb3NlUHNldWRvQ29uc29sZShocGMpOyBocGMgPSBJbnRQdHIuWmVybzsgfQogICAgdHJ5IHsgaWYg'
  'KElucHV0ICE9IG51bGwpIElucHV0LkRpc3Bvc2UoKTsgfSBjYXRjaCB7IH0KICAgIHRyeSB7IGlmIChPdXRwdXQgIT0gbnVsbCkg'
  'T3V0cHV0LkRpc3Bvc2UoKTsgfSBjYXRjaCB7IH0KICAgIGlmIChwcm9jZXNzICE9IEludFB0ci5aZXJvKSB7IENsb3NlSGFuZGxl'
  'KHByb2Nlc3MpOyBwcm9jZXNzID0gSW50UHRyLlplcm87IH0KICB9Cn0KJ0AKCmZ1bmN0aW9uIFNlbmQtRXhjaGFuZ2UoW2J5dGVb'
  'XV0kT3V0cHV0LCBbc3RyaW5nXSRVc2VyLCBbYm9vbF0kQWxpdmUsICRFeGl0Q29kZSwgW3N0cmluZ10kTWVzc2FnZSkgewogICRi'
  'NjQgPSAnJwogIGlmICgkT3V0cHV0IC1hbmQgJE91dHB1dC5MZW5ndGggLWd0IDApIHsgJGI2NCA9IFtDb252ZXJ0XTo6VG9CYXNl'
  'NjRTdHJpbmcoJE91dHB1dCkgfQogICRib2R5ID0gQHsKICAgIG91dHB1dCA9ICRiNjQ7IHVzZXIgPSAkVXNlcjsgYWxpdmUgPSAk'
  'QWxpdmU7IHByaXZpbGVnZWQgPSAkc2NyaXB0OlByaXZpbGVnZWQ7IHR0eSA9ICRzY3JpcHQ6VHR5CiAgICBleGl0Q29kZSA9ICRF'
  'eGl0Q29kZTsgbWVzc2FnZSA9ICRNZXNzYWdlCiAgfSB8IENvbnZlcnRUby1Kc29uIC1Db21wcmVzcwogIHRyeSB7CiAgICAkcmVw'
  'bHkgPSBJbnZva2UtUmVzdE1ldGhvZCAtTWV0aG9kIFBvc3QgLVVyaSAiJFVybC9hcGkvYWdlbnQvam9icy8kSm9iSWQvdHR5P3dh'
  'aXQ9MC40IiAtSGVhZGVycyAkSGVhZGVycyBgCiAgICAgIC1Db250ZW50VHlwZSAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11'
  'dGYtOCcgLUJvZHkgKFtUZXh0LkVuY29kaW5nXTo6VVRGOC5HZXRCeXRlcygkYm9keSkpIC1UaW1lb3V0U2VjIDMwCiAgICAkc2Ny'
  'aXB0OkZhaWx1cmVzID0gMAogICAgcmV0dXJuICRyZXBseS5kYXRhCiAgfSBjYXRjaCB7CiAgICAkc3RhdHVzID0gJG51bGwKICAg'
  'IGlmICgkXy5FeGNlcHRpb24uUmVzcG9uc2UpIHsgJHN0YXR1cyA9IFtpbnRdJF8uRXhjZXB0aW9uLlJlc3BvbnNlLlN0YXR1c0Nv'
  'ZGUgfQogICAgaWYgKCRzdGF0dXMgLWluIDQwNCwgNDA5LCA0MTApIHsgcmV0dXJuIEB7IGNsb3NlID0gJHRydWUgfSB9CiAgICAk'
  'c2NyaXB0OkZhaWx1cmVzICs9IDEKICAgIHJldHVybiAkbnVsbAogIH0KfQoKZnVuY3Rpb24gU3RhcnQtU2hlbGwoW3N0cmluZ10k'
  'U2hlbGwsIFtzdHJpbmddJFVzZXIsIFtpbnRdJENvbHMsIFtpbnRdJFJvd3MpIHsKICAkY21kID0gaWYgKCRTaGVsbCAtZXEgJ2Nt'
  'ZCcpIHsgJ2NtZC5leGUgL3EnIH0gZWxzZSB7ICdwb3dlcnNoZWxsLmV4ZSAtTm9Mb2dvIC1Ob1Byb2ZpbGUgLUV4ZWN1dGlvblBv'
  'bGljeSBCeXBhc3MnIH0KICBpZiAoLW5vdCBbU25pcHB5UHR5XTo6U3VwcG9ydGVkKSB7CiAgICAjIE5vIGNvbnNvbGUgdG8gZHJh'
  'dyBhIHByb21wdCBpbjogcmVhZCBjb21tYW5kcyBmcm9tIHN0ZGluIGluc3RlYWQuCiAgICAkY21kID0gaWYgKCRTaGVsbCAtZXEg'
  'J2NtZCcpIHsgJ2NtZC5leGUgL3EgL2snIH0gZWxzZSB7ICdwb3dlcnNoZWxsLmV4ZSAtTm9Mb2dvIC1Ob1Byb2ZpbGUgLUV4ZWN1'
  'dGlvblBvbGljeSBCeXBhc3MgLUNvbW1hbmQgLScgfQogIH0KICAkdG9rZW4gPSBbSW50UHRyXTo6WmVybwogIGlmICgkVXNlciAt'
  'YW5kICRVc2VyIC1uZSAkZW52OlVTRVJOQU1FKSB7ICR0b2tlbiA9IFtTbmlwcHlQdHldOjpVc2VyVG9rZW4oJFVzZXIpIH0KICBy'
  'ZXR1cm4gW1NuaXBweVB0eV06OlN0YXJ0KCRjbWQsICIkKCRlbnY6U3lzdGVtRHJpdmUpXCIsIFtpbnQxNl0kQ29scywgW2ludDE2'
  'XSRSb3dzLCAkdG9rZW4pCn0KCmZ1bmN0aW9uIFN0YXJ0LVJlYWQoJFB0eSwgW2J5dGVbXV0kQnVmZmVyKSB7IHJldHVybiAkUHR5'
  'Lk91dHB1dC5SZWFkQXN5bmMoJEJ1ZmZlciwgMCwgJEJ1ZmZlci5MZW5ndGgpIH0KCiRzaGVsbCA9ICdwb3dlcnNoZWxsJzsgJHVz'
  'ZXIgPSAnJwpmb3JlYWNoICgkbGluZSBpbiAoR2V0LUNvbnRlbnQgLUxpdGVyYWxQYXRoICRTcGVjUGF0aCkpIHsKICBpZiAoJGxp'
  'bmUgLW1hdGNoICdec2hlbGw9KC4qKSQnKSB7ICRzaGVsbCA9ICRNYXRjaGVzWzFdLlRyaW0oKSB9CiAgZWxzZWlmICgkbGluZSAt'
  'bWF0Y2ggJ151c2VyPSguKikkJykgeyAkdXNlciA9ICRNYXRjaGVzWzFdLlRyaW0oKSB9Cn0KaWYgKCRzaGVsbCAtbmUgJ2NtZCcp'
  'IHsgJHNoZWxsID0gJ3Bvd2Vyc2hlbGwnIH0KJGlkZW50aXR5ID0gW1NlY3VyaXR5LlByaW5jaXBhbC5XaW5kb3dzSWRlbnRpdHld'
  'OjpHZXRDdXJyZW50KCkKJHNjcmlwdDpQcml2aWxlZ2VkID0gJGlkZW50aXR5LklzU3lzdGVtCiRzY3JpcHQ6VHR5ID0gW1NuaXBw'
  'eVB0eV06OlN1cHBvcnRlZAokc2NyaXB0OkZhaWx1cmVzID0gMAokYWN0aXZlID0gaWYgKCR1c2VyKSB7ICR1c2VyIH0gZWxzZSB7'
  'ICRlbnY6VVNFUk5BTUUgfQoKdHJ5IHsKICAkcHR5ID0gU3RhcnQtU2hlbGwgJHNoZWxsICR1c2VyIDEwMCAzMgp9IGNhdGNoIHsK'
  'ICAkbXNnID0gIlNuaXBweUNvZGU6IGNvdWxkIG5vdCBzdGFydCB0aGUgc2hlbGwgYXMgJHthY3RpdmV9OiAkKCRfLkV4Y2VwdGlv'
  'bi5NZXNzYWdlKSIKICBTZW5kLUV4Y2hhbmdlIChbVGV4dC5FbmNvZGluZ106OlVURjguR2V0Qnl0ZXMoIiRtc2dgcmBuIikpICRl'
  'bnY6VVNFUk5BTUUgJGZhbHNlIDEgJG1zZyB8IE91dC1OdWxsCiAgZXhpdCAxCn0KCiRraW5kID0gaWYgKCRzY3JpcHQ6VHR5KSB7'
  'ICdXaW5kb3dzIHBzZXVkbyBjb25zb2xlJyB9IGVsc2UgeyAncmVkaXJlY3RlZCBwaXBlcyAodGhpcyBXaW5kb3dzIGJ1aWxkIGhh'
  'cyBubyBDb25QVFkpJyB9CiRwZW5kaW5nID0gW1RleHQuRW5jb2RpbmddOjpVVEY4LkdldEJ5dGVzKCJTbmlwcHlDb2RlIHRlcm1p'
  'bmFsICgkc2hlbGwsIGFjY291bnQgJGFjdGl2ZSwgJGtpbmQpLiBLZXlzdHJva2VzIGdvIHRvIHRoaXMgc2hlbGwuYHJgbiIpCiRi'
  'dWZmZXIgPSBOZXctT2JqZWN0IGJ5dGVbXSAzMjc2OAokcmVhZCA9IFN0YXJ0LVJlYWQgJHB0eSAkYnVmZmVyCiRzdGFydGVkID0g'
  'R2V0LURhdGU7ICRsYXN0SW8gPSAkc3RhcnRlZAokZXhpdENvZGUgPSAwOyAkbWVzc2FnZSA9ICcnCiRzaXplID0gQHsgQ29scyA9'
  'IDEwMDsgUm93cyA9IDMyIH0KCnRyeSB7CiAgd2hpbGUgKCR0cnVlKSB7CiAgICAkbm93ID0gR2V0LURhdGUKICAgIGlmICgoJG5v'
  'dyAtICRzdGFydGVkKS5Ub3RhbEhvdXJzIC1nZSA0KSB7ICRtZXNzYWdlID0gJ1RoZSBzZXNzaW9uIHJlYWNoZWQgdGhlIDQgaG91'
  'ciBsaW1pdC4nOyBicmVhayB9CiAgICBpZiAoKCRub3cgLSAkbGFzdElvKS5Ub3RhbE1pbnV0ZXMgLWdlIDE1KSB7ICRtZXNzYWdl'
  'ID0gJ1RoZSBzZXNzaW9uIHdhcyBjbG9zZWQgYWZ0ZXIgMTUgbWludXRlcyB3aXRoIG5vdGhpbmcgdHlwZWQgYW5kIG5vIG91dHB1'
  'dC4nOyBicmVhayB9CiAgICBpZiAoJHNjcmlwdDpGYWlsdXJlcyAtZ2UgOCkgeyAkbWVzc2FnZSA9ICdUaGUgc2Vzc2lvbiBsb3N0'
  'IGNvbnRhY3Qgd2l0aCBTbmlwcHlDb2RlLic7IGJyZWFrIH0KCiAgICAkb3V0ID0gTmV3LU9iamVjdCBJTy5NZW1vcnlTdHJlYW0K'
  'ICAgIGlmICgkcGVuZGluZy5MZW5ndGgpIHsgJG91dC5Xcml0ZSgkcGVuZGluZywgMCwgJHBlbmRpbmcuTGVuZ3RoKTsgJHBlbmRp'
  'bmcgPSBOZXctT2JqZWN0IGJ5dGVbXSAwIH0KICAgICRkZWFkbGluZSA9IChHZXQtRGF0ZSkuQWRkTWlsbGlzZWNvbmRzKDI1MCkK'
  'ICAgICRlb2YgPSAkZmFsc2UKICAgIHdoaWxlICgoR2V0LURhdGUpIC1sdCAkZGVhZGxpbmUgLWFuZCAkb3V0Lkxlbmd0aCAtbHQg'
  'MzI3NjgpIHsKICAgICAgaWYgKC1ub3QgJHJlYWQuV2FpdCgzMCkpIHsgaWYgKCRvdXQuTGVuZ3RoKSB7IGJyZWFrIH0gZWxzZSB7'
  'IGNvbnRpbnVlIH0gfQogICAgICAkbiA9IDAKICAgICAgdHJ5IHsgJG4gPSBbaW50XSRyZWFkLlJlc3VsdCB9IGNhdGNoIHsgJG4g'
  'PSAwIH0KICAgICAgaWYgKCRuIC1sZSAwKSB7ICRlb2YgPSAkdHJ1ZTsgYnJlYWsgfQogICAgICAkb3V0LldyaXRlKCRidWZmZXIs'
  'IDAsICRuKQogICAgICAkcmVhZCA9IFN0YXJ0LVJlYWQgJHB0eSAkYnVmZmVyCiAgICB9CiAgICAkY2h1bmsgPSAkb3V0LlRvQXJy'
  'YXkoKQogICAgaWYgKCRjaHVuay5MZW5ndGgpIHsgJGxhc3RJbyA9IEdldC1EYXRlIH0KCiAgICBpZiAoJGVvZiAtb3IgJHB0eS5I'
  'YXNFeGl0ZWQpIHsKICAgICAgJGV4aXRDb2RlID0gaWYgKCRwdHkuSGFzRXhpdGVkKSB7ICRwdHkuRXhpdENvZGUgfSBlbHNlIHsg'
  'MCB9CiAgICAgIFNlbmQtRXhjaGFuZ2UgJGNodW5rICRhY3RpdmUgJHRydWUgJG51bGwgJycgfCBPdXQtTnVsbAogICAgICAkbWVz'
  'c2FnZSA9ICdUaGUgc2hlbGwgZXhpdGVkLicKICAgICAgYnJlYWsKICAgIH0KCiAgICAkZGF0YSA9IFNlbmQtRXhjaGFuZ2UgJGNo'
  'dW5rICRhY3RpdmUgJHRydWUgJG51bGwgJycKICAgIGlmICgtbm90ICRkYXRhKSB7IFN0YXJ0LVNsZWVwIC1NaWxsaXNlY29uZHMg'
  'NDAwOyBjb250aW51ZSB9CiAgICBpZiAoJGRhdGEuY2xvc2UpIHsgJG1lc3NhZ2UgPSAnU2Vzc2lvbiBjbG9zZWQuJzsgYnJlYWsg'
  'fQoKICAgIGlmICgkZGF0YS5pbnB1dCkgewogICAgICAkYnl0ZXMgPSBbQ29udmVydF06OkZyb21CYXNlNjRTdHJpbmcoW3N0cmlu'
  'Z10kZGF0YS5pbnB1dCkKICAgICAgaWYgKCRieXRlcy5MZW5ndGgpIHsgJHB0eS5JbnB1dC5Xcml0ZSgkYnl0ZXMsIDAsICRieXRl'
  'cy5MZW5ndGgpOyAkcHR5LklucHV0LkZsdXNoKCk7ICRsYXN0SW8gPSBHZXQtRGF0ZSB9CiAgICB9CiAgICBpZiAoJGRhdGEuc2ln'
  'bmFsIC1lcSAnSU5UJyAtb3IgJGRhdGEuc2lnbmFsIC1lcSAnVEVSTScpIHsKICAgICAgIyBUaHJvdWdoIGEgcHNldWRvIGNvbnNv'
  'bGUsIEVUWCBpcyBkZWxpdmVyZWQgYXMgYSByZWFsIEN0cmwrQyBldmVudC4KICAgICAgJGV0eCA9IFtieXRlW11dKDMpCiAgICAg'
  'ICRwdHkuSW5wdXQuV3JpdGUoJGV0eCwgMCwgMSk7ICRwdHkuSW5wdXQuRmx1c2goKQogICAgICBpZiAoJGRhdGEuc2lnbmFsIC1l'
  'cSAnVEVSTScgLWFuZCAtbm90ICRzY3JpcHQ6VHR5KSB7ICYgdGFza2tpbGwuZXhlIC9UIC9GIC9QSUQgJHB0eS5Qcm9jZXNzSWQg'
  'fCBPdXQtTnVsbCB9CiAgICB9CiAgICAkY29scyA9IFtpbnRdJGRhdGEuY29sczsgJHJvd3MgPSBbaW50XSRkYXRhLnJvd3MKICAg'
  'IGlmICgkY29scyAtZ3QgMCAtYW5kICRyb3dzIC1ndCAwIC1hbmQgKCRjb2xzIC1uZSAkc2l6ZS5Db2xzIC1vciAkcm93cyAtbmUg'
  'JHNpemUuUm93cykpIHsKICAgICAgJHB0eS5SZXNpemUoW2ludDE2XSRjb2xzLCBbaW50MTZdJHJvd3MpOyAkc2l6ZS5Db2xzID0g'
  'JGNvbHM7ICRzaXplLlJvd3MgPSAkcm93cwogICAgfQogICAgJHJlcXVlc3RlZCA9IFtzdHJpbmddJGRhdGEudXNlcgogICAgaWYg'
  'KCRyZXF1ZXN0ZWQgLWFuZCAkcmVxdWVzdGVkIC1uZSAkYWN0aXZlKSB7CiAgICAgIHRyeSB7CiAgICAgICAgJG5leHQgPSBTdGFy'
  'dC1TaGVsbCAkc2hlbGwgJHJlcXVlc3RlZCAkc2l6ZS5Db2xzICRzaXplLlJvd3MKICAgICAgICAkcHR5LkRpc3Bvc2UoKQogICAg'
  'ICAgICRwdHkgPSAkbmV4dAogICAgICAgICRyZWFkID0gU3RhcnQtUmVhZCAkcHR5ICRidWZmZXIKICAgICAgICAkYWN0aXZlID0g'
  'JHJlcXVlc3RlZAogICAgICAgICRwZW5kaW5nID0gW1RleHQuRW5jb2RpbmddOjpVVEY4LkdldEJ5dGVzKCJgcmBuU25pcHB5Q29k'
  'ZTogc3dpdGNoZWQgdG8gJHJlcXVlc3RlZGByYG4iKQogICAgICB9IGNhdGNoIHsKICAgICAgICAkcGVuZGluZyA9IFtUZXh0LkVu'
  'Y29kaW5nXTo6VVRGOC5HZXRCeXRlcygiYHJgblNuaXBweUNvZGU6IGNhbm5vdCBzd2l0Y2ggdG8gJHtyZXF1ZXN0ZWR9OiAkKCRf'
  'LkV4Y2VwdGlvbi5NZXNzYWdlKWByYG4iKQogICAgICB9CiAgICAgICRsYXN0SW8gPSBHZXQtRGF0ZQogICAgfQogIH0KfSBmaW5h'
  'bGx5IHsKICB0cnkgeyAmIHRhc2traWxsLmV4ZSAvVCAvRiAvUElEICRwdHkuUHJvY2Vzc0lkIDI+JG51bGwgfCBPdXQtTnVsbCB9'
  'IGNhdGNoIHsgfQogICRwdHkuRGlzcG9zZSgpCiAgU2VuZC1FeGNoYW5nZSAoTmV3LU9iamVjdCBieXRlW10gMCkgJGFjdGl2ZSAk'
  'ZmFsc2UgJGV4aXRDb2RlICRtZXNzYWdlIHwgT3V0LU51bGwKfQpleGl0IDAK'
) -join ''
$script:LivePty = $null

function Send-PtyResult($Id, $ExitCode, $Stdout, $Stderr, $Duration) {
  $body = @{ exitCode = $ExitCode; stdout = $Stdout; stderr = $Stderr; durationMs = $Duration; timedOut = $false } | ConvertTo-Json -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($body)
  foreach ($attempt in 1..5) {
    try {
      Invoke-RestMethod -Method Post -Uri "$Url/api/agent/jobs/$Id/result" -Headers $Headers `
        -ContentType 'application/json; charset=utf-8' -Body $bytes -TimeoutSec 60 | Out-Null
      return
    } catch {
      Write-Log "Could not send the result of terminal job $Id (attempt $attempt): $($_.Exception.Message)"
      Start-Sleep -Seconds ($attempt * 5)
    }
  }
}

function Complete-PtySession([switch]$Kill) {
  $state = $script:LivePty
  $script:LivePty = $null
  if (-not $state) { return }
  if ($Kill -and -not $state.Process.HasExited) {
    & taskkill.exe /T /F /PID $state.Process.Id 2>$null | Out-Null
  }
  try { $state.Process.WaitForExit(5000) | Out-Null } catch { }
  $code = 0
  try { $code = $state.Process.ExitCode } catch { }
  $err = if (Test-Path $state.Err) { Get-Content $state.Err -Raw } else { '' }
  # The helper usually reports the result itself. A second post is ignored.
  Send-PtyResult $state.Id $code "Interactive terminal ($($state.Shell))." (Limit $err) ([int]((Get-Date) - $state.Started).TotalMilliseconds)
  Remove-Item $state.Spec, $state.Out, $state.Err -Force -ErrorAction SilentlyContinue
  Write-Log "Terminal job $($state.Id) finished with exit code $code"
}

function Start-PtySession($Id, [string]$Spec) {
  if ($script:LivePty) { Complete-PtySession -Kill }
  $shell = 'powershell'
  foreach ($line in ($Spec -split "`r?`n")) { if ($line -match '^shell=(.*)$') { $shell = $Matches[1].Trim() } }
  $helper = Join-Path $Work 'pty_session.ps1'
  [IO.File]::WriteAllBytes($helper, [Convert]::FromBase64String($PtyHelperB64))
  $specFile = Join-Path $Work "job-$Id.pty"
  [IO.File]::WriteAllText($specFile, $Spec)
  $out = Join-Path $Work "job-$Id.pty.out"
  $err = Join-Path $Work "job-$Id.pty.err"
  $env:SNIPPYCODE_URL = $Url
  $env:SNIPPYCODE_TOKEN = ($Headers.Authorization -replace '^Bearer ', '')
  $env:SNIPPYCODE_FINGERPRINT = [string]$Headers['X-Agent-Fingerprint']
  try {
    $process = Start-Process -FilePath 'powershell.exe' -PassThru -NoNewWindow `
      -ArgumentList "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$helper`" -JobId $Id -SpecPath `"$specFile`"" `
      -RedirectStandardOutput $out -RedirectStandardError $err
  } finally {
    Remove-Item Env:SNIPPYCODE_TOKEN, Env:SNIPPYCODE_FINGERPRINT, Env:SNIPPYCODE_URL -ErrorAction SilentlyContinue
  }
  $script:LivePty = @{ Id = $Id; Process = $process; Shell = $shell; Started = Get-Date; Spec = $specFile; Out = $out; Err = $err }
  Write-Log "Interactive terminal job $Id started ($shell)"
}

function Sync-PtySession {
  if ($script:LivePty -and $script:LivePty.Process.HasExited) { Complete-PtySession }
}

Write-Log "SnippyCode agent $AgentVersion polling $Url"
$backoff = 5
$factsAt = [datetime]::MinValue
$updateTried = ''

while ($true) {
  # Every 2 minutes: feeds monitors and the trend graphs
  if (((Get-Date) - $factsAt).TotalMinutes -ge 2) {
    Send-Facts
    $factsAt = Get-Date
  }

  try {
    if ($script:LivePty) { Sync-PtySession }
    $caps = [uri]::EscapeDataString((Get-Capabilities))
    # The terminal helper runs on its own; poll a little faster so a closed session is reaped.
    $wait = if ($script:LivePty) { 5 } else { 25 }
    $response = Invoke-WebRequest -UseBasicParsing -Uri "$Url/api/agent/next?wait=$wait&version=$AgentVersion&caps=$caps&agentId=$AgentId" `
      -Headers $Headers -TimeoutSec 45

    $latest = [string]$response.Headers['X-Agent-Latest']
    if ($response.StatusCode -eq 204 -and $latest -and $latest -ne $AgentVersion -and $latest -ne $updateTried) {
      $updateTried = $latest
      Update-Agent $latest
    }

    if ($response.StatusCode -eq 200) {
      $id = [int]$response.Headers['X-Job-Id']
      $language = [string]$response.Headers['X-Job-Language']
      $timeout = [int]$response.Headers['X-Job-Timeout-Ms']
      if ($timeout -le 0) { $timeout = 300000 }
      $code = if ($response.Content -is [byte[]]) { [Text.Encoding]::UTF8.GetString($response.Content) } else { [string]$response.Content }
      if ($language -eq 'pty') {
        Start-PtySession $id $code
      } else {
        Write-Log "Running job $id ($language)"
        Invoke-Job $id $language $timeout $code
      }
    }
    $backoff = 5
  } catch {
    $status = $null
    if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
    $reenrol = $false
    if ($status -eq 409 -and $_.Exception.Response.Headers) {
      try { $reenrol = [bool]$_.Exception.Response.Headers['X-Reenrol-Required'] } catch { }
    }
    if ($reenrol) {
      Write-Log 'The server says this device token belongs to other hardware; re-enrolling'
      if (-not (Invoke-Reenrol)) { Start-Sleep -Seconds 300 }
    } elseif ($status -eq 401 -or $status -eq 403) {
      Write-Log 'The device token was rejected (revoked?). Retrying in 5 minutes.'
      Start-Sleep -Seconds 300
    } else {
      Write-Log "SnippyCode is not reachable ($($_.Exception.Message)). Retrying in ${backoff}s."
      Start-Sleep -Seconds $backoff
      $backoff = [math]::Min($backoff * 2, 60)
    }
  }
}
