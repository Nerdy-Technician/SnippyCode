import { AuditLogModel } from '../models';

export const auditLog = async (
  action: string,
  options: {
    userId?: number | null;
    target?: string | null;
    ipAddress?: string | null;
    metadata?: unknown;
  } = {}
): Promise<void> => {
  await AuditLogModel.create({
    action,
    userId: options.userId || null,
    target: options.target || null,
    ipAddress: options.ipAddress || null,
    metadata: JSON.stringify(options.metadata || {})
  });
};

export const requestIp = (req: { ip?: string; headers?: any }): string | null => {
  const forwarded = String(req.headers?.['x-forwarded-for'] || '')
    .split(',')[0]
    .trim();

  return forwarded || req.ip || null;
};
