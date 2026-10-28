/**
 * Built-in device tools, in the spirit of an RMM: read the machine's
 * services, scheduled tasks, processes, software, updates and error logs,
 * and act on them. Each tool is a script per OS that the agent runs like any
 * other job. Linux scripts print tab-separated rows (no jq or python needed);
 * Windows scripts print JSON. Parsers turn both into the same shapes.
 */

export type ToolOs = 'linux' | 'windows';

export type ReadTool = 'system' | 'services' | 'tasks' | 'processes' | 'software' | 'updates' | 'logs';
export type ActionTool = 'service' | 'task' | 'process' | 'shell' | 'crontab' | 'patch' | 'files' | 'fileget' | 'fileput';
export type ToolId = ReadTool | ActionTool;

export const READ_TOOLS: ReadTool[] = ['system', 'services', 'tasks', 'processes', 'software', 'updates', 'logs'];
export const ACTION_TOOLS: ActionTool[] = ['service', 'task', 'process', 'shell', 'crontab', 'patch', 'files', 'fileget', 'fileput'];

/** Tools that only read, so viewers may use them too */
export const VIEW_TOOLS: ToolId[] = ['files'];

/** Largest file the browser can download or upload through the agent */
export const MAX_FILE_BYTES = 700 * 1024;

/** Marker a terminal command prints so the next one starts in the same folder */
export const CWD_MARKER = '__SNIPPYCODE_CWD__';

/** Cron lines SnippyCode switched off start with this, so they can come back */
export const CRON_OFF_MARKER = '#off# ';

export interface ServiceInfo {
  name: string;
  displayName: string;
  status: 'running' | 'stopped' | 'failed' | 'other';
  state: string;
  startup: string;
  account?: string;
}

export interface TaskInfo {
  id: string;
  kind: 'cron' | 'timer' | 'periodic' | 'windows';
  name: string;
  schedule: string;
  user?: string;
  command: string;
  source: string;
  nextRun?: string;
  lastRun?: string;
  lastResult?: string;
  enabled: boolean;
  state?: string;
  /** Cron: the line as written in the file, and which file to edit */
  raw?: string;
  target?: string;
}

export interface ProcessInfo {
  pid: number;
  name: string;
  user?: string;
  cpu: number;
  cpuUnit: 'percent' | 'seconds';
  memMb: number;
  elapsedSeconds?: number;
}

export interface SoftwareInfo {
  name: string;
  version: string;
  publisher?: string;
  installed?: string;
}

export interface UpdateInfo {
  name: string;
  version?: string;
  from?: string;
  source?: string;
  security: boolean;
}

export interface LogEntry {
  time: string;
  level: string;
  source: string;
  message: string;
}

export interface SystemAudit {
  os?: string;
  kernel?: string;
  arch?: string;
  hostname?: string;
  manufacturer?: string;
  model?: string;
  serial?: string;
  cpu?: string;
  cores?: number;
  load?: string;
  boot?: string;
  users?: string;
  memTotalMb?: number;
  disks: { mount: string; device: string; type: string; totalGb: number; usedGb: number }[];
  networks: { name: string; address: string }[];
}

// Validation -----------------------------------------------------------------

