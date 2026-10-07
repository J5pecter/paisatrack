/**
 * App shell: sidebar on desktop, bottom tab bar on mobile.
 */
import * as React from 'react';
import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import {
  MenuIcon,
  MoonIcon,
  PlusIcon,
  SearchIcon,
  SunIcon,
} from '@/components/icons';
import { NAV_ITEMS, type NavItem } from './nav';
import { BackToTop, ScrollProgress, SkipToContent } from '@/components/Chrome';
import { CommandPalette } from '@/components/CommandPalette';
import { QuickAdd } from '@/components/QuickAdd';
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  TooltipProvider,
} from '@/components/ui';
import { SyncIndicator } from './SyncIndicator';
import { useUI } from '@/stores/ui';
import { cn } from '@/lib/utils';

export { NAV_ITEMS } from './nav';
export type { NavItem } from './nav';

export function AppShell() {
  const { theme, toggleTheme, setCommandOpen, setQuickAddOpen, sidebarCollapsed, toggleSidebar } =
    useUI();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  const mobileItems = NAV_ITEMS.filter((i) => i.primary);
  const moreItems = NAV_ITEMS.filter((i) => !i.primary);

  const [moreOpen, setMoreOpen] = React.useState(false);
  const moreIsActive = moreItems.some((i) => isActive(pathname, i.to));

  // A tab-bar sheet that outlives the navigation it triggered would cover the
  // page the user just asked for.
  React.useEffect(() => {
    setMoreOpen(false);
  }, [pathname]);

  return (
    <TooltipProvider delayDuration={300}>
      <SkipToContent />
      <ScrollProgress />

      <div className="flex min-h-dvh bg-[var(--color-background)] text-[var(--color-foreground)]">
        {/* Desktop sidebar */}
        <aside
          className={cn(
            'hidden shrink-0 border-r border-[var(--color-border)] bg-[var(--color-card)] md:flex md:flex-col',
            sidebarCollapsed ? 'md:w-16' : 'md:w-56',
            'transition-[width] duration-200',
          )}
        >
          <div className="flex h-14 items-center gap-2 border-b border-[var(--color-border)] px-3">
            <button
              onClick={toggleSidebar}
              className="rounded-md p-1.5 hover:bg-[var(--color-accent)]"
              aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            >
              <MenuIcon className="h-4 w-4" weight="bold" />
            </button>
            {!sidebarCollapsed && (
              <span className="text-sm font-semibold tracking-tight">PaisaTrack</span>
            )}
          </div>

          <nav className="flex-1 space-y-0.5 overflow-y-auto p-2" aria-label="Main">
            {NAV_ITEMS.map((item) => (
              <NavLink key={item.to} item={item} active={isActive(pathname, item.to)} collapsed={sidebarCollapsed} />
            ))}
          </nav>

          <div className="border-t border-[var(--color-border)] p-2">
            <button
              onClick={toggleTheme}
              className={cn(
                'flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm hover:bg-[var(--color-accent)]',
                sidebarCollapsed && 'justify-center px-0',
              )}
              aria-label="Toggle theme"
            >
              {theme === 'dark' ? <MoonIcon className="h-4 w-4" weight="fill" /> : <SunIcon className="h-4 w-4" weight="fill" />}
              {!sidebarCollapsed && <span>{theme === 'dark' ? 'Dark' : 'Light'}</span>}
            </button>
          </div>
        </aside>

        {/* Main column */}
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-background)]/90 px-3 backdrop-blur sm:px-4">
            <span className="text-sm font-semibold tracking-tight md:hidden">PaisaTrack</span>

            <button
              onClick={() => setCommandOpen(true)}
              className="tap ml-auto flex items-center justify-center gap-2 rounded-md border border-[var(--color-border)] px-2.5 py-1.5 text-xs text-[var(--color-muted-foreground)] hover:bg-[var(--color-accent)] sm:min-w-56"
              aria-label="Open command palette"
            >
              <SearchIcon className="h-3.5 w-3.5" weight="bold" />
              <span className="hidden sm:inline">Search or jump to…</span>
              <kbd className="ml-auto hidden rounded border border-[var(--color-border)] px-1.5 py-0.5 font-mono text-[10px] sm:inline">
                Ctrl K
              </kbd>
            </button>

            <SyncIndicator />

            {/*
              The label is hidden below sm:, so without aria-label this button
              is an unnamed icon to a screen reader. The name starts with the
              visible word so voice control ("click Add") still matches it.
            */}
            <Button
              size="sm"
              onClick={() => setQuickAddOpen(true)}
              className="tap gap-1.5"
              aria-label="Add a record"
            >
              <PlusIcon className="h-4 w-4" weight="bold" />
              <span className="hidden sm:inline">Add</span>
            </Button>

            <button
              onClick={toggleTheme}
              className="tap flex items-center justify-center rounded-md p-2 hover:bg-[var(--color-accent)] md:hidden"
              aria-label="Toggle theme"
            >
              {theme === 'dark' ? <MoonIcon className="h-4 w-4" weight="fill" /> : <SunIcon className="h-4 w-4" weight="fill" />}
            </button>
          </header>

          <main
            id="main-content"
            tabIndex={-1}
            className="flex-1 px-3 pb-24 pt-4 outline-none sm:px-4 md:pb-8 lg:px-6"
          >
            <div className="mx-auto w-full max-w-7xl">
              <Outlet />
            </div>
          </main>
        </div>

        {/* Mobile tab bar */}
        <nav
          className="safe-bottom fixed inset-x-0 bottom-0 z-30 flex border-t border-[var(--color-border)] bg-[var(--color-card)] md:hidden"
          aria-label="Main"
        >
          {mobileItems.map((item) => {
            const active = isActive(pathname, item.to);
            return (
              <Link
                key={item.to}
                to={item.to}
                className={cn(
                  'flex flex-1 flex-col items-center gap-0.5 py-2 text-[10px] font-medium transition-colors',
                  active ? 'text-[var(--color-primary)]' : 'text-[var(--color-muted-foreground)]',
                )}
                aria-current={active ? 'page' : undefined}
              >
                <item.icon className="h-5 w-5" weight={active ? 'fill' : 'regular'} />
                {item.label}
              </Link>
            );
          })}
          {/*
            "More" used to be a link straight to Settings, which left Bills,
            Income, Budgets, Investments, Reports and Help reachable on a phone
            only through the Ctrl-K palette — i.e. not at all. It now opens a
            sheet containing every secondary destination.
          */}
          <button
            type="button"
            onClick={() => setMoreOpen(true)}
            className={cn(
              'flex flex-1 flex-col items-center gap-0.5 py-2 text-[10px] font-medium transition-colors',
              moreIsActive
                ? 'text-[var(--color-primary)]'
                : 'text-[var(--color-muted-foreground)]',
            )}
            aria-haspopup="dialog"
            aria-expanded={moreOpen}
          >
            <MenuIcon className="h-5 w-5" weight={moreIsActive ? 'fill' : 'regular'} />
            More
          </button>
        </nav>

        {/*
          The secondary-navigation sheet. Anchored to the bottom because it is
          opened from the tab bar and a thumb is already there; twMerge lets the
          positioning classes override DialogContent's centred defaults.
        */}
        <Dialog open={moreOpen} onOpenChange={setMoreOpen}>
          <DialogContent
            className="bottom-0 left-0 top-auto w-full max-w-none translate-x-0 translate-y-0 rounded-b-none rounded-t-2xl pb-[calc(1.25rem+env(safe-area-inset-bottom))] md:hidden"
          >
            <DialogHeader>
              <DialogTitle className="text-base">More</DialogTitle>
            </DialogHeader>
            <nav aria-label="Secondary" className="grid grid-cols-2 gap-2">
              {moreItems.map((item) => {
                const active = isActive(pathname, item.to);
                return (
                  <Link
                    key={item.to}
                    to={item.to}
                    onClick={() => setMoreOpen(false)}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'flex items-center gap-2.5 rounded-lg border px-3 py-3 text-sm font-medium',
                      active
                        ? 'border-[var(--color-primary)]/40 bg-[var(--color-primary)]/10 text-[var(--color-primary)]'
                        : 'border-[var(--color-border)] text-[var(--color-foreground)]',
                    )}
                  >
                    <item.icon className="h-5 w-5 shrink-0" weight={active ? 'fill' : 'regular'} />
                    {item.label}
                  </Link>
                );
              })}
            </nav>
          </DialogContent>
        </Dialog>

        {/*
          These live inside the shell rather than beside RouterProvider in
          main.tsx. Rendered as a sibling of the router, the palette's
          useNavigate() has no router context and silently does nothing — which
          is exactly the bug this placement fixes.
        */}
        <BackToTop />
        <CommandPalette />
        <QuickAdd />
      </div>
    </TooltipProvider>
  );
}

