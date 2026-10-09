/**
 * Add to home screen.
 *
 * A PWA is only useful once it is actually installed, and almost nobody
 * discovers "Install app" buried in a browser menu. This surfaces it.
 *
 * Two platforms, two entirely different mechanisms:
 *
 * - **Chrome, Edge, Samsung Internet** fire `beforeinstallprompt`. Capturing it
 *   and calling `prompt()` later shows the real OS install dialog.
 * - **iOS Safari never fires it.** There is no API at all — the only route is
 *   Share → Add to Home Screen, done by hand. So iOS gets instructions rather
 *   than a button, because a button that cannot do anything is worse than no
 *   button.
 *
 * The event fires early, often before React has mounted, so it is captured at
 * module scope. Registering the listener inside a component would miss it.
 */
import * as React from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { Button } from '@/components/ui';
import { CheckCircleIcon, CloseIcon, MobileIcon, ShareIcon } from '@/components/icons';
import { cn } from '@/lib/utils';

/** Not in TypeScript's DOM lib — it is a Chromium extension to the spec. */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferredPrompt: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const fn of listeners) fn();
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    // Without preventDefault, Chrome shows its own mini-infobar and the event
    // cannot be replayed later from a button of our own.
    e.preventDefault();
    deferredPrompt = e as BeforeInstallPromptEvent;
    notify();
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    notify();
  });
}

/** Is the app already running from the home screen rather than a browser tab? */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    // iOS Safari's own flag, which predates the standard media query.
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/**
 * iOS, including iPadOS.
 *
 * iPadOS 13+ reports a Macintosh user agent, so the touch-point count is what
 * separates an iPad from a desktop Mac — a Mac reports 0.
 */
function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  return /iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
}

export type InstallState = 'INSTALLED' | 'PROMPTABLE' | 'IOS_MANUAL' | 'UNAVAILABLE';

export function useInstallState(): InstallState {
  const hasPrompt = React.useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => deferredPrompt !== null,
    () => false,
  );

  // Read once per render rather than caching: a user can install mid-session,
  // and the media query flips without a reload.
  if (isStandalone()) return 'INSTALLED';
  if (hasPrompt) return 'PROMPTABLE';
  if (isIOS()) return 'IOS_MANUAL';
  return 'UNAVAILABLE';
}

/** Fire the real install dialog. Resolves to whether the user accepted. */
export async function promptInstall(): Promise<boolean> {
  if (!deferredPrompt) return false;
  await deferredPrompt.prompt();
  const { outcome } = await deferredPrompt.userChoice;
  // The event is single-use: Chrome will not let the same one be replayed.
  deferredPrompt = null;
  notify();
  return outcome === 'accepted';
}

/* ------------------------------------------------------------------ *
 * Dismissal
 * ------------------------------------------------------------------ */

interface InstallNagState {
  dismissed: boolean;
  dismiss: () => void;
}

/**
 * Whether the banner has been waved away.
 *
 * Persisted, because asking again on every visit is how a prompt becomes an
 * advert. The Settings entry stays available regardless, so dismissing the
 * banner hides the nagging and not the feature.
 */
const useInstallNag = create<InstallNagState>()(
  persist(
    (set) => ({
      dismissed: false,
      dismiss: () => set({ dismissed: true }),
    }),
    { name: 'paisatrack-install-nag' },
  ),
);

/* ------------------------------------------------------------------ *
 * Surfaces
 * ------------------------------------------------------------------ */

/** The Share → Add to Home Screen walkthrough, for iOS. */
function IOSSteps() {
  return (
    <ol className="space-y-1.5 text-xs text-[var(--color-muted-foreground)]">
      <li className="flex items-start gap-2">
        <span aria-hidden>1.</span>
        <span>
          Tap <ShareIcon className="inline h-3.5 w-3.5 align-text-bottom" weight="bold" />{' '}
          <strong className="text-[var(--color-foreground)]">Share</strong> in Safari&rsquo;s
          toolbar.
        </span>
      </li>
      <li className="flex items-start gap-2">
        <span aria-hidden>2.</span>
        <span>
          Scroll down and choose{' '}
          <strong className="text-[var(--color-foreground)]">Add to Home Screen</strong>.
        </span>
      </li>
      <li className="flex items-start gap-2">
        <span aria-hidden>3.</span>
        <span>
          Tap <strong className="text-[var(--color-foreground)]">Add</strong>. PaisaTrack opens
          full-screen from then on.
        </span>
      </li>
    </ol>
  );
}

