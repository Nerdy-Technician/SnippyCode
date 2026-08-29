import { useContext } from 'react';
import { Link } from 'react-router-dom';
import { AuthContext } from '../../store';
import { canEditSnippets } from '../../utils';

export const EmptyState = (): JSX.Element => {
  const { user } = useContext(AuthContext);
  const editorLink = canEditSnippets(user?.role) ? (
    <Link to='/editor' className='btn btn-primary'>
      <span>Create first snippet</span>
    </Link>
  ) : null;

  return (
    <div className='col-12'>
      <section className='empty-state'>
        <p className='eyebrow'>No snippets yet</p>
        <h1>Build a personal code library worth returning to.</h1>
        <p>Store commands, patterns, docs, and the tiny fixes future-you keeps needing.</p>
        {editorLink}
      </section>
    </div>
  );
};
