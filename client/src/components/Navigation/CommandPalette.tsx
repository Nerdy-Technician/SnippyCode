import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useHistory } from 'react-router-dom';
import axios from 'axios';
import { AuthContext, SnippetsContext } from '../../store';
import { Response, RunbookListItem, Schedule } from '../../typescript/interfaces';
import { canAdmin, canEditSnippets } from '../../utils';

interface Item {
  id: string;
  kind: 'Page' | 'Action' | 'Snippet' | 'Site' | 'Runbook' | 'Schedule';
  label: string;
  hint?: string;
  to: string;
}

const PAGES: Item[] = [
  { id: 'p-home', kind: 'Page', label: 'Home', to: '/' },
  { id: 'p-snippets', kind: 'Page', label: 'Snippets', to: '/snippets' },
  { id: 'p-sites', kind: 'Page', label: 'Sites', to: '/sites' },
  { id: 'p-runbooks', kind: 'Page', label: 'Runbooks', to: '/runbooks' },
  { id: 'p-schedules', kind: 'Page', label: 'Schedules', to: '/schedules' },
  { id: 'p-variables', kind: 'Page', label: 'Variables', to: '/variables' }
];

// Simple fuzzy score: every query word must appear; earlier matches rank higher
const score = (text: string, query: string): number => {
  const haystack = text.toLowerCase();
  let total = 0;

  for (const word of query.toLowerCase().split(/\s+/).filter(Boolean)) {
    const index = haystack.indexOf(word);
    if (index < 0) {
      return -1;
    }
    total += index === 0 ? 0 : haystack[index - 1] === ' ' ? 1 : 3 + index / 100;
  }

  return total;
};

export const CommandPalette = (props: { open: boolean; onClose: () => void }): JSX.Element | null => {
  const { open, onClose } = props;
  const history = useHistory();
  const { user } = useContext(AuthContext);
  const { snippets, getSnippets, sites, getSites } = useContext(SnippetsContext);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [runbooks, setRunbooks] = useState<RunbookListItem[]>([]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    setQuery('');
    setActive(0);
    window.setTimeout(() => input.current?.focus(), 0);

    if (!snippets.length) {
      getSnippets();
    }
    getSites();
    axios.get<Response<RunbookListItem[]>>('/api/runbooks').then(res => setRunbooks(res.data.data)).catch(() => undefined);
    axios.get<Response<Schedule[]>>('/api/schedules').then(res => setSchedules(res.data.data)).catch(() => undefined);
  }, [open]);

  const items = useMemo(() => {
    const actions: Item[] = [
      ...(canEditSnippets(user?.role)
        ? [
            { id: 'a-new', kind: 'Action' as const, label: 'New snippet', to: '/editor' },
            { id: 'a-runbook', kind: 'Action' as const, label: 'New runbook', to: '/runbooks' },
            { id: 'a-schedule', kind: 'Action' as const, label: 'New schedule', to: '/schedules?new=1' }
          ]
        : []),
      ...(canAdmin(user?.role)
        ? [
            { id: 'p-admin', kind: 'Page' as const, label: 'Admin', to: '/admin' },
            { id: 'a-backup', kind: 'Action' as const, label: 'Backups', hint: 'Admin', to: '/admin?tab=system' },
            { id: 'a-notify', kind: 'Action' as const, label: 'Notifications', hint: 'Admin', to: '/admin?tab=notifications' }
          ]
        : [])
    ];
    const all: Item[] = [
      ...PAGES,
      ...actions,
      ...snippets.map(snippet => ({
        id: `s-${snippet.id}`,
        kind: 'Snippet' as const,
        label: snippet.title,
        hint: `${snippet.language} · ${snippet.collection || 'General'}`,
        to: `/snippet/${snippet.id}`
      })),
      ...sites.map(site => ({
        id: `site-${site.id}`,
        kind: 'Site' as const,
        label: site.name,
        hint: site.tags.join(', '),
        to: `/sites/${site.id}`
      })),
      ...runbooks.map(runbook => ({
        id: `r-${runbook.id}`,
        kind: 'Runbook' as const,
        label: runbook.title,
        hint: `${runbook.stepCount} steps`,
        to: `/runbooks/${runbook.id}`
      })),
      ...schedules.map(schedule => ({
        id: `sc-${schedule.id}`,
        kind: 'Schedule' as const,
        label: schedule.name,
        hint: schedule.cron,
        to: `/schedules/${schedule.id}`
      }))
    ];

    if (!query.trim()) {
      return all.filter(item => item.kind === 'Page' || item.kind === 'Action').slice(0, 12);
    }

    return all
      .map(item => ({ item, score: score(`${item.label} ${item.hint || ''}`, query) }))
      .filter(entry => entry.score >= 0)
      .sort((a, b) => a.score - b.score)
      .slice(0, 12)
      .map(entry => entry.item);
  }, [query, snippets, sites, runbooks, schedules, user]);

  if (!open) {
    return null;
  }

  const go = (item?: Item) => {
    if (item) {
      history.push(item.to);
      onClose();
    }
  };

  return (
    <div className='palette-backdrop' onMouseDown={onClose} role='presentation'>
      <div
        className='palette'
        role='dialog'
        aria-modal='true'
        aria-label='Go to'
        onMouseDown={event => event.stopPropagation()}
      >
        <input
          ref={input}
          className='palette-input'
          placeholder='Search snippets, sites, runbooks, pages…'
          value={query}
          onChange={event => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={event => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setActive(current => Math.min(current + 1, items.length - 1));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setActive(current => Math.max(current - 1, 0));
            } else if (event.key === 'Enter') {
              event.preventDefault();
              go(items[active]);
            } else if (event.key === 'Escape') {
              onClose();
            }
          }}
          aria-activedescendant={items[active] ? `palette-${items[active].id}` : undefined}
        />
        <ul className='palette-list' role='listbox'>
          {items.map((item, index) => (
            <li
              key={item.id}
              id={`palette-${item.id}`}
              role='option'
              aria-selected={index === active}
              className={index === active ? 'is-active' : ''}
              onMouseEnter={() => setActive(index)}
              onClick={() => go(item)}
            >
              <span className='palette-kind'>{item.kind}</span>
              <span className='palette-label'>{item.label}</span>
              {item.hint && <span className='palette-hint'>{item.hint}</span>}
            </li>
          ))}
          {items.length === 0 && <li className='palette-empty'>Nothing matches “{query}”.</li>}
        </ul>
        <div className='palette-footer'>
          <span>↑↓ to move</span>
          <span>Enter to open</span>
          <span>Esc to close</span>
        </div>
      </div>
    </div>
  );
};
