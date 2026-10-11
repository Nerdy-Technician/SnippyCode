import { createHash, createPublicKey, KeyObject, verify } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { getSetting, setSetting } from './oidcSettings';

/**
 * Signed agent releases and staged rollout.
 *
 * A release is made OFFLINE with scripts/agent-release.js and an Ed25519
 * private key that never touches the server, the repo or the database. Each
 * agent file gets a signed manifest entry covering file, platform, arch,
 * version, SHA-256 and whether a pinned downgrade to it is allowed (see
 * signedMessage). Agents verify that signature with the key list embedded
 * in their own code. The server re-checks it with AGENT_UPDATE_PUBLIC_KEYS,
 * which is mandatory in production, and only decides who is offered what.
 */
export const AGENT_FILES = ['snippycode-agent.sh', 'snippycode-agent.ps1'] as const;
export type AgentFile = (typeof AGENT_FILES)[number];

/** First agent version that verifies its own updates */
export const VERIFYING_AGENT_VERSION = '1.4.0';

export interface AgentReleaseFile {
  sha256: string;
  /** base64 Ed25519 signature over signedMessage(...) */
  signature: string;
  platform: 'linux' | 'windows';
  arch: string;
  /** A device pinned to this version may move DOWN to it */
  downgrade: boolean;
}

export interface AgentRelease {
  version: string;
  files: Partial<Record<AgentFile, AgentReleaseFile>>;
}

/** The exact bytes that are signed for one file. Agents rebuild this too. */
export const signedMessage = (entry: { file: string; platform: string; arch: string; version: string; sha256: string; downgrade: boolean }): string =>
  `snippycode-agent-update/v1\nfile=${entry.file}\nplatform=${entry.platform}\narch=${entry.arch}\nversion=${entry.version}\nsha256=${entry.sha256}\ndowngrade=${entry.downgrade ? 1 : 0}\n`;

export const PLATFORM_OF: Record<AgentFile, 'linux' | 'windows'> = {
  'snippycode-agent.sh': 'linux',
  'snippycode-agent.ps1': 'windows'
};

/**
 * Windows agents do not update themselves: Windows PowerShell/.NET has no
 * built-in Ed25519, and trusting an openssl.exe found on PATH as SYSTEM is
 * binary planting (Locke U1). Only the Linux agent is ever offered.
 */
export const AUTO_UPDATE_FILES: AgentFile[] = ['snippycode-agent.sh'];

export const RING_NAMES = ['canary', 'early', 'stable'] as const;
export type UpdateRing = (typeof RING_NAMES)[number];

export interface RolloutSettings {
  /**
   * auto (default): canary first; early once enough canaries updated and
   * stayed healthy; then `percent` of stable once early did too. Any
   * rollback pauses it. manual: exactly `rings` + `percent`.
   */
  mode: 'auto' | 'manual';
  /** manual mode: rings that get the release straight away */
  rings: UpdateRing[];
  /** 0-100: share of stable (auto) / of the rest (manual), stable per version */
  percent: number;
  paused: boolean;
  pausedReason?: string;
  /** Legacy (pre-1.4.0) agents: one-time unsigned hop, off after this date */
  bootstrapUntil?: string | null;
}

export const DEFAULT_ROLLOUT: RolloutSettings = { mode: 'auto', rings: ['canary'], percent: 25, paused: false, bootstrapUntil: null };

/** Health needed before the next ring opens */
export const HEALTH = { minDevices: 3, checkins: 5 };

export const releaseDir = (): string => process.env.AGENT_RELEASE_DIR || join(process.cwd(), 'agent', 'release');

const VERSION = /^\d+\.\d+\.\d+([.-][0-9A-Za-z.-]+)?$/;

