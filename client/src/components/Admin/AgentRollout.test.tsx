/* eslint-disable testing-library/no-unnecessary-act -- plain react-dom rendering, no Testing Library here */
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import axios from 'axios';
import { AgentRollout } from './AgentRollout';

jest.mock('axios');
const mocked = axios as jest.Mocked<typeof axios>;
let container: HTMLDivElement;
let root: Root;

const status = (release: unknown) => ({
  data: {
    data: {
      release,
      rollout: { mode: 'manual', rings: ['canary'], percent: 10, paused: false },
      stage: 'manual',
      bootstrapOpen: false,
      rings: ['canary', 'early', 'stable'],
      devices: { total: 20, current: 3, offered: 5, pinned: 1 }
    }
  }
});

describe('AgentRollout', () => {
  beforeAll(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  });
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    jest.resetAllMocks();
  });

  it('shows the release and saves a ring change', async () => {
    mocked.get.mockResolvedValue(status({ version: '1.4.0', files: ['snippycode-agent.sh'] }));
    mocked.put.mockResolvedValue({ data: { data: {} } });
    await act(async () => root.render(<AgentRollout />));
    expect(container.textContent).toContain('Signed release 1.4.0: 3 of 20 devices');
    const early = Array.from(container.querySelectorAll('label')).find(label => label.textContent === 'early ring')!;
    await act(async () => (early.querySelector('input') as HTMLInputElement).click());
    expect(mocked.put).toHaveBeenCalledWith('/api/devices/agent-rollout', { mode: 'manual', rings: ['canary', 'early'], percent: 10, paused: false });
  });

  it('explains when no signed release is installed', async () => {
    mocked.get.mockResolvedValue(status(null));
    await act(async () => root.render(<AgentRollout />));
    expect(container.textContent).toContain('No signed release is installed');
  });
});
