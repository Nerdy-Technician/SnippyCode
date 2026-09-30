import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { About } from './About';
import { APP_VERSION, REMOTE_EXECUTE_WARNING } from '../utils';

// Root package.json: the version the About page must show.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { version } = require('../../../package.json');

const aboutMarkup = (): string =>
  renderToStaticMarkup(
    <MemoryRouter initialEntries={['/about']}>
      <About />
    </MemoryRouter>
  );

describe('About page', () => {
  it('shows the version from the root package.json', () => {
    expect(APP_VERSION).toBe(version);
    expect(aboutMarkup()).toContain(`data-testid="app-version">${version}<`);
  });

  it('lists share links and PowerShell remote execute with its safety note', () => {
    const view = aboutMarkup();

    expect(view).toContain('Share links');
    expect(view).toContain('PowerShell remote execute');
    expect(view).toContain(REMOTE_EXECUTE_WARNING);
  });

  it('links to the repo, the release notes and the author', () => {
    const view = aboutMarkup();

    expect(view).toContain('href="https://github.com/Nerdy-Technician/SnippyCode"');
    expect(view).toContain('href="https://github.com/Nerdy-Technician/SnippyCode/releases"');
    expect(view).toContain('Nerdy-Technician');
    expect(view).toContain('Sign in');
  });
});
