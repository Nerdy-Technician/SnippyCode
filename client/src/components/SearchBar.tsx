import { useRef, useEffect, KeyboardEvent, useContext } from 'react';
import { SnippetsContext } from '../store';
import { searchParser } from '../utils';

interface Props {
  autoFocus?: boolean;
}

export const SearchBar = (props: Props): JSX.Element => {
  const { searchSnippets, clearSearch } = useContext(SnippetsContext);
  const inputRef = useRef<HTMLInputElement>(document.createElement('input'));

  useEffect(() => {
    if (props.autoFocus !== false) {
      inputRef.current.focus();
    }
  }, [inputRef, props.autoFocus]);

  const inputHandler = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      searchSnippets(searchParser(inputRef.current.value));
    } else if (e.key === 'Escape') {
      inputRef.current.value = '';
      clearSearch();
    }
  };

  return (
    <div className='search-panel'>
      <input
        type='text'
        className='form-control form-control-lg'
        placeholder='Search titles, docs, and code. Try lang:typescript tags:ui,react collection:homelab'
        ref={inputRef}
        onKeyUp={e => inputHandler(e)}
      />
      <div className='form-text'>
        Search with Enter. Clear with Esc. Press / to focus search, n for a
        new snippet. Filters: lang:typescript, tags:ui,react, or
        collection:homelab.
      </div>
    </div>
  );
};
