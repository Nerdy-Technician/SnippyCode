/** Mirrors the server's scheduleDevices() for a live preview in the form */
export interface TargetDevice {
  id: number;
  siteId: number;
  tags?: string[];
}

export interface TargetForm {
  siteMode: string;
  siteIds: number[];
  deviceIds: number[];
  /** Names of the chosen shared tags; a device matches with ANY of them */
  deviceTags: string[];
}

export const normaliseTag = (tag: string): string =>
  tag.trim().toLowerCase().replace(/[^a-z0-9_.-]/g, '-').slice(0, 40);

export const previewTargets = <T extends TargetDevice>(
  devices: T[],
  form: TargetForm,
  siteIdsForMode?: number[]
): T[] => {
  const tags = form.deviceTags.map(normaliseTag).filter(Boolean);
  const tag = tags.length > 0;
  let base: T[] = [];

  if (form.siteMode === 'devices') {
    base = tag ? devices : [];
  } else if (form.siteMode === 'sites') {
    base = devices.filter(device => form.siteIds.includes(device.siteId));
  } else if (form.siteMode === 'all') {
    base = devices;
  } else if (siteIdsForMode) {
    base = devices.filter(device => siteIdsForMode.includes(device.siteId));
  }

  if (tag) {
    base = base.filter(device => (device.tags || []).some(name => tags.includes(name)));
  }

  const picked = devices.filter(device => form.deviceIds.includes(device.id));
  return Array.from(new Map([...base, ...picked].map(device => [device.id, device])).values());
};

export const parseTags = (value: string): string[] =>
  Array.from(new Set(value.split(',').map(normaliseTag).filter(Boolean))).slice(0, 20);
