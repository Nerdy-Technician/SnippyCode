import { QueryTypes } from 'sequelize';
import { sequelize } from '../db';

export type UsageKind = 'view' | 'copy' | 'raw' | 'run';

const statColumns: { [kind in UsageKind]: string } = {
  view: 'viewCount',
  copy: 'copyCount',
  raw: 'rawFetchCount',
  run: 'runCount'
};

export interface SnippetUsage {
  views: number;
  copies: number;
  rawFetches: number;
  runs: number;
  lastUsedAt: Date | null;
}

export interface PersonalUsage {
  isFavorite: boolean;
  views: number;
  copies: number;
  lastViewedAt: Date | null;
  lastCopiedAt: Date | null;
}

const emptyUsage = (): SnippetUsage => ({
  views: 0,
  copies: 0,
  rawFetches: 0,
  runs: 0,
  lastUsedAt: null
});

const emptyPersonal = (): PersonalUsage => ({
  isFavorite: false,
  views: 0,
  copies: 0,
  lastViewedAt: null,
  lastCopiedAt: null
});

/**
 * Count a view, copy, raw fetch, or run. Views and copies are also recorded
 * against the signed-in user for their favorites and history.
 */
export const recordSnippetUsage = async (
  snippetId: number,
  kind: UsageKind,
  userId?: number | null
): Promise<void> => {
  const column = statColumns[kind];

  await sequelize.query(
    `INSERT INTO snippet_stats ("snippetId", "${column}", "lastUsedAt")
     VALUES (:snippetId, 1, NOW())
     ON CONFLICT ("snippetId") DO UPDATE
     SET "${column}" = snippet_stats."${column}" + 1, "lastUsedAt" = NOW()`,
    { replacements: { snippetId } }
  );

  if (!userId || (kind !== 'view' && kind !== 'copy')) {
    return;
  }

  const [countColumn, dateColumn] =
    kind === 'view' ? ['viewCount', 'lastViewedAt'] : ['copyCount', 'lastCopiedAt'];

  await sequelize.query(
    `INSERT INTO user_snippets ("userId", "snippetId", "${countColumn}", "${dateColumn}")
     VALUES (:userId, :snippetId, 1, NOW())
     ON CONFLICT ("userId", "snippetId") DO UPDATE
     SET "${countColumn}" = user_snippets."${countColumn}" + 1, "${dateColumn}" = NOW()`,
    { replacements: { userId, snippetId } }
  );
};

export const setSnippetFavorite = async (
  userId: number,
  snippetId: number,
  isFavorite: boolean
): Promise<void> => {
  await sequelize.query(
    `INSERT INTO user_snippets ("userId", "snippetId", "isFavorite")
     VALUES (:userId, :snippetId, :isFavorite)
     ON CONFLICT ("userId", "snippetId") DO UPDATE SET "isFavorite" = :isFavorite`,
    { replacements: { userId, snippetId, isFavorite } }
  );
};

/**
 * Add `usage` (library-wide) and `personal` (current user) fields to snippets.
 */
export const attachSnippetUsage = async <T extends { id: number }>(
  snippets: T[],
  userId?: number | null
): Promise<Array<T & { usage: SnippetUsage; personal: PersonalUsage }>> => {
  if (!snippets.length) {
    return [];
  }

  const ids = snippets.map(snippet => snippet.id);
  const stats = await sequelize.query<{
    snippetId: number;
    viewCount: number;
    copyCount: number;
    rawFetchCount: number;
    runCount: number;
    lastUsedAt: Date | null;
  }>(`SELECT * FROM snippet_stats WHERE "snippetId" IN (:ids)`, {
    type: QueryTypes.SELECT,
    replacements: { ids }
  });
  const personalRows = userId
    ? await sequelize.query<{
        snippetId: number;
        isFavorite: boolean;
        viewCount: number;
        copyCount: number;
        lastViewedAt: Date | null;
        lastCopiedAt: Date | null;
      }>(
        `SELECT * FROM user_snippets WHERE "userId" = :userId AND "snippetId" IN (:ids)`,
        { type: QueryTypes.SELECT, replacements: { userId, ids } }
      )
    : [];

  const statsById = new Map(stats.map(row => [row.snippetId, row]));
  const personalById = new Map(personalRows.map(row => [row.snippetId, row]));

  return snippets.map(snippet => {
    const stat = statsById.get(snippet.id);
    const mine = personalById.get(snippet.id);

    return {
      ...snippet,
      usage: stat
        ? {
            views: stat.viewCount,
            copies: stat.copyCount,
            rawFetches: stat.rawFetchCount,
            runs: stat.runCount,
            lastUsedAt: stat.lastUsedAt
          }
        : emptyUsage(),
      personal: mine
        ? {
            isFavorite: mine.isFavorite,
            views: mine.viewCount,
            copies: mine.copyCount,
            lastViewedAt: mine.lastViewedAt,
            lastCopiedAt: mine.lastCopiedAt
          }
        : emptyPersonal()
    };
  });
};