const LINUX_UNIT = /^[A-Za-z0-9@._:\\-]{1,200}$/;
// eslint-disable-next-line no-control-regex -- rejects NUL bytes on purpose
const WINDOWS_NAME = /^[^\r\n"`$\x00]{1,256}$/;

/**
 * A bash single-quoted word. Unit names are checked against LINUX_UNIT first,
 * so they never contain a quote; quoting keeps systemd escapes like \x2d.
 */
const shQuote = (value: string): string => `'${value}'`;

/** Any value as one bash word: single quotes, with embedded ones closed and reopened */
const shQuoteAny = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/** A PowerShell single-quoted string; only ' needs escaping (doubled). */
const psQuote = (value: string): string => `'${value.replace(/'/g, "''")}'`;

export class ToolError extends Error {}

const need = (condition: unknown, message: string): void => {
  if (!condition) {
    throw new ToolError(message);
  }
};

// Scripts ---------------------------------------------------------------------

const LINUX_HEADER = 'export LC_ALL=C\nset +e\n';
const WIN_HEADER =
  "$ErrorActionPreference = 'Continue'\n$ProgressPreference = 'SilentlyContinue'\n[Console]::OutputEncoding = [Text.Encoding]::UTF8\n";

const linuxRead: { [tool in ReadTool]: string } = {
  system: `
kv() { printf 'kv\\t%s\\t%s\\n' "$1" "$(printf '%s' "$2" | tr '\\t\\n' '  ')"; }
[ -r /etc/os-release ] && . /etc/os-release
kv os "\${PRETTY_NAME:-$(uname -s)}"
kv kernel "$(uname -r)"
kv arch "$(uname -m)"
kv hostname "$(hostname -f 2>/dev/null || hostname)"
kv manufacturer "$(cat /sys/class/dmi/id/sys_vendor 2>/dev/null)"
kv model "$(cat /sys/class/dmi/id/product_name 2>/dev/null)"
kv serial "$(cat /sys/class/dmi/id/product_serial 2>/dev/null)"
kv cpu "$(awk -F': ' '/^model name/ {print $2; exit}' /proc/cpuinfo 2>/dev/null)"
kv cores "$(nproc 2>/dev/null)"
kv load "$(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null)"
kv boot "$(uptime -s 2>/dev/null)"
kv users "$(who 2>/dev/null | awk '{print $1}' | sort -u | paste -sd, -)"
kv memTotalMb "$(awk '/^MemTotal:/ {printf "%d", $2 / 1024}' /proc/meminfo 2>/dev/null)"
df -PT -x tmpfs -x devtmpfs -x squashfs -x overlay -x efivarfs 2>/dev/null | awk 'NR > 1 {printf "disk\\t%s\\t%s\\t%s\\t%.1f\\t%.1f\\n", $7, $1, $2, $3 / 1048576, $4 / 1048576}'
ip -o -4 addr show 2>/dev/null | awk '$2 != "lo" {printf "net\\t%s\\t%s\\n", $2, $4}'
`,
  services: `
command -v systemctl >/dev/null || { echo "systemd is not available on this device" >&2; exit 2; }
systemctl list-unit-files --type=service --no-legend --no-pager 2>/dev/null | awk '{printf "file\\t%s\\t%s\\n", $1, $2}'
systemctl list-units --type=service --all --no-legend --no-pager --plain 2>/dev/null | awk '{d = ""; for (i = 5; i <= NF; i++) d = d (i > 5 ? " " : "") $i; printf "unit\\t%s\\t%s\\t%s\\t%s\\n", $1, $3, $4, d}'
`,
  tasks: `
for f in /var/spool/cron/crontabs/* /var/spool/cron/*; do
  [ -f "$f" ] || continue
  u="$(basename "$f")"
  grep -vE '^[[:space:]]*(#|$)' "$f" | grep -vE '^[A-Za-z_][A-Za-z0-9_]*=' | while IFS= read -r line; do
    printf 'cron\\t%s\\t%s\\t%s\\n' "$f" "$u" "$line"
  done
  sed -n 's/^#off# //p' "$f" | while IFS= read -r line; do
    printf 'cronoff\\t%s\\t%s\\t%s\\n' "$f" "$u" "$line"
  done
done
for f in /etc/crontab /etc/cron.d/*; do
  [ -f "$f" ] || continue
  grep -vE '^[[:space:]]*(#|$)' "$f" | grep -vE '^[A-Za-z_][A-Za-z0-9_]*=' | while IFS= read -r line; do
    printf 'syscron\\t%s\\t%s\\n' "$f" "$line"
  done
  sed -n 's/^#off# //p' "$f" | while IFS= read -r line; do
    printf 'syscronoff\\t%s\\t%s\\n' "$f" "$line"
  done
done
for p in hourly daily weekly monthly; do
  for f in /etc/cron.$p/*; do
    [ -f "$f" ] && [ -x "$f" ] && printf 'periodic\\t%s\\t%s\\n' "$p" "$f"
  done
done
if command -v systemctl >/dev/null; then
  for t in $(systemctl list-units --type=timer --all --no-legend --no-pager --plain 2>/dev/null | awk '{print $1}'); do
    systemctl show "$t" -p Id -p Unit -p NextElapseUSecRealtime -p LastTriggerUSec -p ActiveState -p UnitFileState -p Description -p TimersCalendar 2>/dev/null \\
      | awk '{ i = index($0, "="); v[substr($0, 1, i - 1)] = substr($0, i + 1) } END { gsub(/\\t/, " ", v["TimersCalendar"]); printf "timer\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n", v["Id"], v["Unit"], v["NextElapseUSecRealtime"], v["LastTriggerUSec"], v["ActiveState"], v["UnitFileState"], v["Description"], v["TimersCalendar"] }'
  done
fi
`,
  processes: `
ps -eo pid=,user=,pcpu=,rss=,etimes=,comm= --sort=-pcpu 2>/dev/null | head -n 1500 | awk '{c = ""; for (i = 6; i <= NF; i++) c = c (i > 6 ? " " : "") $i; printf "proc\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n", $1, $2, $3, $4, $5, c}'
`,
  software: `
if command -v dpkg-query >/dev/null; then
  dpkg-query -W -f='pkg\\t\${Package}\\t\${Version}\\t\${db:Status-Abbrev}\\n' 2>/dev/null | awk -F'\\t' '$4 ~ /^ii/ {printf "pkg\\t%s\\t%s\\n", $2, $3}'
elif command -v rpm >/dev/null; then
  rpm -qa --qf 'pkg\\t%{NAME}\\t%{VERSION}-%{RELEASE}\\t%{VENDOR}\\n' 2>/dev/null
elif command -v apk >/dev/null; then
  apk info -v 2>/dev/null | sed 's/-\\([0-9][^-]*-r[0-9]*\\)$/\\t\\1/' | awk -F'\\t' '{printf "pkg\\t%s\\t%s\\n", $1, $2}'
fi
`,
  updates: `
if command -v apt >/dev/null; then
  apt list --upgradable 2>/dev/null | tail -n +2 | sed 's/^/apt\\t/'
elif command -v dnf >/dev/null; then
  dnf -q check-update 2>/dev/null | awk 'NF == 3 {printf "dnf\\t%s\\t%s\\t%s\\n", $1, $2, $3}'
fi
[ -f /var/run/reboot-required ] && printf 'reboot\\t1\\n'
exit 0
`,
  logs: `
if command -v journalctl >/dev/null; then
  journalctl -p warning -n 200 --no-pager -o short-iso 2>/dev/null | grep -v '^-- ' | sed 's/^/j\\t/'
else
  tail -n 400 /var/log/syslog /var/log/messages 2>/dev/null | grep -iE 'error|fail|crit|warn' | tail -n 200 | sed 's/^/s\\t/'
fi
`
};

const windowsRead: { [tool in ReadTool]: string } = {
  system: `
$os = Get-CimInstance Win32_OperatingSystem
$cs = Get-CimInstance Win32_ComputerSystem
$bios = Get-CimInstance Win32_BIOS
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
[pscustomobject]@{
  os = $os.Caption; kernel = $os.Version; arch = $os.OSArchitecture
  hostname = $env:COMPUTERNAME; manufacturer = $cs.Manufacturer; model = $cs.Model
  serial = $bios.SerialNumber; cpu = $cpu.Name; cores = $cs.NumberOfLogicalProcessors
  load = "$($cpu.LoadPercentage)%"; boot = $os.LastBootUpTime.ToString('s'); users = [string]$cs.UserName
  memTotalMb = [math]::Round($os.TotalVisibleMemorySize / 1024)
  disks = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object {
    [pscustomobject]@{ mount = $_.DeviceID; device = $_.VolumeName; type = $_.FileSystem
      totalGb = [math]::Round($_.Size / 1GB, 1); usedGb = [math]::Round(($_.Size - $_.FreeSpace) / 1GB, 1) } })
  networks = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -ne '127.0.0.1' } | ForEach-Object {
    [pscustomobject]@{ name = $_.InterfaceAlias; address = "$($_.IPAddress)/$($_.PrefixLength)" } })
} | ConvertTo-Json -Depth 4 -Compress
`,
  services: `
Get-CimInstance Win32_Service | ForEach-Object {
  [pscustomobject]@{ name = $_.Name; displayName = $_.DisplayName; state = [string]$_.State; startup = [string]$_.StartMode; account = [string]$_.StartName }
} | ConvertTo-Json -Compress
`,
  tasks: `
Get-ScheduledTask | Where-Object { $_.TaskPath -notlike '\\Microsoft\\*' } | ForEach-Object {
  $info = $_ | Get-ScheduledTaskInfo -ErrorAction SilentlyContinue
  [pscustomobject]@{
    name = $_.TaskName; path = $_.TaskPath; state = [string]$_.State; user = [string]$_.Principal.UserId
    command = (($_.Actions | ForEach-Object { ("$($_.Execute) $($_.Arguments)").Trim() }) -join '; ')
    triggers = (($_.Triggers | ForEach-Object { ($_.CimClass.CimClassName -replace '^MSFT_Task', '' -replace 'Trigger$', '') }) -join ', ')
    nextRun = if ($info -and $info.NextRunTime) { $info.NextRunTime.ToString('s') } else { '' }
    lastRun = if ($info -and $info.LastRunTime -and $info.LastRunTime.Year -gt 2000) { $info.LastRunTime.ToString('s') } else { '' }
    lastResult = if ($info) { '0x{0:X}' -f $info.LastTaskResult } else { '' }
  }
} | ConvertTo-Json -Compress
`,
  processes: `
Get-Process | Sort-Object CPU -Descending | Select-Object -First 1000 | ForEach-Object {
  [pscustomobject]@{ pid = $_.Id; name = $_.ProcessName; cpu = [math]::Round([double]$_.CPU, 1); memMb = [math]::Round($_.WorkingSet64 / 1MB) }
} | ConvertTo-Json -Compress
`,
  software: `
$keys = 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', 'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
Get-ItemProperty $keys -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -and -not $_.SystemComponent } | ForEach-Object {
  [pscustomobject]@{ name = $_.DisplayName; version = [string]$_.DisplayVersion; publisher = [string]$_.Publisher; installed = [string]$_.InstallDate }
} | Sort-Object name -Unique | ConvertTo-Json -Compress
`,
  updates: `
$reboot = Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired'
$searcher = (New-Object -ComObject Microsoft.Update.Session).CreateUpdateSearcher()
$found = $searcher.Search("IsInstalled=0 and IsHidden=0")
[pscustomobject]@{
  reboot = $reboot
  updates = @($found.Updates | ForEach-Object {
    [pscustomobject]@{ name = $_.Title; version = (($_.KBArticleIDs | ForEach-Object { "KB$_" }) -join ', ')
      security = [bool]($_.Categories | Where-Object { $_.Name -match 'Security' }); source = [string]$_.MsrcSeverity } })
} | ConvertTo-Json -Depth 4 -Compress
`,
  logs: `
Get-WinEvent -FilterHashtable @{ LogName = @('System', 'Application'); Level = @(1, 2, 3) } -MaxEvents 200 -ErrorAction SilentlyContinue | ForEach-Object {
  $message = if ($_.Message) { $_.Message } else { '' }
  [pscustomobject]@{ time = $_.TimeCreated.ToString('s'); level = [string]$_.LevelDisplayName; source = "$($_.ProviderName) ($($_.Id))"; message = $message.Substring(0, [math]::Min(400, $message.Length)) }
} | ConvertTo-Json -Compress
`
};

export const TOOL_LABELS: { [tool in ToolId]: string } = {
  system: 'System audit',
  services: 'Services',
  tasks: 'Scheduled tasks',
  processes: 'Processes',
  software: 'Software',
  updates: 'Updates',
  logs: 'Event log',
  service: 'Service',
  task: 'Scheduled task',
  process: 'Process',
  shell: 'Shell command',
  crontab: 'Cron',
  patch: 'Patching',
  files: 'Files',
  fileget: 'Download file',
  fileput: 'Upload file'
};

/** Minutes a tool may take on the device */
const TOOL_TIMEOUT_MINUTES: { [tool in ToolId]?: number } = { updates: 15, software: 5, patch: 30, fileput: 5 };

export const toolTimeoutMs = (tool: ToolId): number => (TOOL_TIMEOUT_MINUTES[tool] || 2) * 60_000;

export interface ToolPlan {
  language: 'bash' | 'powershell' | 'bat';
  code: string;
  title: string;
}

/**
 * The script to send for a tool. Arguments are validated here; anything that
 * reaches a script is either a whitelisted keyword, a checked name, a number,
 * or (for PowerShell) a single-quoted literal.
 */
export const buildToolScript = (
  tool: ToolId,
  os: ToolOs,
  args: Record<string, unknown> = {}
): ToolPlan => {
  const language = os === 'windows' ? 'powershell' : 'bash';
  const header = os === 'windows' ? WIN_HEADER : LINUX_HEADER;

  if ((READ_TOOLS as string[]).includes(tool)) {
    let script = (os === 'windows' ? windowsRead : linuxRead)[tool as ReadTool];

    // "Check for updates": refresh the package lists before reading them
    if (tool === 'updates' && args.fetch && os === 'linux') {
      script = `(command -v apt-get >/dev/null && apt-get update -q >/dev/null 2>&1) || (command -v dnf >/dev/null && dnf -q makecache >/dev/null 2>&1)\n${script}`;
    }

    return { language, code: header + script.trim() + '\n', title: `${TOOL_LABELS[tool]}: refresh` };
  }

  if (tool === 'service') {
    const name = String(args.name || '');
    const action = String(args.action || '');
    need(['start', 'stop', 'restart', 'enable', 'disable'].includes(action), 'Unknown service action');

    if (os === 'linux') {
      need(LINUX_UNIT.test(name), 'Invalid service name');
      const unit = shQuote(name);
      const follow =
        action === 'enable' || action === 'disable'
          ? `systemctl is-enabled -- ${unit}`
          : `systemctl is-active -- ${unit}`;
      return {
        language,
        code: `${header}systemctl ${action} -- ${unit} || exit $?\n${follow}\n`,
        title: `Service ${name}: ${action}`
      };
    }

    need(WINDOWS_NAME.test(name), 'Invalid service name');
    const quoted = psQuote(name);
    const commands: { [key: string]: string } = {
      start: `Start-Service -Name ${quoted}`,
      stop: `Stop-Service -Name ${quoted} -Force`,
      restart: `Restart-Service -Name ${quoted} -Force`,
      enable: `Set-Service -Name ${quoted} -StartupType Automatic`,
      disable: `Set-Service -Name ${quoted} -StartupType Disabled`
    };
    return {
      language,
      code: `${header}$ErrorActionPreference = 'Stop'\n${commands[action]}\nGet-Service -Name ${quoted} | Select-Object Name, Status, StartType | Format-List | Out-String\n`,
      title: `Service ${name}: ${action}`
    };
  }

  if (tool === 'task') {
    const action = String(args.action || '');
    need(['run', 'enable', 'disable'].includes(action), 'Unknown task action');

    if (os === 'linux') {
      // Only systemd timers can be acted on; cron lines are read-only
      const timer = String(args.timer || '');
      const unit = String(args.unit || '');
      need(LINUX_UNIT.test(timer) && timer.endsWith('.timer'), 'Invalid timer');

      if (action === 'run') {
        need(LINUX_UNIT.test(unit), 'Invalid unit');
        return {
          language,
          code: `${header}systemctl start -- ${shQuote(unit)} || exit $?\nsystemctl status --no-pager -n 5 -- ${shQuote(unit)}\n`,
          title: `Timer ${timer}: run now`
        };
      }

      return {
        language,
        code: `${header}systemctl ${action} --now -- ${shQuote(timer)} || exit $?\nsystemctl is-enabled -- ${shQuote(timer)}\n`,
        title: `Timer ${timer}: ${action}`
      };
    }

    const name = String(args.name || '');
    const path = String(args.path || '\\');
    need(WINDOWS_NAME.test(name) && WINDOWS_NAME.test(path), 'Invalid task');
    const verb = { run: 'Start-ScheduledTask', enable: 'Enable-ScheduledTask', disable: 'Disable-ScheduledTask' }[action];
    return {
      language,
      code: `${header}$ErrorActionPreference = 'Stop'\n${verb} -TaskName ${psQuote(name)} -TaskPath ${psQuote(path)} | Out-Null\nGet-ScheduledTask -TaskName ${psQuote(name)} -TaskPath ${psQuote(path)} | Select-Object TaskName, State | Format-List | Out-String\n`,
      title: `Task ${name}: ${action === 'run' ? 'run now' : action}`
    };
  }

  if (tool === 'crontab') {
    need(os === 'linux', 'Cron editing is for Linux devices');
    const op = String(args.op || '');
    const target = parseCronTarget(String(args.target || ''));
    need(op === 'read' || op === 'write', 'Unknown crontab operation');

    if (op === 'read') {
      return {
        language,
        code:
          target.kind === 'user'
            ? `${header}crontab -u ${shQuote(target.user)} -l 2>/dev/null\nexit 0\n`
            : `${header}[ -f ${shQuote(target.path)} ] && cat ${shQuote(target.path)}\nexit 0\n`,
        title: `Cron ${target.label}: open`
      };
    }

    const raw = String(args.content ?? '');
    need(raw.length <= 64_000, 'That file is too big');
    const content = raw && !raw.endsWith('\n') ? `${raw}\n` : raw;
    // Base64 keeps every character of the file away from the shell
    const encoded = Buffer.from(content, 'utf8').toString('base64');
    const lines = [header.trim(), 'tmp="$(mktemp)"', `trap 'rm -f "$tmp"' EXIT`, `printf '%s' '${encoded}' | base64 -d > "$tmp" || exit 1`];

    if (target.kind === 'user') {
      // crontab checks the syntax itself and refuses a bad file
      lines.push(`crontab -u ${shQuote(target.user)} "$tmp" || { echo "Nothing was changed." >&2; exit 1; }`);
    } else {
      // System files need 5 time fields (or an @keyword), a user that exists
      // on this machine, and a command
      lines.push(
        `users=" $(cut -d: -f1 /etc/passwd | tr '\\n' ' ') "`,
        `bad="$(awk -v users="$users" '/^[[:space:]]*(#|$)/ || /^[A-Za-z_][A-Za-z0-9_]*=/ { next } { u = ($1 ~ /^@/) ? 2 : 6; if (NF < u + 1 || index(users, " " $u " ") == 0) printf "  line %d: %s\\n", NR, $0 }' "$tmp")"`,
        `[ -z "$bad" ] || { printf 'Each job needs a schedule, a user on this machine, and a command. Nothing was changed.\\n%s\\n' "$bad" >&2; exit 1; }`,
        'mkdir -p /var/backups/snippycode',
        `[ -f ${shQuote(target.path)} ] && cp -p ${shQuote(target.path)} "/var/backups/snippycode/$(basename ${shQuote(target.path)}).$(date +%Y%m%d%H%M%S)"`,
        `install -m 644 -o root -g root "$tmp" ${shQuote(target.path)} || exit $?`
      );
    }

    lines.push(`echo ${shQuote(`Saved ${target.label}`)}`);
    return { language, code: `${lines.join('\n')}\n`, title: `Cron ${target.label}: save` };
  }

  if (tool === 'process') {
    const pid = Number(args.pid);
    need(Number.isInteger(pid) && pid > 1, 'Invalid process id');
    const force = Boolean(args.force);

    return os === 'windows'
      ? { language, code: `${header}$ErrorActionPreference = 'Stop'\nStop-Process -Id ${pid} -Force\n"Stopped process ${pid}"\n`, title: `Process ${pid}: end` }
      : { language, code: `${header}kill -${force ? 'KILL' : 'TERM'} ${pid} || exit $?\necho "Sent ${force ? 'SIGKILL' : 'SIGTERM'} to ${pid}"\n`, title: `Process ${pid}: ${force ? 'kill' : 'end'}` };
  }

  if (tool === 'patch') {
    const mode = String(args.mode || 'security');
    const reboot = String(args.reboot || 'never');
    need(['security', 'all', 'selected'].includes(mode), 'Unknown patch mode');
    need(['never', 'if-required', 'always'].includes(reboot), 'Unknown reboot option');
    const packages = Array.isArray(args.packages) ? (args.packages as unknown[]).map(String) : [];

    if (os === 'linux') {
      need(mode !== 'selected' || (packages.length > 0 && packages.every(name => /^[A-Za-z0-9][A-Za-z0-9+._:~-]{0,120}$/.test(name))), 'Choose valid packages');
      const list = packages.join(' ');
      const apt = 'apt-get -y -q -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold';
      const aptInstall = { all: `${apt} upgrade`, security: `pkgs="$(apt list --upgradable 2>/dev/null | grep -i -- '-security' | cut -d/ -f1 | tr '\\n' ' ')"\n  if [ -n "$pkgs" ]; then ${apt} install --only-upgrade $pkgs; else echo "No security updates to install"; fi`, selected: `${apt} install --only-upgrade ${list}` }[mode];
      const dnfInstall = { all: 'dnf -y upgrade', security: 'dnf -y upgrade --security', selected: `dnf -y upgrade ${list}` }[mode];
      const rebootLine =
        reboot === 'always'
          ? 'echo "Restarting in 1 minute"; shutdown -r +1 "SnippyCode patching" || true'
          : reboot === 'if-required'
          ? 'if [ -f /var/run/reboot-required ] || (command -v needs-restarting >/dev/null && ! needs-restarting -r >/dev/null 2>&1); then echo "Restart required: restarting in 1 minute"; shutdown -r +1 "SnippyCode patching" || true; else echo "No restart needed"; fi'
          : '[ -f /var/run/reboot-required ] && echo "A restart is required to finish updating"';

      return {
        language,
        code: [
          header.trim(),
          'export DEBIAN_FRONTEND=noninteractive',
          'if command -v apt-get >/dev/null; then',
          '  apt-get update -q || exit $?',
          `  ${aptInstall} || exit $?`,
          'elif command -v dnf >/dev/null; then',
          `  ${dnfInstall} || exit $?`,
          'else',
          '  echo "No supported package manager (apt or dnf) found" >&2; exit 2',
          'fi',
          rebootLine,
          'exit 0'
        ].join('\n') + '\n',
        title: `Patching: ${mode === 'selected' ? `${packages.length} selected` : mode}${reboot !== 'never' ? `, reboot ${reboot}` : ''}`
      };
    }

    need(mode !== 'selected' || (packages.length > 0 && packages.every(kb => /^KB\d{4,9}$/i.test(kb))), 'Choose valid KB numbers');
    const filter =
      mode === 'all'
        ? '$true'
        : mode === 'security'
        ? "[bool]($u.Categories | Where-Object { $_.Name -match 'Security' })"
        : `@(${packages.map(kb => psQuote(kb.replace(/^KB/i, ''))).join(', ')}) -contains ([string]($u.KBArticleIDs | Select-Object -First 1))`;

    return {
      language,
      code: `${header}$ErrorActionPreference = 'Stop'
$session = New-Object -ComObject Microsoft.Update.Session
$found = $session.CreateUpdateSearcher().Search("IsInstalled=0 and IsHidden=0")
$wanted = New-Object -ComObject Microsoft.Update.UpdateColl
foreach ($u in $found.Updates) { if (${filter}) { if (-not $u.EulaAccepted) { $u.AcceptEula() }; [void]$wanted.Add($u) } }
if ($wanted.Count -eq 0) { "No matching updates to install"; exit 0 }
"Installing $($wanted.Count) updates"
$downloader = $session.CreateUpdateDownloader(); $downloader.Updates = $wanted; [void]$downloader.Download()
$installer = $session.CreateUpdateInstaller(); $installer.Updates = $wanted
$result = $installer.Install()
for ($i = 0; $i -lt $wanted.Count; $i++) { "{0}: {1}" -f $wanted.Item($i).Title, $result.GetUpdateResult($i).ResultCode }
${reboot === 'always' ? '"Restarting in 60 seconds"; shutdown.exe /r /t 60 /c "SnippyCode patching"' : reboot === 'if-required' ? 'if ($result.RebootRequired) { "Restart required: restarting in 60 seconds"; shutdown.exe /r /t 60 /c "SnippyCode patching" } else { "No restart needed" }' : 'if ($result.RebootRequired) { "A restart is required to finish updating" }'}
if ($result.ResultCode -gt 3) { exit 1 }
`,
      title: `Patching: ${mode === 'selected' ? `${packages.length} selected` : mode}${reboot !== 'never' ? `, reboot ${reboot}` : ''}`
    };
  }

  if (tool === 'files' || tool === 'fileget' || tool === 'fileput') {
    const path = String(args.path || '');
    // eslint-disable-next-line no-control-regex -- rejects NUL bytes on purpose
    need(path.length < 1024 && !/[\r\n\x00]/.test(path), 'Invalid path');

    if (tool === 'files') {
      if (os === 'windows') {
        return {
          language,
          code: path
            ? `${header}$ErrorActionPreference = 'Stop'\nGet-ChildItem -LiteralPath ${psQuote(path)} -Force | Select-Object -First 3000 | ForEach-Object { [pscustomobject]@{ name = $_.Name; type = if ($_.PSIsContainer) { 'd' } else { 'f' }; size = if ($_.PSIsContainer) { 0 } else { $_.Length }; modified = $_.LastWriteTime.ToString('s'); mode = [string]$_.Mode } } | ConvertTo-Json -Compress\n`
            : `${header}Get-PSDrive -PSProvider FileSystem | ForEach-Object { [pscustomobject]@{ name = $_.Root; type = 'd'; size = 0; modified = ''; mode = 'drive' } } | ConvertTo-Json -Compress\n`,
          title: `Files: ${path || 'drives'}`
        };
      }

      need(path.startsWith('/'), 'Use an absolute path');
      return {
        language,
        code: `${header}[ -d ${shQuoteAny(path)} ] || { echo "Not a folder: ${path.replace(/[^\w./ -]/g, '')}" >&2; exit 2; }\nfind ${shQuoteAny(path)} -mindepth 1 -maxdepth 1 -printf '%y\\t%s\\t%T@\\t%m\\t%u\\t%f\\n' 2>/dev/null | head -n 3000\n`,
        title: `Files: ${path}`
      };
    }

    need(os === 'windows' ? /^[A-Za-z]:\\/.test(path) || path.startsWith('\\\\') : path.startsWith('/'), 'Use an absolute path');

    if (tool === 'fileget') {
      return os === 'windows'
        ? {
            language,
            code: `${header}$ErrorActionPreference = 'Stop'\n$f = Get-Item -LiteralPath ${psQuote(path)}\nif ($f.Length -gt ${MAX_FILE_BYTES}) { throw "The file is larger than ${Math.round(MAX_FILE_BYTES / 1024)} KB" }\n[Convert]::ToBase64String([IO.File]::ReadAllBytes($f.FullName))\n`,
            title: `Download ${path}`
          }
        : {
            language,
            code: `${header}f=${shQuoteAny(path)}\n[ -f "$f" ] || { echo "Not a file" >&2; exit 2; }\n[ "$(stat -c %s "$f")" -le ${MAX_FILE_BYTES} ] || { echo "The file is larger than ${Math.round(MAX_FILE_BYTES / 1024)} KB" >&2; exit 2; }\nbase64 -w0 "$f"\n`,
            title: `Download ${path}`
          };
    }

    const content = String(args.content || '');
    need(/^[A-Za-z0-9+/=]*$/.test(content), 'Invalid file data');
    need(content.length <= Math.ceil(MAX_FILE_BYTES / 3) * 4 + 4, `Uploads are limited to ${Math.round(MAX_FILE_BYTES / 1024)} KB`);

    return os === 'windows'
      ? {
          language,
          code: `${header}$ErrorActionPreference = 'Stop'\n[IO.File]::WriteAllBytes(${psQuote(path)}, [Convert]::FromBase64String('${content}'))\n"Saved ${path.replace(/['"`$]/g, '')}"\n`,
          title: `Upload ${path}`
        }
      : {
          language,
          code: `${header}f=${shQuoteAny(path)}\ntmp="$(mktemp)"\nprintf '%s' '${content}' | base64 -d > "$tmp" || exit 1\nif [ -f "$f" ]; then cat "$tmp" > "$f" && rm -f "$tmp"; else mv "$tmp" "$f" && chmod 644 "$f"; fi || exit $?\necho "Saved $f ($(stat -c %s "$f") bytes)"\n`,
          title: `Upload ${path}`
        };
  }

  if (tool === 'shell') {
    const code = String(args.code || '');
    const shell = String(args.shell || (os === 'windows' ? 'powershell' : 'bash'));
    need(code.trim(), 'Type a command');
    need(code.length <= 20_000, 'That command is too long');
    need(os === 'windows' ? ['powershell', 'cmd'].includes(shell) : shell === 'bash', 'Unknown shell');
    const firstLine = code.trim().split('\n')[0].slice(0, 80);
    const cwd = typeof args.cwd === 'string' ? args.cwd : '';
    // eslint-disable-next-line no-control-regex -- rejects NUL bytes on purpose
    need(!cwd || (cwd.length < 1024 && !/[\r\n\x00]/.test(cwd)), 'Invalid folder');
    // cmd expands % and ! inside quotes, and a quote in the folder would break out of cd /d "..."
    if (args.terminal && shell === 'cmd' && cwd && /[%!^&|<>"]/.test(cwd)) {
      throw new ToolError('That folder cannot be used as a cmd working directory');
    }

    // One command, stdin closed by the agent. Interactive prompts use a pty session instead.
    // Terminal mode also reports the folder we ended in, and keeps the command's exit code.
    const wrapped = !args.terminal
      ? code
      : shell === 'cmd'
      ? `@echo off\r\n${cwd ? `cd /d "${cwd.replace(/"/g, '')}" 2>nul\r\n` : ''}${code}\r\nset __RC=%ERRORLEVEL%\r\necho.\r\necho ${CWD_MARKER}%CD%\r\nexit /b %__RC%\r\n`
      : os === 'windows'
      ? `${cwd ? `Set-Location -LiteralPath ${psQuote(cwd)} -ErrorAction SilentlyContinue\n` : ''}$LASTEXITCODE = $null\n${code}\n$__rc = 0\nif ($null -ne $LASTEXITCODE) { $__rc = $LASTEXITCODE } elseif (-not $?) { $__rc = 1 }\n"\n${CWD_MARKER}$((Get-Location).Path)"\nexit $__rc\n`
      : `${cwd ? `cd -- ${shQuoteAny(cwd)} 2>/dev/null || cd /\n` : ''}${code}\n__rc=$?\nprintf '\\n${CWD_MARKER}%s\\n' "$PWD"\nexit $__rc\n`;

    return {
      language: shell === 'cmd' ? 'bat' : language,
      code: wrapped,
      title: `Shell: ${firstLine}`
    };
  }

  throw new ToolError('Unknown tool');
};

