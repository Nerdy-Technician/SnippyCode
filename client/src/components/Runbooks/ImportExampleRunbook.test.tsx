/* eslint-disable testing-library/no-unnecessary-act -- plain react-dom rendering, no Testing Library here */
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import axios from 'axios';
import { ImportExampleRunbook } from './ImportExampleRunbook';

jest.mock('axios');
const mocked = axios as jest.Mocked<typeof axios>;

let container: HTMLDivElement;
let root: Root;
const flush = () => act(() => new Promise(resolve => setTimeout(resolve, 0)));

const mount = async (onImported = jest.fn()) => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter>
        <ImportExampleRunbook onImported={onImported} />
      </MemoryRouter>
    );
  });
  await flush();
  return onImported;
};

const button = () =>
  Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Import example runbook')!;

const choose = async (value: string) => {
  const select = container.querySelector('select')!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
    setter.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
};

describe('ImportExampleRunbook', () => {
  beforeAll(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    mocked.get.mockResolvedValue({ data: { data: [{ id: 1, name: 'Office' }, { id: 2, name: 'Lab' }] } });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    jest.resetAllMocks();
  });

  it('needs a site, then imports into it', async () => {
    mocked.post.mockResolvedValue({
      data: { data: { runbookId: 9, created: { snippets: 3, runbook: true, variables: 4 } } }
    });
    const onImported = await mount();
    expect(button().disabled).toBe(true);

    await choose('2');
    expect(button().disabled).toBe(false);
    await act(async () => button().click());
    await flush();

    expect(mocked.post).toHaveBeenCalledWith('/api/runbooks/example', { siteId: 2 });
    expect(onImported).toHaveBeenCalled();
    expect(container.textContent).toContain('Imported 3 snippet(s), 4 site variable(s) and the runbook');
    expect(container.querySelector('a')?.getAttribute('href')).toBe('/runbooks/9');
  });

  it('says so when the example is already there', async () => {
    mocked.post.mockResolvedValue({
      data: { data: { runbookId: 9, created: { snippets: 0, runbook: false, variables: 0 } } }
    });
    await mount();
    await choose('1');
    await act(async () => button().click());
    await flush();
    expect(container.textContent).toContain('Already imported');
  });

  it('shows the server error', async () => {
    mocked.post.mockRejectedValue({ response: { data: { error: 'Site was not found' } } });
    await mount();
    await choose('1');
    await act(async () => button().click());
    await flush();
    expect(container.querySelector('.alert-danger')).not.toBeNull();
  });
});
