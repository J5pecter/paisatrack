/**
 * Settings — the server, backup/restore, sample data, and the reset button.
 *
 * The token handling here is deliberately careful: it is stored in IndexedDB on
 * this device, masked in the UI once saved, and only ever sent to
 * api.github.com. The copy says so plainly, because nobody should have to guess
 * what an app does with a credential.
 */
import * as React from 'react';
import { toast } from 'sonner';
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ConfirmDialog,
  Switch,
} from '@/components/ui';
import {
  DownloadIcon,
  SparkleIcon,
  UploadIcon,
} from '@/components/icons';
import { PageHeader } from '@/components/layout/AppShell';
import { InstallCard } from '@/components/InstallPrompt';
import { ServerCard } from '@/components/ServerCard';
import { CopyButton } from '@/components/Chrome';
import { bulkPutMany, getDeviceId } from '@/lib/db/repository';
import { isEmpty, removeSampleData, seedSampleData } from '@/lib/db/seed';
import { buildPayload, parsePayload, serialisePayload } from '@/lib/backup/payload';
import { clear as clearStore, getTable, loadAll } from '@/lib/store/records';
import { callSync, postToWorker } from '@/lib/server/config';
import { MigrationCard, useLegacyData } from '@/components/MigrationCard';
import { checkImportFile, ValidationError } from '@/lib/validation';
import { todayISO } from '@/lib/finance/dates';
import { downloadBlob } from '@/lib/utils';
import { useUI } from '@/stores/ui';
import { SYNC_TABLES, type BaseRecord, type SyncTable } from '@/types';

