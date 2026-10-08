/**
 * Reminders for money that is about to leave your account.
 *
 * This is the one job in PaisaTrack that genuinely cannot be done on the
 * device. The app knows a card payment is due on the 18th, but a closed tab
 * cannot tell you so — and the whole point of knowing is being told before it
 * is too late to act, not after you next happen to open the app.
 *
 * ## What the server learns, exactly
 *
 * A list of **dates**. Nothing else.
 *
 * Not the amount, not the card, not the payee, not which of them it is. The
 * push itself carries no payload at all — a bodiless push is a legal push, it
 * wakes the service worker, and the service worker shows a generic line. When
 * the user taps it, the app opens and reads the real detail out of the local
 * database.
 *
 * This is why there is no encryption code here. A payload would have to be
 * encrypted by the sender, and to encrypt it the Worker would first have to
 * hold it. Sending nothing is both simpler and strictly more private than
 * sending something encrypted, because the cleartext never exists off-device
 * in the first place.
 *
 * So Cloudflare can learn that this device has *something* due on the 18th.
 * It cannot learn that it is ₹24,500 to an HDFC card.
 */
import type { UpcomingDue } from '@/lib/finance/dashboard';
import { postToWorker, type WorkerCall } from '@/lib/server/config';

/** How far ahead to tell the server about. Longer costs nothing and survives a device going quiet. */
const HORIZON_DAYS = 90;

export function pushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

export function permissionState(): NotificationPermission | 'unsupported' {
  if (!pushSupported()) return 'unsupported';
  return Notification.permission;
}

/**
 * The dates something is due, de-duplicated and sorted.
 *
 * Pure, and the only thing that ever gets uploaded — which is why it returns
 * strings rather than the `UpcomingDue` objects it was given. Everything
 * identifying lives in those objects and none of it crosses this boundary.
 */
export function dueDates(dues: UpcomingDue[]): string[] {
  const seen = new Set<string>();
  for (const due of dues) {
    // An overdue payment is not a reminder, it is a fact the user already has
    // on the dashboard. Notifying about it would be nagging about the past.
    if (!due.isOverdue && due.daysUntil <= HORIZON_DAYS) seen.add(due.dueDate);
  }
  return [...seen].sort();
}

/** base64url → bytes, for `applicationServerKey`, which will not accept the string. */
function decodeKey(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
  // Backed by a plain ArrayBuffer explicitly: `applicationServerKey` wants a
  // BufferSource, and the default Uint8Array type is widened to allow
  // SharedArrayBuffer, which is not one.
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function registration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration();
  if (existing) return existing;
  // `ready` resolves only once a worker is active, which it will be on any
  // normal load — but not on the very first visit before install completes.
  return navigator.serviceWorker.ready;
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const registered = await navigator.serviceWorker.getRegistration();
  return (await registered?.pushManager.getSubscription()) ?? null;
}

/**
 * The Worker's public VAPID key.
 *
 * Fetched rather than compiled in: the key belongs to whichever Worker this
 * user deployed, and baking one into the bundle would mean a fork could never
 * use its own. It is public by definition, so it needs no token.
 */
async function serverKey(call: WorkerCall): Promise<string> {
  const response = await fetch(`${call.url}/push/key`);
  if (!response.ok) throw new Error('The server did not return a push key. Is the Worker deployed?');
  const { key } = (await response.json()) as { key: string | null };
  if (!key) {
    throw new Error(
      'The Worker has no VAPID key set. Run `node scripts/gen-vapid.mjs` and set both secrets.',
    );
  }
  return key;
}

export interface EnableResult {
  endpoint: string;
  dates: number;
}

/**
 * Turn reminders on: permission, subscription, schedule.
 *
 * Permission is requested here rather than on page load on purpose — a
 * notification prompt that appears before the user has asked for notifications
 * is the fastest way to get permanently denied.
 */
export async function enableReminders(
  call: WorkerCall,
  dates: string[],
  leadDays: number,
): Promise<EnableResult> {
  if (!pushSupported()) {
    throw new Error('This browser cannot do push notifications.');
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error(
      permission === 'denied'
        ? 'Notifications are blocked for this site. Allow them in the browser’s site settings, then try again.'
        : 'Notification permission was not granted.',
    );
  }

  const registered = await registration();
  const existing = await registered.pushManager.getSubscription();
  const subscription =
    existing ??
    (await registered.pushManager.subscribe({
      // Required by every browser: a push that any server could trigger would
      // be a spam channel.
      userVisibleOnly: true,
      applicationServerKey: decodeKey(await serverKey(call)),
    }));

  await postToWorker(call, '/push/subscribe', {
    endpoint: subscription.endpoint,
    dates,
    leadDays,
  });

  return { endpoint: subscription.endpoint, dates: dates.length };
}

/** Re-upload the schedule. Cheap, and the dates move as bills are paid. */
export async function syncSchedule(
  call: WorkerCall,
  dates: string[],
  leadDays: number,
): Promise<boolean> {
  const subscription = await currentSubscription();
  if (!subscription) return false;
  await postToWorker(call, '/push/subscribe', {
    endpoint: subscription.endpoint,
    dates,
    leadDays,
  });
  return true;
}

/**
 * Turn reminders off, at both ends.
 *
 * The local unsubscribe happens even if the server call fails: a user who has
 * asked to stop being notified should stop being notified, and a Worker that
 * is unreachable would otherwise hold them hostage. The orphaned record on the
 * server expires on its own, and the first failed push deletes it.
 */
export async function disableReminders(call: WorkerCall | null): Promise<void> {
  const subscription = await currentSubscription();
  if (!subscription) return;

  if (call) {
    try {
      await postToWorker(call, '/push/unsubscribe', { endpoint: subscription.endpoint });
    } catch {
      // Deliberately swallowed — see above.
    }
  }

  await subscription.unsubscribe();
}

/** Fire one push now, so setup can be verified without waiting for a due date. */
export async function sendTestReminder(call: WorkerCall): Promise<void> {
  const subscription = await currentSubscription();
  if (!subscription) throw new Error('Reminders are not switched on for this device.');

  const result = await postToWorker<{ ok: boolean; status: number }>(call, '/push/test', {
    endpoint: subscription.endpoint,
  });

  if (!result.ok) {
    throw new Error(
      `The push service rejected it (HTTP ${result.status}). If that is 403, the Worker’s VAPID keys do not match the ones this device subscribed with.`,
    );
  }
}
