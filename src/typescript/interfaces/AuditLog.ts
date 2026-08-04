import { Optional } from 'sequelize';
import { Model } from '.';

export interface AuditLog extends Model {
  userId?: number | null;
  action: string;
  target?: string | null;
  ipAddress?: string | null;
  metadata: string;
}

export interface AuditLogCreationAttributes
  extends Optional<AuditLog, 'id' | 'createdAt' | 'updatedAt' | 'userId' | 'target' | 'ipAddress' | 'metadata'> {}
