# SNIPPYCODE_PTY_HELPER
<#
  ConPTY bridge for one SnippyCode terminal session on Windows.

  The agent starts this in its own PowerShell process for language "pty", so
  one-shot jobs keep running while a session is open. It posts output and
  long-polls for keystrokes on /api/agent/jobs/<id>/tty.

  Windows 10 1809+ / Server 2019+ get a real pseudo console (full-screen
  programs, Ctrl+C, console-only prompts). Older builds fall back to redirected
  pipes. Running as SYSTEM, it can open the shell as any user who is signed in
  (console or RDP) using that session's token, so no password is needed.
#>
param([Parameter(Mandatory = $true)][int]$JobId, [Parameter(Mandatory = $true)][string]$SpecPath)
$ErrorActionPreference = 'Stop'

$Url = $env:SNIPPYCODE_URL.TrimEnd('/')
$Headers = @{ Authorization = "Bearer $($env:SNIPPYCODE_TOKEN)" }
if ($env:SNIPPYCODE_FINGERPRINT) { $Headers['X-Agent-Fingerprint'] = $env:SNIPPYCODE_FINGERPRINT }

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

public sealed class SnippyPty : IDisposable {
  [StructLayout(LayoutKind.Sequential)] struct COORD { public short X; public short Y; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct STARTUPINFO {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX; public int dwY; public int dwXSize; public int dwYSize; public int dwXCountChars;
    public int dwYCountChars; public int dwFillAttribute; public int dwFlags; public short wShowWindow;
    public short cbReserved2; public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
  }
  [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }
  [StructLayout(LayoutKind.Sequential)] struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public int bInheritHandle; }
  [StructLayout(LayoutKind.Sequential)] struct WTS_SESSION_INFO { public int SessionId; public IntPtr pWinStationName; public int State; }

  const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000, CREATE_UNICODE_ENVIRONMENT = 0x00000400, CREATE_NO_WINDOW = 0x08000000;
  const uint CREATE_NEW_PROCESS_GROUP = 0x00000200;
  static readonly IntPtr PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE = (IntPtr)0x00020016;
  const int STARTF_USESTDHANDLES = 0x100;

