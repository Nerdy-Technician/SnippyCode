import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { buildToolScript, parseCronTarget, parseToolOutput } from '../src/utils/deviceTools';

const bash = (code: string) => spawnSync('bash', ['-c', code], { encoding: 'utf8' });

describe('device tool parsers (Linux)', () => {
  test('services merge unit state with startup type', () => {
    const out = [
      'file\tnginx.service\tenabled',
      'file\tcups.service\tdisabled',
      'unit\tnginx.service\tactive\trunning\tA high performance web server',
      'unit\tbroken.service\tfailed\tfailed\tSomething broken'
    ].join('\n');
    const services = parseToolOutput('services', 'linux', out) as any[];

    assert.deepEqual(
      services.map(s => [s.name, s.status, s.startup]),
      [
        ['broken.service', 'failed', 'static'],
        ['cups.service', 'stopped', 'disabled'],
        ['nginx.service', 'running', 'enabled']
      ]
    );
  });

  test('cron lines keep tabs, commands and disabled jobs', () => {
    const out = [
      'syscron\t/etc/crontab\t17 *\t* * *\troot\tcd / && run-parts --report /etc/cron.hourly',
      'cron\t/var/spool/cron/crontabs/alice\talice\t@reboot /home/alice/start.sh',
      'syscronoff\t/etc/cron.d/backup\t0 3 * * * root /usr/local/bin/backup'
    ].join('\n');
    const tasks = parseToolOutput('tasks', 'linux', out) as any[];

    assert.equal(tasks[0].schedule, '@reboot');
    assert.equal(tasks[0].target, 'user:alice');
    assert.equal(tasks[1].schedule, '17 * * * *');
    assert.equal(tasks[1].user, 'root');
    assert.equal(tasks[1].name, 'run-parts');
    assert.equal(tasks[1].raw, '17 *\t* * *\troot\tcd / && run-parts --report /etc/cron.hourly');
    assert.equal(tasks[2].enabled, false);
    assert.equal(tasks[2].target, '/etc/cron.d/backup');
  });

  test('apt updates and the reboot flag', () => {
    const out = [
      'apt\topenssl/noble-updates,noble-security 3.0.13-0ubuntu3.4 amd64 [upgradable from: 3.0.13-0ubuntu3.1]',
      'apt\tvim/noble-updates 2:9.1.0016-1ubuntu7.9 amd64 [upgradable from: 2:9.1.0016-1ubuntu7.8]',
      'reboot\t1'
    ].join('\n');
    const data = parseToolOutput('updates', 'linux', out) as any;

    assert.equal(data.reboot, true);
    assert.deepEqual(data.updates.map((u: any) => [u.name, u.security]), [['openssl', true], ['vim', false]]);
    assert.equal(data.updates[0].from, '3.0.13-0ubuntu3.1');
  });
});

describe('device tool parsers (Windows)', () => {
  test('a single object from ConvertTo-Json still becomes a list', () => {
    const services = parseToolOutput(
      'services',
      'windows',
      '{"name":"Spooler","displayName":"Print Spooler","state":"Running","startup":"Auto","account":"LocalSystem"}'
    ) as any[];

    assert.equal(services.length, 1);
    assert.equal(services[0].status, 'running');
    assert.equal(services[0].startup, 'auto');
  });
});

