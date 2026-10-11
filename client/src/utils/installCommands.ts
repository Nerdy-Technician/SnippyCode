export interface InstallCommand {
  label: string;
  command: string;
}

const interpreters: { [language: string]: string } = {
  bash: 'bash',
  shell: 'bash',
  sh: 'sh',
  zsh: 'zsh',
  python: 'python3',
  javascript: 'node'
};

/**
 * Ready-to-paste commands for a raw URL. When a checksum is known, the verify
 * variant downloads to a file, checks it, and only then runs it.
 */
export const installCommands = (
  language: string,
  url: string,
  fileName: string,
  sha256?: string
): InstallCommand[] => {
  const lang = (language || '').toLowerCase();
  const file = fileName || 'snippet.txt';
  const commands: InstallCommand[] = [];

  if (lang === 'powershell') {
    commands.push({ label: 'Run', command: `irm "${url}" | iex` });

    if (sha256) {
      commands.push({
        label: 'Verify + run',
        command: `$f = Join-Path $env:TEMP "${file}"; irm "${url}" -OutFile $f; if ((Get-FileHash $f -Algorithm SHA256).Hash -ne "${sha256.toUpperCase()}") { throw "Checksum mismatch" }; & $f`
      });
    }

    return commands;
  }

  const interpreter = interpreters[lang];

  if (interpreter) {
    const pipeTarget = interpreter === 'bash' || interpreter === 'sh' || interpreter === 'zsh'
      ? interpreter
      : `${interpreter} -`;

    commands.push({ label: 'Run', command: `curl -fsSL "${url}" | ${pipeTarget}` });

    if (interpreter === 'bash' || interpreter === 'sh') {
      commands.push({ label: 'wget', command: `wget -qO- "${url}" | ${interpreter}` });
    }

    if (sha256) {
      commands.push({
        label: 'Verify + run',
        command: `curl -fsSL "${url}" -o "/tmp/${file}" && echo "${sha256}  /tmp/${file}" | sha256sum -c - && ${interpreter} "/tmp/${file}"`
      });
    }

    return commands;
  }

  commands.push({ label: 'Download', command: `curl -fsSL "${url}" -o "${file}"` });

  if (sha256) {
    commands.push({
      label: 'Verify',
      command: `curl -fsSL "${url}" -o "${file}" && echo "${sha256}  ${file}" | sha256sum -c -`
    });
  }

  return commands;
};
