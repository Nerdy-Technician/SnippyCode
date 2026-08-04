export interface SecretFinding {
  label: string;
  severity: 'medium' | 'high';
}

const secretPatterns: Array<[RegExp, SecretFinding]> = [
  [
    /-----BEGIN (RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/i,
    { label: 'Private key', severity: 'high' }
  ],
  [
    /\b[A-Za-z0-9_]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/,
    { label: 'JWT-like token', severity: 'medium' }
  ],
  [
    /\b(password|passwd|secret|token|api[_-]?key|client_secret)\s*[:=]\s*['"]?[^'"\s]+/i,
    { label: 'Credential assignment', severity: 'high' }
  ],
  [
    /github_pat_[A-Za-z0-9_]+|ghp_[A-Za-z0-9_]+|gho_[A-Za-z0-9_]+/i,
    { label: 'GitHub token', severity: 'high' }
  ],
  [
    /AWS_(SECRET_ACCESS_KEY|ACCESS_KEY_ID)\s*=/i,
    { label: 'AWS credential', severity: 'high' }
  ],
  [
    /\bAKIA[0-9A-Z]{16}\b/,
    { label: 'AWS access key', severity: 'high' }
  ],
  [
    /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/i,
    { label: 'Slack webhook', severity: 'high' }
  ],
  [
    /https:\/\/discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9._-]+/i,
    { label: 'Discord webhook', severity: 'high' }
  ],
  [
    /\bAIza[0-9A-Za-z_-]{35}\b/,
    { label: 'Google API key', severity: 'high' }
  ],
  [
    /\bnpm_[A-Za-z0-9]{36}\b/,
    { label: 'npm token', severity: 'high' }
  ],
  [
    /\b(postgres|postgresql|mysql|mongodb):\/\/[^:\s]+:[^@\s]+@/i,
    { label: 'Database connection string', severity: 'high' }
  ],
  [
    /\bAuthorization:\s*Bearer\s+[A-Za-z0-9._~+/-]+=*/i,
    { label: 'Bearer token header', severity: 'high' }
  ]
];

export const detectSecretFindings = (...parts: Array<string | null | undefined>): SecretFinding[] => {
  const text = parts.filter(Boolean).join('\n');
  const findings = new Map<string, SecretFinding>();

  secretPatterns.forEach(([pattern, finding]) => {
    if (pattern.test(text)) {
      findings.set(finding.label, finding);
    }
  });

  return [...findings.values()];
};
