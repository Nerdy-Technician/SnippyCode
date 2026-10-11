import { NextFunction, Response } from 'express';
import { fn, col } from 'sequelize';
import { sequelize } from '../db';
import { DeviceTagModel, ScheduleModel, Snippet_TagModel, TagModel } from '../models';
import { asyncWrapper, AuthenticatedRequest } from '../middleware';
import {
  auditLog,
  cleanTagColor,
  cleanTagName,
  DEFAULT_TAG_COLOR,
  ErrorResponse,
  parseIdList,
  refreshDeviceTagCache,
  requestIp
} from '../utils';

/**
 * Shared tag manager: one list of tags (names + colours) used by snippets
 * and devices. Everyone signed in can read it; admins manage it.
 */
const actor = (req: AuthenticatedRequest) => ({
  userId: req.user?.id || null,
  ipAddress: requestIp(req)
});

const counts = async (model: typeof DeviceTagModel | typeof Snippet_TagModel, column: string) => {
  const rows = (await (model as any).findAll({
    attributes: [[col(column), 'tagId'], [fn('COUNT', col(column)), 'count']],
    group: [column],
    raw: true
  })) as Array<{ tagId: number; count: string }>;
  return new Map(rows.map(row => [Number(row.tagId), Number(row.count)]));
};

export const getTags = asyncWrapper(async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
  const [tags, devices, snippets] = await Promise.all([
    TagModel.findAll({ order: [['name', 'ASC']] }),
    counts(DeviceTagModel, 'tagId'),
    counts(Snippet_TagModel, 'tag_id')
  ]);
  res.status(200).json({
    data: tags.map(tag => ({
      id: tag.id,
      name: tag.name,
      color: tag.color || null,
      deviceCount: devices.get(tag.id) || 0,
      snippetCount: snippets.get(tag.id) || 0
    }))
  });
});

export const createTag = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const name = cleanTagName(req.body?.name);
    if (!name) return next(new ErrorResponse(400, 'Tag name is required'));
    if (await TagModel.findOne({ where: { name } })) return next(new ErrorResponse(409, 'That tag already exists'));
    const tag = await TagModel.create({ name, color: cleanTagColor(req.body?.color) || DEFAULT_TAG_COLOR });
    await auditLog('tag.created', { ...actor(req), target: `tag:${tag.id}`, metadata: { name, color: tag.color } });
    res.status(201).json({ data: { id: tag.id, name: tag.name, color: tag.color || null, deviceCount: 0, snippetCount: 0 } });
  }
);

export const updateTag = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const tag = await TagModel.findByPk(Number(req.params.id) || -1);
    if (!tag) return next(new ErrorResponse(404, 'Tag was not found'));
    const before = { name: tag.name, color: tag.color || null };
    const patch: { name?: string; color?: string | null } = {};
    if (req.body?.name !== undefined) {
      const name = cleanTagName(req.body.name);
      if (!name) return next(new ErrorResponse(400, 'Tag name is required'));
      const clash = await TagModel.findOne({ where: { name } });
      if (clash && clash.id !== tag.id) return next(new ErrorResponse(409, 'That tag already exists'));
      patch.name = name;
    }
    if (req.body?.color !== undefined) {
      if (req.body.color && !cleanTagColor(req.body.color)) return next(new ErrorResponse(400, 'Colour must be #rrggbb'));
      patch.color = cleanTagColor(req.body.color);
    }
    await tag.update(patch);
    if (patch.name && patch.name !== before.name) {
      const joins = await DeviceTagModel.findAll({ where: { tagId: tag.id } });
      await refreshDeviceTagCache(joins.map(join => join.deviceId));
    }
    await auditLog('tag.updated', { ...actor(req), target: `tag:${tag.id}`, metadata: { before, after: { name: tag.name, color: tag.color || null } } });
    res.status(200).json({ data: { id: tag.id, name: tag.name, color: tag.color || null } });
  }
);

export const deleteTag = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const tag = await TagModel.findByPk(Number(req.params.id) || -1);
    if (!tag) return next(new ErrorResponse(404, 'Tag was not found'));
    const joins = await DeviceTagModel.findAll({ where: { tagId: tag.id } });
    const schedules = (await ScheduleModel.findAll()).filter(schedule => parseIdList(schedule.deviceTagIds).includes(tag.id));
    await sequelize.transaction(async transaction => {
      for (const schedule of schedules) {
        await schedule.update({ deviceTagIds: parseIdList(schedule.deviceTagIds).filter(id => id !== tag.id).join(',') }, { transaction });
      }
      await DeviceTagModel.destroy({ where: { tagId: tag.id }, transaction });
      await Snippet_TagModel.destroy({ where: { tag_id: tag.id }, transaction });
      await tag.destroy({ transaction });
    });
    await refreshDeviceTagCache(joins.map(join => join.deviceId));
    await auditLog('tag.deleted', {
      ...actor(req),
      target: `tag:${tag.id}`,
      metadata: { name: tag.name, devices: joins.length, schedules: schedules.map(s => s.id) }
    });
    res.status(200).json({ data: { id: tag.id } });
  }
);
