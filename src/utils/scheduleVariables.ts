import { SECRET_MASK, decryptSecret, encryptSecret, isBoundSecret, isEncryptedSecret } from './secretBox';

/**
 * Schedule variable values are stored encrypted (secretBox, the
 * VARIABLES_SECRET_KEY) and bound to their schedule and name with AAD
 * ("schedules:<id>:variables:<name>"), so a value copied to another
 * schedule or name fails to decrypt. They are decrypted only when a
 * schedule runs or in the editor-only edit fetch; everything else sees
 * SECRET_MASK. Legacy values (plain or enc:v1 without AAD) are read once and
 * rewritten bound.
 */
type Values = Record<string, string>;

export const scheduleAad = (scheduleId: number, name: string): string => `schedules:${scheduleId}:variables:${name}`;

const entries = (values: unknown): Array<[string, string]> =>
  values && typeof values === 'object' && !Array.isArray(values)
    ? Object.entries(values as Record<string, unknown>).map(([key, value]) => [key, String(value ?? '')])
    : [];

export const encryptScheduleVariables = (values: unknown, scheduleId: number): Values =>
  Object.fromEntries(
    entries(values).map(([key, value]) => {
      if (value === '' || isBoundSecret(value)) return [key, value];
      // Plain, or legacy v1: (decrypt and) bind to this schedule
      const plain = isEncryptedSecret(value) ? decryptSecret(value) : value;
      return [key, encryptSecret(plain, scheduleAad(scheduleId, key))];
    })
  );

export const decryptScheduleVariables = (values: unknown, scheduleId: number): Values =>
  Object.fromEntries(
    entries(values).map(([key, value]) => [
      key,
      isBoundSecret(value) ? decryptSecret(value, scheduleAad(scheduleId, key)) : decryptSecret(value)
    ])
  );

/** True when some value is still plain or legacy (unbound) ciphertext */
export const needsRebinding = (values: unknown): boolean =>
  entries(values).some(([, value]) => value !== '' && !isBoundSecret(value));

export const maskScheduleVariables = (values: unknown): Values =>
  Object.fromEntries(entries(values).map(([key, value]) => [key, value === '' ? '' : SECRET_MASK]));

/**
 * An edit form that was filled from a masked list sends SECRET_MASK back
 * for values it did not change: keep the stored value for those.
 */
export const restoreMaskedValues = (incoming: unknown, stored: unknown, scheduleId: number): unknown => {
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return incoming;
  const plain = decryptScheduleVariables(stored, scheduleId);
  return Object.fromEntries(
    Object.entries(incoming as Record<string, unknown>)
      .map(([key, value]) => [key, value === SECRET_MASK ? plain[key] : value])
      .filter(([, value]) => value !== undefined)
  );
};
