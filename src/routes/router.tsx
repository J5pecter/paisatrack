/**
 * Code-based routing.
 *
 * Routes are declared one by one rather than through a helper, because
 * TanStack Router infers the typed route tree from these literals — a helper
 * erases the path types and `<Link to="/cards">` stops type-checking.
 *
 * Every page is lazily chunked except the dashboard, which is the landing
 * screen and so ships with the shell to avoid a spinner on first paint.
 */
import { lazy } from 'react';
import { createRootRoute, createRoute, createRouter, ErrorComponent } from '@tanstack/react-router';
import { AppShell } from '@/components/layout/AppShell';
import { Dashboard } from '@/pages/Dashboard';
import { Button, Skeleton } from '@/components/ui';

const Accounts = lazy(() => import('@/pages/Accounts').then((m) => ({ default: m.Accounts })));
const Expenses = lazy(() => import('@/pages/Expenses').then((m) => ({ default: m.Expenses })));
const Cards = lazy(() => import('@/pages/Cards').then((m) => ({ default: m.Cards })));
const Loans = lazy(() => import('@/pages/Loans').then((m) => ({ default: m.Loans })));
const Bills = lazy(() => import('@/pages/Bills').then((m) => ({ default: m.Bills })));
const Income = lazy(() => import('@/pages/Income').then((m) => ({ default: m.Income })));
const Budgets = lazy(() => import('@/pages/Budgets').then((m) => ({ default: m.Budgets })));
const Investments = lazy(() =>
  import('@/pages/Investments').then((m) => ({ default: m.Investments })),
);
const Reports = lazy(() => import('@/pages/Reports').then((m) => ({ default: m.Reports })));
const Settings = lazy(() => import('@/pages/Settings').then((m) => ({ default: m.Settings })));
const Help = lazy(() => import('@/pages/Help').then((m) => ({ default: m.Help })));

const rootRoute = createRootRoute({
  component: AppShell,
  errorComponent: ErrorComponent,
  notFoundComponent: NotFound,
});

const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: Dashboard });
const accountsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/accounts', component: Accounts });
const expensesRoute = createRoute({ getParentRoute: () => rootRoute, path: '/expenses', component: Expenses });
const cardsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/cards', component: Cards });
const loansRoute = createRoute({ getParentRoute: () => rootRoute, path: '/loans', component: Loans });
const billsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/bills', component: Bills });
const incomeRoute = createRoute({ getParentRoute: () => rootRoute, path: '/income', component: Income });
const budgetsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/budgets', component: Budgets });
const investmentsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/investments', component: Investments });
const reportsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/reports', component: Reports });
const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/settings', component: Settings });
const helpRoute = createRoute({ getParentRoute: () => rootRoute, path: '/help', component: Help });

const routeTree = rootRoute.addChildren([
  indexRoute,
  accountsRoute,
  expensesRoute,
  cardsRoute,
  loansRoute,
  billsRoute,
  incomeRoute,
  budgetsRoute,
  investmentsRoute,
  reportsRoute,
  settingsRoute,
  helpRoute,
]);

export const router = createRouter({
  routeTree,
  // GitHub Pages serves the app under /<repo>/, so the router must agree.
  basepath: import.meta.env.BASE_URL,
  defaultPendingComponent: PageSkeleton,
  defaultPreload: 'intent',
  scrollRestoration: true,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

function PageSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-8 w-48" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-28" />
        ))}
      </div>
      <Skeleton className="h-64" />
    </div>
  );
}

function NotFound() {
  return (
    <div className="py-20 text-center">
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <p className="mt-2 text-sm text-[var(--color-muted-foreground)]">
        That route does not exist in PaisaTrack.
      </p>
      <Button asChild className="mt-5">
        <a href={import.meta.env.BASE_URL}>Back to the dashboard</a>
      </Button>
    </div>
  );
}
