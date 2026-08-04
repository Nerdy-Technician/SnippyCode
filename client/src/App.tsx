import { BrowserRouter, Switch, Route } from 'react-router-dom';
import { AuthGate } from './components/Auth';
import { Navbar } from './components/Navigation/Navbar';
import { Admin, Editor, Home, Snippet, Snippets } from './containers';
import {
  AuthContextProvider,
  SnippetsContextProvider,
  ThemeContextProvider
} from './store';

export const App = () => {
  return (
    <BrowserRouter>
      <ThemeContextProvider>
        <AuthContextProvider>
          <AuthGate>
            <SnippetsContextProvider>
              <Navbar />
              <Switch>
                <Route exact path='/' component={Home} />
                <Route path='/snippets' component={Snippets} />
                <Route path='/snippet/:id' component={Snippet} />
                <Route path='/editor/:id?' component={Editor} />
                <Route path='/admin' component={Admin} />
              </Switch>
            </SnippetsContextProvider>
          </AuthGate>
        </AuthContextProvider>
      </ThemeContextProvider>
    </BrowserRouter>
  );
};
