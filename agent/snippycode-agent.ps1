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
  # pty: interactive stdin for the terminal. One-shot jobs stay -NonInteractive.
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

# Interactive terminal. Not a ConPTY: programs that require a real console can
# still refuse, but Read-Host and other stdin prompts work. One-shot jobs do
# not come through here, and Windows cannot switch OS users without a password.
$script:LivePty = $null

function Join-PtyBytes($Chunks) {
  $len = 0
  foreach ($chunk in $Chunks) { if ($chunk) { $len += $chunk.Length } }
  $all = New-Object byte[] $len
  $offset = 0
  foreach ($chunk in $Chunks) {
    if (-not $chunk -or $chunk.Length -eq 0) { continue }
    [Array]::Copy($chunk, 0, $all, $offset, $chunk.Length)
    $offset += $chunk.Length
  }
  return $all
}

function Read-PtyChunk($Stream, [byte[]]$Buffer, $Task) {
  $result = @{ Eof = $false; Data = (New-Object byte[] 0); Task = $Task }
  if (-not $result.Task) {
    $result.Task = $Stream.ReadAsync($Buffer, 0, $Buffer.Length)
    return $result
  }
  if (-not $result.Task.IsCompleted) { return $result }
  $count = [int]$result.Task.Result
  if ($count -le 0) {
    $result.Eof = $true
    $result.Task = $null
    return $result
  }
  $copy = New-Object byte[] $count
  [Array]::Copy($Buffer, $copy, $count)
  $result.Data = $copy
  $result.Task = $Stream.ReadAsync($Buffer, 0, $Buffer.Length)
  return $result
}

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

