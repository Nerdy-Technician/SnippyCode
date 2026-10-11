import { useState } from 'react';
import { Link } from 'react-router-dom';
import axios from 'axios';
import { Response, Snippet } from '../../typescript/interfaces';
import { apiError } from '../Variables/VariableFields';

type Match = Snippet & { reason: string };

/**
 * Ask the AI assistant which snippets answer a question, in plain words.
 */
export const MeaningSearch = (): JSX.Element => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Match[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const search = async () => {
    setLoading(true);
    setError('');

    try {
      const res = await axios.post<Response<{ results: Match[] }>>('/api/snippets/search/meaning', { query });
      setResults(res.data.data.results);
    } catch (err) {
      setError(apiError(err, 'The assistant could not search.'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className='meaning-search'>
      <form
        onSubmit={event => {
          event.preventDefault();
          if (query.trim()) {
            search();
          }
        }}
      >
        <input
          className='form-control'
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder='Describe what you need, e.g. "free up disk space on a Windows server"'
          aria-label='Search by meaning'
        />
        <button type='submit' className='btn btn-outline-secondary' disabled={loading || !query.trim()}>
          {loading ? 'Thinking…' : 'Ask AI'}
        </button>
      </form>
      {error && <p className='text-danger small mb-0'>{error}</p>}
      {results && (
        <ul className='quick-list meaning-results'>
          {results.length === 0 && <li className='text-muted'>Nothing in the library fits that.</li>}
          {results.map(result => (
            <li key={result.id}>
              <Link to={{ pathname: `/snippet/${result.id}`, state: { from: '/snippets' } }}>{result.title}</Link>
              <span>{result.reason}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
