import { useContext } from 'react';
import Icon from '@mdi/react';
import { mdiStar, mdiStarOutline } from '@mdi/js';
import { SnippetsContext } from '../../store';

interface Props {
  id: number;
  isFavorite: boolean;
}

// Personal star, unlike the team-wide pin
export const SnippetFavorite = (props: Props): JSX.Element => {
  const { toggleFavorite } = useContext(SnippetsContext);
  const { id, isFavorite } = props;
  const label = isFavorite ? 'Remove from my favorites' : 'Add to my favorites';

  return (
    <button
      type='button'
      className='snippet-favorite'
      onClick={() => toggleFavorite(id)}
      title={label}
      aria-label={label}
      aria-pressed={isFavorite}
    >
      <Icon
        path={isFavorite ? mdiStar : mdiStarOutline}
        size={0.8}
        color={isFavorite ? '#f6d365' : '#ced4da'}
      />
    </button>
  );
};
