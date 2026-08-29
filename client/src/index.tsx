import React from 'react';
import { createRoot } from 'react-dom/client';
import { loader } from '@monaco-editor/react';
import './styles/style.scss';
import { App } from './App';

loader.config({
  paths: {
    vs: `${process.env.PUBLIC_URL || ''}/monaco/vs`
  }
});

const container = document.getElementById('root');

if (container) {
  const root = createRoot(container);
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}
