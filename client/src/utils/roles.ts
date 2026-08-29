const roleRank: { [key: string]: number } = {
  viewer: 10,
  user: 30,
  editor: 30,
  admin: 40,
  owner: 50
};

export const hasMinimumRole = (
  role: string | undefined,
  minimum: string
): boolean => (roleRank[role || ''] || 0) >= (roleRank[minimum] || 0);

export const canEditSnippets = (role?: string): boolean =>
  hasMinimumRole(role, 'editor');

export const canAdmin = (role?: string): boolean => hasMinimumRole(role, 'admin');

export const roleLabel = (role?: string, isOwner?: boolean): string => {
  if (isOwner || role === 'owner') {
    return 'Owner';
  }

  if (role === 'admin') {
    return 'Admin';
  }

  if (role === 'viewer') {
    return 'Viewer';
  }

  return 'Editor';
};
