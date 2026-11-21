import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import i18n from './workbench-i18n';
import { Workbench } from './workbench-app';
import './workbench.css';

const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 15_000 } } });

export function mountWorkbench(root: HTMLElement, basename: string) {
  document.body.classList.add('wb-standalone');
  createRoot(root).render(
    <StrictMode><QueryClientProvider client={client}><I18nextProvider i18n={i18n}><BrowserRouter basename={basename}><Workbench /></BrowserRouter></I18nextProvider></QueryClientProvider></StrictMode>,
  );
}