  [DllImport("kernel32.dll", SetLastError = true)] static extern int CreatePseudoConsole(COORD size, SafeFileHandle hInput, SafeFileHandle hOutput, uint flags, out IntPtr phPC);
  [DllImport("kernel32.dll", SetLastError = true)] static extern int ResizePseudoConsole(IntPtr hPC, COORD size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern void ClosePseudoConsole(IntPtr hPC);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CreatePipe(out SafeFileHandle r, out SafeFileHandle w, ref SECURITY_ATTRIBUTES sa, int size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(SafeFileHandle h, int mask, int flags);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attr, IntPtr value, IntPtr size, IntPtr prev, IntPtr retSize);
  [DllImport("kernel32.dll", SetLastError = true)] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CreateProcessW(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFOEX si, out PROCESS_INFORMATION pi);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CreateProcessAsUserW(IntPtr token, string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFOEX si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr h, uint code);
  [DllImport("wtsapi32.dll", SetLastError = true)] static extern bool WTSEnumerateSessions(IntPtr server, int reserved, int version, out IntPtr info, out int count);
  [DllImport("wtsapi32.dll", SetLastError = true)] static extern bool WTSQuerySessionInformation(IntPtr server, int session, int infoClass, out IntPtr buffer, out int bytes);
  [DllImport("wtsapi32.dll")] static extern void WTSFreeMemory(IntPtr p);
  [DllImport("wtsapi32.dll", SetLastError = true)] static extern bool WTSQueryUserToken(int session, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool DuplicateTokenEx(IntPtr token, uint access, IntPtr sa, int level, int type, out IntPtr dup);
  [DllImport("userenv.dll", SetLastError = true)] static extern bool CreateEnvironmentBlock(out IntPtr env, IntPtr token, bool inherit);
  [DllImport("userenv.dll", SetLastError = true)] static extern bool DestroyEnvironmentBlock(IntPtr env);
  [DllImport("userenv.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool GetUserProfileDirectoryW(IntPtr token, StringBuilder dir, ref int size);

  IntPtr hpc = IntPtr.Zero, process = IntPtr.Zero;
  public Stream Input; public Stream Output;
  public int ProcessId;
  public bool Pseudo;

  public static bool Supported {
    get {
      IntPtr k = LoadLibrary("kernel32.dll");
      return k != IntPtr.Zero && GetProcAddress(k, "CreatePseudoConsole") != IntPtr.Zero;
    }
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Ansi)] static extern IntPtr LoadLibrary(string name);
  [DllImport("kernel32.dll", CharSet = CharSet.Ansi)] static extern IntPtr GetProcAddress(IntPtr m, string name);

  /// Session id of a signed-in user (console or RDP), or -1.
  public static int FindSession(string user) {
    IntPtr info; int count;
    if (!WTSEnumerateSessions(IntPtr.Zero, 0, 1, out info, out count)) return -1;
    try {
      int size = Marshal.SizeOf(typeof(WTS_SESSION_INFO));
      int best = -1;
      for (int i = 0; i < count; i++) {
        var s = (WTS_SESSION_INFO)Marshal.PtrToStructure(new IntPtr(info.ToInt64() + i * size), typeof(WTS_SESSION_INFO));
        IntPtr buf; int bytes;
        if (!WTSQuerySessionInformation(IntPtr.Zero, s.SessionId, 5 /* WTSUserName */, out buf, out bytes)) continue;
        string name = Marshal.PtrToStringAnsi(buf); WTSFreeMemory(buf);
        if (!string.Equals(name, user, StringComparison.OrdinalIgnoreCase)) continue;
        if (s.State == 0 /* WTSActive */) return s.SessionId;
        if (best < 0) best = s.SessionId;
      }
      return best;
    } finally { WTSFreeMemory(info); }
  }

  public static IntPtr UserToken(string user) {
    int session = FindSession(user);
    if (session < 0) throw new InvalidOperationException(user + " is not signed in on this machine (console or remote desktop).");
    IntPtr token, primary;
    if (!WTSQueryUserToken(session, out token)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not get " + user + "'s session token (the agent must run as SYSTEM)");
    try {
      if (!DuplicateTokenEx(token, 0x02000000 /* MAXIMUM_ALLOWED */, IntPtr.Zero, 2 /* impersonation */, 1 /* primary */, out primary))
        throw new Win32Exception(Marshal.GetLastWin32Error());
    } finally { CloseHandle(token); }
    return primary;
  }

  public static SnippyPty Start(string commandLine, string cwd, short cols, short rows, IntPtr token) {
    var pty = new SnippyPty();
    var sa = new SECURITY_ATTRIBUTES { nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)), bInheritHandle = 1 };
    SafeFileHandle inRead, inWrite, outRead, outWrite;
    if (!CreatePipe(out inRead, out inWrite, ref sa, 0) || !CreatePipe(out outRead, out outWrite, ref sa, 0))
      throw new Win32Exception(Marshal.GetLastWin32Error(), "CreatePipe");
    pty.Pseudo = Supported;
    var si = new STARTUPINFOEX();
    si.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
    IntPtr attrs = IntPtr.Zero;
    uint flags = CREATE_UNICODE_ENVIRONMENT;
    bool inherit = false;
    if (pty.Pseudo) {
      int hr = CreatePseudoConsole(new COORD { X = cols, Y = rows }, inRead, outWrite, 0, out pty.hpc);
      if (hr != 0) throw new Win32Exception(hr, "CreatePseudoConsole");
      IntPtr size = IntPtr.Zero;
      InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
      attrs = Marshal.AllocHGlobal(size);
      if (!InitializeProcThreadAttributeList(attrs, 1, 0, ref size)) throw new Win32Exception(Marshal.GetLastWin32Error());
      if (!UpdateProcThreadAttribute(attrs, 0, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, pty.hpc, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero))
        throw new Win32Exception(Marshal.GetLastWin32Error());
      si.lpAttributeList = attrs;
      flags |= EXTENDED_STARTUPINFO_PRESENT;
    } else {
      // Pre-1809 fallback: plain pipes, no console.
      SetHandleInformation(inWrite, 1, 0);
      SetHandleInformation(outRead, 1, 0);
      si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
      si.StartupInfo.hStdInput = inRead.DangerousGetHandle();
      si.StartupInfo.hStdOutput = outWrite.DangerousGetHandle();
      si.StartupInfo.hStdError = outWrite.DangerousGetHandle();
      flags |= CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP;
      inherit = true;
    }
    IntPtr env = IntPtr.Zero;
    PROCESS_INFORMATION pi;
    try {
      bool ok;
      if (token != IntPtr.Zero) {
        CreateEnvironmentBlock(out env, token, false);
        int len = 260; var dir = new StringBuilder(len);
        if (GetUserProfileDirectoryW(token, dir, ref len)) cwd = dir.ToString();
        si.StartupInfo.lpDesktop = "winsta0\\default";
        ok = CreateProcessAsUserW(token, null, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, inherit, flags, env, cwd, ref si, out pi);
      } else {
        ok = CreateProcessW(null, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, inherit, flags, IntPtr.Zero, cwd, ref si, out pi);
      }
      if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateProcess");
    } finally {
      if (env != IntPtr.Zero) DestroyEnvironmentBlock(env);
      if (attrs != IntPtr.Zero) { DeleteProcThreadAttributeList(attrs); Marshal.FreeHGlobal(attrs); }
    }
    CloseHandle(pi.hThread);
    pty.process = pi.hProcess;
    pty.ProcessId = pi.dwProcessId;
    // The console (or child) owns these ends now.
    inRead.Dispose(); outWrite.Dispose();
    pty.Input = new FileStream(inWrite, FileAccess.Write, 1, false);
    pty.Output = new FileStream(outRead, FileAccess.Read, 1, false);
    return pty;
  }

  public void Resize(short cols, short rows) {
    if (hpc != IntPtr.Zero && cols > 0 && rows > 0) ResizePseudoConsole(hpc, new COORD { X = cols, Y = rows });
  }

  public bool HasExited { get { return process == IntPtr.Zero || WaitForSingleObject(process, 0) == 0; } }

  public int ExitCode { get { uint c; return GetExitCodeProcess(process, out c) ? (int)c : 1; } }

  public void Kill() { if (process != IntPtr.Zero && !HasExited) TerminateProcess(process, 1); }

  public void Dispose() {
    Kill();
    if (hpc != IntPtr.Zero) { ClosePseudoConsole(hpc); hpc = IntPtr.Zero; }
    try { if (Input != null) Input.Dispose(); } catch { }
    try { if (Output != null) Output.Dispose(); } catch { }
    if (process != IntPtr.Zero) { CloseHandle(process); process = IntPtr.Zero; }
  }
}
'@

function Send-Exchange([byte[]]$Output, [string]$User, [bool]$Alive, $ExitCode, [string]$Message) {
  $b64 = ''
  if ($Output -and $Output.Length -gt 0) { $b64 = [Convert]::ToBase64String($Output) }
  $body = @{
    output = $b64; user = $User; alive = $Alive; privileged = $script:Privileged; tty = $script:Tty
    exitCode = $ExitCode; message = $Message
  } | ConvertTo-Json -Compress
  try {
    $reply = Invoke-RestMethod -Method Post -Uri "$Url/api/agent/jobs/$JobId/tty?wait=0.4" -Headers $Headers `
      -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 30
    $script:Failures = 0
    return $reply.data
  } catch {
    $status = $null
    if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
    if ($status -in 404, 409, 410) { return @{ close = $true } }
    $script:Failures += 1
    return $null
  }
}

function Start-Shell([string]$Shell, [string]$User, [int]$Cols, [int]$Rows) {
  $cmd = if ($Shell -eq 'cmd') { 'cmd.exe /q' } else { 'powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass' }
  if (-not [SnippyPty]::Supported) {
    # No console to draw a prompt in: read commands from stdin instead.
    $cmd = if ($Shell -eq 'cmd') { 'cmd.exe /q /k' } else { 'powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command -' }
  }
  $token = [IntPtr]::Zero
  if ($User -and $User -ne $env:USERNAME) { $token = [SnippyPty]::UserToken($User) }
  return [SnippyPty]::Start($cmd, "$($env:SystemDrive)\", [int16]$Cols, [int16]$Rows, $token)
}

function Start-Read($Pty, [byte[]]$Buffer) { return $Pty.Output.ReadAsync($Buffer, 0, $Buffer.Length) }

$shell = 'powershell'; $user = ''
foreach ($line in (Get-Content -LiteralPath $SpecPath)) {
  if ($line -match '^shell=(.*)$') { $shell = $Matches[1].Trim() }
  elseif ($line -match '^user=(.*)$') { $user = $Matches[1].Trim() }
}
if ($shell -ne 'cmd') { $shell = 'powershell' }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$script:Privileged = $identity.IsSystem
$script:Tty = [SnippyPty]::Supported
$script:Failures = 0
$active = if ($user) { $user } else { $env:USERNAME }

try {
  $pty = Start-Shell $shell $user 100 32
} catch {
  $msg = "SnippyCode: could not start the shell as ${active}: $($_.Exception.Message)"
  Send-Exchange ([Text.Encoding]::UTF8.GetBytes("$msg`r`n")) $env:USERNAME $false 1 $msg | Out-Null
  exit 1
}

$kind = if ($script:Tty) { 'Windows pseudo console' } else { 'redirected pipes (this Windows build has no ConPTY)' }
$pending = [Text.Encoding]::UTF8.GetBytes("SnippyCode terminal ($shell, account $active, $kind). Keystrokes go to this shell.`r`n")
$buffer = New-Object byte[] 32768
$read = Start-Read $pty $buffer
$started = Get-Date; $lastIo = $started
$exitCode = 0; $message = ''
$size = @{ Cols = 100; Rows = 32 }

try {
  while ($true) {
    $now = Get-Date
    if (($now - $started).TotalHours -ge 4) { $message = 'The session reached the 4 hour limit.'; break }
    if (($now - $lastIo).TotalMinutes -ge 15) { $message = 'The session was closed after 15 minutes with nothing typed and no output.'; break }
    if ($script:Failures -ge 8) { $message = 'The session lost contact with SnippyCode.'; break }

    $out = New-Object IO.MemoryStream
    if ($pending.Length) { $out.Write($pending, 0, $pending.Length); $pending = New-Object byte[] 0 }
    $deadline = (Get-Date).AddMilliseconds(250)
    $eof = $false
    while ((Get-Date) -lt $deadline -and $out.Length -lt 32768) {
      if (-not $read.Wait(30)) { if ($out.Length) { break } else { continue } }
      $n = 0
      try { $n = [int]$read.Result } catch { $n = 0 }
      if ($n -le 0) { $eof = $true; break }
      $out.Write($buffer, 0, $n)
      $read = Start-Read $pty $buffer
    }
    $chunk = $out.ToArray()
    if ($chunk.Length) { $lastIo = Get-Date }

    if ($eof -or $pty.HasExited) {
      $exitCode = if ($pty.HasExited) { $pty.ExitCode } else { 0 }
      Send-Exchange $chunk $active $true $null '' | Out-Null
      $message = 'The shell exited.'
      break
    }

    $data = Send-Exchange $chunk $active $true $null ''
    if (-not $data) { Start-Sleep -Milliseconds 400; continue }
    if ($data.close) { $message = 'Session closed.'; break }

    if ($data.input) {
      $bytes = [Convert]::FromBase64String([string]$data.input)
      if ($bytes.Length) { $pty.Input.Write($bytes, 0, $bytes.Length); $pty.Input.Flush(); $lastIo = Get-Date }
    }
    if ($data.signal -eq 'INT' -or $data.signal -eq 'TERM') {
      # Through a pseudo console, ETX is delivered as a real Ctrl+C event.
      $etx = [byte[]](3)
      $pty.Input.Write($etx, 0, 1); $pty.Input.Flush()
      if ($data.signal -eq 'TERM' -and -not $script:Tty) { & taskkill.exe /T /F /PID $pty.ProcessId | Out-Null }
    }
    $cols = [int]$data.cols; $rows = [int]$data.rows
    if ($cols -gt 0 -and $rows -gt 0 -and ($cols -ne $size.Cols -or $rows -ne $size.Rows)) {
      $pty.Resize([int16]$cols, [int16]$rows); $size.Cols = $cols; $size.Rows = $rows
    }
    $requested = [string]$data.user
    if ($requested -and $requested -ne $active) {
      try {
        $next = Start-Shell $shell $requested $size.Cols $size.Rows
        $pty.Dispose()
        $pty = $next
        $read = Start-Read $pty $buffer
        $active = $requested
        $pending = [Text.Encoding]::UTF8.GetBytes("`r`nSnippyCode: switched to $requested`r`n")
      } catch {
        $pending = [Text.Encoding]::UTF8.GetBytes("`r`nSnippyCode: cannot switch to ${requested}: $($_.Exception.Message)`r`n")
      }
      $lastIo = Get-Date
    }
  }
} finally {
  try { & taskkill.exe /T /F /PID $pty.ProcessId 2>$null | Out-Null } catch { }
  $pty.Dispose()
  Send-Exchange (New-Object byte[] 0) $active $false $exitCode $message | Out-Null
}
exit 0
