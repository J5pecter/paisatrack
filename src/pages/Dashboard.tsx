/**
 * Dashboard — where you stand this month and what is due next.
 *
 * Ordered by what actually matters when you open a money app: how much of the
 * month's income is left, what is about to be taken out of your account, how
 * deep the debt is, then the slower-moving picture.
 */
import * as React from 'react';
import { Link } from '@tanstack/react-router';
import {
  ArrowRightIcon,
  CardIcon,
  ExpenseIcon,
  IncomeIcon,
  LoanIcon,
  SparkleIcon,
  TrendDownIcon,
  TrendUpIcon,
  WarningIcon,
} from '@/components/icons';
import type { PhosphorIcon } from '@/components/icons';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  Progress,
  Skeleton,
} from '@/components/ui';
import { PageHeader } from '@/components/layout/AppShell';
import { Money } from '@/components/Money';
import { Reveal, TiltCard } from '@/components/motion';
import { staggerDelay } from '@/lib/motion';
import { CategoryDonut, TrendChart } from '@/components/LazyCharts';
import { useDashboardData, useHasData } from '@/hooks/useData';
import {
  cardHealth,
  debtOverview,
  monthSnapshot,
  monthlyTrend,
  netWorth,
  spendByCategory,
  upcomingDues,
  type UpcomingDue,
} from '@/lib/finance/dashboard';
import { utilizationBand } from '@/lib/finance/creditCard';
import { resolveAllCardStates } from '@/lib/finance/cardState';
import { resolveAllLoanStates } from '@/lib/finance/loanState';
import { dueLabel, dueUrgency, formatMonthKey, monthKey } from '@/lib/finance/dates';
import { seedSampleData } from '@/lib/db/seed';
import { useUI } from '@/stores/ui';
import { cn, humanise } from '@/lib/utils';
import { toast } from 'sonner';

