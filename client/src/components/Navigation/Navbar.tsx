import { useContext, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faCircleHalfStroke,
  faMoon,
  faSun
} from '@fortawesome/free-solid-svg-icons';
import { ProfileModal } from '../Auth';
import { AppTheme, AuthContext, ThemeContext } from '../../store';
import { Route } from '../../typescript/interfaces';
import { routes as clientRoutes } from './routes.json';

const themeIcons = {
  dark: faMoon,
  light: faSun,
  midnight: faCircleHalfStroke
};

export const Navbar = (): JSX.Element => {
  const routes = clientRoutes as Route[];
  const { user } = useContext(AuthContext);
  const { theme, themes, setTheme } = useContext(ThemeContext);
  const [profileOpen, setProfileOpen] = useState(false);

  return (
    <>
      <nav className='navbar navbar-expand app-navbar'>
        <div className='container-lg'>
          <NavLink exact to='/' className='navbar-brand'>
            <img src='/CodeSnippy.png' alt='' />
            <span>SnippyCode</span>
          </NavLink>
          <ul className='navbar-nav'>
            {routes.map(({ name, dest }, idx) => (
              <li className='nav-item' key={idx}>
                <NavLink exact to={dest} className='nav-link'>
                  {name}
                </NavLink>
              </li>
            ))}
          </ul>
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
          <div className='theme-switcher' aria-label='Theme'>
            {themes.map(option => (
              <button
                key={option.value}
                type='button'
                className={theme === option.value ? 'active' : ''}
                title={`${option.label} theme`}
                aria-label={`${option.label} theme`}
                aria-pressed={theme === option.value}
                onClick={() => setTheme(option.value as AppTheme)}
              >
                <FontAwesomeIcon icon={themeIcons[option.value]} />
                <span>{option.label}</span>
              </button>
            ))}
          </div>
        </div>
      </nav>
      {profileOpen && <ProfileModal close={() => setProfileOpen(false)} />}
    </>
  );
};
