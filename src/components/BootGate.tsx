/**
 * Nothing renders until the data has arrived.
 *
 * This component exists because of a trade the app made deliberately: the
 * records live on the Worker and there is no local copy, so there is a short
 * window on every load where PaisaTrack genuinely does not know anything, and
 * a longer one where it cannot find out.
 *
 * The alternative — render the app and let each screen show zeros until the
 * fetch lands — is worse than a spinner in a specific way. A net worth of ₹0
 * is a *claim*, and someone glancing at their phone has no way to tell a
 * loading state from a wiped database. Better to show nothing and say why.
 *
 * Three states are worth distinguishing, and conflating them is how setup
 * problems become mysteries:
 *
 *   not configured  You have not told it where the server is. A setup screen,
 *                   not an error — nothing is broken.
 *   loading         The request is in flight.
 *   error           The server is unreachable, or rejected the token. The app
 *                   has nothing to show and says so, with the reason.
 */
import * as React from 'react';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui';
import { CloudOffIcon, SpinnerIcon, WarningIcon } from '@/components/icons';
import { ServerCard } from '@/components/ServerCard';
import { getError, getStatus, getTable, loadAll, NotConfigured, subscribe } from '@/lib/store/records';
import { readWorkerConfig } from '@/lib/server/config';
import { migrationHandled } from '@/lib/db/legacy';
import { MigrationCard, useLegacyData } from '@/components/MigrationCard';
import { SYNC_TABLES } from '@/types';

export function BootGate({ children }: { children: React.ReactNode }) {
  const status = React.useSyncExternalStore(subscribe, getStatus, getStatus);
  const error = React.useSyncExternalStore(subscribe, getError, getError);
  const [configured, setConfigured] = React.useState(() => readWorkerConfig() !== null);
  const [migrationDone, setMigrationDone] = React.useState(() => migrationHandled());

  /*
    Latched, not recomputed.

    The condition that opens this screen includes "the server is empty", and a
    successful migration makes that false — so re-evaluating it every render
    tore the screen down the instant it succeeded, before the user could see
    the confirmation or the offer to delete the old local copy. Once shown, it
    stays until they dismiss it.
  */
  const [showMigration, setShowMigration] = React.useState(false);

  /*
    Looked for only once the server has answered, so the question is never
    "do you have old data?" but "do you have old data that is not already
    here?". Asking before the fetch lands would offer a migration to someone
    who migrated on another device last week.
  */
  const legacy = useLegacyData();

  const load = React.useCallback(() => {
    loadAll().catch((e) => {
      // NotConfigured is a setup state, not a failure — the store has already
      // recorded it and the screen below explains what to do.
      if (!(e instanceof NotConfigured)) return;
      setConfigured(false);
    });
  }, []);

  React.useEffect(() => {
    if (configured) load();
  }, [configured, load]);

  /*
    Re-check after the user saves a server in the setup screen below. Settings
    writes to localStorage, which fires no event in the tab that wrote it, so
    polling briefly is simpler and more reliable than threading a callback
    through ServerCard purely for this one case.
  */
  React.useEffect(() => {
    if (configured) return;
    const timer = setInterval(() => {
      if (readWorkerConfig() !== null) setConfigured(true);
    }, 800);
    return () => clearInterval(timer);
  }, [configured]);

  if (!configured) {
    return (
      <Shell>
        <Card className="mb-5">
          <CardHeader>
            <CardTitle className="text-base">Point PaisaTrack at your server</CardTitle>
            <CardDescription>
              Your records live on a Cloudflare Worker you deploy yourself — free, no card — so they
              follow you between devices instead of sitting in one browser. Paste its address and
              token below and the app will load.
              <span className="mt-2 block">
                The deploy guide is <code className="font-mono">worker/README.md</code> in the repo.
                It takes about five minutes and you only do it once.
              </span>
            </CardDescription>
          </CardHeader>
        </Card>
        <ServerCard />
      </Shell>
    );
  }

  if (status === 'ERROR') {
    return (
      <Shell>
        <Card className="border-[var(--color-danger)]/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base text-[var(--color-danger)]">
              <WarningIcon className="h-4 w-4" weight="fill" />
              Could not reach your data
            </CardTitle>
            <CardDescription>{error}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="flex items-start gap-2 text-xs text-[var(--color-muted-foreground)]">
              <CloudOffIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {/*
                Said plainly rather than buried. Someone who installed this as a
                PWA reasonably expects it to work on a train, and it used to.
              */}
              PaisaTrack keeps no copy on this device, so there is nothing to show while the server
              is unreachable. Your data is not lost — it is on the Worker.
            </p>
            <Button onClick={load}>Try again</Button>
          </CardContent>
        </Card>
        <div className="mt-5">
          <ServerCard />
        </div>
      </Shell>
    );
  }

  /*
    The one screen that blocks the app on purpose.

    Someone with months of records in the old local database opens this version
    and sees an empty dashboard. That is a bad enough moment — "my finance app
    lost everything" — to be worth interrupting for, exactly once. It only
    appears when the server is genuinely empty, so it cannot nag anyone who has
    already moved.
  */
  if (
    !showMigration &&
    status === 'READY' &&
    !migrationDone &&
    legacy.data &&
    SYNC_TABLES.every((t) => getTable(t).length === 0)
  ) {
    setShowMigration(true);
  }

  if (showMigration && legacy.data) {
    const dismiss = () => {
      setShowMigration(false);
      setMigrationDone(true);
    };
    return (
      <Shell>
        <MigrationCard data={legacy.data} onDone={dismiss} onSkip={dismiss} />
      </Shell>
    );
  }

  if (status !== 'READY') {
    return (
      <Shell>
        <div className="flex flex-col items-center justify-center gap-3 py-24 text-sm text-[var(--color-muted-foreground)]">
          <SpinnerIcon className="h-5 w-5 animate-spin" />
          Loading your data…
        </div>
      </Shell>
    );
  }

  return <>{children}</>;
}

/** A minimal frame, because AppShell's navigation is useless without data behind it. */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto min-h-dvh w-full max-w-2xl px-4 py-10">
      <h1 className="mb-6 text-xl font-semibold tracking-tight">PaisaTrack</h1>
      {children}
    </div>
  );
}
