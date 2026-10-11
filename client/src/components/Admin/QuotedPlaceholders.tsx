import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import axios from 'axios';
import { apiError } from '../Variables/VariableFields';

interface Problem {
  name: string;
  line: number;
  context: string;
}

interface Report {
  scanned: number;
  flagged: Array<{ id: number; title: string; language: string; problems: Problem[] }>;
}

/**
 * Snippets with placeholders written inside quotes, backticks, $( ), ${ },
 * heredocs or template literals. Values are quoted automatically, so these
 * are refused at save and run time until the surrounding quotes are removed.
 */
export const QuotedPlaceholders = (): JSX.Element => {
  const [report, setReport] = useState<Report | null>(null);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    axios
      .get<{ data: Report }>('/api/snippets/quoted-placeholders')
      .then(res => setReport(res.data.data))
      .catch(err => setNotice(apiError(err, 'Could not load the placeholder report.')));
  }, []);

  return (
    <div className='quoted-placeholders'>
      <h5>Placeholders inside quotes</h5>
      <p className='text-muted small'>
        Values are quoted automatically, so a placeholder inside quotes or a substitution could break out of
        them. These snippets will not run until the quotes around the placeholder are removed (or an admin marks
        the variable raw).
      </p>
      {notice && <div className='alert alert-danger'>{notice}</div>}
      {report && report.flagged.length === 0 && (
        <p className='mb-0'>None of the {report.scanned} snippets are affected.</p>
      )}
      {report && report.flagged.length > 0 && (
        <ul className='mb-0'>
          {report.flagged.map(item => (
            <li key={item.id}>
              <Link to={`/snippets/${item.id}`}>{item.title}</Link> ({item.language}):{' '}
              {item.problems.map(p => `{{${p.name}}} line ${p.line} inside ${p.context}`).join('; ')}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
