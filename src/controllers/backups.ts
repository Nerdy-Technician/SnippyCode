import { Response, NextFunction } from 'express';
import { readFile } from 'fs/promises';
import { asyncWrapper, AuthenticatedRequest, clearSessionCookie } from '../middleware';
import {
  ErrorResponse,
  auditLog,
  backupPath,
  deleteBackup,
  encryptSecret,
  getBackupSchedule,
  listBackups,
  requestIp,
  restoreBackupData,
  runAutomaticBackup,
  saveBackup,
  saveBackupSchedule
} from '../utils';

const auditActor = (req: AuthenticatedRequest) => ({
  userId: req.user?.id || null,
  ipAddress: requestIp(req)
});

const publicSchedule = async () => {
  const schedule = await getBackupSchedule();
  return { ...schedule, passphrase: undefined, hasPassphrase: Boolean(schedule.passphrase) };
};

/**
 * @description Stored backups and the automatic backup settings
 * @route /api/admin/backups
 * @request GET
 */
export const getBackups = asyncWrapper(
  async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
    res.status(200).json({ data: { backups: listBackups(), schedule: await publicSchedule() } });
  }
);

/**
 * @description Take a backup now and keep it on the server
 * @route /api/admin/backups
 * @request POST
 */
export const createBackup = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const passphrase = typeof req.body?.passphrase === 'string' ? req.body.passphrase : '';

    if (passphrase && passphrase.length < 8) {
      return next(new ErrorResponse(400, 'Use a passphrase of at least 8 characters'));
    }

    const saved = await saveBackup({
      passphrase,
      includeHistory: req.body?.includeHistory !== false,
      label: 'manual'
    });

    await auditLog('backup.created', {
      ...auditActor(req),
      metadata: { name: saved.name, encrypted: saved.encrypted, size: saved.size }
    });

    res.status(201).json({ data: saved });
  }
);

export const downloadBackup = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    let path: string;

    try {
      path = backupPath(String(req.params.name));
    } catch {
      return next(new ErrorResponse(404, 'Backup was not found'));
    }

    await auditLog('backup.downloaded', { ...auditActor(req), metadata: { name: req.params.name } });
    res.download(path);
  }
);

export const removeBackup = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      await deleteBackup(String(req.params.name));
    } catch {
      return next(new ErrorResponse(404, 'Backup was not found'));
    }

    await auditLog('backup.deleted', { ...auditActor(req), metadata: { name: req.params.name } });
    res.status(200).json({ data: {} });
  }
);

/**
 * @description Automatic backup settings. Omit passphrase to keep it; send
 * an empty string to remove it.
 * @route /api/admin/backups/schedule
 * @request PUT
 */
export const updateBackupSchedule = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const current = await getBackupSchedule();
    const body = req.body || {};
    const passphrase = typeof body.passphrase === 'string' ? body.passphrase : undefined;

    if (passphrase && passphrase.length < 8) {
      return next(new ErrorResponse(400, 'Use a passphrase of at least 8 characters'));
    }

    await saveBackupSchedule({
      ...current,
      enabled: Boolean(body.enabled),
      everyHours: Math.min(Math.max(Number(body.everyHours) || 24, 1), 24 * 30),
      keep: Math.min(Math.max(Number(body.keep) || 14, 1), 365),
      includeHistory: body.includeHistory !== false,
      passphrase: passphrase === undefined ? current.passphrase : passphrase ? encryptSecret(passphrase) : ''
    });

    await auditLog('backup.schedule_updated', {
      ...auditActor(req),
      metadata: { enabled: Boolean(body.enabled), everyHours: body.everyHours, keep: body.keep }
    });

    res.status(200).json({ data: await publicSchedule() });
  }
);

export const runBackupNow = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const saved = await runAutomaticBackup(new Date(), true);

    if (!saved) {
      return next(new ErrorResponse(500, (await getBackupSchedule()).lastError || 'Backup failed'));
    }

    res.status(201).json({ data: saved });
  }
);

/**
 * @description Replace all data with a backup: an uploaded file, or a stored
 * backup by name. Needs confirm: "RESTORE". Signs everyone out.
 * @route /api/admin/backups/restore
 * @request POST
 */
export const restoreBackup = asyncWrapper(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    if (String(req.body?.confirm || '') !== 'RESTORE') {
      return next(new ErrorResponse(400, 'Type RESTORE to confirm. This replaces all current data.'));
    }

    const upload = (req as AuthenticatedRequest & { file?: { buffer: Buffer } }).file;
    let raw: Buffer;

    try {
      raw = upload ? upload.buffer : await readFile(backupPath(String(req.body?.name || '')));
    } catch {
      return next(new ErrorResponse(400, 'Upload a backup file or choose a stored backup'));
    }

    const actor = { ...auditActor(req) };

    try {
      const result = await restoreBackupData(raw, String(req.body?.passphrase || ''));

      // The user table was replaced; log without a user id that may be gone
      await auditLog('backup.restored', {
        ipAddress: actor.ipAddress,
        metadata: {
          from: upload ? 'upload' : req.body?.name,
          createdAt: result.meta.createdAt,
          safetyBackup: result.safetyBackup,
          by: req.user?.email
        }
      });

      clearSessionCookie(res);
      res.status(200).json({ data: result });
    } catch (err) {
      next(new ErrorResponse(400, err instanceof Error ? err.message : 'Restore failed'));
    }
  }
);
