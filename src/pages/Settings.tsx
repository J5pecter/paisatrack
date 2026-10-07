/**
 * Settings — GitHub sync, backup/restore, sample data, and the reset button.
 *
 * The token handling here is deliberately careful: it is stored in IndexedDB on
 * this device, masked in the UI once saved, and only ever sent to
 * api.github.com. The copy says so plainly, because nobody should have to guess
 * what an app does with a credential.
 */
import * as React from 'react';
import { toast } from 'sonner';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ConfirmDialog,
  Field,
  Input,
  Separator,
  Switch,
} from '@/components/ui';
import {
  CheckCircleIcon,
  CloudIcon,
  DownloadIcon,
  GithubIcon,
  HideIcon,
  LockIcon,
  ShowIcon,
  SparkleIcon,
  SyncIcon,
  TipIcon,
  UploadIcon,
  WarningIcon,
} from '@/components/icons';
import { PageHeader } from '@/components/layout/AppShell';
import { InstallCard } from '@/components/InstallPrompt';
import { CopyButton, LastUpdated } from '@/components/Chrome';
import { db } from '@/lib/db/schema';
import { bulkPut, getDeviceId } from '@/lib/db/repository';
import { isEmpty, removeSampleData, seedSampleData } from '@/lib/db/seed';
import {
  clearConfig,
  DEFAULT_CONFIG,
  type GitHubConfig,
  loadConfig,
  rateLimit,
  testConnection,
} from '@/lib/github/client';
import { reconfigure, syncEngine, type SyncState } from '@/lib/sync/engine';
import { buildPayload, parsePayload, serialisePayload } from '@/lib/sync/merge';
import { checkImportFile, ValidationError } from '@/lib/validation';
import { todayISO } from '@/lib/finance/dates';
import { downloadBlob } from '@/lib/utils';
import { useUI } from '@/stores/ui';
import { SYNC_TABLES, type BaseRecord, type SyncTable } from '@/types';

