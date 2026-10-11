import { DeviceInstance } from '../models';

export interface DeviceFields {
  assetTag?: string;
  owner?: string;
  location?: string;
  warranty?: string;
  notes?: string;
  /** Free-form extra fields, keys in UPPER_SNAKE */
  custom?: Record<string, string>;
}

export type RemoteType = 'rustdesk' | 'vnc' | 'rdp' | 'ssh' | 'url';

export interface DeviceRemote {
  type?: RemoteType;
  address?: string;
  port?: number;
  username?: string;
  /** RustDesk ID */
  remoteId?: string;
  /** Stored encrypted */
  password?: string;
}

export const readJson = <T>(raw: string): T => {
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return {} as T;
  }
};

const facts = (device: DeviceInstance) => readJson<{ ip?: string; osName?: string }>(device.facts);

/**
 * Values snippets see as {{DEVICE_NAME}}, {{DEVICE_IP}}, {{DEVICE_ASSET_TAG}}
 * and {{DEVICE_<CUSTOM>}} when they run on a device.
 */
export const deviceVariableValues = (device: DeviceInstance, siteName = ''): Record<string, string> => {
  const fields = readJson<DeviceFields>(device.fields);
  const values: Record<string, string> = {
    DEVICE_NAME: device.name,
    DEVICE_HOSTNAME: device.hostname,
    DEVICE_IP: facts(device).ip || device.lastIp || '',
    DEVICE_OS: facts(device).osName || device.os,
    DEVICE_SITE: siteName
  };

  const standard: [keyof DeviceFields, string][] = [
    ['assetTag', 'DEVICE_ASSET_TAG'],
    ['owner', 'DEVICE_OWNER'],
    ['location', 'DEVICE_LOCATION'],
    ['warranty', 'DEVICE_WARRANTY']
  ];
  standard.forEach(([key, name]) => {
    if (typeof fields[key] === 'string' && fields[key]) {
      values[name] = fields[key] as string;
    }
  });

  Object.entries(fields.custom || {}).forEach(([key, value]) => {
    if (/^[A-Z][A-Z0-9_]{0,50}$/.test(key)) {
      values[`DEVICE_${key}`] = String(value);
    }
  });

  return values;
};
