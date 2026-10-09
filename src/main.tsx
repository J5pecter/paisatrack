import { StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from '@tanstack/react-router';
import { Toaster } from 'sonner';
import { router } from '@/routes/router';
import { useGlobalShortcuts } from '@/components/CommandPalette';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { BootGate } from '@/components/BootGate';
import { initTheme, useUI } from '@/stores/ui';
import './index.css';

initTheme();

function App() {
  const theme = useUI((s) => s.theme);
  useGlobalShortcuts();

  return (
    <ErrorBoundary>
      {/*
        BootGate is outside Suspense on purpose: it owns the "we have no data
        yet" state, and wrapping it in a boundary that renders null would show
        a blank page instead of the reason.
      */}
      <BootGate>
        <Suspense fallback={null}>
          <RouterProvider router={router} />
        </Suspense>
      </BootGate>
      <Toaster
        theme={theme}
        position="bottom-right"
        richColors
        closeButton
        toastOptions={{ className: 'text-sm' }}
      />
    </ErrorBoundary>
  );
}

const container = document.getElementById('root')!;

// Vite's HMR re-executes this module on edit. Creating a second root over the
// same container throws and leaves the DOM in a broken state, so the root is
// stashed and reused. Production only ever runs this once.
declare global {
  interface Window {
    __paisatrackRoot?: ReturnType<typeof createRoot>;
  }
}

const root = window.__paisatrackRoot ?? createRoot(container);
window.__paisatrackRoot = root;

root.render(
  <StrictMode>
    <App />
  </StrictMode>,
);