export function Settings() {
  const { theme, setTheme } = useUI();
  const [confirmReset, setConfirmReset] = React.useState(false);
  const [confirmRemoveSample, setConfirmRemoveSample] = React.useState(false);
  const restoreRef = React.useRef<HTMLInputElement>(null);
  // Offered here as well as at boot, for anyone who chose "not now" then.
  const legacy = useLegacyData();

  /**
   * Write every record to a file on this device.
   *
   * This matters more than it did. The server holds the only copy now, so a
   * deleted Cloudflare account, a lost token or a mistaken wipe takes the lot
   * — and a backup is by definition a copy somewhere the server cannot reach.
   */
  async function exportBackup() {
    const data = {} as Record<SyncTable, BaseRecord[]>;
    for (const table of SYNC_TABLES) {
      data[table] = [...getTable(table)];
    }
    const json = serialisePayload(buildPayload(data, getDeviceId()));
    downloadBlob(json, `paisatrack-backup-${todayISO()}.json`, 'application/json');
    toast.success('Backup downloaded');
  }

  function restoreBackup(file: File) {
    const check = checkImportFile(file, 'json');
    if (!check.ok) {
      toast.error(check.message ?? 'That file cannot be restored.');
      return;
    }

    const reader = new FileReader();
    reader.onerror = () => toast.error('That file could not be read.');
    reader.onload = async () => {
      try {
        // Validates structurally and drops individual malformed records.
        const payload = await parsePayload(String(reader.result));

        /*
          One call across every table rather than seventeen. A restore that
          half-applied would leave card statements without their card, which
          reads on screen as corrupted data rather than an interrupted restore.
        */
        const groups = SYNC_TABLES.map((table) => ({
          table,
          records: (payload.data[table] ?? []) as BaseRecord[],
        })).filter((g) => g.records.length > 0);

        const restored = await bulkPutMany(groups);

        if (payload.dropped > 0) {
          toast.warning(`Restored ${restored} records, skipped ${payload.dropped} malformed`, {
            description: payload.problems.slice(0, 3).join(' · '),
          });
        } else {
          toast.success(`Restored ${restored} records`);
        }
      } catch (e) {
        toast.error(
          e instanceof ValidationError
            ? e.message
            : e instanceof Error
              ? e.message
              : 'That file could not be read.',
        );
      }
    };
    reader.readAsText(file);
  }

  async function loadSample() {
    if (!(await isEmpty())) {
      toast.info('Sample data is only loaded into an empty database.');
      return;
    }
    const { counts } = await seedSampleData();
    toast.success(`Loaded ${Object.values(counts).reduce((a, b) => a + b, 0)} sample records`);
  }

  /**
   * Delete everything, on the server.
   *
   * This used to clear an IndexedDB database that only this browser could see.
   * It now destroys the single authoritative copy, from any device, and no
   * other device holds a replica to restore from — so the confirmation it sits
   * behind is carrying considerably more weight than it used to, and the
   * wording below says so.
   */
  async function resetEverything() {
    const call = callSync();
    if (!call) {
      toast.error('No server is configured.');
      return;
    }

    try {
      const result = await postToWorker<{ deleted: number }>(call, '/data/wipe', {});
      clearStore();
      localStorage.removeItem('paisatrack.ui');
      setConfirmReset(false);
      toast.success(`Deleted ${result.deleted} records from the server`);
      setTimeout(() => window.location.reload(), 600);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'The reset failed.');
    }
  }

  return (
    <>
      <PageHeader
        title="Settings"
        subtitle={`Device ${getDeviceId()}`}
        actions={<CopyButton value={getDeviceId()} label="Copy device id" />}
      />

      <div className="grid gap-5 lg:grid-cols-2">

        <ServerCard />

        {legacy.data && (
          <MigrationCard data={legacy.data} onDone={() => void loadAll()} />
        )}

        <div className="space-y-5">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Appearance</CardTitle>
            </CardHeader>
            <CardContent>
              <label className="flex items-center justify-between gap-3 text-sm">
                <span>
                  Dark mode
                  <span className="block text-xs text-[var(--color-muted-foreground)]">
                    Easier on the eyes at 11pm, which is when most people check their balance.
                  </span>
                </span>
                <Switch
                  checked={theme === 'dark'}
                  onCheckedChange={(v) => setTheme(v ? 'dark' : 'light')}
                  aria-label="Dark mode"
                />
              </label>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">This device</CardTitle>
            </CardHeader>
            <CardContent>
              <InstallCard />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Backup and restore</CardTitle>
              <p className="text-sm text-[var(--color-muted-foreground)]">
                A plain JSON file you own, and now the only copy that does not depend on your
                server. Worth taking occasionally.
              </p>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => void exportBackup()} className="gap-1.5">
                <DownloadIcon className="h-4 w-4" weight="bold" />
                Download backup
              </Button>
              <Button
                variant="outline"
                onClick={() => restoreRef.current?.click()}
                className="gap-1.5"
              >
                <UploadIcon className="h-4 w-4" weight="bold" />
                Restore from file
              </Button>
              <input
                ref={restoreRef}
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) restoreBackup(file);
                  e.target.value = '';
                }}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Sample data</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => void loadSample()} className="gap-1.5">
                <SparkleIcon className="h-4 w-4" weight="duotone" />
                Load sample data
              </Button>
              <Button variant="outline" onClick={() => setConfirmRemoveSample(true)}>
                Remove sample data
              </Button>
            </CardContent>
          </Card>

          <Card className="border-[var(--color-danger)]/40">
            <CardHeader>
              <CardTitle className="text-base text-[var(--color-danger)]">Danger zone</CardTitle>
              <p className="text-sm text-[var(--color-muted-foreground)]">
                Deletes every record from your server, permanently. This is the only copy — no
                device holds a replica to restore from, so export a backup first if there is any
                doubt.
              </p>
            </CardHeader>
            <CardContent>
              <Button variant="destructive" onClick={() => setConfirmReset(true)}>
                Delete everything
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>

      <ConfirmDialog
        open={confirmReset}
        onOpenChange={setConfirmReset}
        title="Clear all local data?"
        description="Every expense, card, loan and bill on this device will be erased, along with your GitHub token. Download a backup first if you are not syncing."
        confirmLabel="Erase everything"
        onConfirm={() => void resetEverything()}
      />

      <ConfirmDialog
        open={confirmRemoveSample}
        onOpenChange={setConfirmRemoveSample}
        title="Remove the sample data?"
        description="Only the seeded demo records are removed. Anything you entered yourself stays."
        confirmLabel="Remove"
        onConfirm={async () => {
          await removeSampleData();
          setConfirmRemoveSample(false);
          toast.success('Sample data removed');
        }}
      />
    </>
  );
}

// ---------------------------------------------------------------------------