type CronTarget =
  | { kind: 'user'; user: string; label: string }
  | { kind: 'file'; path: string; label: string };

/**
 * "user:NAME" for a user's crontab, or /etc/crontab or /etc/cron.d/NAME for a
 * system file. Anything else is refused.
 */
export const parseCronTarget = (target: string): CronTarget => {
  const user = /^user:([a-z_][a-z0-9_-]{0,31})$/.exec(target);

  if (user) {
    return { kind: 'user', user: user[1], label: `${user[1]}'s crontab` };
  }

  // cron skips cron.d files with dots in their names, so new ones can't have them
  if (target === '/etc/crontab' || /^\/etc\/cron\.d\/[A-Za-z0-9_-]{1,64}$/.test(target)) {
    return { kind: 'file', path: target, label: target };
  }

  throw new ToolError('Choose a user crontab, /etc/crontab, or a file in /etc/cron.d (letters, digits, - and _)');
};

// Parsers ---------------------------------------------------------------------

/**
 * Tab-separated rows for a tag. With `columns`, the last column keeps any
 * tabs of its own (crontab lines and log messages often contain them).
 */
const rows = (stdout: string, tag: string, columns?: number): string[][] =>
  stdout
    .split('\n')
    .map(line => line.replace(/\r$/, ''))
    .filter(line => line.startsWith(`${tag}\t`))
    .map(line => {
      const parts = line.split('\t').slice(1);
      return columns && parts.length > columns
        ? [...parts.slice(0, columns - 1), parts.slice(columns - 1).join('\t')]
        : parts;
    });

