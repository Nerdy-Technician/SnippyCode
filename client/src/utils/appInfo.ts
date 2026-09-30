/** Static facts about the app, shown on the About page. */
export const APP_NAME = 'SnippyCode';
export const APP_DESCRIPTION =
  'A private, self-hosted snippet manager with versioning, sharing and raw links.';
export const APP_AUTHOR = 'Nerdy-Technician';
export const APP_AUTHOR_URL = 'https://github.com/Nerdy-Technician';
export const REPO_URL = 'https://github.com/Nerdy-Technician/SnippyCode';
export const RELEASES_URL = `${REPO_URL}/releases`;

/**
 * Injected from the root package.json by config-overrides.js at build and
 * test time. 'dev' only appears if the client is built some other way.
 */
export const APP_VERSION = process.env.REACT_APP_VERSION || 'dev';
