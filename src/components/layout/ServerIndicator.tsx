/**
 * Whether the app is currently talking to its server.
 *
 * Replaces the old SyncIndicator, which reported something genuinely different:
 * sync was a background process with queued changes, a last-pushed time and the
 * possibility of conflicts, so the indicator had to answer "is my data safe
 * yet?". Writes go straight to the server now and are confirmed before they
 * appear, so by the time anything is on screen it is already stored.
 *
 * What is left worth showing is connectivity — and specifically the moment a
 * write fails, because with no local copy there is no queue to retry from. A
 * failed write is a change that did not happen, and the user needs to know
 * immediately rather than discovering it at the end of the month.
 */
import * as React from 'react';
import { CloudIcon, CloudOffIcon, SpinnerIcon } from '@/components/icons';
import { Tooltip } from '@/components/ui';
import { getStatus, subscribe } from '@/lib/store/records';
import { cn } from '@/lib/utils';

export function ServerIndicator() {
  const status = React.useSyncExternalStore(subscribe, getStatus, getStatus);

  /*
    The browser's own view of connectivity, which catches the common case —
    a phone in a lift — before a request has to time out to discover it.
    `navigator.onLine` is famously optimistic (it reports a connection to a
    captive portal as online), so it is only ever used to show a warning
    sooner, never to suppress one.
  */
  const [online, setOnline] = React.useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );

  React.useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);

  const offline = !online || status === 'ERROR';

  const label = offline
    ? 'No connection to your server. Changes cannot be saved until it is back — PaisaTrack keeps no copy on this device.'
    : status === 'LOADING'
      ? 'Loading from your server…'
      : 'Connected. Every change is saved on the server as you make it.';

  return (
    <Tooltip content={label}>
      <span
        className={cn(
          'inline-flex h-8 w-8 items-center justify-center rounded-md transition-colors',
          offline ? 'text-[var(--color-danger)]' : 'text-[var(--color-muted-foreground)]',
        )}
        aria-label={label}
        role="status"
      >
        {status === 'LOADING' ? (
          <SpinnerIcon className="h-4 w-4 animate-spin" />
        ) : offline ? (
          <CloudOffIcon className="h-4 w-4" weight="fill" />
        ) : (
          <CloudIcon className="h-4 w-4" />
        )}
      </span>
    </Tooltip>
  );
}
