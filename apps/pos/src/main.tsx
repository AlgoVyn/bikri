import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { router } from './app.tsx';
import './styles.css';

const rootElement = document.getElementById('root');
if (rootElement === null) {
  throw new Error('Root element #root is missing');
}

createRoot(rootElement).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
