import type { ReactNode } from 'react';

declare module 'react-router-dom' {
  interface BrowserRouterProps {
    children?: ReactNode;
  }

  interface MemoryRouterProps {
    children?: ReactNode;
  }

  interface HashRouterProps {
    children?: ReactNode;
  }

  interface RouterProps {
    children?: ReactNode;
  }

  interface SwitchProps {
    children?: ReactNode;
  }

  interface RouteProps {
    children?: ReactNode;
  }

  interface RedirectProps {
    children?: ReactNode;
  }

  interface LinkProps {
    children?: ReactNode;
  }

  interface NavLinkProps {
    children?: ReactNode;
  }
}