/** Every key the server trusts: AGENT_UPDATE_PUBLIC_KEYS (list) and AGENT_UPDATE_PUBLIC_KEY */
export const trustedKeys = (): KeyObject[] => {
  const raw = [process.env.AGENT_UPDATE_PUBLIC_KEYS || '', process.env.AGENT_UPDATE_PUBLIC_KEY || ''].join('\n').replace(/\\n/g, '\n');
  const keys: KeyObject[] = [];
  const pems = raw.match(/-----BEGIN PUBLIC KEY-----[\s\S]+?-----END PUBLIC KEY-----/g) || [];
  pems.forEach(pem => keys.push(createPublicKey(pem)));
  raw
    .replace(/-----BEGIN PUBLIC KEY-----[\s\S]+?-----END PUBLIC KEY-----/g, '')
    .split(/[\s,]+/)
    .filter(item => /^[A-Za-z0-9+/=]{40,}$/.test(item))
    .forEach(item => keys.push(createPublicKey({ key: Buffer.from(item, 'base64'), format: 'der', type: 'spki' })));
  return keys;
};

let cache: { at: number; release: AgentRelease | null } | null = null;

/**
 * The current release, or null if there is none or it does not check out:
 * every listed file must exist, match its SHA-256 and carry a valid
 * signature from a trusted key. With no key configured, production offers
 * nothing; elsewhere (dev/test) the checksum alone is checked.
 */
export const loadRelease = (now = Date.now()): AgentRelease | null => {
  if (cache && now - cache.at < 30_000) return cache.release;
  let release: AgentRelease | null = null;
  try {
    const keys = trustedKeys();
    if (!keys.length && process.env.NODE_ENV === 'production') throw new Error('no trusted key');
    const dir = releaseDir();
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    const version = String(manifest.version);
    if (!VERSION.test(version)) throw new Error('bad version');
    const files: AgentRelease['files'] = {};
    for (const name of AGENT_FILES) {
      const entry = manifest.files?.[name];
      if (!entry) continue;
      const path = join(dir, name);
      if (!existsSync(path)) throw new Error(`${name} is missing`);
      const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
      const clean: AgentReleaseFile = {
        sha256: String(entry.sha256).toLowerCase(),
        signature: String(entry.signature),
        platform: PLATFORM_OF[name],
        arch: String(entry.arch || 'any'),
        downgrade: Boolean(entry.downgrade)
      };
      if (sha256 !== clean.sha256 || entry.platform !== clean.platform) throw new Error(`${name} checksum/platform`);
      const message = Buffer.from(signedMessage({ file: name, version, ...clean }));
      if (keys.length && !keys.some(key => verify(null, message, key, Buffer.from(clean.signature, 'base64')))) {
        throw new Error(`${name} signature`);
      }
      files[name] = clean;
    }
    release = Object.keys(files).length ? { version, files } : null;
  } catch {
    release = null;
  }
  cache = { at: now, release };
  return release;
};

export const clearReleaseCache = (): void => {
  cache = null;
};

export const isOlder = (current: string, latest: string): boolean => {
  const parts = (value: string) => value.split(/[.-]/).slice(0, 3).map(part => Number(part) || 0);
  const [a, b] = [parts(current), parts(latest)];
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
};

/** 0-99, stable for a device and version so a percentage grows, never reshuffles */
export const rolloutBucket = (deviceId: number, version: string): number =>
  createHash('sha256').update(`${version}:${deviceId}`).digest().readUInt32BE(0) % 100;

export const cleanRollout = (input: Partial<RolloutSettings>, current: RolloutSettings = DEFAULT_ROLLOUT): RolloutSettings => {
  const rings = input.rings === undefined ? current.rings : input.rings;
  const until = input.bootstrapUntil === undefined ? current.bootstrapUntil : input.bootstrapUntil;
  const untilDate = until ? new Date(until) : null;
  return {
    mode: input.mode === 'manual' || input.mode === 'auto' ? input.mode : current.mode,
    rings: Array.from(new Set((Array.isArray(rings) ? rings : []).filter(ring => (RING_NAMES as readonly string[]).includes(ring)))) as UpdateRing[],
    percent: Math.min(100, Math.max(0, Math.round(Number(input.percent ?? current.percent) || 0))),
    paused: input.paused === undefined ? current.paused : Boolean(input.paused),
    pausedReason: input.paused === false ? '' : String(input.pausedReason ?? current.pausedReason ?? '').slice(0, 200),
    // At most 30 days of the unsigned first hop
    bootstrapUntil:
      untilDate && !Number.isNaN(untilDate.getTime())
        ? new Date(Math.min(untilDate.getTime(), Date.now() + 30 * 86_400_000)).toISOString()
        : null
  };
};

