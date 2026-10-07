/**
 * Sync status pill in the header.
 *
 * Green means everything is committed to GitHub, amber means there are queued
 * changes, red means something went wrong. A grey cloud means sync is simply
 * turned off — which is a perfectly valid way to use the app, so it is stated
 * neutrally rather than as a warning.
 */
import { useEffect, useState } from 'react';
import {
  CloudIcon,
  CloudOffIcon,
  CloudSyncedIcon,
  SpinnerIcon,
  SyncIcon,
  WarningIcon,
} from '@/components/icons';
import { syncEngine, type SyncState } from '@/lib/sync/engine';
import { Tooltip } from '@/components/ui';
import { cn } from '@/lib/utils';
import { formatDistanceToNowStrict } from 'date-fns';

export function SyncIndicator() {
  const [state, setState] = useState<SyncState>(syncEngine.getState());

  useEffect(() => syncEngine.subscribe(setState), []);

  const { icon: Icon, colour, label, spin } = describe(state);

  return (
    <Tooltip content={<SyncTooltip state={state} />}>
      <button
        onClick={() => void syncEngine.syncNow()}
        className={cn(
          'tap flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors hover:bg-[var(--color-accent)]',
          colour,
        )}
        aria-label={`Sync status: ${label}. Click to sync now.`}
      >
        <Icon className={cn('h-3.5 w-3.5', spin && 'animate-spin')} />
        <span className="hidden lg:inline">{label}</span>
        {state.pendingCount > 0 && (
          <span className="rounded-full bg-[var(--color-warning)]/20 px-1.5 text-[10px]">
            {state.pendingCount}
          </span>
        )}
      </button>
    </Tooltip>
  );
}

function describe(state: SyncState) {
  switch (state.status) {
    case 'SYNCING':
      return { icon: SpinnerIcon, colour: 'text-[var(--color-info)]', label: 'Syncing', spin: true };
    case 'PENDING':
      return { icon: SyncIcon, colour: 'text-[var(--color-warning)]', label: 'Pending', spin: false };
    case 'OFFLINE':
      return { icon: CloudOffIcon, colour: 'text-[var(--color-muted-foreground)]', label: 'Offline', spin: false };
    case 'ERROR':
      return { icon: WarningIcon, colour: 'text-[var(--color-danger)]', label: 'Sync error', spin: false };
    case 'DISABLED':
      return { icon: CloudIcon, colour: 'text-[var(--color-muted-foreground)]', label: 'Local only', spin: false };
    case 'IDLE':
    default:
      return { icon: CloudSyncedIcon, colour: 'text-[var(--color-success)]', label: 'Synced', spin: false };
  }
}

function SyncTooltip({ state }: { state: SyncState }) {
  if (state.status === 'DISABLED') {
    return (
      <div className="space-y-1">
        <p className="font-medium">Sync is off</p>
        <p className="text-[var(--color-muted-foreground)]">
          Everything is saved on this device. Add a GitHub token in Settings to sync across devices.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {state.status === 'ERROR' && state.error && (
        <p className="text-[var(--color-danger)]">{state.error}</p>
      )}
      {state.pendingCount > 0 && (
        <p>
          {state.pendingCount} change{state.pendingCount === 1 ? '' : 's'} waiting to commit
        </p>
      )}
      {state.lastSyncedAt && (
        <p className="text-[var(--color-muted-foreground)]">
          Last synced {formatDistanceToNowStrict(new Date(state.lastSyncedAt))} ago
        </p>
      )}
      <p className="text-[var(--color-muted-foreground)]">Click to sync now</p>
    </div>
  );
}