const json = (stdout: string): any => {
  const text = stdout.trim().replace(/^\uFEFF/, '');
  if (!text) {
    return [];
  }
  return JSON.parse(text);
};

// PowerShell turns single-item arrays into objects
const list = (value: any): any[] => (Array.isArray(value) ? value : value ? [value] : []);

const num = (value: unknown): number | undefined => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const serviceStatus = (state: string): ServiceInfo['status'] => {
  const value = state.toLowerCase();
  if (value === 'running' || value === 'active') return 'running';
  if (value === 'failed') return 'failed';
  if (['stopped', 'dead', 'inactive', 'exited'].includes(value)) return 'stopped';
  return 'other';
};

const CRON_SPECIAL = /^@(reboot|yearly|annually|monthly|weekly|daily|midnight|hourly)$/;

// "cd / && run-parts --report /etc/cron.hourly" -> "run-parts"
const cronName = (command: string): string => {
  const words = command.replace(/^\s*(cd [^;&]+(&&|;)\s*)+/, '').split(/\s+/);
  const program = words.find(word => word && !/^[A-Z_]+=/.test(word) && !['test', '[', '-x', 'sudo', 'nice', 'ionice'].includes(word));
  return (program || 'cron job').split('/').pop() || 'cron job';
};

const splitCron = (line: string, withUser: boolean) => {
  const parts = line.trim().split(/\s+/);
  const scheduleParts = CRON_SPECIAL.test(parts[0]) ? 1 : 5;
  const schedule = parts.slice(0, scheduleParts).join(' ');
  const user = withUser ? parts[scheduleParts] : undefined;
  const command = parts.slice(scheduleParts + (withUser ? 1 : 0)).join(' ');
  return { schedule, user, command };
};