describe('device tool scripts', () => {
  test('cron targets are limited to crontabs, /etc/crontab and /etc/cron.d', () => {
    assert.equal(parseCronTarget('user:root').kind, 'user');
    assert.equal(parseCronTarget('/etc/cron.d/backup-job').kind, 'file');
    for (const bad of ['/etc/passwd', '/etc/cron.d/../shadow', '/etc/cron.d/a.b', 'user:ro;ot', 'user:$(id)']) {
      assert.throws(() => parseCronTarget(bad), Error, bad);
    }
  });

  test('system cron files are checked line by line before anything is written', () => {
    const check = (content: string) => {
      const code = buildToolScript('crontab', 'linux', { op: 'write', target: '/etc/cron.d/snippytest', content }).code;
      // Stop before touching the system: run everything up to the backup step
      return bash(code.slice(0, code.indexOf('mkdir -p /var/backups')) + '\necho CHECKED\n');
    };

    assert.match(check('*/5 * * * * echo no user\n').stderr, /line 1: \*\/5 \* \* \* \* echo no user/);
    assert.match(check('0 3 * * * nosuchuser99 /bin/true\n').stderr, /line 1/);
    assert.match(check('# comment\nSHELL=/bin/bash\n0 3 * * * root /bin/true\n@reboot root /bin/true\n').stdout, /CHECKED/);
  });

  test('file contents reach the device byte for byte', () => {
    const content = `0 3 * * * root echo 'it''s' "$HOME" % $(id) \`id\` EOF\n`;
    const code = buildToolScript('crontab', 'linux', { op: 'write', target: 'user:root', content }).code;
    const encoded = /printf '%s' '([A-Za-z0-9+/=]+)'/.exec(code)![1];

    assert.equal(Buffer.from(encoded, 'base64').toString('utf8'), content);
    assert.ok(!code.includes('$(id)'), 'nothing from the file appears as shell');
  });

  test('one-shot shell is the command itself, with stdin left to the agent', () => {
    assert.equal(buildToolScript('shell', 'linux', { code: 'echo hi', shell: 'bash' }).code, 'echo hi');
    assert.equal(buildToolScript('shell', 'linux', { code: 'echo hi', shell: 'bash' }).language, 'bash');
    assert.equal(buildToolScript('shell', 'windows', { code: 'Get-Date', shell: 'powershell' }).code, 'Get-Date');
    assert.equal(buildToolScript('shell', 'windows', { code: 'dir', shell: 'cmd' }).language, 'bat');
  });

  test('terminal mode keeps the exit code and refuses a cmd folder that can break out', () => {
    const bash = buildToolScript('shell', 'linux', { code: 'echo hi', shell: 'bash', terminal: true, cwd: "/tmp/a'b" });
    assert.match(bash.code, /cd -- '\/tmp\/a'\\''b'/);
    assert.match(bash.code, /__rc=\$\?/);
    assert.match(bash.code, /exit \$__rc/);
    assert.equal(bash.language, 'bash');

    const powershell = buildToolScript('shell', 'windows', { code: 'Get-Date', shell: 'powershell', terminal: true, cwd: 'C:\\Tools' });
    assert.match(powershell.code, /\$LASTEXITCODE = \$null/);
    assert.match(powershell.code, /exit \$__rc/);
    assert.match(powershell.code, /Set-Location -LiteralPath 'C:\\Tools'/);

    assert.throws(() => buildToolScript('shell', 'windows', { code: 'dir', shell: 'cmd', terminal: true, cwd: 'C:\\temp & calc' }));
    const cmd = buildToolScript('shell', 'windows', { code: 'dir', shell: 'cmd', terminal: true, cwd: 'C:\\temp' });
    assert.match(cmd.code, /cd \/d "C:\\temp"/);
    assert.match(cmd.code, /exit \/b %__RC%/);
  });

  test('names are validated or quoted', () => {
    assert.throws(() => buildToolScript('service', 'linux', { name: 'nginx; rm -rf /', action: 'restart' }));
    assert.throws(() => buildToolScript('service', 'linux', { name: 'nginx', action: 'explode' }));
    assert.throws(() => buildToolScript('process', 'linux', { pid: '1; reboot' }));
    assert.match(buildToolScript('service', 'windows', { name: "it's", action: 'stop' }).code, /-Name 'it''s'/);
    assert.match(buildToolScript('service', 'linux', { name: 'systemd-fsck@dev-disk\\x2dx.service', action: 'restart' }).code, /'systemd-fsck@dev-disk\\x2dx\.service'/);
  });
});