export const getRollout = async (): Promise<RolloutSettings> => {
  const saved = await getSetting<Partial<RolloutSettings> | null>('agentRollout', null);
  return saved ? cleanRollout(saved, { ...DEFAULT_ROLLOUT, ...saved } as RolloutSettings) : DEFAULT_ROLLOUT;
};

export const saveRollout = async (input: Partial<RolloutSettings>): Promise<RolloutSettings> => {
  const clean = cleanRollout(input, await getRollout());
  await setSetting('agentRollout', clean);
  return clean;
};

export interface RolloutDevice {
  id: number;
  agentVersion: string;
  updateRing?: string;
  updatePin?: string;
  healthyCheckins?: number;
  os?: string;
}

/** Which rings/percent are open now; auto mode opens rings as health is proven */
export const effectiveStage = (
  rollout: RolloutSettings,
  release: AgentRelease | null,
  fleet: RolloutDevice[]
): { rings: UpdateRing[]; percent: number; stage: string } => {
  if (rollout.mode === 'manual') return { rings: rollout.rings, percent: rollout.percent, stage: 'manual' };
  if (!release) return { rings: [], percent: 0, stage: 'none' };
  const healthy = (ring: UpdateRing) => {
    const members = fleet.filter(device => (device.updateRing || 'stable') === ring && !device.updatePin);
    const done = members.filter(device => device.agentVersion === release.version && (device.healthyCheckins || 0) >= HEALTH.checkins);
    return members.length > 0 && done.length >= Math.min(HEALTH.minDevices, members.length);
  };
  if (!healthy('canary')) return { rings: ['canary'], percent: 0, stage: 'canary' };
  if (!healthy('early')) return { rings: ['canary', 'early'], percent: 0, stage: 'early' };
  return { rings: ['canary', 'early'], percent: rollout.percent, stage: 'stable' };
};

/**
 * Whether a device should be offered this release now. A per-device pin
 * wins: pinned devices get exactly that version (and nothing else), and
 * may move down to it only if the release was signed allowing that.
 */
export const updateOffer = (
  device: RolloutDevice,
  release: AgentRelease | null,
  rollout: RolloutSettings,
  stage: { rings: UpdateRing[]; percent: number } = { rings: rollout.rings, percent: rollout.percent }
): string | null => {
  const file = release?.files['snippycode-agent.sh'];
  if (!release || !file || !device.agentVersion) return null;
  if (/^win/i.test(device.os || '')) return null;
  if (device.updatePin) {
    if (device.updatePin !== release.version || device.agentVersion === release.version) return null;
    return isOlder(device.agentVersion, release.version) || file.downgrade ? release.version : null;
  }
  if (!isOlder(device.agentVersion, release.version) || rollout.paused) return null;
  const ring = (device.updateRing || 'stable') as UpdateRing;
  if (stage.rings.includes(ring)) return release.version;
  return ring === 'stable' || rollout.mode === 'manual'
    ? rolloutBucket(device.id, release.version) < stage.percent
      ? release.version
      : null
    : null;
};

/**
 * Legacy agents (before 1.4.0) can't verify; their only way over is their
 * old self-update (download /agent/snippycode-agent.sh). Allowed only while
 * the admin-set bootstrap window is open, and only when the release file
 * matches AGENT_BOOTSTRAP_SHA256 pinned in the server config.
 */
export const bootstrapAllowed = (rollout: RolloutSettings, release: AgentRelease | null, now = Date.now()): boolean => {
  const pinned = String(process.env.AGENT_BOOTSTRAP_SHA256 || '').toLowerCase();
  const file = release?.files['snippycode-agent.sh'];
  return Boolean(
    file && pinned && pinned === file.sha256 && rollout.bootstrapUntil && new Date(rollout.bootstrapUntil).getTime() > now
  );
};

export const isLegacyAgent = (version: string): boolean => Boolean(version) && isOlder(version, VERIFYING_AGENT_VERSION);
