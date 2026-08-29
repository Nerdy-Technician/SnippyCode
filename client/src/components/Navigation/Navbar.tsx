import { useContext, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { ProfileModal } from '../Auth';
import { AuthContext } from '../../store';
import { Route } from '../../typescript/interfaces';
import { hasMinimumRole } from '../../utils';
import routeConfig from './routes.json';

export const Navbar = (): JSX.Element => {
  const routes = (routeConfig as { routes: Route[] }).routes;
  const { user } = useContext(AuthContext);
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
            {routes
              .filter(
                ({ minRole }) =>
                  !minRole || hasMinimumRole(user?.role, minRole)
              )
              .map(({ name, dest }, idx) => (
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
        </div>
      </nav>
      {profileOpen && <ProfileModal close={() => setProfileOpen(false)} />}
    </>
  );
};
