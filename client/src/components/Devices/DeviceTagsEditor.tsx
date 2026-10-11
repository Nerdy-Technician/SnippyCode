import { useEffect, useState } from 'react';
import axios from 'axios';
import { parseTags, useSharedTags } from '../../utils';
import { apiError } from '../Variables/VariableFields';
import { TagChip } from '../Tags/TagChip';

/**
 * A device's tags, picked from the shared tag list (new names create tags).
 * Admins and the device's site admins can change them; the server checks.
 */
export const DeviceTagsEditor = (props: { deviceId: number; tags: string[]; onSaved: () => void }): JSX.Element => {
  const { tags: shared, reload } = useSharedTags();
  const [chosen, setChosen] = useState<string[]>(props.tags);
  const [extra, setExtra] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => setChosen(props.tags), [props.tags]);

  const toggle = (name: string) =>
    setChosen(current => (current.includes(name) ? current.filter(item => item !== name) : [...current, name]));

  const save = async () => {
    setNotice('');
    const tagIds = shared.filter(tag => chosen.includes(tag.name)).map(tag => tag.id);
    try {
      await axios.put(`/api/devices/${props.deviceId}/tags`, { tagIds, tags: parseTags(extra) });
      setExtra('');
      setNotice('Tags saved.');
      await reload();
      props.onSaved();
    } catch (err) {
      setNotice(apiError(err, 'Could not save tags.'));
    }
  };

  return (
    <div className='device-tags-editor'>
      <span>Tags</span>
      <div className='d-flex flex-wrap gap-1' aria-label='Device tags'>
        {shared.map(tag => (
          <TagChip key={tag.id} name={tag.name} color={tag.color} active={chosen.includes(tag.name)} onClick={() => toggle(tag.name)} />
        ))}
      </div>
      <input
        className='form-control form-control-sm'
        value={extra}
        onChange={event => setExtra(event.target.value)}
        placeholder='New tags, comma separated'
        aria-label='New device tags'
      />
      <button type='button' className='btn btn-sm btn-outline-secondary' onClick={save}>
        Save tags
      </button>
      {notice && <span className='form-text ms-2'>{notice}</span>}
    </div>
  );
};
