/**
 * Ctrl/Cmd+K command palette: jump to any page, add an expense, search
 * transactions by description or amount.
 */
import * as React from 'react';
import { Command } from 'cmdk';
import { useNavigate } from '@tanstack/react-router';
import { MoonIcon, PlusIcon, ReceiptIcon, SearchIcon } from '@/components/icons';
import type { PhosphorIcon } from '@/components/icons';
import { Dialog, DialogContent } from '@/components/ui';
import { NAV_ITEMS } from '@/components/layout/nav';
import { useExpenses } from '@/hooks/useData';
import { useUI } from '@/stores/ui';
import { formatINR } from '@/lib/finance/money';
import { formatDateShort } from '@/lib/finance/dates';
import { humanise } from '@/lib/utils';

export function CommandPalette() {
  const { commandOpen, setCommandOpen, setQuickAddOpen, toggleTheme } = useUI();
  const navigate = useNavigate();
  const expenses = useExpenses();
  const [query, setQuery] = React.useState('');

  React.useEffect(() => {
    if (!commandOpen) setQuery('');
  }, [commandOpen]);

  const matches = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    return expenses
      .filter(
        (e) =>
          e.description.toLowerCase().includes(q) ||
          humanise(e.category).toLowerCase().includes(q) ||
          String(Math.round(e.amount / 100)).includes(q),
      )
      .slice(0, 8);
  }, [expenses, query]);

  const run = (fn: () => void) => {
    setCommandOpen(false);
    // Let the dialog close before navigating, so focus lands correctly.
    setTimeout(fn, 0);
  };

  return (
    <Dialog open={commandOpen} onOpenChange={setCommandOpen}>
      <DialogContent hideClose className="max-w-xl p-0">
        <Command label="Command palette" shouldFilter={false} className="overflow-hidden">
          <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-3">
            <SearchIcon className="h-4 w-4 shrink-0 text-[var(--color-muted-foreground)]" weight="bold" />
            <Command.Input
              autoFocus
              value={query}
              onValueChange={setQuery}
              placeholder="Search expenses, or jump to a page…"
              className="h-12 w-full bg-transparent text-sm outline-none placeholder:text-[var(--color-muted-foreground)]"
            />
          </div>

          <Command.List className="max-h-80 overflow-y-auto p-2">
            <Command.Empty className="py-8 text-center text-sm text-[var(--color-muted-foreground)]">
              Nothing matched “{query}”.
            </Command.Empty>

            <Command.Group
              heading="Actions"
              className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-[var(--color-muted-foreground)]"
            >
              <Item onSelect={() => run(() => setQuickAddOpen(true))} icon={PlusIcon}>
                Add expense
                <Kbd>N</Kbd>
              </Item>
              <Item onSelect={() => run(toggleTheme)} icon={MoonIcon}>
                Toggle theme
              </Item>
            </Command.Group>

            <Command.Group
              heading="Go to"
              className="mt-1 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-[var(--color-muted-foreground)]"
            >
              {NAV_ITEMS.filter(
                (i) => !query || i.label.toLowerCase().includes(query.toLowerCase()),
              ).map((item) => (
                <Item
                  key={item.to}
                  onSelect={() => run(() => void navigate({ to: item.to }))}
                  icon={item.icon}
                >
                  {item.label}
                </Item>
              ))}
            </Command.Group>

            {matches.length > 0 && (
              <Command.Group
                heading="Expenses"
                className="mt-1 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-[var(--color-muted-foreground)]"
              >
                {matches.map((e) => (
                  <Item
                    key={e.id}
                    onSelect={() => run(() => void navigate({ to: '/expenses' }))}
                    icon={ReceiptIcon}
                  >
                    <span className="flex-1 truncate">{e.description}</span>
                    <span className="tnum text-xs text-[var(--color-muted-foreground)]">
                      {formatDateShort(e.date)}
                    </span>
                    <span className="tnum text-xs font-medium">{formatINR(e.amount)}</span>
                  </Item>
                ))}
              </Command.Group>
            )}
          </Command.List>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

function Item({
  children,
  onSelect,
  icon: Icon,
}: {
  children: React.ReactNode;
  onSelect: () => void;
  icon?: PhosphorIcon;
}) {
  return (
    <Command.Item
      onSelect={onSelect}
      className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-2 text-sm data-[selected=true]:bg-[var(--color-accent)]"
    >
      {Icon && <Icon className="h-4 w-4 shrink-0 text-[var(--color-muted-foreground)]" />}
      {children}
    </Command.Item>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="ml-auto rounded border border-[var(--color-border)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-muted-foreground)]">
      {children}
    </kbd>
  );
}

/**
 * Global shortcuts. Ignored while typing in a field, so N does not hijack a
 * description you are halfway through writing.
 */
export function useGlobalShortcuts() {
  const { setCommandOpen, setQuickAddOpen, commandOpen, quickAddOpen } = useUI();

  React.useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable === true;

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCommandOpen(!commandOpen);
        return;
      }

      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key.toLowerCase() === 'n' && !quickAddOpen) {
        e.preventDefault();
        setQuickAddOpen(true);
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [commandOpen, quickAddOpen, setCommandOpen, setQuickAddOpen]);
}