export function Settings() {
  const { theme, setTheme } = useUI();
  const [syncState, setSyncState] = React.useState<SyncState>(syncEngine.getState());
  const [confirmReset, setConfirmReset] = React.useState(false);
  const [confirmRemoveSample, setConfirmRemoveSample] = React.useState(false);
  const restoreRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => syncEngine.subscribe(setSyncState), []);

  async function exportBackup() {
    const data = {} as Record<SyncTable, BaseRecord[]>;
    for (const table of SYNC_TABLES) {
      data[table] = (await (db[table] as never as { toArray(): Promise<BaseRecord[]> }).toArray());
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
        let restored = 0;
        for (const table of SYNC_TABLES) {
          const rows = payload.data[table] ?? [];
          if (rows.length) {
            // skipSync: a restore is a local operation; the next sync will
            // reconcile it with the remote on its own terms.
            await bulkPut(table, rows as BaseRecord[], { skipSync: true });
            restored += rows.length;
          }
        }

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

  async function resetEverything() {
    await db.transaction('rw', db.tables, async () => {
      await Promise.all(db.tables.map((t) => t.clear()));
    });
    localStorage.removeItem('paisatrack.ui');
    setConfirmReset(false);
    toast.success('Everything cleared');
    setTimeout(() => window.location.reload(), 600);
  }

  return (
    <>
      <PageHeader
        title="Settings"
        subtitle={`Device ${getDeviceId()}`}
        actions={<CopyButton value={getDeviceId()} label="Copy device id" />}
      />

      <div className="grid gap-5 lg:grid-cols-2">
        <GitHubSyncCard syncState={syncState} />

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
                A plain JSON file you own. Works whether or not GitHub sync is on.
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
                Clears everything on this device. If sync is on, your GitHub repo still holds the
                data and the next sync will pull it back.
              </p>
            </CardHeader>
            <CardContent>
              <Button variant="destructive" onClick={() => setConfirmReset(true)}>
                Reset this device
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

function GitHubSyncCard({ syncState }: { syncState: SyncState }) {
  const [config, setConfig] = React.useState<GitHubConfig | null>(null);
  const [form, setForm] = React.useState({
    token: '',
    owner: '',
    repo: DEFAULT_CONFIG.repo,
    path: DEFAULT_CONFIG.path,
    branch: DEFAULT_CONFIG.branch,
  });
  const [showToken, setShowToken] = React.useState(false);
  const [testing, setTesting] = React.useState(false);
  const [result, setResult] = React.useState<{ ok: boolean; message: string } | null>(null);
  const [quota, setQuota] = React.useState<{ remaining: number; limit: number } | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = React.useState(false);

  React.useEffect(() => {
    void loadConfig().then((c) => {
      if (!c) return;
      setConfig(c);
      setForm({ token: c.token, owner: c.owner, repo: c.repo, path: c.path, branch: c.branch });
      void rateLimit(c).then(setQuota).catch(() => undefined);
    });
  }, []);

  async function test() {
    if (!form.token || !form.owner) {
      setResult({ ok: false, message: 'Enter your GitHub username and a token.' });
      return;
    }
    setTesting(true);
    setResult(null);
    try {
      const res = await testConnection(form);
      setResult(res);
      if (res.ok) {
        await reconfigure(form);
        setConfig(form);
        void rateLimit(form).then(setQuota).catch(() => undefined);
        toast.success('Sync connected');
      }
    } finally {
      setTesting(false);
    }
  }

  async function disconnect() {
    syncEngine.stop();
    await clearConfig();
    setConfig(null);
    setForm({ token: '', owner: '', repo: DEFAULT_CONFIG.repo, path: DEFAULT_CONFIG.path, branch: DEFAULT_CONFIG.branch });
    setResult(null);
    setQuota(null);
    setConfirmDisconnect(false);
    toast.success('Sync disconnected. Your data stays on this device.');
  }

  const connected = Boolean(config?.token);

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <GithubIcon className="h-5 w-5" weight="fill" />
            GitHub sync
          </CardTitle>
          <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
            Optional. Syncs this device with a private repo you own — every save is a commit, so
            your whole history is recoverable.
          </p>
        </div>
        {connected ? (
          <Badge variant="success">Connected</Badge>
        ) : (
          <Badge variant="outline">Local only</Badge>
        )}
      </CardHeader>

      <CardContent className="space-y-4">
        {!connected && (
          <ol className="space-y-1.5 rounded-md border border-[var(--color-border)] p-3 text-xs text-[var(--color-muted-foreground)]">
            <li>
              <strong className="text-[var(--color-foreground)]">1.</strong> Create a{' '}
              <strong className="text-[var(--color-foreground)]">private</strong> repo called{' '}
              <code className="rounded bg-[var(--color-muted)] px-1">paisatrack-data</code>.
            </li>
            <li>
              <strong className="text-[var(--color-foreground)]">2.</strong> Go to Settings →
              Developer settings → Personal access tokens → Fine-grained tokens.
            </li>
            <li>
              <strong className="text-[var(--color-foreground)]">3.</strong> Generate a token scoped
              to that one repo, with{' '}
              <strong className="text-[var(--color-foreground)]">Contents: Read and write</strong>.
            </li>
            <li>
              <strong className="text-[var(--color-foreground)]">4.</strong> Paste it below.
            </li>
          </ol>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="GitHub username" required>
            <Input
              value={form.owner}
              onChange={(e) => setForm((f) => ({ ...f, owner: e.target.value.trim() }))}
              placeholder="your-username"
              autoComplete="off"
            />
          </Field>
          <Field label="Data repo" required>
            <Input
              value={form.repo}
              onChange={(e) => setForm((f) => ({ ...f, repo: e.target.value.trim() }))}
              placeholder="paisatrack-data"
              autoComplete="off"
            />
          </Field>
        </div>

        <Field
          label="Personal access token"
          required
          hint="Stored in this browser's IndexedDB. Sent only to api.github.com, never anywhere else."
        >
          <div className="relative">
            <LockIcon className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--color-muted-foreground)]" />
            <Input
              type={showToken ? 'text' : 'password'}
              value={form.token}
              onChange={(e) => setForm((f) => ({ ...f, token: e.target.value.trim() }))}
              placeholder="github_pat_…"
              autoComplete="off"
              spellCheck={false}
              className="px-9 font-mono text-xs"
            />
            <button
              type="button"
              onClick={() => setShowToken((v) => !v)}
              className="tap absolute right-2 top-1/2 flex -translate-y-1/2 items-center justify-center rounded p-1 hover:bg-[var(--color-accent)]"
              aria-label={showToken ? 'Hide token' : 'Show token'}
            >
              {showToken ? <HideIcon className="h-3.5 w-3.5" /> : <ShowIcon className="h-3.5 w-3.5" />}
            </button>
          </div>
        </Field>

        {result && (
          <div
            className={`flex items-start gap-2 rounded-md border p-3 text-xs ${
              result.ok
                ? 'border-[var(--color-success)]/40 bg-[var(--color-success)]/10'
                : 'border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10'
            }`}
          >
            {result.ok ? (
              <CheckCircleIcon className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-success)]" weight="fill" />
            ) : (
              <WarningIcon className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-danger)]" weight="fill" />
            )}
            <p>{result.message}</p>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void test()} disabled={testing} className="gap-1.5">
            <CloudIcon className="h-4 w-4" weight="bold" />
            {testing ? 'Testing…' : connected ? 'Update and reconnect' : 'Connect'}
          </Button>
          {connected && (
            <>
              <Button
                variant="outline"
                onClick={() => void syncEngine.syncNow()}
                disabled={syncState.status === 'SYNCING'}
                className="gap-1.5"
              >
                <SyncIcon
                  className={`h-4 w-4 ${syncState.status === 'SYNCING' ? 'animate-spin' : ''}`}
                  weight="bold"
                />
                Sync now
              </Button>
              <Button variant="ghost" onClick={() => setConfirmDisconnect(true)}>
                Disconnect
              </Button>
            </>
          )}
        </div>

        {connected && (
          <>
            <Separator />
            <dl className="grid grid-cols-2 gap-3 text-xs">
              <div>
                <dt className="text-[var(--color-muted-foreground)]">Status</dt>
                <dd className="font-medium">{syncState.status.toLowerCase()}</dd>
              </div>
              <div>
                <dt className="text-[var(--color-muted-foreground)]">Pending changes</dt>
                <dd className="tnum font-medium">{syncState.pendingCount}</dd>
              </div>
              <div>
                <dt className="text-[var(--color-muted-foreground)]">Last synced</dt>
                <dd className="font-medium">
                  {syncState.lastSyncedAt ? (
                    <LastUpdated at={syncState.lastSyncedAt} className="text-xs font-medium" />
                  ) : (
                    'never'
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-[var(--color-muted-foreground)]">API quota left</dt>
                <dd className="tnum font-medium">
                  {quota ? `${quota.remaining} / ${quota.limit}` : '—'}
                </dd>
              </div>
            </dl>

            {syncState.error && (
              <p className="rounded-md border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 p-3 text-xs text-[var(--color-danger)]">
                {syncState.error}
              </p>
            )}

            <div className="flex items-start gap-2 rounded-md border border-[var(--color-border)] p-3 text-xs">
              <TipIcon className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-info)]" weight="duotone" />
              <p className="text-[var(--color-muted-foreground)]">
                Writes are debounced into a single commit every few seconds, and the other device
                picks them up within 30 seconds while its tab is focused. At roughly 100 requests a
                day you will never come close to GitHub's 5,000/hour limit.
              </p>
            </div>
          </>
        )}
      </CardContent>

      <ConfirmDialog
        open={confirmDisconnect}
        onOpenChange={setConfirmDisconnect}
        title="Disconnect GitHub sync?"
        description="Your token is removed from this device and syncing stops. All your data stays here, and the copy in your repo is untouched."
        confirmLabel="Disconnect"
        onConfirm={() => void disconnect()}
      />
    </Card>
  );
}
