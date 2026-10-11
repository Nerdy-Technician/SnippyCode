import { useContext, useState } from 'react';
import axios from 'axios';
import { AuthContext } from '../../store';
import { canEditSnippets, hasMinimumRole } from '../../utils';
import { apiError } from '../Variables/VariableFields';

interface Props {
  /** e.g. /api/snippets/4/dangerous */
  endpoint: string;
  value: boolean;
  onChange?: (value: boolean) => void;
}

/** Editors can flag something dangerous; only admins can clear it */
export const DangerousToggle = ({ endpoint, value, onChange }: Props): JSX.Element => {
  const { user } = useContext(AuthContext);
  const [dangerous, setDangerous] = useState(value);
  const [error, setError] = useState('');
  const isAdmin = hasMinimumRole(user?.role, 'admin');
  const disabled = !canEditSnippets(user?.role) || (dangerous && !isAdmin);

  const toggle = async () => {
    setError('');
    try {
      await axios.put(endpoint, { dangerous: !dangerous });
      setDangerous(!dangerous);
      onChange?.(!dangerous);
    } catch (err) {
      setError(apiError(err, 'Could not change the flag.'));
    }
  };

  return (
    <div className='dangerous-toggle'>
      <label className='form-check form-switch mb-0' title={dangerous && !isAdmin ? 'Only admins can clear this' : undefined}>
        <input className='form-check-input' type='checkbox' checked={dangerous} disabled={disabled} onChange={toggle} />
        <span className='form-check-label'>Dangerous (runs need admin approval)</span>
      </label>
      {error && <div className='text-danger small'>{error}</div>}
    </div>
  );
};
