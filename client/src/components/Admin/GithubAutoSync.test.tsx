/* eslint-disable testing-library/no-unnecessary-act -- plain react-dom rendering, no Testing Library here */
import { act } from 'react-dom/test-utils';
import { createRoot } from 'react-dom/client';
import axios from 'axios';
import { GithubAutoSync, describeInterval } from './GithubAutoSync';

jest.mock('axios');
const mocked = axios as jest.Mocked<typeof axios>;

test('describes intervals', () => {
  expect(describeInterval(60)).toBe('every hour');
  expect(describeInterval(180)).toBe('every 3 hours');
  expect(describeInterval(15)).toBe('every 15 minutes');
  expect(describeInterval(1440)).toBe('every day');
});

test('shows toggles off by default, the run log and conflicts with resolve buttons', async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  mocked.get.mockResolvedValue({
    data: {
      data: {
        settings: {
          uploadEnabled: false,
          downloadEnabled: false,
          intervalMinutes: 60,
          intervals: [15, 60, 1440],
          lastRunAt: null,
          lastStatus: null,
          lastError: null,
          failures: 0,
          nextAttemptAt: null
        },
        runs: [
          { id: 1, trigger: 'schedule', status: 'failed', uploaded: 0, downloaded: 0, conflicts: 0, unchanged: 0, backup: null, error: 'GitHub 401: Bad credentials', startedAt: '2026-10-11T10:00:00Z', finishedAt: null }
        ],
        conflicts: [
          { id: 9, itemType: 'snippet', itemId: 3, title: 'Disk', conflictItemId: 4, conflictTitle: 'Disk (GitHub conflict)', conflictAt: null }
        ]
      }
    }
  });
  mocked.post.mockResolvedValue({ data: { data: {} } });

  const container = document.createElement('div');
  const root = createRoot(container);
  await act(async () => {
    root.render(<GithubAutoSync />);
  });
  await act(() => new Promise(resolve => setTimeout(resolve, 0)));

  const boxes = Array.from(container.querySelectorAll<HTMLInputElement>('input[type=checkbox]'));
  expect(boxes.map(box => box.checked)).toEqual([false, false]);
  expect(container.textContent).toContain('Last run: never');
  expect(container.textContent).toContain('GitHub 401: Bad credentials');
  expect(container.textContent).toContain('Disk (GitHub conflict)');

  const keepLocal = Array.from(container.querySelectorAll('button')).find(button => button.textContent === 'Keep local')!;
  await act(async () => {
    keepLocal.click();
  });
  expect(mocked.post).toHaveBeenCalledWith('/api/admin/github/sync/conflicts/9', { keep: 'local' });
  act(() => root.unmount());
});
