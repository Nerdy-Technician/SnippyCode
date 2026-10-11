import { Link } from 'react-router-dom';
import { useContext } from 'react';
import { Snippet } from '../../typescript/interfaces';
import { canEditSnippets, dateParser, badgeColor } from '../../utils';
import { Badge, Button, Card } from '../UI';
import { AuthContext, SnippetsContext } from '../../store';
import { SnippetPin } from './SnippetPin';
import { SnippetFavorite } from './SnippetFavorite';

interface Props {
  snippet: Snippet;
}

export const SnippetCard = (props: Props): JSX.Element => {
  const { title, description, language, id, createdAt, isPinned, collection, personal } =
    props.snippet;
  const { setSnippet, duplicateSnippet, copySnippetCode, selectedSiteId } =
    useContext(SnippetsContext);
  const { user } = useContext(AuthContext);
  const canEdit = canEditSnippets(user?.role);

  // Filled in on the server with saved values for the chosen site
  const copyHandler = () => {
    copySnippetCode(props.snippet, { siteId: selectedSiteId }).catch(() => undefined);
  };

  return (
    <Card classes='h-100' bodyClasses='d-flex flex-column'>
      {/* TITLE */}
      <h5 className='card-title snippet-card-title'>
        <Link
          to={{
            pathname: `/snippet/${id}`,
            state: { from: window.location.pathname }
          }}
          onClick={() => setSnippet(id)}
        >
          {title}
        </Link>
        <span className='snippet-title-actions'>
          <SnippetFavorite id={id} isFavorite={Boolean(personal?.isFavorite)} />
          <SnippetPin id={id} isPinned={isPinned} />
        </span>
      </h5>

      <h6 className='card-subtitle mb-2 text-muted'>
        {/* LANGUAGE */}
        <Badge text={language} color={badgeColor(language)} />
      </h6>

      {/* DESCRIPTION */}
      <p className='snippet-description'>{description ? description : 'No description'}</p>

      <div className='mt-auto'>
        {/* UPDATE DATE */}
        <p className='snippet-meta'>
          <Link
            to={`/snippets?collection=${encodeURIComponent(collection || 'General')}`}
          >
            {collection || 'General'}
          </Link>
          {' · Created '}
          {dateParser(createdAt).relative}
        </p>
        <hr />

        {/* ACTIONS */}
        <div className='d-flex justify-content-end flex-wrap gap-2'>
          <Link
            to={{
              pathname: `/snippet/${id}`,
              state: { from: window.location.pathname }
            }}
          >
            <Button
              text='View'
              color='secondary'
              small
              outline
              handler={() => {
                setSnippet(id);
              }}
            />
          </Link>
          {canEdit && (
            <Button
              text='Duplicate'
              color='secondary'
              small
              outline
              handler={() => duplicateSnippet(id)}
            />
          )}
          <Button
            text='Copy code'
            color='secondary'
            small
            handler={copyHandler}
          />
        </div>
      </div>
    </Card>
  );
};