function NavLink({ item, active, collapsed }: { item: NavItem; active: boolean; collapsed: boolean }) {
  return (
    <Link
      to={item.to}
      className={cn(
        'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
        active
          ? 'bg-[var(--color-primary)]/10 text-[var(--color-primary)]'
          : 'text-[var(--color-muted-foreground)] hover:bg-[var(--color-accent)] hover:text-[var(--color-foreground)]',
        collapsed && 'justify-center px-0',
      )}
      aria-current={active ? 'page' : undefined}
      title={collapsed ? item.label : undefined}
    >
      <item.icon className="h-4 w-4 shrink-0" weight={active ? 'fill' : 'regular'} />
      {!collapsed && <span>{item.label}</span>}
    </Link>
  );
}

function isActive(pathname: string, to: string): boolean {
  if (to === '/') return pathname === '/';
  return pathname.startsWith(to);
}

/** Standard page header: title, subtitle, optional actions. */
export function PageHeader({
  title,
  subtitle,
  subtitleTestId,
  actions,
}: {
  title: string;
  subtitle?: string;
  subtitleTestId?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{title}</h1>
        {subtitle && (
          <p
            className="mt-0.5 text-sm text-[var(--color-muted-foreground)]"
            data-testid={subtitleTestId}
          >
            {subtitle}
          </p>
        )}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
