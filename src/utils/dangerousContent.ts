import { createHash } from 'crypto';

/**
 * Content rules for risky code, so approval does not depend only on the
 * manual "dangerous" flag (which a copy or a paste would lose). Matching is
 * deliberately broad: a false positive costs one approval click.
 */
const RULES: Array<{ name: string; pattern: RegExp }> = [
  { name: 'recursive delete', pattern: /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|--recursive)\b/i },
  { name: 'recursive delete', pattern: /\bRemove-Item\b[^\n]*-Recurse/i },
  { name: 'recursive delete', pattern: /\b(rd|rmdir)\s+\/s\b/i },
  { name: 'disk format/partition', pattern: /\b(mkfs(\.\w+)?|diskpart|Format-Volume|Clear-Disk|Initialize-Disk|wipefs|fdisk|parted|sgdisk)\b/i },
  { name: 'disk format/partition', pattern: /(^|[\s;&|])format(\.com)?\s+[a-z]:/im },
  { name: 'raw disk write', pattern: /\bdd\b[^\n]*\bof=\/dev\//i },
  { name: 'registry delete', pattern: /\breg(\.exe)?\s+delete\b/i },
  { name: 'registry delete', pattern: /\bRemove-Item(Property)?\b[^\n]*\b(HKLM|HKCU|Registry)::?/i },
  { name: 'credential dumping', pattern: /\b(mimikatz|sekurlsa|lsadump|procdump[^\n]*lsass|comsvcs(\.dll)?[^\n]*MiniDump|ntds\.dit|reg(\.exe)?\s+save\s+hklm\\(sam|security|system))\b/i },
  { name: 'shadow copy deletion', pattern: /\b(vssadmin[^\n]*delete\s+shadows|wbadmin[^\n]*delete|Win32_ShadowCopy[^\n]*Delete)\b/i },
  { name: 'boot config change', pattern: /\bbcdedit\b/i },
  { name: 'mass shutdown', pattern: /\b(shutdown|Stop-Computer|Restart-Computer|reboot|poweroff|halt)\b/i },
  { name: 'user/permission change', pattern: /\b(net\s+user\b[^\n]*\/(add|delete)|userdel|chmod\s+-R\s+777|icacls[^\n]*\/grant[^\n]*Everyone)/i },
  { name: 'security tooling disabled', pattern: /\b(Set-MpPreference[^\n]*Disable|setenforce\s+0|ufw\s+disable|systemctl\s+(stop|disable)\s+(firewalld|auditd))\b/i },
  { name: 'download and execute', pattern: /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba)?sh\b|\b(iex|Invoke-Expression)\b[^\n]*(DownloadString|Invoke-WebRequest|iwr)\b/i }
];

/** Names of the rules this code trips; empty when none */
export const dangerousContent = (code: string): string[] =>
  Array.from(new Set(RULES.filter(rule => rule.pattern.test(code || '')).map(rule => rule.name)));

/** Dangerous when flagged OR when the content trips a rule */
export const isSnippetDangerous = (snippet: { dangerous?: boolean; code?: string }): boolean =>
  Boolean(snippet.dangerous) || dangerousContent(snippet.code || '').length > 0;

/** Stable sha256 over a JSON value (object keys sorted) */
export const contentHash = (value: unknown): string => {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical);
    if (input && typeof input === 'object' && !(input instanceof Date)) {
      return Object.keys(input as object)
        .sort()
        .reduce((acc: Record<string, unknown>, key) => {
          acc[key] = canonical((input as Record<string, unknown>)[key]);
          return acc;
        }, {});
    }
    return input === undefined ? null : input;
  };
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
};
