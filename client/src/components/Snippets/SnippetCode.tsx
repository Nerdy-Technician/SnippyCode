import { useMemo } from 'react';
import { findLanguage } from '../../utils';
import hljs from 'highlight.js';
import 'highlight.js/styles/atom-one-dark.css';

interface Props {
  code: string;
  language: string;
}

export const SnippetCode = (props: Props): JSX.Element => {
  const { code, language } = props;

  const syntax = (findLanguage(language) ? language : 'plaintext').toLowerCase();

  // Highlight from props so filled-in variables re-render with colors
  const html = useMemo(() => {
    try {
      return hljs.getLanguage(syntax)
        ? hljs.highlight(code, { language: syntax, ignoreIllegals: true }).value
        : null;
    } catch {
      return null;
    }
  }, [code, syntax]);

  return (
    <pre className='code-panel'>
      {html === null ? (
        <code className={`hljs language-${syntax}`} style={{ whiteSpace: 'pre-wrap' }}>
          {code}
        </code>
      ) : (
        <code
          className={`hljs language-${syntax}`}
          style={{ whiteSpace: 'pre-wrap' }}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
    </pre>
  );
};
