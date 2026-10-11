import { EnrollmentToken } from '../typescript/interfaces';

export const DEFAULT_ENROL_EXPIRY_DAYS = 7;
export const MAX_ENROL_EXPIRY_DAYS = 365;

/** "3 of 10", "3 (unlimited)" */
export const describeUses = (token: Pick<EnrollmentToken, 'uses' | 'maxUses'>): string =>
  token.maxUses === null ? `${token.uses} (unlimited)` : `${token.uses} of ${token.maxUses}`;

export const describeStatus = (token: Pick<EnrollmentToken, 'status'>): string =>
  ({ active: 'Active', expired: 'Expired', used: 'Used up', revoked: 'Revoked' }[token.status] || token.status);

/** The request body for a new token; blank max uses means unlimited */
export const enrolmentRequest = (
  siteId: number,
  maxUses: string,
  expiryDays: string,
  label = '',
  allowReenrol = false
) => {
  const uses = maxUses.trim() === '' ? null : Math.max(1, Math.floor(Number(maxUses)) || 1);
  const days = Math.min(
    Math.max(Number(expiryDays) || DEFAULT_ENROL_EXPIRY_DAYS, 1 / 24),
    MAX_ENROL_EXPIRY_DAYS
  );

  return { siteId, maxUses: uses, expiresHours: Math.round(days * 24), label: label.trim(), allowReenrol };
};
