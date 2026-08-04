import { useRef, useEffect, KeyboardEvent, useContext } from 'react';
import { SnippetsContext } from '../store';
import { searchParser } from '../utils';

export const SearchBar = (): JSX.Element => {
  const { searchSnippets } = useContext(SnippetsContext);
  const inputRef = useRef<HTMLInputElement>(document.createElement('input'));

  useEffect(() => {
    inputRef.current.focus();
  }, [inputRef]);

  const inputHandler = (e: KeyboardEvent<HTMLInputElement>) => {
    const query = searchParser(inputRef.current.value);

    if (e.key === 'Enter') {
      searchSnippets(query);
    } else if (e.key === 'Escape') {
      inputRef.current.value = '';
      searchSnippets(searchParser(inputRef.current.value));
    }
  };

  return (
    <div className='col-12 search-panel'>
      <input
        type='text'
        className='form-control form-control-lg'
        placeholder='card lang:typescript tags:ui,react'
        ref={inputRef}
        onKeyUp={e => inputHandler(e)}
      />
      <div className='form-text'>
        Search by pressing `Enter`. Clear with `Esc`. Try filters like
        `lang:typescript` or `tags:ui,react`.
      </div>
    </div>
  );
};
