import { useState } from 'react';
import axios from 'axios';
import { Card } from '../UI';
import { apiError } from '../Variables/VariableFields';
import { SharedTag } from '../../utils/sharedTags';
import { TagChip } from './TagChip';

/**
 * Admin tag manager: one shared list of tags with colours, used by snippets
 * and devices (and schedule targeting).
 */
export const TagManager = (props: { tags: SharedTag[]; onChanged: () => void }): JSX.Element => {
  const [name, setName] = useState('');
  const [color, setColor] = useState('#4f8cc9');
  const [notice, setNotice] = useState('');

  const act = async (work: () => Promise<unknown>, done: string) => {
    setNotice('');
    try {
      await work();
      setNotice(done);
      props.onChanged();
    } catch (err) {
      setNotice(apiError(err, 'That did not work.'));
    }
  };

  return (
    <Card classes='tag-manager'>
      <h5 className='card-title'>Tags</h5>
      <p className='form-text mt-0'>Shared by snippets and devices. Schedules target devices by these tags.</p>
      <form
        className='d-flex gap-2 mb-2'
        onSubmit={e => {
          e.preventDefault();
          act(() => axios.post('/api/tags', { name, color }), 'Tag added.').then(() => setName(''));
        }}
      >
        <input className='form-control form-control-sm' aria-label='New tag name' placeholder='New tag' value={name} onChange={e => setName(e.target.value)} />
        <input type='color' className='form-control form-control-sm form-control-color' aria-label='New tag colour' value={color} onChange={e => setColor(e.target.value)} />
        <button type='submit' className='btn btn-sm btn-outline-primary' disabled={!name.trim()}>
          Add
        </button>
      </form>
      <table className='table table-sm align-middle mb-0'>
        <tbody>
          {props.tags.map(tag => (
            <tr key={tag.id}>
              <td>
                <TagChip name={tag.name} color={tag.color} />
              </td>
              <td className='text-muted small'>
                {tag.deviceCount || 0} devices · {tag.snippetCount || 0} snippets
              </td>
              <td>
                <input
                  type='color'
                  className='form-control form-control-sm form-control-color'
                  aria-label={`Colour for ${tag.name}`}
                  value={tag.color || '#888888'}
                  onChange={e => act(() => axios.put(`/api/tags/${tag.id}`, { color: e.target.value }), 'Colour saved.')}
                />
              </td>
              <td className='text-end'>
                <button
                  type='button'
                  className='btn btn-sm btn-link'
                  onClick={() => {
                    const next = window.prompt('Rename tag', tag.name);
                    if (next && next !== tag.name) act(() => axios.put(`/api/tags/${tag.id}`, { name: next }), 'Renamed.');
                  }}
                >
                  Rename
                </button>
                <button
                  type='button'
                  className='btn btn-sm btn-link text-danger'
                  aria-label={`Delete ${tag.name}`}
                  onClick={() => {
                    if (window.confirm(`Delete "${tag.name}"? It is removed from ${tag.deviceCount || 0} devices, ${tag.snippetCount || 0} snippets and any schedules.`)) {
                      act(() => axios.delete(`/api/tags/${tag.id}`), 'Deleted.');
                    }
                  }}
                >
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {notice && <div className='form-text'>{notice}</div>}
    </Card>
  );
};
