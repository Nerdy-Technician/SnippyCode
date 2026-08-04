import { useEffect } from 'react';
import { findLanguage } from '../../utils';
import hljs from 'highlight.js';
import 'highlight.js/styles/atom-one-dark.css';

interface Props {
  code: string;
  language: string;
}

export const SnippetCode = (props: Props): JSX.Element => {
  const { code, language } = props;

  const syntax = findLanguage(language) ? language : 'plaintext';

  useEffect(() => {
    hljs.highlightAll();
  }, []);

  return (
    <pre className='code-panel'>
      <code
        className={`language-${syntax.toLowerCase()}`}
        style={{ whiteSpace: 'pre-wrap' }}
      >
        {code}
      </code>
    </pre>
  );
};
