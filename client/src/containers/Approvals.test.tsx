/* eslint-disable testing-library/no-unnecessary-act -- plain react-dom rendering, no Testing Library here */
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import axios from 'axios';
import { AuthContext } from '../store';
import { Approvals } from './Approvals';
import { approvalMessage, heldApproval } from '../utils';

jest.mock('axios');
jest.mock('../components/UI', () => {
  const React = require('react');
  return {
    Layout: ({ children }: any) => React.createElement('div', null, children),
    Card: ({ children }: any) => React.createElement('div', null, children)
  };
});
const mocked = axios as jest.Mocked<typeof axios>;

const pending = {
  id: 5,
  kind: 'snippet',
  title: 'Wipe temp',
  why: ['dangerous'],
  trigger: 'manual',
  reason: 'clear space',
  snippetId: 3,
  runbookId: null,
  scheduleId: null,
  siteId: 1,
  targets: [{ type: 'device', id: 1, name: 'pc-01' }],
  targetCount: 1,
  status: 'pending',
  requestedBy: 2,
  requestedByName: 'Alice',
  decidedBy: null,
  decidedByName: null,
  decisionComment: '',
  decidedAt: null,
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  result: '',
  createdAt: new Date().toISOString(),
  canDecide: true
};

let container: HTMLDivElement;
let root: Root;
const flush = () => act(() => new Promise(resolve => setTimeout(resolve, 0)));

const mount = async (role = 'admin') => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <AuthContext.Provider value={{ user: { id: 1, role } } as any}>
        <MemoryRouter>
          <Approvals />
        </MemoryRouter>
      </AuthContext.Provider>
    );
  });
  await flush();
};

const button = (name: string) => Array.from(container.querySelectorAll('button')).find(b => b.textContent === name);

describe('Approvals page', () => {
  beforeAll(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    mocked.get.mockImplementation((url: string, config?: any) => {
      if (url === '/api/approvals/settings') {
        return Promise.resolve({ data: { data: { enabled: true, deviceThreshold: 10, expiryHours: 24 } } });
      }
      if (config?.params?.status === 'history') {
        return Promise.resolve({ data: { data: [{ ...pending, id: 4, status: 'denied', decidedByName: 'Adam', decisionComment: 'not today', decidedAt: new Date().toISOString() }] } });
      }
      return Promise.resolve({ data: { data: [pending] } });
    });
    mocked.post.mockResolvedValue({ data: { data: { ...pending, status: 'approved' } } });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    jest.resetAllMocks();
  });

  it('lists pending requests with who, what, targets and reason, plus history', async () => {
    await mount();
    expect(container.textContent).toContain('Wipe temp');
    expect(container.textContent).toContain('Alice');
    expect(container.textContent).toContain('pc-01');
    expect(container.textContent).toContain('clear space');
    expect(container.textContent).toContain('not today');
    expect(container.textContent).toContain('Large run: more than this many devices');
  });

  it('approves with a comment', async () => {
    await mount();
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Comment"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'checked');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => button('Approve')!.click());
    await flush();
    expect(mocked.post).toHaveBeenCalledWith('/api/approvals/5/approve', { comment: 'checked' });
  });

  it('does not offer a decision on requests you cannot decide, nor settings to editors', async () => {
    mocked.get.mockImplementation((url: string, config?: any) =>
      Promise.resolve({ data: { data: config?.params?.status === 'history' ? [] : [{ ...pending, canDecide: false }] } })
    );
    await mount('editor');
    expect(button('Approve')).toBeUndefined();
    expect(container.textContent).toContain('Waiting for another admin');
    expect(container.textContent).not.toContain('Large run: more than');
  });

  it('recognises a held run response', () => {
    const held = heldApproval({ approval: pending });
    expect(held?.id).toBe(5);
    expect(approvalMessage(held!)).toContain('flagged dangerous');
    expect(heldApproval({ jobs: [] })).toBeNull();
  });
});
