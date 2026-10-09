import * as React from 'react';
import { WarningIcon } from '@/components/icons';
import { Button } from '@/components/ui';

interface State {
  error: Error | null;
}

/**
 * Catches render errors so a bad record can never leave the user staring at a
 * blank page. Their data is safe in IndexedDB either way — the reload button
 * says so, because that is the first thing anyone worries about.
 */
export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('PaisaTrack crashed:', error, info.componentStack);
  }

  render(): React.ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex min-h-dvh items-center justify-center bg-[var(--color-background)] p-6 text-[var(--color-foreground)]">
        <div className="w-full max-w-md text-center">
          <div className="mx-auto mb-4 w-fit rounded-full bg-[var(--color-danger)]/15 p-3">
            <WarningIcon className="h-6 w-6 text-[var(--color-danger)]" weight="duotone" />
          </div>
          <h1 className="text-xl font-semibold">Something broke</h1>
          <p className="mt-2 text-sm text-[var(--color-muted-foreground)]">
            Your data is safe — it lives on your server, not in this page.
            Reloading usually clears this.
          </p>
          <pre className="mt-4 max-h-40 overflow-auto rounded-md bg-[var(--color-muted)] p-3 text-left text-xs">
            {error.message}
          </pre>
          <div className="mt-5 flex justify-center gap-2">
            <Button onClick={() => window.location.reload()}>Reload</Button>
            <Button variant="outline" onClick={() => this.setState({ error: null })}>
              Try again
            </Button>
          </div>
        </div>
      </div>
    );
  }
}
