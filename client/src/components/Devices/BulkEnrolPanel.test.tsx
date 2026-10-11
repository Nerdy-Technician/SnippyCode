/* eslint-disable testing-library/no-unnecessary-act -- plain react-dom rendering, no Testing Library here */
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import axios from 'axios';
import { SnippetsContext } from '../../store';
import { BulkEnrolPanel } from './BulkEnrolPanel';

jest.mock('axios');
jest.mock('clipboard-copy', () => jest.fn(() => Promise.resolve()));
const mocked = axios as jest.Mocked<typeof axios>;

const token = {
  id: 7,
  siteId: 1,
  site: { id: 1, name: 'Office' },
  label: '',
  tokenPrefix: 'sc_enroll_abcdef',
  maxUses: null,
  uses: 2,
  expiresAt: '2026-10-18T12:00:00.000Z',
  lastUsedAt: null,
  revokedAt: null,
  createdAt: '2026-10-11T12:00:00.000Z',
  status: 'active'
};

let container: HTMLDivElement;
let root: Root;

const flush = () => act(() => new Promise(resolve => setTimeout(resolve, 0)));

const renderPanel = async () => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <SnippetsContext.Provider value={{ sites: [{ id: 1, name: 'Office', slug: 'office' }] } as any}>
        <BulkEnrolPanel />
      </SnippetsContext.Provider>
    );
  });
  await flush();
};

const buttons = (name: string) =>
  Array.from(container.querySelectorAll('button')).filter(button => button.textContent === name);

describe('BulkEnrolPanel', () => {
  beforeAll(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    mocked.get.mockResolvedValue({ data: { data: [token] } });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  test('lists tokens with uses and status, never the token itself', async () => {
    await renderPanel();

    expect(container.textContent).toContain('sc_enroll_abcdef…');
    expect(container.textContent).toContain('2 (unlimited)');
    expect(container.textContent).toContain('Active');
    expect(buttons('Revoke')).toHaveLength(1);
  });

  test('creates a token with a 7 day default and shows both one-liners', async () => {
    mocked.post.mockResolvedValue({
      data: {
        data: {
          ...token,
          token: 'sc_enroll_PLACEHOLDER',
          linux: 'curl -fsSL https://snippy.example/agent/install.sh | sudo bash -s -- --url https://snippy.example --token sc_enroll_PLACEHOLDER',
          windows: '& ([scriptblock]::Create((irm https://snippy.example/agent/install.ps1))) -Url https://snippy.example -Token sc_enroll_PLACEHOLDER'
        }
      }
    });
    await renderPanel();

    await act(async () => {
      buttons('Create install script')[0].click();
    });
    await flush();

    expect(mocked.post).toHaveBeenCalledWith('/api/devices/enrollments', {
      siteId: 1,
      maxUses: null,
      expiresHours: 168,
      label: '',
      allowReenrol: false
    });
    expect(container.textContent).toContain('sudo bash -s -- --url https://snippy.example --token sc_enroll_PLACEHOLDER');
    expect(container.textContent).toContain('-Token sc_enroll_PLACEHOLDER');
    expect(buttons('Copy install script')).toHaveLength(2);
  });
});
