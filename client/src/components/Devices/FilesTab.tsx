import { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { AgentJobState, FileEntry, Response } from '../../typescript/interfaces';
import { apiError } from '../Variables/VariableFields';

const MAX_BYTES = 700 * 1024;

type RunTool = (tool: string, args?: Record<string, unknown>, key?: string) => Promise<AgentJobState | null>;

const formatSize = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KB` : bytes < 1024 ** 3 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${(bytes / 1024 ** 3).toFixed(1)} GB`;

const joinPath = (windows: boolean, dir: string, name: string) =>
  windows ? (dir ? `${dir.replace(/\\+$/, '')}\\${name}` : name) : `${dir.replace(/\/+$/, '')}/${name}`;

const parentOf = (windows: boolean, path: string): string | null => {
  if (windows) {
    if (!path) return null;
    const trimmed = path.replace(/\\+$/, '');
    const index = trimmed.lastIndexOf('\\');
    return index < 0 ? '' : index === 2 && /^[A-Za-z]:/.test(trimmed) ? trimmed.slice(0, 3) : trimmed.slice(0, index);
  }
  if (path === '/') return null;
  const index = path.replace(/\/+$/, '').lastIndexOf('/');
  return index <= 0 ? '/' : path.slice(0, index);
};

const crumbs = (windows: boolean, path: string) => {
  if (windows) {
    const parts = path.split('\\').filter(Boolean);
    return [
      { label: 'This PC', path: '' },
      ...parts.map((part, index) => ({ label: part, path: index === 0 ? `${part}\\` : parts.slice(0, index + 1).join('\\') }))
    ];
  }
  const parts = path.split('/').filter(Boolean);
  return [{ label: '/', path: '/' }, ...parts.map((part, index) => ({ label: part, path: `/${parts.slice(0, index + 1).join('/')}` }))];
};

const toBase64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

const decode = (base64: string) => Uint8Array.from(atob(base64), char => char.charCodeAt(0));

const looksLikeText = (bytes: Uint8Array) => {
  const sample = bytes.subarray(0, 4096);
  return !sample.some(byte => byte === 0);
};

export const FilesTab = (props: { deviceId: number; windows: boolean; online: boolean; canAct: boolean; runTool: RunTool; busy: boolean }) => {
  const { windows, runTool } = props;
  const [path, setPath] = useState(windows ? '' : '/');
  const [typed, setTyped] = useState(path);
  const [entries, setEntries] = useState<FileEntry[] | null>(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const [viewing, setViewing] = useState<{ path: string; text: string | null; bytes: Uint8Array } | null>(null);
  const [working, setWorking] = useState('');
  const upload = useRef<HTMLInputElement>(null);

  const fetchResult = async (job: AgentJobState | null) => {
    if (!job) throw new Error('Could not reach the device.');
    if (job.status === 'expired') throw new Error('The device did not answer.');
    if (job.status !== 'done') throw new Error(job.run?.stderr?.trim() || job.run?.stdout?.trim() || 'The device reported an error.');
    const res = await axios.get<Response<{ entries?: FileEntry[]; content?: string }>>(`/api/devices/jobs/${job.id}/file`);
    return res.data.data;
  };

  const open = async (next: string) => {
    setError('');
    setWorking('list');
    try {
      const data = await fetchResult(await runTool('files', { path: next }, 'files'));
      setEntries(data.entries || []);
      setPath(next);
      setTyped(next);
      setFilter('');
    } catch (err) {
      setError(err instanceof Error ? err.message : apiError(err, 'Could not list the folder.'));
    } finally {
      setWorking('');
    }
  };

  useEffect(() => {
    if (props.online) open(path);
  }, [props.deviceId]);

  const view = async (entry: FileEntry) => {
    const full = joinPath(windows, path, entry.name);
    if (entry.size > MAX_BYTES) {
      setError(`${entry.name} is ${formatSize(entry.size)}; files up to ${MAX_BYTES / 1024} KB can be fetched through the agent.`);
      return;
    }
    setError('');
    setWorking(full);
    try {
      const data = await fetchResult(await runTool('fileget', { path: full }, 'fileget'));
      const bytes = decode(data.content || '');
      setViewing({ path: full, bytes, text: looksLikeText(bytes) ? new TextDecoder().decode(bytes) : null });
    } catch (err) {
      setError(err instanceof Error ? err.message : apiError(err, 'Could not fetch the file.'));
    } finally {
      setWorking('');
    }
  };

  const save = (name: string, bytes: Uint8Array) => {
    const url = URL.createObjectURL(new Blob([bytes]));
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const onUpload = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_BYTES) {
      setError(`Uploads are limited to ${MAX_BYTES / 1024} KB through the agent.`);
      return;
    }
    const target = joinPath(windows, path, file.name);
    const exists = entries?.some(entry => entry.name === file.name);
    if (!window.confirm(`${exists ? 'Replace' : 'Upload'} ${target} on the device?`)) return;

    setError('');
    setWorking('upload');
    try {
      const job = await runTool('fileput', { path: target, content: await toBase64(file) }, 'fileput');
      if (!job || job.status !== 'done') throw new Error(job?.run?.stderr?.trim() || 'The upload failed.');
      await open(path);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The upload failed.');
    } finally {
      setWorking('');
      if (upload.current) upload.current.value = '';
    }
  };

  const shown = (entries || []).filter(entry => !filter.trim() || entry.name.toLowerCase().includes(filter.trim().toLowerCase()));
  const parent = parentOf(windows, path);

  return (
    <div className='files-tab'>
      <form
        className='files-path'
        onSubmit={event => {
          event.preventDefault();
          open(typed.trim());
        }}
      >
        <button type='button' className='btn btn-sm btn-outline-secondary' disabled={parent === null || Boolean(working)} onClick={() => parent !== null && open(parent)} aria-label='Up one folder'>
          ↑ Up
        </button>
        <input className='form-control form-control-sm mono' value={typed} onChange={event => setTyped(event.target.value)} aria-label='Path' placeholder={windows ? 'C:\\Users' : '/var/log'} />
        <button type='submit' className='btn btn-sm btn-outline-secondary' disabled={Boolean(working) || !props.online}>
          Go
        </button>
        <button type='button' className='btn btn-sm btn-outline-secondary' disabled={Boolean(working) || !props.online} onClick={() => open(path)}>
          Refresh
        </button>
        {props.canAct && (
          <>
            <input ref={upload} type='file' hidden onChange={event => onUpload(event.target.files?.[0])} />
            <button type='button' className='btn btn-sm btn-primary' disabled={Boolean(working) || !props.online || (windows && !path)} onClick={() => upload.current?.click()}>
              {working === 'upload' ? 'Uploading…' : 'Upload file'}
            </button>
          </>
        )}
      </form>

      <nav className='files-crumbs' aria-label='Folder'>
        {crumbs(windows, path).map((crumb, index, all) => (
          <span key={crumb.path}>
            {index > 0 && !(index === 1 && !windows) && <span aria-hidden='true'> {windows ? '›' : '/'} </span>}
            {index === all.length - 1 ? <strong>{crumb.label}</strong> : <button type='button' className='btn btn-link p-0' onClick={() => open(crumb.path)}>{crumb.label}</button>}
          </span>
        ))}
      </nav>

      {!props.online && <p className='text-muted'>The device is offline; files can be browsed once it checks in again.</p>}
      {error && <div className='alert alert-danger'>{error}</div>}

      {working === 'list' && !entries ? (
        <p className='text-muted'>
          <span className='enroll-waiting' aria-hidden='true' /> Asking the device…
        </p>
      ) : entries ? (
        <>
          {entries.length > 30 && (
            <input className='form-control form-control-sm device-search mb-2' value={filter} onChange={event => setFilter(event.target.value)} placeholder='Filter this folder' aria-label='Filter this folder' />
          )}
          <div className={`values-table-wrap ${working === 'list' ? 'is-loading' : ''}`}>
            <table className='values-table tool-table files-table'>
              <thead>
                <tr>
                  <th>Name</th>
                  <th className='text-end'>Size</th>
                  <th>Modified</th>
                  {!windows && <th>Mode</th>}
                  {!windows && <th>Owner</th>}
                  <th />
                </tr>
              </thead>
              <tbody>
                {shown.length === 0 && (
                  <tr>
                    <td colSpan={6} className='text-muted'>
                      {entries.length ? 'Nothing matches.' : 'This folder is empty (or cannot be read).'}
                    </td>
                  </tr>
                )}
                {shown.map(entry => {
                  const full = joinPath(windows, path, entry.name);
                  return (
                    <tr key={entry.name}>
                      <td>
                        {entry.type === 'dir' ? (
                          <button type='button' className='btn btn-link p-0 files-name' onClick={() => open(windows && !path ? entry.name : full)}>
                            <span className='files-icon' aria-hidden='true'>📁</span>
                            {entry.name}
                          </button>
                        ) : (
                          <span className='files-name'>
                            <span className='files-icon' aria-hidden='true'>{entry.type === 'link' ? '🔗' : '📄'}</span>
                            {entry.name}
                          </span>
                        )}
                      </td>
                      <td className='text-end tool-sub'>{entry.type === 'dir' ? '' : formatSize(entry.size)}</td>
                      <td className='tool-sub'>{entry.modified ? new Date(entry.modified).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : ''}</td>
                      {!windows && <td className='mono tool-sub'>{entry.mode}</td>}
                      {!windows && <td className='tool-sub'>{entry.owner}</td>}
                      <td className='text-end'>
                        {entry.type !== 'dir' && props.canAct && (
                          <button type='button' className='btn btn-sm btn-outline-secondary' disabled={Boolean(working)} onClick={() => view(entry)}>
                            {working === full ? 'Fetching…' : 'Open'}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className='form-text mb-0 mt-2'>
            Files up to {MAX_BYTES / 1024} KB can be opened, downloaded and uploaded through the agent. Folders show their first 3,000 items.
            {!props.canAct && ' Only editors can open or upload files.'}
          </p>
        </>
      ) : null}

      {viewing && (
        <div className='raw-modal-backdrop' role='dialog' aria-modal='true' aria-label={viewing.path}>
          <div className='raw-modal files-viewer'>
            <div className='raw-modal-header'>
              <div>
                <p className='eyebrow'>{formatSize(viewing.bytes.length)}</p>
                <h3 className='mono'>{viewing.path}</h3>
              </div>
              <button type='button' onClick={() => setViewing(null)}>
                Close
              </button>
            </div>
            {viewing.text !== null ? (
              <pre className='run-output files-view'>{viewing.text || '(empty file)'}</pre>
            ) : (
              <p className='text-muted'>This looks like a binary file. Download it to open it.</p>
            )}
            <div className='variable-editor-actions mt-3'>
              <button type='button' className='btn btn-primary' onClick={() => save(viewing.path.split(/[\\/]/).pop() || 'file', viewing.bytes)}>
                Download
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