function Send-PtyExchange($Id, [byte[]]$Output, [bool]$Alive, $ExitCode, [string]$Message) {
  $b64 = ''
  if ($Output -and $Output.Length -gt 0) { $b64 = [Convert]::ToBase64String($Output) }
  $body = @{
    output = $b64; user = [string]$env:USERNAME; alive = $Alive; privileged = $false; tty = $false
    exitCode = $ExitCode; message = $Message
  } | ConvertTo-Json -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($body)
  return Invoke-RestMethod -Method Post -Uri "$Url/api/agent/jobs/$Id/tty?wait=0.4" -Headers $Headers `
    -ContentType 'application/json; charset=utf-8' -Body $bytes -TimeoutSec 30
}

function Stop-PtyProcess($State) {
  if (-not $State -or -not $State.Process) { return }
  try {
    if (-not $State.Process.HasExited) {
      & taskkill.exe /T /F /PID $State.Process.Id | Out-Null
      $State.Process.WaitForExit()
    }
  } catch { }
}

function Complete-PtySession([string]$Message, $ExitCode, [byte[]]$Output) {
  $state = $script:LivePty
  $script:LivePty = $null
  if (-not $state) { return }
  Stop-PtyProcess $state
  $final = if ($Output) { $Output } else { New-Object byte[] 0 }
  try { Send-PtyExchange $state.Id $final $false $ExitCode $Message | Out-Null } catch { }
  $stdout = "Interactive terminal ($($state.Shell)) as $env:USERNAME."
  Send-PtyResult $state.Id $ExitCode $stdout $Message ([int]((Get-Date) - $state.Started).TotalMilliseconds)
  Write-Log "Terminal job $($state.Id) finished with exit code $ExitCode"
}

function Start-PtySession($Id, [string]$Spec) {
  if ($script:LivePty) { Complete-PtySession 'Replaced by a new terminal session.' 0 }
  $shell = 'powershell'
  $user = ''
  foreach ($line in ($Spec -split "`r?`n")) {
    if ($line -match '^shell=(.*)$') { $shell = $Matches[1].Trim() }
    elseif ($line -match '^user=(.*)$') { $user = $Matches[1].Trim() }
  }
  if ($shell -ne 'cmd') { $shell = 'powershell' }
  $account = [string]$env:USERNAME
  if ($user -and $user -ne $account) {
    $message = "SnippyCode: Windows agents run as the service account ($account) and cannot switch to $user without a password."
    try { Send-PtyExchange $Id ([Text.Encoding]::UTF8.GetBytes("$message`r`n")) $false 1 $message | Out-Null } catch { }
    Send-PtyResult $Id 1 '' $message 0
    return
  }

  $psi = New-Object System.Diagnostics.ProcessStartInfo
  if ($shell -eq 'cmd') {
    $psi.FileName = 'cmd.exe'
    $psi.Arguments = '/q /k'
  } else {
    $psi.FileName = 'powershell.exe'
    # Not -NonInteractive: this session has to answer Read-Host and y/n prompts.
    $psi.Arguments = '-NoLogo -NoProfile -ExecutionPolicy Bypass -Command -'
  }
  $psi.UseShellExecute = $false
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true
  $psi.WorkingDirectory = "$($env:SystemDrive)\"
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $psi
  [void]$process.Start()

  $script:LivePty = @{
    Id = $Id
    Process = $process
    Shell = $shell
    Started = Get-Date
    LastIo = Get-Date
    Failures = 0
    OutBuf = New-Object byte[] 8192
    ErrBuf = New-Object byte[] 4096
    OutTask = $null
    ErrTask = $null
    Note = [Text.Encoding]::UTF8.GetBytes("SnippyCode terminal ($shell, account $account). Keystrokes go to this shell. This is not a full Windows console.`r`n")
  }
  Write-Log "Interactive terminal job $Id started ($shell as $account)"
}

function Sync-PtySession {
  $state = $script:LivePty
  if (-not $state) { return }
  try {
    $now = Get-Date
    if (($now - $state.Started).TotalHours -ge 4) {
      Complete-PtySession 'The session reached the 4 hour limit.' 0
      return
    }
    if (($now - $state.LastIo).TotalMinutes -ge 15) {
      Complete-PtySession 'The session was closed after 15 minutes with nothing typed and no output.' 0
      return
    }
    if ($state.Failures -ge 8) {
      Complete-PtySession 'The session lost contact with SnippyCode.' 1
      return
    }

    $chunks = @()
    if ($state.Note) { $chunks += ,$state.Note; $state.Note = $null }
    $stdout = Read-PtyChunk $state.Process.StandardOutput.BaseStream $state.OutBuf $state.OutTask
    $stderr = Read-PtyChunk $state.Process.StandardError.BaseStream $state.ErrBuf $state.ErrTask
    $state.OutTask = $stdout.Task
    $state.ErrTask = $stderr.Task
    if ($stdout.Data.Length) { $chunks += ,$stdout.Data }
    if ($stderr.Data.Length) { $chunks += ,$stderr.Data }
    $output = Join-PtyBytes $chunks
    if ($output.Length) { $state.LastIo = Get-Date }
    $alive = -not $state.Process.HasExited -and -not $stdout.Eof
    if (-not $alive) {
      $code = if ($state.Process.HasExited) { $state.Process.ExitCode } else { 0 }
      Complete-PtySession 'The shell exited.' $code $output
      return
    }

    $reply = Send-PtyExchange $state.Id $output $true $null ''
    $data = $reply.data
    if (-not $data) { return }
    $state.Failures = 0
    if ($data.close) {
      Complete-PtySession 'Session closed.' 0
      return
    }
    if ($data.input) {
      $inBytes = [Convert]::FromBase64String([string]$data.input)
      if ($inBytes.Length) {
        $state.Process.StandardInput.BaseStream.Write($inBytes, 0, $inBytes.Length)
        $state.Process.StandardInput.BaseStream.Flush()
        $state.LastIo = Get-Date
      }
    }
    if ($data.signal -eq 'INT' -or $data.signal -eq 'TERM') {
      # No console, so Ctrl+C is a best-effort byte. Close the session to kill the process.
      $break = [byte[]](3)
      $state.Process.StandardInput.BaseStream.Write($break, 0, 1)
      $state.Process.StandardInput.BaseStream.Flush()
      $state.LastIo = Get-Date
    }
    if ($data.user -and [string]$data.user -ne [string]$env:USERNAME) {
      $note = "SnippyCode: Windows agents run as the service account ($env:USERNAME) and cannot switch to $($data.user).`r`n"
      $state.Note = [Text.Encoding]::UTF8.GetBytes($note)
    }
  } catch {
    if ($script:LivePty) { $script:LivePty.Failures += 1 }
    Write-Log "Terminal session error: $($_.Exception.Message)"
  }
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
    # An open terminal has to be pumped; don't sit in a 25s poll while it is live.
    $wait = if ($script:LivePty) { 0 } else { 25 }
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