/**
 * A one-time banner, mobile only.
 *
 * Deliberately not shown on desktop: "add to home screen" is a phone idea, and
 * a desktop user who wants the install can find it in Settings.
 */
export function InstallBanner() {
  const state = useInstallState();
  const { dismissed, dismiss } = useInstallNag();
  const [expanded, setExpanded] = React.useState(false);

  if (dismissed || state === 'INSTALLED' || state === 'UNAVAILABLE') return null;

  return (
    <div
      className="mb-4 rounded-xl border border-[var(--color-primary)]/30 bg-[var(--color-primary)]/5 p-3 md:hidden"
      role="complementary"
      aria-label="Install PaisaTrack"
    >
      <div className="flex items-start gap-3">
        <MobileIcon
          className="mt-0.5 h-5 w-5 shrink-0 text-[var(--color-primary)]"
          weight="duotone"
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Keep PaisaTrack on your home screen</p>
          <p className="mt-0.5 text-xs text-[var(--color-muted-foreground)]">
            Opens full-screen, launches like an app, no app store.
          </p>

          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            {state === 'PROMPTABLE' ? (
              <Button size="sm" className="tap" onClick={() => void promptInstall()}>
                Add to home screen
              </Button>
            ) : (
              <Button size="sm" variant="outline" className="tap" onClick={() => setExpanded((v) => !v)}>
                {expanded ? 'Hide steps' : 'Show me how'}
              </Button>
            )}
            <Button size="sm" variant="ghost" className="tap" onClick={dismiss}>
              Not now
            </Button>
          </div>

          {state === 'IOS_MANUAL' && expanded && (
            <div className="mt-3 border-t border-[var(--color-border)] pt-3">
              <IOSSteps />
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss install prompt"
          className="tap flex shrink-0 items-center justify-center rounded-md p-1 text-[var(--color-muted-foreground)] transition-colors hover:bg-[var(--color-accent)] hover:text-[var(--color-foreground)]"
        >
          <CloseIcon className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

/**
 * The permanent entry, for Settings.
 *
 * Unlike the banner this never hides itself — someone who dismissed the banner
 * months ago should still be able to find the feature.
 */
export function InstallCard({ className }: { className?: string }) {
  const state = useInstallState();

  if (state === 'INSTALLED') {
    return (
      <div
        className={cn(
          'flex items-start gap-2 rounded-md border border-[var(--color-success)]/40 bg-[var(--color-success)]/10 p-3 text-xs',
          className,
        )}
      >
        <CheckCircleIcon
          className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-success)]"
          weight="fill"
        />
        <p>
          Installed. PaisaTrack is running from your home screen — it opens full-screen and works
          with the network off.
        </p>
      </div>
    );
  }

  return (
    <div className={cn('rounded-md border border-[var(--color-border)] p-3', className)}>
      <div className="flex items-start gap-2">
        <MobileIcon className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-primary)]" weight="duotone" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Install on this device</p>
          <p className="mt-0.5 text-xs text-[var(--color-muted-foreground)]">
            Adds PaisaTrack to your home screen, so it opens full-screen without browser chrome.
            Nothing is downloaded from an app store. It still needs a connection — your records live
            on your server, not on the phone.
          </p>

          {state === 'PROMPTABLE' && (
            <Button size="sm" className="tap mt-2.5" onClick={() => void promptInstall()}>
              Add to home screen
            </Button>
          )}

          {state === 'IOS_MANUAL' && (
            <div className="mt-2.5">
              <IOSSteps />
            </div>
          )}

          {state === 'UNAVAILABLE' && (
            <p className="mt-2.5 text-xs text-[var(--color-muted-foreground)]">
              This browser has not offered an install. Chrome, Edge and Safari on a phone all
              support it — look for <strong>Install</strong> or{' '}
              <strong>Add to Home Screen</strong> in the browser menu.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
