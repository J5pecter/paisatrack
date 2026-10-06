/**
 * Page chrome: the small affordances that are invisible until they are missing.
 */
import * as React from 'react';
import { toast } from 'sonner';
import { ArrowUpIcon, CheckIcon, DuplicateIcon } from '@/components/icons';
import { useScrollProgress, useScrolledPast } from '@/hooks/usePerf';
import { cn } from '@/lib/utils';

/**
 * Skip link.
 *
 * Visually hidden until focused, then the first thing a keyboard or screen
 * reader user reaches. Without it, every page starts with ten navigation links
 * that have to be tabbed past before reaching the content.
 */
export function SkipToContent() {
  return (
    <a
      href="#main-content"
      className={cn(
        'sr-only focus:not-sr-only',
        'focus:fixed focus:left-3 focus:top-3 focus:z-[100]',
        'focus:rounded-md focus:bg-[var(--color-primary)] focus:px-4 focus:py-2',
        'focus:text-sm focus:font-medium focus:text-[var(--color-primary-foreground)]',
        'focus:outline-none focus:ring-2 focus:ring-[var(--color-ring)] focus:ring-offset-2',
      )}
    >
      Skip to content
    </a>
  );
}

/**
 * Reading progress for the page.
 *
 * Earns its place on Reports and the longer card pages, which run to several
 * screens. Hidden when there is nothing to scroll, so it never sits at 0% on a
 * short page pretending to be useful.
 */
export function ScrollProgress() {
  const progress = useScrollProgress();
  if (progress <= 0) return null;

  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-0 z-50 h-0.5"
      role="presentation"
      aria-hidden
    >
      <div
        className="h-full bg-[var(--color-primary)] transition-[width] duration-150"
        style={{ width: `${progress}%` }}
      />
    </div>
  );
}

/** Back to top, once there is enough page to be lost in. */
export function BackToTop() {
  const show = useScrolledPast(600);

  return (
    <button
      type="button"
      onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
      aria-label="Back to top"
      className={cn(
        'fixed bottom-20 right-4 z-40 md:bottom-6',
        'rounded-full border border-[var(--color-border)] bg-[var(--color-card)] p-2.5 shadow-lg',
        'transition-all duration-200 hover:bg-[var(--color-accent)]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]',
        show ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-2 opacity-0',
      )}
    >
      <ArrowUpIcon className="h-4 w-4" weight="bold" />
    </button>
  );
}

/**
 * Copy to clipboard, with the state change on the button itself.
 *
 * A toast alone is easy to miss; the tick is the confirmation. Falls back to a
 * hidden textarea where the Clipboard API is unavailable — which, on a page
 * served over plain HTTP during local development, it is.
 */
export function CopyButton({
  value,
  label = 'Copy',
  className,
}: {
  value: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  async function copy() {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        const ta = document.createElement('textarea');
        ta.value = value;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1800);
    } catch {
      toast.error('Could not copy — your browser blocked clipboard access.');
    }
  }

  return (
    <button
      type="button"
      onClick={() => void copy()}
      aria-label={copied ? 'Copied' : label}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)]',
        'px-2 py-1 text-xs transition-colors hover:bg-[var(--color-accent)]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]',
        copied && 'border-[var(--color-success)]/50 text-[var(--color-success)]',
        className,
      )}
    >
      {copied ? (
        <CheckIcon className="h-3.5 w-3.5" weight="bold" />
      ) : (
        <DuplicateIcon className="h-3.5 w-3.5" />
      )}
      {copied ? 'Copied' : label}
    </button>
  );
}

/**
 * When the data on screen was last updated.
 *
 * Stated because a finance figure with no timestamp invites the reader to
 * assume it is live, and here it is only as fresh as the last sync.
 */
export function LastUpdated({ at, className }: { at?: string | null; className?: string }) {
  if (!at) return null;

  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return null;

  return (
    <p className={cn('text-xs text-[var(--color-muted-foreground)]', className)}>
      Last updated{' '}
      <time dateTime={date.toISOString()} title={date.toLocaleString('en-IN')}>
        {date.toLocaleString('en-IN', {
          day: 'numeric',
          month: 'short',
          hour: '2-digit',
          minute: '2-digit',
        })}
      </time>
    </p>
  );
}

/** A disclosure. Used for the help page; collapsed by default. */
export function Expandable({
  question,
  children,
  defaultOpen = false,
}: {
  question: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details
      className="group border-b border-[var(--color-border)] last:border-0"
      open={defaultOpen}
    >
      <summary
        className={cn(
          'flex cursor-pointer list-none items-center justify-between gap-3 py-3.5',
          'text-sm font-medium focus-visible:outline-none',
          'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:ring-offset-2',
        )}
      >
        {question}
        <span
          className="shrink-0 text-[var(--color-muted-foreground)] transition-transform group-open:rotate-45"
          aria-hidden
        >
          +
        </span>
      </summary>
      <div className="pb-4 text-sm leading-relaxed text-[var(--color-muted-foreground)]">
        {children}
      </div>
    </details>
  );
}
