/* eslint-disable testing-library/no-render-in-setup, testing-library/no-unnecessary-act --
   This file mounts with ReactDOM directly (the client has no Testing
   Library); those rules mistake root.render() for Testing Library's render(). */
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { MemoryRouter, Route } from 'react-router-dom';
import axios from 'axios';
import { PublicSnippet } from './PublicSnippet';
import { REMOTE_EXECUTE_WARNING } from '../utils';

jest.mock('axios');
// react-markdown ships ES modules only, which CRA's Jest does not transform.
jest.mock('../components/Snippets/SnippetDocs', () => ({
  SnippetDocs: ({ markdown }: { markdown: string }) =>
    require('react').createElement('div', { className: 'docs-stub' }, markdown)
}));

const snippet = {
  id: 16,
  title: 'Purge OneDrive from Windows',
  description: '',
  language: 'powershell',
  code: Array.from({ length: 200 }, (_, i) => `Write-Host "line ${i}"`).join('\n'),
  docs: '# Purge OneDrive',
  collection: 'General',
  fileName: '',
  rawSlug: 'purge-onedrive-from-windows.powershell',
  tags: ['windows', 'powershell'],
  updatedAt: '2026-09-30T15:48:00.840Z'
};

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  (axios.get as jest.Mock).mockResolvedValue({ data: { data: snippet } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[`/s/${snippet.rawSlug}`]}>
        <Route path='/s/:rawRef' component={PublicSnippet} />
      </MemoryRouter>
    );
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('public snippet page layout', () => {
  it('loads the snippet by its dotted slug', () => {
    expect(axios.get).toHaveBeenCalledWith(
      '/api/snippets/public/purge-onedrive-from-windows.powershell'
    );
    expect(container.textContent).toContain(snippet.title);
  });

  // Regression: .app-card is height: 100%. When the code panel shared a
  // column with the title card, the card grew to the whole column height and
  // the page showed screens of empty panels before the code.
  it('never puts a card and other content in the same column', () => {
    const columns = Array.from(container.querySelectorAll('.row > [class*="col-"]'));
    const cardColumns = columns.filter(col => col.querySelector('.app-card'));

    expect(cardColumns.length).toBeGreaterThan(0);
    cardColumns.forEach(col => {
      expect(col.children).toHaveLength(1);
      expect(col.firstElementChild?.classList.contains('app-card')).toBe(true);
    });
  });

  it('gives the code its own full-width column', () => {
    const pre = container.querySelector('pre.code-panel');
    const column = pre?.parentElement;

    expect(column?.className.split(' ')).toContain('col-12');
    expect(column?.className).not.toMatch(/col-(sm|md|lg|xl)-/);
    expect(column?.querySelector('.app-card')).toBeNull();
  });

  it('shows the title, raw link and one-liner before the code', () => {
    const text = container.textContent || '';
    const codeAt = text.indexOf('Write-Host "line 0"');

    expect(codeAt).toBeGreaterThan(-1);
    [
      snippet.title,
      'Copy raw URL',
      `/raw/${snippet.rawSlug} | iex`,
      REMOTE_EXECUTE_WARNING
    ].forEach(part => {
      const at = text.indexOf(part);
      expect(at).toBeGreaterThan(-1);
      expect(at).toBeLessThan(codeAt);
    });
  });
});
