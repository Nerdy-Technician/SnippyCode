import { Op } from 'sequelize';
import { sequelize } from '../db';
import { DeviceModel, DeviceTagModel, TagModel } from '../models';

/**
 * Shared tags (the tags table, also used by snippets) with colours. Devices
 * join them through device_tags; schedules target tag IDs. devices.tags
 * keeps the names as a cache for display and older code paths.
 */
export const TAG_COLOR = /^#[0-9a-f]{6}$/i;
export const MAX_DEVICE_TAGS = 20;
export const DEFAULT_TAG_COLOR = '#64748b';

export const cleanTagName = (value: unknown): string =>
  String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, '-')
    .slice(0, 40);

export const cleanTagColor = (value: unknown): string | null => {
  const color = String(value ?? '').trim();
  return TAG_COLOR.test(color) ? color.toLowerCase() : null;
};

/** Names from the devices.tags cache: trimmed, lowercased, deduped. */
export const deviceTagNames = (raw: string | null | undefined): string[] =>
  Array.from(new Set(String(raw || '').split(',').map(name => name.trim().toLowerCase()).filter(Boolean)));

export const parseIdList = (value: unknown): number[] =>
  Array.from(
    new Set(
      (Array.isArray(value) ? value : String(value ?? '').split(','))
        .map(item => Number(item))
        .filter(id => Number.isInteger(id) && id > 0)
    )
  );

/** Tag ids for names, creating missing tags */
export const tagIdsForNames = async (names: string[]): Promise<number[]> => {
  const clean = Array.from(new Set(names.map(cleanTagName).filter(Boolean)));
  const ids: number[] = [];
  for (const name of clean) {
    const [tag] = await TagModel.findOrCreate({ where: { name }, defaults: { name, color: DEFAULT_TAG_COLOR } });
    ids.push(tag.id);
  }
  return ids;
};

/** Rewrite the devices.tags name cache from the joins */
export const refreshDeviceTagCache = async (deviceIds?: number[]): Promise<void> => {
  const where = deviceIds ? { id: deviceIds } : {};
  const devices = await DeviceModel.findAll({ where, attributes: ['id', 'tags'] });
  if (!devices.length) return;
  const joins = await DeviceTagModel.findAll({ where: { deviceId: devices.map(d => d.id) } });
  const tags = joins.length ? await TagModel.findAll({ where: { id: Array.from(new Set(joins.map(j => j.tagId))) } }) : [];
  const nameOf = new Map(tags.map(tag => [tag.id, tag.name]));
  for (const device of devices) {
    const names = joins
      .filter(join => join.deviceId === device.id)
      .map(join => nameOf.get(join.tagId))
      .filter(Boolean)
      .sort()
      .join(',');
    if (names !== device.tags) await DeviceModel.update({ tags: names }, { where: { id: device.id } });
  }
};

/** Replace a device's tags with these tag ids (unknown ids ignored) */
export const setDeviceTagIds = async (deviceId: number, tagIds: number[]): Promise<number[]> => {
  const valid = tagIds.length ? (await TagModel.findAll({ where: { id: tagIds }, attributes: ['id'] })).map(t => t.id) : [];
  const keep = valid.slice(0, MAX_DEVICE_TAGS);
  await sequelize.transaction(async transaction => {
    await DeviceTagModel.destroy({ where: { deviceId }, transaction });
    if (keep.length) await DeviceTagModel.bulkCreate(keep.map(tagId => ({ deviceId, tagId })), { transaction });
  });
  await refreshDeviceTagCache([deviceId]);
  return keep;
};

export const deviceTagIds = async (deviceIds: number[]): Promise<Map<number, number[]>> => {
  const joins = deviceIds.length ? await DeviceTagModel.findAll({ where: { deviceId: deviceIds } }) : [];
  const map = new Map<number, number[]>();
  joins.forEach(join => map.set(join.deviceId, [...(map.get(join.deviceId) || []), join.tagId]));
  return map;
};

/** Device ids carrying ANY of these tags */
export const deviceIdsWithTags = async (tagIds: number[]): Promise<number[]> => {
  if (!tagIds.length) return [];
  const joins = await DeviceTagModel.findAll({ where: { tagId: { [Op.in]: tagIds } }, attributes: ['deviceId'] });
  // Devices whose tags were written straight to devices.tags (enrolment,
  // agents, rows from before migration 22) have no joins yet: match them by
  // name too so they are not silently left out of a tag-targeted run
  const tags = await TagModel.findAll({ where: { id: tagIds }, attributes: ['name'] });
  const names = new Set(tags.map(tag => tag.name.toLowerCase()));
  const legacy = names.size
    ? await DeviceModel.findAll({ where: { tags: { [Op.ne]: '' } }, attributes: ['id', 'tags'] })
    : [];
  const byName = legacy
    .filter(device => deviceTagNames(device.tags).some(name => names.has(name)))
    .map(device => device.id);
  return Array.from(new Set([...joins.map(join => join.deviceId), ...byName]));
};
