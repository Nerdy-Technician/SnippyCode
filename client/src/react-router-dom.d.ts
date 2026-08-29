import 'react';

declare module 'react-router-dom' {
  interface BrowserRouterProps {
    children?: React.ReactNode;
  }

  interface MemoryRouterProps {
    children?: React.ReactNode;
  }

  interface HashRouterProps {
    children?: React.ReactNode;
  }

  interface RouterProps {
    children?: React.ReactNode;
  }

  interface SwitchProps {
    children?: React.ReactNode;
  }

  interface RouteProps {
    children?: React.ReactNode;
  }

  interface RedirectProps {
    children?: React.ReactNode;
  }

  interface LinkProps {
    children?: React.ReactNode;
  }

  interface NavLinkProps {
    children?: React.ReactNode;
  }
}
