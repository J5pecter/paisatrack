/**
 * Moving an existing local database to the server.
 *
 * Shown only to people who have one. For anyone starting fresh this component
 * never renders and its code is never downloaded.
 *
 * The thing it is guarding against is specific: someone who has been entering
 * expenses for months opens the new version, sees an empty dashboard, and
 * concludes the app lost their data. It did not — the records are in
 * IndexedDB, where they have always been — but "my finance app is empty" is a
 * bad enough moment that it is worth an explicit screen rather than a line in
 * a changelog.
 */
import * as React from 'react';
import { toast } from 'sonner';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui';
import { CheckCircleIcon, SpinnerIcon, UploadIcon } from '@/components/icons';
import { bulkPutMany } from '@/lib/db/repository';
import {
  dropLegacyDatabase,
  legacyDatabaseExists,
  markMigrationHandled,
  readLegacyData,
  type LegacyData,
} from '@/lib/db/legacy';
import { loadAll } from '@/lib/store/records';
import { humanise } from '@/lib/utils';

export function useLegacyData(): { data: LegacyData | null; checked: boolean } {
  const [data, setData] = React.useState<LegacyData | null>(null);
  const [checked, setChecked] = React.useState(false);

  React.useEffect(() => {
    void (async () => {
      try {
        if (await legacyDatabaseExists()) {
          const found = await readLegacyData();
          if (found.total > 0) setData(found);
        }
      } catch {
        // A browser that blocks IndexedDB, or a corrupt old database. Neither
        // is worth an error on a screen about something else.
      } finally {
        setChecked(true);
      }
    })();
  }, []);

  return { data, checked };
}

export function MigrationCard({
  data,
  onDone,
  onSkip,
}: {
  data: LegacyData;
  onDone: () => void;
  onSkip?: () => void;
}) {
  const [busy, setBusy] = React.useState(false);
  const [moved, setMoved] = React.useState(false);

  async function migrate() {
    setBusy(true);
    try {
      await bulkPutMany(data.groups);
      // Re-read rather than trusting the local application: this is the moment
      // to be certain the server actually has them, because the next thing
      // offered is deleting the only other copy.
      await loadAll();
      markMigrationHandled();
      setMoved(true);
      toast.success(`Moved ${data.total} records to your server`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'The move failed. Your local data is untouched.');
    } finally {
      setBusy(false);
    }
  }

  async function discardOld() {
    try {
      await dropLegacyDatabase();
      toast.success('Old local database deleted');
      onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not delete the old database.');
    }
  }

  if (moved) {
    return (
      <Card className="border-[var(--color-success)]/40">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <CheckCircleIcon className="h-4 w-4 text-[var(--color-success)]" weight="fill" />
            {data.total} records are on your server
          </CardTitle>
          <CardDescription>
            The old copy in this browser has been left exactly as it was. Keep it until you are
            satisfied everything is here — it is the only copy that does not depend on the server.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button onClick={onDone}>Continue</Button>
          <Button variant="ghost" onClick={() => void discardOld()}>
            Delete the old local copy
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <UploadIcon className="h-4 w-4" />
          You have {data.total} records in this browser
        </CardTitle>
        <CardDescription>
          PaisaTrack used to keep everything on the device. It keeps everything on your server now,
          so your data follows you — but these were entered before that change and are still sitting
          here. Move them across and nothing is lost.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        <ul className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-[var(--color-muted-foreground)] sm:grid-cols-3">
          {Object.entries(data.counts).map(([table, n]) => (
            <li key={table} className="flex justify-between gap-2">
              <span>{humanise(table)}</span>
              <span className="font-medium text-[var(--color-foreground)]">{n}</span>
            </li>
          ))}
        </ul>

        <p className="text-xs text-[var(--color-muted-foreground)]">
          This copies. It does not move — the local database is left untouched, so if anything goes
          wrong the original is still here.
        </p>

        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void migrate()} disabled={busy}>
            {busy ? (
              <>
                <SpinnerIcon className="mr-1.5 h-4 w-4 animate-spin" />
                Moving {data.total} records…
              </>
            ) : (
              `Move ${data.total} records to the server`
            )}
          </Button>
          {onSkip && (
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                markMigrationHandled();
                onSkip();
              }}
            >
              Not now
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
