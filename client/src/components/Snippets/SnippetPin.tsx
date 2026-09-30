import { useContext } from 'react';
import { AuthContext, SnippetsContext } from '../../store';
import { canEditSnippets } from '../../utils';
import Icon from '@mdi/react';
import { mdiPin, mdiPinOutline } from '@mdi/js';

interface Props {
  id: number;
  isPinned: boolean;
}

export const SnippetPin = (props: Props): JSX.Element | null => {
  const { toggleSnippetPin } = useContext(SnippetsContext);
  const { user } = useContext(AuthContext);
  const { id, isPinned } = props;
  const canEdit = canEditSnippets(user?.role);

  if (!canEdit) {
    return isPinned ? (
      <Icon path={mdiPin} size={0.8} color='#20c997' />
    ) : null;
  }

  return (
    <div onClick={() => toggleSnippetPin(id, !isPinned)} className='cursor-pointer'>
      {isPinned ? (
        <Icon path={mdiPin} size={0.8} color='#20c997' />
      ) : (
        <Icon path={mdiPinOutline} size={0.8} color='#ced4da' />
      )}
    </div>
  );
};
