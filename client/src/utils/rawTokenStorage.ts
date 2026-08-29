const currentPrefix = 'snippycode_raw_token_';
const legacyPrefix = 'snippysafe_raw_token_';

export const rawTokenStorageKey = (id: number): string => `${currentPrefix}${id}`;

export const readRawToken = (id: number): string => {
  const current = window.localStorage.getItem(rawTokenStorageKey(id));

  if (current) {
    return current;
  }

  const legacy = window.localStorage.getItem(`${legacyPrefix}${id}`);

  if (legacy) {
    window.localStorage.setItem(rawTokenStorageKey(id), legacy);
    window.localStorage.removeItem(`${legacyPrefix}${id}`);
    return legacy;
  }

  return '';
};

export const writeRawToken = (id: number, token: string): void => {
  window.localStorage.setItem(rawTokenStorageKey(id), token);
  window.localStorage.removeItem(`${legacyPrefix}${id}`);
};

export const removeRawToken = (id: number): void => {
  window.localStorage.removeItem(rawTokenStorageKey(id));
  window.localStorage.removeItem(`${legacyPrefix}${id}`);
};
