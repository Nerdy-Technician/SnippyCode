import { Response, NextFunction } from 'express';
import { Op } from 'sequelize';
import { asyncWrapper, AuthenticatedRequest } from '../middleware';
import { SiteModel, SnippetRunModel, SnippetRunInstance, UserModel } from '../models';
import { ErrorResponse, accessibleSiteIds, findAccessibleSite } from '../utils';

const PREVIEW_LENGTH = 400;

/**
 * Runs without a site are visible to everyone signed in; site runs follow
 * site access.
 */
export const runVisibilityFilter = async (viewer: { id?: number; role?: string }) => {
  const ids = await accessibleSiteIds(viewer);

  return ids === 'all'
    ? {}
    : { [Op.or]: [{ siteId: null }, { siteId: ids.length ? ids : [-1] }] };
};

export const describeRuns = async (runs: SnippetRunInstance[], full = false) => {
  const siteIds = Array.from(new Set(runs.map(run => run.siteId).filter(Boolean))) as number[];
  const userIds = Array.from(new Set(runs.map(run => run.userId).filter(Boolean))) as number[];
  const [sites, users] = await Promise.all([
    siteIds.length ? SiteModel.findAll({ where: { id: siteIds }, attributes: ['id', 'name', 'slug'] }) : [],
    userIds.length ? UserModel.findAll({ where: { id: userIds }, attributes: ['id', 'displayName'] }) : []
  ]);

  return runs.map(run => {
    const site = sites.find(item => item.id === run.siteId);
    const user = users.find(item => item.id === run.userId);

    return {
      id: run.id,
      snippetId: run.snippetId,
      snippetTitle: run.snippetTitle,
      site: site ? { id: site.id, name: site.name, slug: site.slug } : null,
      user: user ? { id: user.id, displayName: user.displayName } : null,
      runbookRunId: run.runbookRunId,
      scheduleRunId: run.scheduleRunId,
      deviceId: run.deviceId,
      deviceName: run.deviceName,
      sandbox: run.sandbox,
      kind: run.kind,
      language: run.language,
      ok: run.ok,
      exitCode: run.exitCode,
      timedOut: run.timedOut,
      durationMs: run.durationMs,
      createdAt: run.createdAt,
      ...(full
        ? { stdout: run.stdout, stderr: run.stderr }
        : {
            stdout: run.stdout.slice(0, PREVIEW_LENGTH),
            stderr: run.stderr.slice(0, PREVIEW_LENGTH),
            truncated: run.stdout.length > PREVIEW_LENGTH || run.stderr.length > PREVIEW_LENGTH
          })
    };
  });
};

/**
 * @description Run history, newest first. Filter by siteId, snippetId, or
 * runbookRunId.
 * @route /api/runs
 * @request GET
 */
export const getRuns = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const where: { [key: string]: unknown }[] = [await runVisibilityFilter(req.user || {})];

    if (req.query.siteId) {
      const site = await findAccessibleSite(req.user || {}, req.query.siteId);

      if (!site) {
        return next(new ErrorResponse(404, 'Site was not found'));
      }

      where.push({ siteId: site.id });
    }

    if (req.query.snippetId) {
      where.push({ snippetId: Number(req.query.snippetId) || -1 });
    }

    if (req.query.deviceId) {
      where.push({ deviceId: Number(req.query.deviceId) || -1 });
    } else if (req.query.includeTools !== 'true') {
      // Device tool refreshes are noise outside the device's own page
      where.push({ kind: 'snippet' });
    }

    if (req.query.runbookRunId) {
      where.push({ runbookRunId: Number(req.query.runbookRunId) || -1 });
    }

    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const runs = await SnippetRunModel.findAll({
      where: { [Op.and]: where },
      order: [['createdAt', 'DESC']],
      limit
    });

    res.status(200).json({ data: await describeRuns(runs) });
  }
);

/**
 * @description One run with its full saved output
 * @route /api/runs/:id
 * @request GET
 */
export const getRun = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const run = await SnippetRunModel.findOne({
      where: {
        [Op.and]: [{ id: Number(req.params.id) || -1 }, await runVisibilityFilter(req.user || {})]
      }
    });

    if (!run) {
      return next(new ErrorResponse(404, 'Run was not found'));
    }

    res.status(200).json({ data: (await describeRuns([run], true))[0] });
  }
);
