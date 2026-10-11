import { DataTypes, QueryInterface } from 'sequelize';

const { INTEGER, STRING, TEXT } = DataTypes;

export const DEFAULT_TAG_COLOR = '#64748b';

/** Trim, drop blanks and dedupe case-insensitively (first spelling wins, lowercased). */
export const normaliseTagNames = (raw: string): string[] =>
  Array.from(new Set(raw.split(',').map(name => name.trim().toLowerCase()).filter(Boolean)));

/**
 * Shared tag list with colours: the existing tags table (snippet tags) gains
 * a colour, devices join it through device_tags, and schedules target tag
 * IDs. Existing comma-separated device tags and schedule device tags are
 * migrated. devices.tags is kept as a read-only cache of the names.
 */
export const up = async (queryInterface: QueryInterface): Promise<void> => {
  const q = queryInterface.sequelize;
  await queryInterface.addColumn('tags', 'color', { type: STRING(7), allowNull: true });
  await queryInterface.createTable('device_tags', {
    deviceId: {
      type: INTEGER,
      allowNull: false,
      primaryKey: true,
      references: { model: 'devices', key: 'id' },
      onDelete: 'CASCADE'
    },
    tagId: {
      type: INTEGER,
      allowNull: false,
      primaryKey: true,
      references: { model: 'tags', key: 'id' },
      onDelete: 'CASCADE'
    }
  });
  await queryInterface.addIndex('device_tags', ['tagId']);
  await queryInterface.addColumn('schedules', 'deviceTagIds', { type: TEXT, allowNull: false, defaultValue: '' });

  // Existing device tags -> shared tags + joins (trimmed, case-insensitive)
  const [devices] = (await q.query(`SELECT id, tags FROM devices WHERE tags <> ''`)) as [Array<{ id: number; tags: string }>, unknown];
  const tagIdFor = async (name: string): Promise<number> => {
    const [found] = (await q.query(`SELECT id FROM tags WHERE lower(trim(name)) = :name ORDER BY id LIMIT 1`, {
      replacements: { name }
    })) as [Array<{ id: number }>, unknown];
    if (found[0]) return found[0].id;
    const [created] = (await q.query(`INSERT INTO tags (name, color) VALUES (:name, :color) RETURNING id`, {
      replacements: { name, color: DEFAULT_TAG_COLOR }
    })) as [Array<{ id: number }>, unknown];
    return created[0].id;
  };
  for (const device of devices) {
    for (const name of normaliseTagNames(device.tags)) {
      const tagId = await tagIdFor(name);
      await q.query(`INSERT INTO device_tags ("deviceId", "tagId") VALUES (:id, :tagId) ON CONFLICT DO NOTHING`, {
        replacements: { id: device.id, tagId }
      });
    }
    await q.query(`UPDATE devices SET tags = :tags WHERE id = :id`, {
      replacements: { id: device.id, tags: normaliseTagNames(device.tags).sort().join(',') }
    });
  }

  // Schedule device tag (one name) -> tag id
  const [schedules] = (await q.query(`SELECT id, "deviceTag" FROM schedules WHERE "deviceTag" <> ''`)) as [
    Array<{ id: number; deviceTag: string }>,
    unknown
  ];
  for (const schedule of schedules) {
    const name = normaliseTagNames(schedule.deviceTag)[0];
    if (!name) continue;
    const tagId = await tagIdFor(name);
    await q.query(`UPDATE schedules SET "deviceTagIds" = :tagId WHERE id = :id`, {
      replacements: { id: schedule.id, tagId: String(tagId) }
    });
  }

  await q.query(`UPDATE tags SET color = :color WHERE color IS NULL`, { replacements: { color: DEFAULT_TAG_COLOR } });
};

export const down = async (queryInterface: QueryInterface): Promise<void> => {
  await queryInterface.removeColumn('schedules', 'deviceTagIds');
  await queryInterface.dropTable('device_tags');
  await queryInterface.removeColumn('tags', 'color');
};
