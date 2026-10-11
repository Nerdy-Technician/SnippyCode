import { useContext, useEffect, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faMagnifyingGlass } from '@fortawesome/free-solid-svg-icons';
import { ProfileModal } from '../Auth';
import { AuthContext } from '../../store';
import { Route } from '../../typescript/interfaces';
import { canEditSnippets, hasMinimumRole } from '../../utils';
import routeConfig from './routes.json';
import { CommandPalette } from './CommandPalette';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

export const Navbar = (): JSX.Element => {
  const routes = (routeConfig as { routes: Route[] }).routes;
  const { user } = useContext(AuthContext);
  const location = useLocation();
  const [profileOpen, setProfileOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  // Close the mobile menu after navigating
  useEffect(() => setMenuOpen(false), [location.pathname]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen(open => !open);
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const visible = routes.filter(({ minRole }) => !minRole || hasMinimumRole(user?.role, minRole));

  return (
    <>
      <nav className={`navbar app-navbar ${menuOpen ? 'is-open' : ''}`}>
        <div className='container-lg'>
          <NavLink exact to='/' className='navbar-brand'>
            <img src='/CodeSnippy.png' alt='' />
            <span>SnippyCode</span>
          </NavLink>

          <button
            type='button'
            className='nav-menu-toggle'
            aria-expanded={menuOpen}
            aria-controls='main-nav'
            onClick={() => setMenuOpen(open => !open)}
          >
            <span aria-hidden='true'>{menuOpen ? '✕' : '☰'}</span>
            <span className='visually-hidden'>Menu</span>
          </button>

          <ul className='navbar-nav' id='main-nav'>
            {visible.map(({ name, dest }) => (
              <li className='nav-item' key={dest}>
                <NavLink exact={dest === '/'} to={dest} className='nav-link'>
                  {name}
                </NavLink>
              </li>
            ))}
          </ul>

          <div className='nav-actions'>
            <button
              type='button'
              className='nav-search'
              onClick={() => setPaletteOpen(true)}
              aria-label='Search and jump (Ctrl K)'
            >
              <FontAwesomeIcon icon={faMagnifyingGlass} />
              <span>Search</span>
              <kbd>{isMac ? '⌘' : 'Ctrl'} K</kbd>
            </button>
            {canEditSnippets(user?.role) && (
              <Link to='/editor' className='btn btn-primary btn-sm nav-new'>
                + New snippet
              </Link>
            )}
            {user && (
              <button
                type='button'
                className='profile-trigger'
                onClick={() => setProfileOpen(true)}
              >
                <img src={user.avatarUrl} alt='' />
                <span>{user.displayName}</span>
              </button>
            )}
          </div>
        </div>
      </nav>
      {profileOpen && <ProfileModal close={() => setProfileOpen(false)} />}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </>
  );
};
