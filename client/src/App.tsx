import { useContext } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useParams } from 'react-router-dom';
import { AuthGate } from './components/Auth';
import { KeyboardShortcuts } from './components/Navigation/KeyboardShortcuts';
import { Navbar } from './components/Navigation/Navbar';
import { Admin, Editor, Home, PublicSnippet, Snippet, Snippets } from './containers';
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
    return <Navigate replace to={id ? `/snippet/${id}` : '/snippets'} />;
  }

  return <Editor />;
};

const AdminRoute = (): JSX.Element => {
  const { user } = useContext(AuthContext);

  if (!canAdmin(user?.role)) {
    return <Navigate replace to='/' />;
  }

  return <Admin />;
};

const PrivateApp = (): JSX.Element => (
  <AuthGate>
    <SnippetsContextProvider>
      <KeyboardShortcuts />
      <Navbar />
      <Routes>
        <Route index element={<Home />} />
        <Route path='snippets/*' element={<Snippets />} />
        <Route path='snippet/:id/*' element={<Snippet />} />
        <Route path='editor/:id?/*' element={<EditorRoute />} />
        <Route path='admin/*' element={<AdminRoute />} />
      </Routes>
    </SnippetsContextProvider>
  </AuthGate>
);

export const App = () => {
  return (
    <BrowserRouter>
      <ThemeContextProvider>
        <AuthContextProvider>
          <Routes>
            <Route path='/s/:rawRef/*' element={<PublicSnippet />} />
            <Route path='/*' element={<PrivateApp />} />
          </Routes>
        </AuthContextProvider>
      </ThemeContextProvider>
    </BrowserRouter>
  );
};
