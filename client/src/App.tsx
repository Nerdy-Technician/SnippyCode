import { useContext } from 'react';
import { BrowserRouter, Redirect, Route, Switch, useParams } from 'react-router-dom';
import { AuthGate } from './components/Auth';
import { KeyboardShortcuts } from './components/Navigation/KeyboardShortcuts';
import { Navbar } from './components/Navigation/Navbar';
import {
  About,
  Admin,
  Editor,
  Home,
  PublicSnippet,
  Snippet,
  Snippets
} from './containers';
import {
  AuthContext,
  AuthContextProvider,
  SnippetsContextProvider,
  ThemeContextProvider
} from './store';
import { canAdmin, canEditSnippets } from './utils';

const EditorRoute = (): JSX.Element => {
  const { user } = useContext(AuthContext);
  const { id } = useParams<{ id?: string }>();

  if (!canEditSnippets(user?.role)) {
    return <Redirect to={id ? `/snippet/${id}` : '/snippets'} />;
  }

  return <Editor />;
};

const AdminRoute = (): JSX.Element => {
  const { user } = useContext(AuthContext);

  if (!canAdmin(user?.role)) {
    return <Redirect to='/' />;
  }

  return <Admin />;
};

const PrivateApp = (): JSX.Element => (
  <AuthGate>
    <SnippetsContextProvider>
      <KeyboardShortcuts />
      <Navbar />
      <Switch>
        <Route exact path='/' component={Home} />
        <Route path='/snippets' component={Snippets} />
        <Route path='/snippet/:id' component={Snippet} />
        <Route path='/editor/:id?' component={EditorRoute} />
        <Route path='/admin' component={AdminRoute} />
      </Switch>
    </SnippetsContextProvider>
  </AuthGate>
);

export const App = () => {
  return (
    <BrowserRouter>
      <ThemeContextProvider>
        <AuthContextProvider>
          <Switch>
            <Route path='/s/:rawRef' component={PublicSnippet} />
            <Route exact path='/about' component={About} />
            <Route path='/' component={PrivateApp} />
          </Switch>
        </AuthContextProvider>
      </ThemeContextProvider>
    </BrowserRouter>
  );
};