// systemd prints "n/a" or "0" for never; tidy those away
const when = (value?: string): string | undefined =>
  !value || value === 'n/a' || value === '0' ? undefined : value;

export interface FileEntry {
  name: string;
  type: 'file' | 'dir' | 'link' | 'other';
  size: number;
  modified: string | null;
  mode: string;
  owner: string;
}

/** A folder listing from the files tool, folders first */
export const parseFileList = (os: ToolOs, stdout: string): FileEntry[] => {
  const kinds: { [key: string]: FileEntry['type'] } = { f: 'file', d: 'dir', l: 'link' };
  let entries: FileEntry[];

  if (os === 'windows') {
    const text = stdout.trim();
    const parsed = text ? JSON.parse(text) : [];
    entries = (Array.isArray(parsed) ? parsed : [parsed]).map((item: any) => ({
      name: String(item.name),
      type: kinds[item.type] || 'other',
      size: Number(item.size) || 0,
      modified: item.modified || null,
      mode: String(item.mode || ''),
      owner: ''
    }));
  } else {
    entries = stdout
      .split('\n')
      .filter(line => line.includes('\t'))
      .map(line => {
        const [type, size, modified, mode, owner, ...name] = line.split('\t');
        return {
          name: name.join('\t'),
          type: kinds[type] || 'other',
          size: Number(size) || 0,
          modified: Number(modified) ? new Date(Number(modified) * 1000).toISOString() : null,
          mode,
          owner
        };
      });
  }

  return entries.sort((a, b) =>
    a.type === 'dir' && b.type !== 'dir' ? -1 : b.type === 'dir' && a.type !== 'dir' ? 1 : a.name.localeCompare(b.name)
  );
};

