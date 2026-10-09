/**
 * Settings for the Cloudflare Worker.
 *
 * The framing matters as much as the controls, and it changed: this used to be
 * an optional accessory to a local-first app, and it is now where the records
 * live. Without a URL and token here PaisaTrack has nothing to show.
 *
 * What stayed opt-in is everything built ON TOP of storage — server OCR and
 * push reminders each have their own switch, because each has a consequence
 * the user should agree to separately rather than inherit from having set up
 * a database.
 *
 * The screen's other job is to fail loudly in the one place this is easy to get
 * wrong: the Content Security Policy names the Worker's origin at build time,
 * so a URL typed here that the build did not know about is blocked by the
 * browser before any of our code runs. Without the check below, that surfaces
 * as a bare "Failed to fetch" with nothing to act on.
 */
import * as React from 'react';
import { toast } from 'sonner';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Switch,
} from '@/components/ui';
import {
  CheckCircleIcon,
  CloudIcon,
  HideIcon,
  ReminderIcon,
  ShieldIcon,
  ShowIcon,
  SpinnerIcon,
  WarningIcon,
} from '@/components/icons';
import { useDashboardData } from '@/hooks/useData';
import { upcomingDues } from '@/lib/finance/dashboard';
import {
  allowedWorkerOrigin,
  clearWorkerConfig,
  loadWorkerConfig,
  normaliseUrl,
  saveWorkerConfig,
  workerCall,
  workerOrigin,
  type WorkerConfig,
} from '@/lib/server/config';
import {
  currentSubscription,
  disableReminders,
  dueDates,
  enableReminders,
  permissionState,
  sendTestReminder,
  syncSchedule,
} from '@/lib/push';

type Health = { ok: boolean; ai: boolean; push: boolean } | null;

