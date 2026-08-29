import { useContext, useEffect } from 'react';
import { useHistory } from 'react-router-dom';
import { AuthContext } from '../../store';
import { canEditSnippets } from '../../utils';

export const KeyboardShortcuts = (): null => {
  const history = useHistory();
  const { user } = useContext(AuthContext);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target != null &&
        (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) ||
          target.isContentEditable ||
          Boolean(target.closest('.monaco-editor, .monaco-diff-editor')));

      if (event.ctrlKey || event.metaKey || event.altKey) {
        return;
      }

      if (event.key === '/' && !typing) {
        event.preventDefault();
        const focusSearch = () => {
          const input = document.querySelector(
            '.search-panel input'
          ) as HTMLInputElement | null;

          if (input) {
            input.focus();
            input.select();
            return true;
          }

          return false;
        };

        if (focusSearch()) {
          return;
        }

        history.push('/snippets');
        window.setTimeout(focusSearch, 0);
      }

      if (
        event.key.toLowerCase() === 'n' &&
        !event.shiftKey &&
        !typing &&
        canEditSnippets(user?.role)
      ) {
        event.preventDefault();
        history.push('/editor');
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [history, user]);

  return null;
};
