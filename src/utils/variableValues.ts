import { Op, WhereOptions } from 'sequelize';
import { VariableModel } from '../models';
import { decryptSecret, encryptSecret, isBoundSecret } from './secretBox';

export type VariableOrigin = 'global' | 'site' | 'user';

/** AAD for a saved variable's value: a ciphertext copied to another row fails */
export const variableAad = (id: number): string => `variables:${id}:value`;

/** Encrypt a variable value bound to its row (empty stays empty) */
export const encryptVariableValue = (id: number, plain: string): string =>
  plain === '' ? '' : encryptSecret(plain, variableAad(id));

/** Decrypt a stored variable value; legacy enc:v1 values are still readable */
export const decryptVariableValue = (row: { id: number; value: string }): string =>
  isBoundSecret(row.value) ? decryptSecret(row.value, variableAad(row.id)) : decryptSecret(row.value);

type Values = Record<string, string>;

export interface VariableLayers {
  /** Resolved saved values (user, then site, then global) */
  sources: Values[];
  /** Plain-text secret values, for masking output */
  secretValues: string[];
  /** Secret names that were withheld because secrets were not allowed */
  withheld: string[];
  /** Names whose winning value is a (decrypted) secret */
  secretNames: string[];
  /** Names the user set a personal value for */
  personalNames: string[];
  /** Which scope each resolved name came from */
  origins: Record<string, VariableOrigin>;
}

/**
 * Saved values for rendering a snippet. Secrets are decrypted only when
 * `includeSecrets` is set; otherwise their placeholders are kept as-is.
 */
export const loadVariableLayers = async (options: {
  userId?: number | null;
  siteId?: number | null;
  includeTeam?: boolean;
  includeSecrets: boolean;
}): Promise<VariableLayers> => {
  const { userId, siteId, includeTeam = true, includeSecrets } = options;
  const scopes: WhereOptions[] = [];

  if (userId) {
    scopes.push({ userId });
  }
  if (siteId) {
    scopes.push({ siteId });
  }
  if (includeTeam) {
    scopes.push({ userId: null, siteId: null });
  }

  const rows = scopes.length
    ? await VariableModel.findAll({ where: { [Op.or]: scopes }, raw: true })
    : [];
  const WITHHELD = Symbol('withheld');
  type Layer = Map<string, string | typeof WITHHELD>;
  const personal: Layer = new Map();
  const site: Layer = new Map();
  const team: Layer = new Map();
  const secretValues: string[] = [];
  const secretKeys = new Set<string>();

  rows.forEach(row => {
    const target = row.userId ? personal : row.siteId ? site : team;

    if (!row.isSecret) {
      target.set(row.name, row.value);
      return;
    }

    if (!includeSecrets) {
      target.set(row.name, WITHHELD);
      return;
    }

    try {
      const plain = decryptVariableValue(row);
      target.set(row.name, plain);
      secretValues.push(plain);
      secretKeys.add(`${target === personal ? 'p' : target === site ? 's' : 't'}:${row.name}`);
    } catch {
      // Unreadable (key changed): keep the placeholder rather than fail
      target.set(row.name, WITHHELD);
    }
  });

  // The first layer that defines a name wins. A withheld secret keeps its
  // placeholder instead of falling through to a lower layer or the default.
  const values: Values = {};
  const withheld: string[] = [];
  const secretNames: string[] = [];
  const origins: Record<string, VariableOrigin> = {};
  const originOf = { p: 'user', s: 'site', t: 'global' } as const;

  ([['p', personal], ['s', site], ['t', team]] as const).forEach(([key, layer]) => {
    layer.forEach((value, name) => {
      if (name in values) {
        return;
      }

      origins[name] = originOf[key];

      if (value === WITHHELD) {
        values[name] = `{{${name}}}`;
        withheld.push(name);
      } else {
        values[name] = value;

        if (secretKeys.has(`${key}:${name}`)) {
          secretNames.push(name);
        }
      }
    });
  });

  return {
    sources: [values],
    secretValues,
    withheld,
    secretNames,
    personalNames: Array.from(personal.keys()),
    origins
  };
};