export function Dashboard() {
  const hasData = useHasData();
  const data = useDashboardData();
  const setQuickAddOpen = useUI((s) => s.setQuickAddOpen);
  const month = monthKey(new Date());

  // Resolve each card once, from the ledger where it exists and from entered
  // statements otherwise. Everything below shares this, so no two tiles on the
  // dashboard can ever quote a different balance for the same card.
  const cardStates = React.useMemo(
    () =>
      resolveAllCardStates({
        cards: data.cards,
        statements: data.statements,
        txns: data.cardTxns,
        payments: data.cardPayments,
      }),
    [data.cards, data.statements, data.cardTxns, data.cardPayments],
  );

  // Same contract as the cards: recorded EMIs win over the stored figure.
  const loanStates = React.useMemo(
    () => resolveAllLoanStates({ loans: data.loans, payments: data.loanPayments }),
    [data.loans, data.loanPayments],
  );

  const snapshot = React.useMemo(
    () => monthSnapshot({ month, ...data }),
    [month, data],
  );
  const dues = React.useMemo(() => upcomingDues({ ...data, days: 30, cardStates }), [data, cardStates]);
  const debt = React.useMemo(
    () => debtOverview({ ...data, cardStates, loanStates }),
    [data, cardStates, loanStates],
  );
  const cards = React.useMemo(
    () => cardHealth({ cards: data.cards, statements: data.statements, cardStates }),
    [data, cardStates],
  );
  const categories = React.useMemo(() => spendByCategory(data.expenses, month), [data.expenses, month]);
  const trend = React.useMemo(() => monthlyTrend({ ...data, months: 12 }), [data]);
  const worth = React.useMemo(
    () => netWorth({ ...data, cardStates, loanStates }),
    [data, cardStates, loanStates],
  );

  // One consistent snapshot or none: never render real income against zero spend.
  if (data.isLoading) return <DashboardSkeleton />;
  if (hasData === false) return <FirstRun />;

  const overdue = dues.filter((d) => d.isOverdue);
  const dueSoon = dues.filter((d) => !d.isOverdue && d.daysUntil <= 7);

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle={formatMonthKey(month)}
        actions={
          <Button onClick={() => setQuickAddOpen(true)} className="gap-1.5">
            <ExpenseIcon className="h-4 w-4" weight="bold" />
            Add expense
          </Button>
        }
      />

      {(overdue.length > 0 || dueSoon.length > 0) && (
        <div
          className={cn(
            'mb-5 flex items-start gap-3 rounded-lg border p-3.5 text-sm',
            overdue.length > 0
              ? 'border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10'
              : 'border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10',
          )}
          role="status"
        >
          <WarningIcon
            className={cn(
              'mt-0.5 h-4 w-4 shrink-0',
              overdue.length > 0 ? 'text-[var(--color-danger)]' : 'text-[var(--color-warning)]',
            )}
          />
          <div>
            {overdue.length > 0 && (
              <p className="font-medium">
                {overdue.length} payment{overdue.length === 1 ? ' is' : 's are'} overdue.
              </p>
            )}
            {dueSoon.length > 0 && (
              <p className={overdue.length > 0 ? 'text-[var(--color-muted-foreground)]' : 'font-medium'}>
                {dueSoon.length} more due in the next 7 days.
              </p>
            )}
          </div>
        </div>
      )}

      {/* This month */}
      <div className="tilt-scene mb-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4 [&>*]:min-w-0">
        <StatCard
          index={0}
          label="Income this month"
          testId="stat-income"
          value={snapshot.incomeExpected}
          icon={IncomeIcon}
          tone="neutral"
          footnote={`${((snapshot.incomeReceived / Math.max(1, snapshot.incomeExpected)) * 100).toFixed(0)}% credited so far`}
        />
        <StatCard
          index={1}
          label="Spent"
          testId="stat-spent"
          value={snapshot.expensesTotal + snapshot.billsTotal}
          icon={TrendDownIcon}
          tone="spend"
          footnote={`${snapshot.expensesTotal > 0 ? categories.length : 0} categories`}
        />
        <StatCard
          index={2}
          label="EMIs + minimums"
          testId="stat-obligation"
          value={debt.monthlyObligation}
          icon={LoanIcon}
          tone="spend"
          footnote={debt.totalDebt > 0 ? 'Fixed monthly obligation' : 'Debt free'}
        />
        <StatCard
          index={3}
          label="Savings rate"
          testId="stat-savings"
          value={snapshot.savings}
          icon={TrendUpIcon}
          tone="good"
          footnote={`${snapshot.savingsRatePercent.toFixed(0)}% of income`}
        />
      </div>

      {/* Income remaining */}
      <Card className="mb-5">
        <CardContent className="pt-5">
          <div className="mb-2 flex items-baseline justify-between gap-3">
            <span className="text-sm font-medium">Income left this month</span>
            <span className="text-sm text-[var(--color-muted-foreground)]">
              {snapshot.daysLeft} day{snapshot.daysLeft === 1 ? '' : 's'} to go ·{' '}
              <Money value={snapshot.safeToSpendPerDay} className="font-medium" />/day
            </span>
          </div>
          <Progress
            value={snapshot.incomeRemainingPercent}
            label="Income remaining"
            barClassName={
              snapshot.incomeRemainingPercent < 15
                ? 'bg-[var(--color-danger)]'
                : snapshot.incomeRemainingPercent < 35
                  ? 'bg-[var(--color-warning)]'
                  : 'bg-[var(--color-success)]'
            }
          />
          <div className="mt-2 flex justify-between text-xs text-[var(--color-muted-foreground)]">
            <span>
              <Money value={snapshot.expensesTotal + snapshot.billsTotal + snapshot.emiTotal} /> committed
            </span>
            <span>
              <Money value={snapshot.incomeExpected} /> total
            </span>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-5 lg:grid-cols-3 [&>*]:min-w-0">
        {/* Upcoming dues */}
        <Card className="lg:col-span-2">
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base">Due in the next 30 days</CardTitle>
            <Badge variant="outline">{dues.length}</Badge>
          </CardHeader>
          <CardContent>
            {dues.length === 0 ? (
              <p className="py-6 text-center text-sm text-[var(--color-muted-foreground)]">
                Nothing due. Enjoy it.
              </p>
            ) : (
              <ul className="divide-y divide-[var(--color-border)]" data-testid="upcoming-dues">
                {dues.slice(0, 8).map((due) => (
                  <DueRow key={due.id} due={due} />
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* Debt */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Debt</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <div className="flex items-baseline justify-between">
                <span className="text-sm text-[var(--color-muted-foreground)]">Total owed</span>
                <Money value={debt.totalDebt} className="text-xl font-semibold" animate />
              </div>
            </div>

            <div className="space-y-2 text-sm">
              <Row label="Credit cards" value={debt.cardOutstanding} />
              <Row label="Loans" value={debt.loanOutstanding} />
              <Row label="Monthly obligation" value={debt.monthlyObligation} muted />
            </div>

            {debt.totalBorrowed > 0 && (
              <div>
                <div className="mb-1.5 flex justify-between text-xs text-[var(--color-muted-foreground)]">
                  <span>Loan principal repaid</span>
                  <span>{debt.repaidPercent.toFixed(0)}%</span>
                </div>
                <Progress value={debt.repaidPercent} barClassName="bg-[var(--color-success)]" />
              </div>
            )}

            <Button asChild variant="outline" size="sm" className="w-full">
              <Link to="/cards">Payoff planner <ArrowRightIcon className="h-3.5 w-3.5" weight="bold" /></Link>
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* Card health */}
      {cards.length > 0 && (
        <Card className="mt-5">
          <CardHeader>
            <CardTitle className="text-base">Card health</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {cards.map((c) => {
              const band = utilizationBand(c.utilizationPercent);
              return (
                <div key={c.card.id} className="rounded-lg border border-[var(--color-border)] p-3.5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        {c.card.issuer} {c.card.cardName}
                      </p>
                      <p className="text-xs text-[var(--color-muted-foreground)]">
                        ····{c.card.last4}
                      </p>
                    </div>
                    <Badge
                      variant={band === 'GOOD' ? 'success' : band === 'WATCH' ? 'warning' : 'danger'}
                    >
                      {c.utilizationPercent.toFixed(0)}%
                    </Badge>
                  </div>

                  <Progress
                    value={Math.min(100, c.utilizationPercent)}
                    className="mt-3"
                    barClassName={
                      band === 'GOOD'
                        ? 'bg-[var(--color-success)]'
                        : band === 'WATCH'
                          ? 'bg-[var(--color-warning)]'
                          : 'bg-[var(--color-danger)]'
                    }
                  />

                  <div className="mt-3 space-y-1 text-xs">
                    <div className="flex justify-between">
                      <span className="text-[var(--color-muted-foreground)]">Outstanding</span>
                      <Money value={c.outstanding} className="font-medium" />
                    </div>
                    {c.minimumDue > 0 && (
                      <div className="flex justify-between">
                        <span className="text-[var(--color-muted-foreground)]">Minimum due</span>
                        <Money value={c.minimumDue} />
                      </div>
                    )}
                    <div className="flex justify-between">
                      <span className="text-[var(--color-muted-foreground)]">Due</span>
                      <span className={c.daysUntilDue < 0 ? 'text-[var(--color-danger)]' : ''}>
                        {dueLabel(c.dueDate)}
                      </span>
                    </div>
                  </div>

                  {band !== 'GOOD' && (
                    <p className="mt-2.5 text-[11px] leading-snug text-[var(--color-warning)]">
                      Utilization above 30% drags your CIBIL score down.
                    </p>
                  )}
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {/* Charts */}
      <div className="mt-5 grid gap-5 lg:grid-cols-2 [&>*]:min-w-0">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Where it went</CardTitle>
          </CardHeader>
          <CardContent>
            {categories.length === 0 ? (
              <p className="py-10 text-center text-sm text-[var(--color-muted-foreground)]">
                No expenses logged this month yet.
              </p>
            ) : (
              <CategoryDonut data={categories} />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Income vs spending</CardTitle>
          </CardHeader>
          <CardContent>
            <TrendChart data={trend} />
          </CardContent>
        </Card>
      </div>

      {/* Net worth */}
      <Card className="mt-5">
        <CardHeader>
          <CardTitle className="text-base">Net worth</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <div>
              <p className="text-xs text-[var(--color-muted-foreground)]">Cash and bank</p>
              <Money value={worth.cash} className="text-lg font-semibold" animate data-testid="nw-cash" />
              <p className="mt-0.5 text-xs text-[var(--color-muted-foreground)]">Spendable today</p>
            </div>
            <div>
              <p className="text-xs text-[var(--color-muted-foreground)]">Investments</p>
              <Money value={worth.investments} className="text-lg font-semibold" animate data-testid="nw-investments" />
              {worth.investedPrincipal > 0 && (
                <p className="mt-0.5 text-xs">
                  <Money value={worth.gains} showSign colour /> ({worth.gainPercent.toFixed(1)}%)
                </p>
              )}
            </div>
            <div>
              <p className="text-xs text-[var(--color-muted-foreground)]">Card debt</p>
              <Money value={-worth.cardDebt} className="text-lg font-semibold" data-testid="nw-card-debt" />
            </div>
            <div>
              <p className="text-xs text-[var(--color-muted-foreground)]">Loan debt</p>
              <Money value={-worth.loanDebt} className="text-lg font-semibold" data-testid="nw-loan-debt" />
            </div>
            <div className="rounded-lg bg-[var(--color-muted)] p-3">
              <p className="text-xs text-[var(--color-muted-foreground)]">Net worth</p>
              <Money
                value={worth.netWorth}
                className="text-xl font-semibold"
                colour
                animate
                data-testid="nw-total"
              />
            </div>
          </div>
        </CardContent>
      </Card>
    </>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-5" aria-busy="true" aria-label="Loading your dashboard">
      <Skeleton className="h-9 w-40" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-28" />
        ))}
      </div>
      <Skeleton className="h-24" />
      <div className="grid gap-5 lg:grid-cols-3">
        <Skeleton className="h-80 lg:col-span-2" />
        <Skeleton className="h-80" />
      </div>
    </div>
  );
}

function Row({ label, value, muted }: { label: string; value: number; muted?: boolean }) {
  return (
    <div className="flex justify-between">
      <span className="text-[var(--color-muted-foreground)]">{label}</span>
      <Money value={value} className={muted ? 'text-[var(--color-muted-foreground)]' : 'font-medium'} />
    </div>
  );
}

function StatCard({
  label,
  value,
  icon: Icon,
  tone,
  footnote,
  testId,
  index = 0,
}: {
  label: string;
  value: number;
  icon: PhosphorIcon;
  tone: 'good' | 'spend' | 'neutral';
  footnote?: string;
  testId?: string;
  /** Position in the row, used for the reveal stagger. */
  index?: number;
}) {
  const toneClass =
    tone === 'good'
      ? 'text-[var(--color-success)]'
      : tone === 'spend'
        ? 'text-[var(--color-warning)]'
        : 'text-[var(--color-info)]';

  return (
    <Reveal delay={staggerDelay(index)}>
      <TiltCard>
        <Card className="h-full">
      <CardContent className="pt-5">
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium text-[var(--color-muted-foreground)]">{label}</p>
          <Icon className={cn('h-4 w-4', toneClass)} weight="bold" />
        </div>
        <Money
          value={value}
          className="mt-1.5 block text-2xl font-semibold"
          animate
          data-testid={testId}
        />
        {footnote && (
          <p className="mt-1 text-xs text-[var(--color-muted-foreground)]">{footnote}</p>
        )}
      </CardContent>
        </Card>
      </TiltCard>
    </Reveal>
  );
}

function DueRow({ due }: { due: UpcomingDue }) {
  const urgency = dueUrgency(due.dueDate);
  const Icon = due.kind === 'CARD' ? CardIcon : due.kind === 'EMI' ? LoanIcon : ExpenseIcon;

  const badgeVariant =
    urgency === 'OVERDUE' || urgency === 'TODAY'
      ? 'danger'
      : urgency === 'CRITICAL'
        ? 'danger'
        : urgency === 'SOON'
          ? 'warning'
          : 'outline';

  return (
    <li className="flex items-center gap-3 py-2.5">
      <div className="shrink-0 rounded-md bg-[var(--color-muted)] p-1.5">
        <Icon className="h-3.5 w-3.5 text-[var(--color-muted-foreground)]" weight="bold" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{due.label}</p>
        {due.sublabel && (
          <p className="truncate text-xs text-[var(--color-muted-foreground)]">{due.sublabel}</p>
        )}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <Money value={due.amount} className="text-sm font-medium" />
        <Badge variant={badgeVariant}>{dueLabel(due.dueDate)}</Badge>
      </div>
    </li>
  );
}

function FirstRun() {
  const [loading, setLoading] = React.useState(false);
  const setQuickAddOpen = useUI((s) => s.setQuickAddOpen);

  async function loadSample() {
    setLoading(true);
    try {
      const { counts } = await seedSampleData();
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      toast.success(`Loaded ${total} sample records`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not load the sample data');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="py-10">
      <EmptyState
        icon={SparkleIcon}
        title="Welcome to PaisaTrack"
        description="Track your salary, credit cards, EMIs, bills and expenses — all stored on this device, and optionally synced to your own private GitHub repo. Nothing leaves your control."
        action={
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button onClick={() => void loadSample()} disabled={loading}>
              {loading ? 'Loading…' : 'Load sample data'}
            </Button>
            <Button variant="outline" onClick={() => setQuickAddOpen(true)}>
              Add my first expense
            </Button>
          </div>
        }
      />

      <div className="mx-auto mt-8 grid max-w-3xl gap-4 sm:grid-cols-3">
        {[
          { icon: CardIcon, title: 'Credit cards', body: 'Real Average Daily Balance interest, the minimum-due trap, and an avalanche-vs-snowball payoff planner.' },
          { icon: LoanIcon, title: 'Loans', body: 'Full amortization, prepayment savings, and rates pre-filled from every major Indian lender.' },
          { icon: IncomeIcon, title: 'Salary', body: 'CTC to in-hand, plus a new-vs-old tax regime comparison for FY 2025-26.' },
        ].map((f) => (
          <div key={f.title} className="rounded-lg border border-[var(--color-border)] p-4">
            <f.icon className="h-6 w-6 text-[var(--color-primary)]" weight="duotone" />
            <h3 className="mt-2 text-sm font-semibold">{f.title}</h3>
            <p className="mt-1 text-xs leading-relaxed text-[var(--color-muted-foreground)]">
              {f.body}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

export { humanise };
