import { useContext, useEffect, useState } from 'react';
import { DiffEditor } from '@monaco-editor/react';
import axios from 'axios';
import copy from 'clipboard-copy';
import { AuthContext } from '../../store';
import { Response, Snippet, SnippetVersion, SnippetVersionDiff } from '../../typescript/interfaces';
import { dateParser, canEditSnippets } from '../../utils';

interface Props {
  snippet: Snippet;
  onClose: () => void;
  onRestored: () => void;
}

const canRestoreRole = (role?: string): boolean => canEditSnippets(role);

export const SnippetHistory = (props: Props): JSX.Element => {
  const { snippet, onClose, onRestored } = props;
  const { user } = useContext(AuthContext);
  const [versions, setVersions] = useState<SnippetVersion[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState('');
  const [against, setAgainst] = useState<'current' | number>('current');
  const [diff, setDiff] = useState<SnippetVersionDiff | null>(null);

  const selected = versions.find(version => version.id === selectedId) || null;
  const compareTo = against === 'current' ? null : versions.find(version => version.id === against) || null;
  const modifiedCode = compareTo ? compareTo.code : snippet.code;
  const modifiedLabel = compareTo ? dateParser(compareTo.createdAt).relative : 'Current';

  useEffect(() => {
    setDiff(null);
    if (!selected) {
      return;
    }
    const query = against === 'current' ? '' : `?against=${against}`;
    axios
      .get<Response<SnippetVersionDiff>>(`/api/snippets/${snippet.id}/versions/${selected.id}/diff${query}`)
      .then(res => setDiff(res.data.data))
      .catch(() => setDiff(null));
  }, [snippet.id, snippet.code, selected, against]);
  const canRestore = canRestoreRole(user?.role);

  useEffect(() => {
    axios
      .get<Response<SnippetVersion[]>>(`/api/snippets/${snippet.id}/versions`)
      .then(res => {
        setVersions(res.data.data);
        setSelectedId(res.data.data[0]?.id || null);
      })
      .catch(() => setError('Could not load version history.'))
      .finally(() => setLoading(false));
  }, [snippet.id]);

  const restoreVersion = async () => {
    if (!selected || !canRestore) {
      return;
    }

    if (
      !window.confirm(
        'Roll back to this version? The current snippet will be saved in history first, so this can be undone.'
      )
    ) {
      return;
    }

    setRestoring(true);
    setError('');

    try {
      await axios.post(
        `/api/snippets/${snippet.id}/versions/${selected.id}/restore`
      );
      onRestored();
    } catch (err) {
      setError('Could not restore this version.');
    } finally {
      setRestoring(false);
    }
  };

  return (
    <div className='raw-modal-backdrop' role='dialog' aria-modal='true'>
      <div className='raw-modal version-modal'>
        <div className='raw-modal-header'>
          <div>
            <p className='eyebrow'>Version history</p>
            <h3>{snippet.title}</h3>
          </div>
          <button type='button' onClick={onClose}>
            Close
          </button>
        </div>

        {loading ? (
          <p className='text-muted'>Loading history…</p>
        ) : versions.length === 0 ? (
          <p className='text-muted'>
            No previous versions yet. History is created when you save changes.
          </p>
        ) : (
          <div className='version-modal-body'>
            <div className='version-list'>
              {versions.map(version => {
                const isActive = version.id === selectedId;

                return (
                  <button
                    type='button'
                    key={version.id}
                    className={`version-list-item${isActive ? ' is-active' : ''}`}
                    onClick={() => setSelectedId(version.id)}
                  >
                    <strong>{version.title}</strong>
                    <span>{dateParser(version.createdAt).relative}</span>
                  </button>
                );
              })}
            </div>

            <div className='version-diff'>
              {selected && (
                <>
                  <div className='version-diff-meta'>
                    <span>
                      {dateParser(selected.createdAt).relative} → {modifiedLabel}
                      {diff && (
                        <span className='version-diff-stats' data-testid='diff-stats'>
                          {' '}
                          <span className='text-success'>+{diff.added}</span>{' '}
                          <span className='text-danger'>−{diff.removed}</span>
                          {diff.changed.title && ' · title changed'}
                          {diff.changed.docs && ' · docs changed'}
                        </span>
                      )}
                    </span>
                    <select
                      aria-label='Compare against'
                      className='form-select form-select-sm version-compare'
                      value={String(against)}
                      onChange={e =>
                        setAgainst(e.target.value === 'current' ? 'current' : Number(e.target.value))
                      }
                    >
                      <option value='current'>vs current</option>
                      {versions
                        .filter(version => version.id !== selected.id)
                        .map(version => (
                          <option key={version.id} value={version.id}>
                            vs {dateParser(version.createdAt).relative} ({version.title})
                          </option>
                        ))}
                    </select>
                    <div className='admin-actions'>
                      <button
                        type='button'
                        className='btn btn-outline-secondary btn-sm'
                        onClick={() => copy(selected.code)}
                      >
                        Copy old code
                      </button>
                      {canRestore && (
                        <button
                          type='button'
                          className='btn btn-primary btn-sm'
                          disabled={restoring}
                          onClick={restoreVersion}
                        >
                          {restoring ? 'Rolling back…' : 'Roll back to this'}
                        </button>
                      )}
                    </div>
                  </div>
                  <DiffEditor
                    height='420px'
                    theme='vs-dark'
                    language={selected.language || snippet.language}
                    original={selected.code}
                    modified={modifiedCode}
                    options={{
                      readOnly: true,
                      renderSideBySide: true,
                      automaticLayout: true,
                      minimap: { enabled: false },
                      fontFamily:
                        'JetBrains Mono, Fira Code, Consolas, monospace',
                      fontSize: 13
                    }}
                  />
                </>
              )}
            </div>
          </div>
        )}

        {error && <p className='text-danger mt-3 mb-0'>{error}</p>}
      </div>
    </div>
  );
};
