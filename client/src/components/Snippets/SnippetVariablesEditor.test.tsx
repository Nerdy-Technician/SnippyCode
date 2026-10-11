/* eslint-disable testing-library/no-unnecessary-act -- plain react-dom rendering, no Testing Library here */
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { useState } from 'react';
import axios from 'axios';
import { SnippetVariablesEditor } from './SnippetVariablesEditor';
import { VariableDefinition } from '../../utils/snippetVariables';

jest.mock('axios');
const mocked = axios as jest.Mocked<typeof axios>;

let container: HTMLDivElement;
let root: Root;
let latest: VariableDefinition[] = [];
const flush = () => act(() => new Promise(resolve => setTimeout(resolve, 0)));

const Harness = ({ initial, code }: { initial: VariableDefinition[]; code: string }) => {
  const [value, setValue] = useState(initial);
  latest = value;
  return <SnippetVariablesEditor code={code} value={value} onChange={setValue} />;
};

const mount = async (code: string, initial: VariableDefinition[] = []) => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<Harness code={code} initial={initial} />));
};

const buttons = (text: string) => Array.from(container.querySelectorAll('button')).filter(b => b.textContent === text);
const change = async (el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string) => {
  await act(async () => {
    const proto = Object.getPrototypeOf(el);
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  });
};

describe('SnippetVariablesEditor', () => {
  beforeAll(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    jest.resetAllMocks();
  });

  it('offers to add placeholders found in the script and flags unused ones', async () => {
    await mount('rm -rf {{DIR}} --days {{DAYS:7}}', [{ name: 'OLD', type: 'string', default: '', required: false, description: '' }]);
    expect(container.textContent).toContain('Found in the script but not defined');
    expect(container.textContent).toContain('not used in the script');
    await act(async () => buttons('Add all')[0].click());
    expect(latest.map(def => def.name)).toEqual(['OLD', 'DIR', 'DAYS']);
    expect(latest[2].default).toBe('7');
    expect(container.textContent).not.toContain('Found in the script but not defined');
  });

  it('edits type, required and removes a variable', async () => {
    await mount('echo {{A}}', [{ name: 'A', type: 'string', default: '', required: false, description: '' }]);
    await change(container.querySelector('select[aria-label="Variable type"]')!, 'number');
    await act(async () => (container.querySelector('input[aria-label="Required"]') as HTMLInputElement).click());
    expect(latest[0]).toMatchObject({ type: 'number', required: true });
    await act(async () => (container.querySelector('button[aria-label="Remove A"]') as HTMLButtonElement).click());
    expect(latest).toEqual([]);
  });

  it('imports from pasted JSON', async () => {
    await mount('');
    await change(container.querySelector('select[aria-label="Import variables"]')!, 'json');
    await change(container.querySelector('textarea[aria-label="Variables JSON"]')!, '[{"name":"HOST","type":"string","required":true}]');
    await act(async () => buttons('Import JSON')[0].click());
    expect(latest).toMatchObject([{ name: 'HOST', required: true }]);
  });

  it('imports saved variables as references, never values', async () => {
    mocked.get.mockResolvedValue({
      data: { data: { snippets: [], saved: [{ name: 'VAULT_TOKEN', scope: 'site', siteName: 'Office', isSecret: true, description: '' }] } }
    });
    await mount('');
    await change(container.querySelector('select[aria-label="Import variables"]')!, 'saved');
    await flush();
    expect(container.textContent).toContain('secret');
    await act(async () => buttons('VAULT_TOKEN')[0].click());
    expect(latest[0]).toMatchObject({ name: 'VAULT_TOKEN', type: 'secret-ref', ref: 'VAULT_TOKEN', default: '' });
  });
});