export const parseToolOutput = (tool: ReadTool, os: ToolOs, stdout: string): unknown => {
  if (os === 'windows') {
    const data = json(stdout);

    switch (tool) {
      case 'system':
        return {
          ...data,
          cores: num(data.cores),
          memTotalMb: num(data.memTotalMb),
          disks: list(data.disks),
          networks: list(data.networks)
        } as SystemAudit;
      case 'services':
        return list(data).map(
          (item): ServiceInfo => ({
            name: item.name,
            displayName: item.displayName || item.name,
            state: item.state,
            status: serviceStatus(item.state || ''),
            startup: String(item.startup || '').toLowerCase(),
            account: item.account || undefined
          })
        );
      case 'tasks':
        return list(data).map(
          (item): TaskInfo => ({
            id: `${item.path}${item.name}`,
            kind: 'windows',
            name: item.name,
            schedule: item.triggers || 'On demand',
            user: item.user || undefined,
            command: item.command || '',
            source: item.path,
            nextRun: item.nextRun || undefined,
            lastRun: item.lastRun || undefined,
            lastResult: item.lastResult || undefined,
            enabled: String(item.state).toLowerCase() !== 'disabled',
            state: item.state
          })
        );
      case 'processes':
        return list(data).map(
          (item): ProcessInfo => ({
            pid: Number(item.pid),
            name: item.name,
            cpu: Number(item.cpu) || 0,
            cpuUnit: 'seconds',
            memMb: Number(item.memMb) || 0
          })
        );
      case 'software':
        return list(data).map(
          (item): SoftwareInfo => ({
            name: item.name,
            version: item.version || '',
            publisher: item.publisher || undefined,
            installed: item.installed || undefined
          })
        );
      case 'updates':
        return {
          reboot: Boolean(data.reboot),
          updates: list(data.updates).map(
            (item): UpdateInfo => ({
              name: item.name,
              version: item.version || undefined,
              source: item.source || undefined,
              security: Boolean(item.security)
            })
          )
        };
      case 'logs':
        return list(data).map(
          (item): LogEntry => ({
            time: item.time,
            level: String(item.level || '').toLowerCase(),
            source: item.source,
            message: item.message
          })
        );
    }
  }

  switch (tool) {
    case 'system': {
      const facts = new Map<string, string>();
      rows(stdout, 'kv').forEach(([key, value]) => {
        facts.set(key, (value || '').trim());
      });

      return {
        os: facts.get('os'),
        kernel: facts.get('kernel'),
        arch: facts.get('arch'),
        hostname: facts.get('hostname'),
        manufacturer: facts.get('manufacturer') || undefined,
        model: facts.get('model') || undefined,
        serial: facts.get('serial') || undefined,
        cpu: facts.get('cpu') || undefined,
        cores: num(facts.get('cores')),
        load: facts.get('load'),
        boot: facts.get('boot') || undefined,
        users: facts.get('users') || undefined,
        memTotalMb: num(facts.get('memTotalMb')),
        disks: rows(stdout, 'disk').map(([mount, device, type, total, used]) => ({
          mount,
          device,
          type,
          totalGb: Number(total) || 0,
          usedGb: Number(used) || 0
        })),
        networks: rows(stdout, 'net').map(([name, address]) => ({ name, address }))
      } as SystemAudit;
    }
    case 'services': {
      const startup = new Map(rows(stdout, 'file').map(([name, state]) => [name, state]));
      const seen = new Set<string>();
      const services: ServiceInfo[] = rows(stdout, 'unit')
        .filter(([name]) => name && name.endsWith('.service'))
        .map(([name, active, sub, description]) => {
          seen.add(name);
          return {
            name,
            displayName: description || name,
            state: `${active}/${sub}`,
            status: active === 'failed' ? 'failed' : serviceStatus(sub === 'running' ? 'running' : active),
            startup: startup.get(name) || 'static'
          };
        });

      // Installed but not loaded units are simply stopped
      startup.forEach((state, name) => {
        if (!seen.has(name) && !name.includes('@.')) {
          services.push({ name, displayName: name, state: 'inactive', status: 'stopped', startup: state });
        }
      });

      return services.sort((a, b) => a.name.localeCompare(b.name));
    }
    case 'tasks': {
      const tasks: TaskInfo[] = [];

      const userCron = (tag: string, enabled: boolean) =>
        rows(stdout, tag, 3).forEach(([file, user, line], index) => {
          const { schedule, command } = splitCron(line || '', false);
          tasks.push({
            id: `${tag}-${index}`, kind: 'cron', name: cronName(command), schedule, user, command,
            source: file, enabled, raw: line, target: `user:${user}`
          });
        });
      const systemCron = (tag: string, enabled: boolean) =>
        rows(stdout, tag, 2).forEach(([file, line], index) => {
          const { schedule, user, command } = splitCron(line || '', true);
          tasks.push({
            id: `${tag}-${index}`, kind: 'cron', name: cronName(command), schedule, user, command,
            source: file, enabled, raw: line, target: file
          });
        });

      userCron('cron', true);
      userCron('cronoff', false);
      systemCron('syscron', true);
      systemCron('syscronoff', false);
      rows(stdout, 'periodic').forEach(([period, file]) => {
        tasks.push({ id: `periodic-${file}`, kind: 'periodic', name: file.split('/').pop() || file, schedule: period, user: 'root', command: file, source: `/etc/cron.${period}`, enabled: true });
      });
      rows(stdout, 'timer').forEach(([id, unit, next, last, active, fileState, description, calendar]) => {
        const onCalendar = /OnCalendar=([^;]+)/.exec(calendar || '');
        tasks.push({
          id,
          kind: 'timer',
          name: id,
          schedule: onCalendar ? onCalendar[1].trim() : 'Timer',
          user: 'root',
          command: unit,
          source: description || 'systemd',
          nextRun: when(next),
          lastRun: when(last),
          enabled: fileState === 'enabled' || fileState === 'static' || active === 'active',
          state: `${active}${fileState ? ` · ${fileState}` : ''}`
        });
      });

      return tasks;
    }
    case 'processes':
      return rows(stdout, 'proc').map(
        ([pid, user, cpu, rss, elapsed, name]): ProcessInfo => ({
          pid: Number(pid),
          name,
          user,
          cpu: Number(cpu) || 0,
          cpuUnit: 'percent',
          memMb: Math.round((Number(rss) || 0) / 1024),
          elapsedSeconds: num(elapsed)
        })
      );
    case 'software':
      return rows(stdout, 'pkg').map(
        ([name, version, publisher]): SoftwareInfo => ({ name, version: version || '', publisher: publisher || undefined })
      );
    case 'updates': {
      const updates: UpdateInfo[] = [];

      // e.g. "openssl/noble-updates,noble-security 3.0.13-0ubuntu3.4 amd64 [upgradable from: 3.0.13-0ubuntu3.1]"
      rows(stdout, 'apt', 1).forEach(([line]) => {
        const match = /^([^/]+)\/(\S+)\s+(\S+)\s+\S+(?:\s+\[upgradable from: ([^\]]+)\])?/.exec(line || '');
        if (match) {
          updates.push({ name: match[1], source: match[2], version: match[3], from: match[4], security: /security/.test(match[2]) });
        }
      });
      rows(stdout, 'dnf').forEach(([name, version, repo]) => {
        updates.push({ name, version, source: repo, security: /security/i.test(repo || '') });
      });

      return { reboot: rows(stdout, 'reboot').length > 0, updates };
    }
    case 'logs':
      return rows(stdout, 'j', 1)
        .concat(rows(stdout, 's', 1))
        .map(([line]): LogEntry => {
          // "2026-09-30T19:00:00+0100 host unit[123]: message"
          const match = /^(\S+)\s+\S+\s+([^:\s][^:]*):\s?(.*)$/.exec(line || '');
          return match
            ? { time: match[1], level: /error|fail|crit|emerg|alert/i.test(match[3]) ? 'error' : 'warning', source: match[2], message: match[3] }
            : { time: '', level: 'warning', source: '', message: line || '' };
        })
        .reverse();
  }

  return null;
};

export const deviceToolOs = (device: { os: string }): ToolOs | null => {
  const os = (device.os || '').toLowerCase();
  if (os.includes('windows')) return 'windows';
  if (os.includes('linux')) return 'linux';
  return null;
};