export function ServerCard() {
  const data = useDashboardData();

  const [config, setConfig] = React.useState<WorkerConfig | null>(null);
  const [url, setUrl] = React.useState('');
  const [token, setToken] = React.useState('');
  const [showToken, setShowToken] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [health, setHealth] = React.useState<Health>(null);
  const [subscribed, setSubscribed] = React.useState(false);

  React.useEffect(() => {
    void (async () => {
      const loaded = await loadWorkerConfig();
      if (loaded) {
        setConfig(loaded);
        setUrl(loaded.url);
        setToken(loaded.token);
      }
      setSubscribed(Boolean(await currentSubscription()));
    })();
  }, []);

  /*
    The dates — and only the dates — that would be uploaded. Computed here so
    the card can show the user the exact count before they agree to anything,
    rather than asking them to trust a sentence about it.
  */
  const dates = React.useMemo(
    () => (data.isLoading ? [] : dueDates(upcomingDues({ ...data, days: 90 }))),
    [data],
  );

  const allowed = allowedWorkerOrigin();
  const typedOrigin = url.trim() ? workerOrigin(url) : null;
  const originBlocked = Boolean(typedOrigin) && typedOrigin !== allowed;

  async function save() {
    const trimmed = normaliseUrl(url);
    if (!trimmed || !token.trim()) {
      toast.error('Both the URL and the token are needed.');
      return;
    }
    if (!workerOrigin(trimmed)) {
      toast.error('That does not look like a URL.');
      return;
    }

    const next: WorkerConfig = {
      url: trimmed,
      token: token.trim(),
      ocrEnabled: config?.ocrEnabled ?? false,
      remindersEnabled: config?.remindersEnabled ?? false,
      leadDays: config?.leadDays ?? 3,
    };
    await saveWorkerConfig(next);
    setConfig(next);
    toast.success('Saved. Nothing is switched on yet.');
  }

  async function check() {
    setBusy('check');
    setHealth(null);
    try {
      const response = await fetch(`${normaliseUrl(url)}/health`);
      if (!response.ok) throw new Error(`The Worker returned ${response.status}.`);
      setHealth((await response.json()) as Health);
      toast.success('The Worker answered.');
    } catch (e) {
      toast.error(
        originBlocked
          ? 'Blocked by this build’s Content Security Policy — see the note above.'
          : e instanceof Error
            ? e.message
            : 'Could not reach the Worker.',
      );
    } finally {
      setBusy(null);
    }
  }

  async function update(patch: Partial<WorkerConfig>) {
    if (!config) return;
    const next = { ...config, ...patch };
    await saveWorkerConfig(next);
    setConfig(next);
  }

  async function toggleReminders(on: boolean) {
    const call = await workerCall();
    if (!call) return;

    setBusy('reminders');
    try {
      if (on) {
        const result = await enableReminders(call, dates, config?.leadDays ?? 3);
        setSubscribed(true);
        await update({ remindersEnabled: true });
        toast.success(
          result.dates === 0
            ? 'Reminders on. Nothing is due in the next 90 days, so nothing was uploaded.'
            : `Reminders on. ${result.dates} date${result.dates === 1 ? '' : 's'} uploaded — dates only.`,
        );
      } else {
        await disableReminders(call);
        setSubscribed(false);
        await update({ remindersEnabled: false });
        toast.success('Reminders off, and the schedule was deleted from the server.');
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'That did not work.');
    } finally {
      setBusy(null);
    }
  }

  async function resend() {
    const call = await workerCall();
    if (!call) return;
    setBusy('resend');
    try {
      await syncSchedule(call, dates, config?.leadDays ?? 3);
      toast.success(`Schedule updated — ${dates.length} date${dates.length === 1 ? '' : 's'}.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not update the schedule.');
    } finally {
      setBusy(null);
    }
  }

  async function test() {
    const call = await workerCall();
    if (!call) return;
    setBusy('test');
    try {
      await sendTestReminder(call);
      toast.success('Sent. It should arrive in a moment.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'The test push failed.');
    } finally {
      setBusy(null);
    }
  }

  async function forget() {
    await disableReminders(await workerCall());
    await clearWorkerConfig();
    setConfig(null);
    setUrl('');
    setToken('');
    setHealth(null);
    setSubscribed(false);
    toast.success('Server settings cleared.');
  }

  const permission = permissionState();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <CloudIcon className="h-4 w-4" />
          Your server
          {config && <Badge variant="outline">Configured</Badge>}
        </CardTitle>
        <CardDescription>
          A Cloudflare Worker you deploy yourself, on their free plan, with no card. Your records
          live on it, so PaisaTrack needs it to show anything at all. Two extras sit on top and are
          separately optional: reading a scan the on-device engine cannot manage, and reminding you
          about a payment while the app is closed.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        <Field
          label="Worker URL"
          htmlFor="worker-url"
          hint="From `wrangler deploy`. See worker/README.md."
        >
          <Input
            id="worker-url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://paisatrack.your-name.workers.dev"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>

        {/*
          The single most likely setup failure, and completely opaque without
          this: the browser refuses the request before it is made, so the
          Worker's own logs show nothing at all.
        */}
        {originBlocked && (
          <p className="flex items-start gap-2 rounded-md border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/5 p-3 text-xs text-[var(--color-warning)]">
            <ShieldIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" weight="fill" />
            <span>
              This build only permits{' '}
              <code className="font-mono">{allowed ?? 'no server at all'}</code>, so the browser will
              block requests to <code className="font-mono">{typedOrigin}</code> before they are sent.
              The origin is compiled into the Content Security Policy — rebuild and redeploy with{' '}
              <code className="font-mono">VITE_WORKER_ORIGIN={typedOrigin}</code> to allow it.
            </span>
          </p>
        )}

        <Field
          label="Shared token"
          htmlFor="worker-token"
          hint="Matches the Worker’s API_TOKEN secret. It stops a stranger who finds the URL spending your free quota — it is not protecting data, because the Worker stores none."
        >
          <div className="flex gap-2">
            <Input
              id="worker-token"
              type={showToken ? 'text' : 'password'}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
            <Button
              variant="outline"
              size="icon"
              type="button"
              onClick={() => setShowToken((v) => !v)}
              aria-label={showToken ? 'Hide token' : 'Show token'}
            >
              {showToken ? <HideIcon className="h-4 w-4" /> : <ShowIcon className="h-4 w-4" />}
            </Button>
          </div>
        </Field>

        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void save()} size="sm">
            Save
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void check()}
            disabled={!url.trim() || busy === 'check'}
          >
            {busy === 'check' ? <SpinnerIcon className="h-4 w-4 animate-spin" /> : 'Test connection'}
          </Button>
          {config && (
            <Button variant="ghost" size="sm" onClick={() => void forget()}>
              Forget
            </Button>
          )}
        </div>

        {health && (
          <p className="flex items-center gap-2 text-xs text-[var(--color-muted-foreground)]">
            <CheckCircleIcon className="h-3.5 w-3.5 text-[var(--color-success)]" weight="fill" />
            Reachable · AI binding {health.ai ? 'present' : 'MISSING'} · push key{' '}
            {health.push ? 'set' : 'NOT SET'}
          </p>
        )}

        {config && (
          <div className="space-y-4 border-t border-[var(--color-border)] pt-4">
            <label className="flex items-start justify-between gap-3 text-sm">
              <span>
                Offer server OCR for scans
                <span className="block text-xs text-[var(--color-muted-foreground)]">
                  Adds a button on the import screen, next to the on-device one. Pressing it{' '}
                  <strong>uploads that statement</strong> to your Worker, which sends it to
                  Cloudflare’s vision model and keeps nothing. Nothing is uploaded unless you press
                  it, each time, for each file.
                </span>
              </span>
              <Switch
                checked={config.ocrEnabled}
                onCheckedChange={(v) => void update({ ocrEnabled: v })}
                aria-label="Offer server OCR for scans"
              />
            </label>

            <label className="flex items-start justify-between gap-3 text-sm">
              <span>
                Remind me about due payments
                <span className="block text-xs text-[var(--color-muted-foreground)]">
                  Uploads <strong>only the dates</strong> something falls due — no amounts, no
                  payees, no account names. The notification itself carries nothing either; it says a
                  payment is due and the app fills in which one after you tap.{' '}
                  {dates.length > 0
                    ? `${dates.length} date${dates.length === 1 ? '' : 's'} would be sent.`
                    : 'Nothing is due in the next 90 days.'}
                </span>
              </span>
              <Switch
                checked={config.remindersEnabled && subscribed}
                onCheckedChange={(v) => void toggleReminders(v)}
                disabled={busy === 'reminders' || permission === 'unsupported'}
                aria-label="Remind me about due payments"
              />
            </label>

            {permission === 'unsupported' && (
              <p className="flex items-start gap-2 text-xs text-[var(--color-muted-foreground)]">
                <WarningIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                This browser has no push support. On an iPhone, notifications only work once
                PaisaTrack is added to the Home Screen.
              </p>
            )}

            {config.remindersEnabled && subscribed && (
              <>
                <Field
                  label="Warn me this many days ahead"
                  htmlFor="worker-lead"
                  hint="Re-upload the schedule after changing it."
                >
                  <Input
                    id="worker-lead"
                    type="number"
                    min={0}
                    max={14}
                    value={config.leadDays}
                    onChange={(e) =>
                      void update({ leadDays: Math.max(0, Math.min(14, Number(e.target.value) || 0)) })
                    }
                    className="w-24"
                  />
                </Field>

                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void resend()}
                    disabled={busy === 'resend'}
                  >
                    <ReminderIcon className="mr-1.5 h-4 w-4" />
                    Update schedule
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void test()}
                    disabled={busy === 'test'}
                  >
                    Send a test notification
                  </Button>
                </div>
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
