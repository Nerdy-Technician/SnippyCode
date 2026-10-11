<#
  SnippyCode agent for Windows.

  Polls SnippyCode for jobs queued for this device, runs them here, and sends
  back the output. Installed and started by install.ps1 as a scheduled task
  running as SYSTEM; settings live in C:\ProgramData\SnippyCode\agent.json.
#>
$ErrorActionPreference = 'Stop'
$AgentVersion = '1.3.0'
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

function Get-Capabilities {
  $found = @('powershell', 'cmd')
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

# Replace this script with the server's newer agent and start it again. The
# new file must parse and report the expected version before it is used.
function Update-Agent([string]$Latest) {
  if ($config.PSObject.Properties['AutoUpdate'] -and -not $config.AutoUpdate) { return }
  $self = $PSCommandPath
  $new = Join-Path $Work 'agent.new.ps1'
  try {
    Invoke-WebRequest -UseBasicParsing -Uri "$Url/agent/snippycode-agent.ps1" -OutFile $new -TimeoutSec 60
    $errors = $null
    [System.Management.Automation.Language.Parser]::ParseFile($new, [ref]$null, [ref]$errors) | Out-Null
    if ($errors.Count -gt 0 -or -not (Select-String -Path $new -Pattern "AgentVersion = '$Latest'" -Quiet)) {
      throw 'The downloaded agent did not check out'
    }
    Move-Item -Force $new $self
    Write-Log "Updated from $AgentVersion to $Latest; restarting"
    Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden `
      -ArgumentList "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$self`""
    exit 0
  } catch {
    Remove-Item $new -Force -ErrorAction SilentlyContinue
    Write-Log "Update to $Latest failed ($($_.Exception.Message)); staying on $AgentVersion"
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
    $caps = [uri]::EscapeDataString((Get-Capabilities))
    $response = Invoke-WebRequest -UseBasicParsing -Uri "$Url/api/agent/next?wait=25&version=$AgentVersion&caps=$caps" `
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
      Write-Log "Running job $id ($language)"
      Invoke-Job $id $language $timeout $code
    }
    $backoff = 5
  } catch {
    $status = $null
    if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
    if ($status -eq 401 -or $status -eq 403) {
      Write-Log 'The device token was rejected (revoked?). Retrying in 5 minutes.'
      Start-Sleep -Seconds 300
    } else {
      Write-Log "SnippyCode is not reachable ($($_.Exception.Message)). Retrying in ${backoff}s."
      Start-Sleep -Seconds $backoff
      $backoff = [math]::Min($backoff * 2, 60)
    }
  }
}
