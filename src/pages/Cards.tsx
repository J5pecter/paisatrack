/**
 * Credit cards — the sharpest edge of personal finance in India.
 *
 * Three jobs: track what each card actually costs, show what paying only the
 * minimum really means, and lay out the fastest route out of the debt.
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
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Field,
  Input,
  Progress,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui';
import {
  CardIcon,
  DeleteIcon,
  EditIcon,
  PayIcon,
  PlusIcon,
  ScalesIcon,
  TipIcon,
  WarningIcon,
} from '@/components/icons';
import { PageHeader } from '@/components/layout/AppShell';
import { Money } from '@/components/Money';
import { DayInput, MoneyInput, PercentInput } from '@/components/MoneyInput';
import { BalanceOverTimeChart, CHART_COLOURS } from '@/components/LazyCharts';
import { CardLedger } from '@/components/CardLedger';
import { useCardPayments, useCardTxns, useCreditCards, useStatements } from '@/hooks/useData';
import { resolveAllCardStates, type CardState } from '@/lib/finance/cardState';
import { create, remove, update } from '@/lib/db/repository';
import {
  calculateMinimumDue,
  comparePayoffStrategies,
  simulateMinimumPayments,
  utilization,
  utilizationBand,
} from '@/lib/finance/creditCard';
import {
  currentStatementDate,
  dueDateFor,
  dueLabel,
  formatDate,
  monthKey,
  nextStatementDate,
  toISODate,
  todayISO,
} from '@/lib/finance/dates';
import { clampZero, formatINR, sumMoney, toPaise } from '@/lib/finance/money';
import { cn, humanise } from '@/lib/utils';
import type { CreditCard, CreditCardStatement, StatementStatus } from '@/types';

const ISSUERS = [
  'HDFC Bank', 'SBI Card', 'ICICI Bank', 'Axis Bank', 'Kotak Mahindra Bank',
  'IndusInd Bank', 'American Express', 'IDFC FIRST Bank', 'RBL Bank',
  'Standard Chartered', 'Yes Bank', 'AU Small Finance Bank', 'Other',
];

/** Typical APRs. IndusInd also uses a 2% minimum-due rate rather than 5%. */
const ISSUER_DEFAULTS: Record<string, { apr: number; madPercent: number; madVariant: 'STANDARD' | 'HDFC' }> = {
  'HDFC Bank': { apr: 43.2, madPercent: 5, madVariant: 'HDFC' },
  'SBI Card': { apr: 45, madPercent: 5, madVariant: 'STANDARD' },
  'ICICI Bank': { apr: 45.6, madPercent: 5, madVariant: 'STANDARD' },
  'Axis Bank': { apr: 52.86, madPercent: 5, madVariant: 'STANDARD' },
  'Kotak Mahindra Bank': { apr: 44.4, madPercent: 5, madVariant: 'STANDARD' },
  'IndusInd Bank': { apr: 46, madPercent: 2, madVariant: 'STANDARD' },
  'American Express': { apr: 42, madPercent: 5, madVariant: 'STANDARD' },
  'IDFC FIRST Bank': { apr: 44.76, madPercent: 5, madVariant: 'STANDARD' },
};

export function Cards() {
  const cards = useCreditCards();
  const statements = useStatements();
  const cardTxns = useCardTxns();
  const cardPayments = useCardPayments();
  const [cardDialog, setCardDialog] = React.useState<CreditCard | 'new' | null>(null);
  const [statementFor, setStatementFor] = React.useState<CreditCard | null>(null);
  const [payFor, setPayFor] = React.useState<CreditCardStatement | null>(null);
  const [confirmDelete, setConfirmDelete] = React.useState<CreditCard | null>(null);

  // One resolver for the whole page: the ledger when a card has transactions,
  // entered statements otherwise. The header, the trap simulator and the payoff
  // planner all read from this, so they cannot quote different balances.
  const cardStates = React.useMemo(
    () => resolveAllCardStates({ cards, statements, txns: cardTxns, payments: cardPayments }),
    [cards, statements, cardTxns, cardPayments],
  );
  const stateFor = React.useCallback(
    (cardId: string) => cardStates.find((s) => s.card.id === cardId),
    [cardStates],
  );

  const totalOutstanding = React.useMemo(
    () => sumMoney(cardStates.map((s) => s.outstanding)),
    [cardStates],
  );

  const totalLimit = React.useMemo(() => sumMoney(cards.map((c) => c.creditLimit)), [cards]);

  if (cards.length === 0) {
    return (
      <>
        <PageHeader title="Credit cards" />
        <Card>
          <EmptyState
            icon={CardIcon}
            title="No cards yet"
            description="Add a card to track its outstanding, utilization and interest — and to find out what paying only the minimum would actually cost you."
            action={<Button onClick={() => setCardDialog('new')}>Add a card</Button>}
          />
        </Card>
        {cardDialog && (
          <CardDialog card={cardDialog === 'new' ? null : cardDialog} onClose={() => setCardDialog(null)} />
        )}
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Credit cards"
        subtitle={`${formatINR(totalOutstanding)} outstanding across ${cards.length} card${cards.length === 1 ? '' : 's'} · ${utilization(totalOutstanding, totalLimit).toFixed(0)}% utilized`}
        actions={
          <Button size="sm" onClick={() => setCardDialog('new')} className="gap-1.5">
            <PlusIcon className="h-4 w-4" weight="bold" />
            Add card
          </Button>
        }
      />

      <Tabs defaultValue="cards">
        <TabsList>
          <TabsTrigger value="cards">Cards</TabsTrigger>
          <TabsTrigger value="trap">Minimum-due trap</TabsTrigger>
          <TabsTrigger value="payoff">Payoff planner</TabsTrigger>
        </TabsList>

        <TabsContent value="cards" className="space-y-5">
          {cards.map((card) => (
            <CardPanel
              key={card.id}
              card={card}
              state={stateFor(card.id)}
              statements={statements.filter((s) => s.cardId === card.id)}
              onEdit={() => setCardDialog(card)}
              onDelete={() => setConfirmDelete(card)}
              onAddStatement={() => setStatementFor(card)}
              onPay={setPayFor}
            />
          ))}
        </TabsContent>

        <TabsContent value="trap">
          <MinimumDueTrap cards={cards} cardStates={cardStates} />
        </TabsContent>

        <TabsContent value="payoff">
          <PayoffPlanner cardStates={cardStates} />
        </TabsContent>
      </Tabs>

      {cardDialog && (
        <CardDialog card={cardDialog === 'new' ? null : cardDialog} onClose={() => setCardDialog(null)} />
      )}
      {statementFor && (
        <StatementDialog card={statementFor} onClose={() => setStatementFor(null)} />
      )}
      {payFor && <PaymentDialog statement={payFor} onClose={() => setPayFor(null)} />}

      <ConfirmDialog
        open={confirmDelete !== null}
        onOpenChange={(open) => !open && setConfirmDelete(null)}
        title={`Delete ${confirmDelete?.issuer} ${confirmDelete?.cardName}?`}
        description="The card and its statement history will be removed from PaisaTrack."
        onConfirm={async () => {
          if (!confirmDelete) return;
          await remove('creditCards', confirmDelete.id);
          toast.success('Card deleted');
          setConfirmDelete(null);
        }}
      />
    </>
  );
}

// ---------------------------------------------------------------------------

function CardPanel({
  card,
  state,
  statements,
  onEdit,
  onDelete,
  onAddStatement,
  onPay,
}: {
  card: CreditCard;
  state?: CardState;
  statements: CreditCardStatement[];
  onEdit: () => void;
  onDelete: () => void;
  onAddStatement: () => void;
  onPay: (s: CreditCardStatement) => void;
}) {
  const sorted = [...statements].sort((a, b) => b.statementDate.localeCompare(a.statementDate));
  const latest = sorted[0];
  // These come from the shared resolver so the header agrees with the Ledger
  // tab immediately below it.
  const outstanding = state?.outstanding ?? (latest ? clampZero(latest.totalAmountDue - latest.totalPaid) : 0);
  const util = state?.utilizationPercent ?? utilization(outstanding, card.creditLimit);
  const band = utilizationBand(util);

  // The *next* statement, not the current one - the Dashboard counts down to
  // the same date, and the two screens disagreeing is worse than either being
  // slightly less informative.
  const nextStatement = nextStatementDate(new Date(), card.statementDay);
  const nextDue = dueDateFor(nextStatement, card.dueDay);

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle className="text-base">
            {card.issuer} {card.cardName}
          </CardTitle>
          <p className="mt-0.5 text-xs text-[var(--color-muted-foreground)]">
            ····{card.last4} · {card.apr}% p.a. ({(card.apr / 12).toFixed(2)}%/month) ·{' '}
            {card.madPercent}% minimum
            {card.madVariant === 'HDFC' && ' · HDFC formula'}
          </p>
        </div>
        <div className="flex gap-0.5">
          <Button size="icon" variant="ghost" className="h-8 w-8" onClick={onEdit} aria-label="Edit card">
            <EditIcon className="h-4 w-4" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-8 w-8 text-[var(--color-danger)]"
            onClick={onDelete}
            aria-label="Delete card"
          >
            <DeleteIcon className="h-4 w-4" />
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-4">
          <Stat label="Outstanding" value={outstanding} />
          <Stat label="Limit" value={card.creditLimit} muted />
          <Stat label="Available" value={clampZero(card.creditLimit - outstanding)} muted />
          <div>
            <p className="text-xs text-[var(--color-muted-foreground)]">Utilization</p>
            <p
              className={cn(
                'tnum text-lg font-semibold',
                band === 'GOOD'
                  ? 'text-[var(--color-success)]'
                  : band === 'WATCH'
                    ? 'text-[var(--color-warning)]'
                    : 'text-[var(--color-danger)]',
              )}
            >
              {util.toFixed(1)}%
            </p>
          </div>
        </div>

        <Progress
          value={Math.min(100, util)}
          label={`Utilization ${util.toFixed(0)}%`}
          barClassName={
            band === 'GOOD'
              ? 'bg-[var(--color-success)]'
              : band === 'WATCH'
                ? 'bg-[var(--color-warning)]'
                : 'bg-[var(--color-danger)]'
          }
        />

        {band !== 'GOOD' && (
          <div className="flex items-start gap-2 rounded-md border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 p-2.5 text-xs">
            <WarningIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-warning)]" weight="fill" />
            <p>
              Utilization above 30% pulls your CIBIL score down. Paying{' '}
              <Money value={clampZero(outstanding - Math.floor(card.creditLimit * 0.3))} className="font-medium" />{' '}
              would bring this card back under 30%.
            </p>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--color-border)] pt-3">
          <p className="text-xs text-[var(--color-muted-foreground)]">
            Next statement {formatDate(nextStatement)} · due {formatDate(nextDue)}
          </p>
          <div className="flex gap-2">
            {latest && latest.status !== 'PAID' && (
              <Button size="sm" variant="outline" onClick={() => onPay(latest)} className="gap-1.5">
                <PayIcon className="h-3.5 w-3.5" weight="bold" />
                Log payment
              </Button>
            )}
            <Button size="sm" variant="secondary" onClick={onAddStatement} className="gap-1.5">
              <PlusIcon className="h-3.5 w-3.5" weight="bold" />
              Log statement
            </Button>
          </div>
        </div>

        <Tabs defaultValue="statements">
          <TabsList>
            <TabsTrigger value="statements">Statements</TabsTrigger>
            <TabsTrigger value="ledger">Ledger</TabsTrigger>
          </TabsList>

          <TabsContent value="statements" className="space-y-3">
        {sorted.length === 0 ? (
          <p className="py-6 text-center text-sm text-[var(--color-muted-foreground)]">
            No statements logged. Enter your bill totals here, or switch to the Ledger tab to log
            individual transactions and have PaisaTrack compute the statements for you.
          </p>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Statement</TH>
                <TH className="text-right">Total due</TH>
                <TH className="text-right">Minimum</TH>
                <TH className="text-right">Paid</TH>
                <TH className="hidden sm:table-cell">Due date</TH>
                <TH>Status</TH>
              </TR>
            </THead>
            <TBody>
              {sorted.slice(0, 6).map((s) => (
                <TR key={s.id}>
                  <TD className="text-xs">{formatDate(s.statementDate)}</TD>
                  <TD className="text-right"><Money value={s.totalAmountDue} /></TD>
                  <TD className="text-right text-[var(--color-muted-foreground)]">
                    <Money value={s.minimumDue} />
                  </TD>
                  <TD className="text-right"><Money value={s.totalPaid} /></TD>
                  <TD className="hidden sm:table-cell text-xs">
                    {s.status === 'PAID' ? formatDate(s.dueDate) : dueLabel(s.dueDate)}
                  </TD>
                  <TD><StatusBadge status={s.status} /></TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
        {latest && latest.interestCharged > 0 && (
          <p className="text-xs text-[var(--color-muted-foreground)]">
            Last statement charged <Money value={latest.interestCharged} className="font-medium" /> in
            interest plus <Money value={latest.gst} /> GST.
            {latest.revolving && ' This card is revolving — new purchases accrue interest from the day you make them.'}
          </p>
        )}
          </TabsContent>

          <TabsContent value="ledger">
            <CardLedger card={card} />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, muted }: { label: string; value: number; muted?: boolean }) {
  return (
    <div>
      <p className="text-xs text-[var(--color-muted-foreground)]">{label}</p>
      <Money
        value={value}
        className={cn('text-lg font-semibold', muted && 'text-[var(--color-muted-foreground)]')}
      />
    </div>
  );
}

function StatusBadge({ status }: { status: StatementStatus }) {
  const variant =
    status === 'PAID' ? 'success'
    : status === 'OVERDUE' ? 'danger'
    : status === 'MIN_PAID' || status === 'PARTIAL' ? 'warning'
    : 'outline';
  return <Badge variant={variant}>{humanise(status)}</Badge>;
}

// ---------------------------------------------------------------------------
// Minimum-due trap
// ---------------------------------------------------------------------------

function MinimumDueTrap({
  cards,
  cardStates,
}: {
  cards: CreditCard[];
  cardStates: CardState[];
}) {
  const [cardId, setCardId] = React.useState(cards[0]?.id ?? '');
  const card = cards.find((c) => c.id === cardId) ?? cards[0];
  const state = cardStates.find((s) => s.card.id === card?.id);

  const [balance, setBalance] = React.useState(state?.outstanding || toPaise(1_00_000));

  // Follow the selected card's real balance, but leave a figure the user has
  // typed in alone.
  const [edited, setEdited] = React.useState(false);
  React.useEffect(() => {
    if (!edited && state && state.outstanding > 0) setBalance(state.outstanding);
  }, [state, edited]);

  const sim = React.useMemo(
    () => simulateMinimumPayments(balance, card?.apr ?? 45, card?.madPercent ?? 5),
    [balance, card],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">What paying only the minimum costs</CardTitle>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          The minimum due is designed to keep you in debt. This is what it looks like.
        </p>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Card">
            <Select value={cardId} onValueChange={setCardId}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {cards.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.issuer} {c.cardName} ({c.apr}%)
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Balance" hint={`At ${card?.apr ?? 45}% p.a. with a ${card?.madPercent ?? 5}% minimum`}>
            <MoneyInput
              value={balance}
              onChange={(v) => {
                setBalance(v);
                setEdited(true);
              }}
            />
          </Field>
        </div>

        {balance <= 0 ? (
          <p className="py-6 text-center text-sm text-[var(--color-muted-foreground)]">
            Nothing outstanding on this card. Keep it that way.
          </p>
        ) : sim.neverPaysOff ? (
          <div className="flex items-start gap-3 rounded-lg border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 p-4">
            <WarningIcon className="mt-0.5 h-5 w-5 shrink-0 text-[var(--color-danger)]" weight="fill" />
            <div>
              <p className="font-semibold">The minimum never clears this balance.</p>
              <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
                At this rate the minimum does not even cover the monthly interest, so the balance grows
                no matter how long you pay. You have to pay more than the minimum.
              </p>
            </div>
          </div>
        ) : (
          <>
            <div className="rounded-lg border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 p-4">
              <p className="text-sm">
                Paying only the minimum, you would be in debt for{' '}
                <strong className="text-[var(--color-danger)]">
                  {sim.years > 0 && `${sim.years} year${sim.years === 1 ? '' : 's'}`}
                  {sim.years > 0 && sim.remainingMonths > 0 && ' and '}
                  {sim.remainingMonths > 0 && `${sim.remainingMonths} month${sim.remainingMonths === 1 ? '' : 's'}`}
                </strong>{' '}
                and pay <Money value={sim.totalInterest} className="font-semibold text-[var(--color-danger)]" /> in
                interest — on a <Money value={balance} /> balance.
              </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-4">
              <div>
                <p className="text-xs text-[var(--color-muted-foreground)]">Months to clear</p>
                <p className="tnum text-lg font-semibold">{sim.months}</p>
              </div>
              <div>
                <p className="text-xs text-[var(--color-muted-foreground)]">Total you would pay</p>
                <Money value={sim.totalPaid} className="text-lg font-semibold" />
              </div>
              <div>
                <p className="text-xs text-[var(--color-muted-foreground)]">Of which interest</p>
                <Money value={sim.totalInterest} className="text-lg font-semibold text-[var(--color-danger)]" />
              </div>
              <div>
                <p className="text-xs text-[var(--color-muted-foreground)]">First month&rsquo;s minimum</p>
                <Money value={sim.schedule[0]?.payment ?? 0} className="text-lg font-semibold" />
              </div>
            </div>

            <BalanceOverTimeChart
              series={[
                {
                  name: 'Minimum only',
                  colour: CHART_COLOURS[4],
                  points: sim.schedule.map((r) => ({ month: r.month, balance: r.closingBalance })),
                },
              ]}
            />

            <div className="flex items-start gap-2 rounded-md border border-[var(--color-border)] p-3 text-xs">
              <TipIcon className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-warning)]" weight="duotone" />
              <p className="text-[var(--color-muted-foreground)]">
                Paying even a little above the minimum changes this dramatically — almost all of the
                minimum goes to interest, so every extra rupee attacks the principal directly. The
                payoff planner shows what a fixed monthly budget would do.
              </p>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Payoff planner
// ---------------------------------------------------------------------------

function PayoffPlanner({ cardStates }: { cardStates: CardState[] }) {
  const payoffCards = React.useMemo(
    () =>
      cardStates
        .map((s) => ({
          id: s.card.id,
          name: `${s.card.issuer} ${s.card.cardName}`,
          balance: s.outstanding,
          apr: s.card.apr,
          madPercent: s.card.madPercent,
        }))
        .filter((c) => c.balance > 0),
    [cardStates],
  );

  const totalBalance = sumMoney(payoffCards.map((c) => c.balance));
  const [budget, setBudget] = React.useState(() => Math.max(toPaise(5_000), Math.round(totalBalance * 0.1)));

  const result = React.useMemo(
    () => comparePayoffStrategies(payoffCards, budget),
    [payoffCards, budget],
  );

  if (payoffCards.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={ScalesIcon}
          title="No card debt to plan"
          description="Once a card carries a balance, this will compare paying the highest rate first against clearing the smallest balance first."
        />
      </Card>
    );
  }

  const { avalanche, snowball, interestSaved, monthsSaved } = result;

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Avalanche vs snowball</CardTitle>
          <p className="text-sm text-[var(--color-muted-foreground)]">
            <Money value={totalBalance} className="font-medium" /> across {payoffCards.length} card
            {payoffCards.length === 1 ? '' : 's'}. Set what you can put towards them each month.
          </p>
        </CardHeader>
        <CardContent className="space-y-5">
          <Field
            label="Monthly budget"
            hint={
              avalanche.feasible
                ? undefined
                : `Needs at least ${formatINR(avalanche.minimumBudgetRequired)} just to cover every minimum.`
            }
          >
            <MoneyInput value={budget} onChange={setBudget} />
          </Field>

          {!avalanche.feasible ? (
            <div className="flex items-start gap-3 rounded-lg border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 p-4">
              <WarningIcon className="mt-0.5 h-5 w-5 shrink-0 text-[var(--color-danger)]" weight="fill" />
              <div className="text-sm">
                <p className="font-semibold">That budget will not cover the minimums.</p>
                <p className="mt-1 text-[var(--color-muted-foreground)]">
                  You need at least{' '}
                  <Money value={avalanche.minimumBudgetRequired} className="font-medium" /> a month
                  before any of this debt starts falling.
                </p>
              </div>
            </div>
          ) : (
            <>
              <div className="grid gap-4 md:grid-cols-2">
                <StrategyCard
                  title="Avalanche"
                  subtitle="Highest interest rate first"
                  result={avalanche}
                  recommended
                />
                <StrategyCard
                  title="Snowball"
                  subtitle="Smallest balance first"
                  result={snowball}
                />
              </div>

              {interestSaved > 0 && (
                <div className="flex items-start gap-2 rounded-md border border-[var(--color-success)]/40 bg-[var(--color-success)]/10 p-3 text-sm">
                  <TipIcon className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-success)]" weight="duotone" />
                  <p>
                    Avalanche saves <Money value={interestSaved} className="font-semibold" /> in interest
                    {monthsSaved > 0 && ` and finishes ${monthsSaved} month${monthsSaved === 1 ? '' : 's'} sooner`}.
                    Snowball clears individual cards faster, which some people need to stay with it.
                  </p>
                </div>
              )}

              <BalanceOverTimeChart
                series={[
                  {
                    name: 'Avalanche',
                    colour: CHART_COLOURS[0],
                    points: avalanche.schedule.map((r) => ({ month: r.month, balance: r.totalBalance })),
                  },
                  {
                    name: 'Snowball',
                    colour: CHART_COLOURS[1],
                    points: snowball.schedule.map((r) => ({ month: r.month, balance: r.totalBalance })),
                  },
                ]}
              />
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function StrategyCard({
  title,
  subtitle,
  result,
  recommended,
}: {
  title: string;
  subtitle: string;
  result: ReturnType<typeof comparePayoffStrategies>['avalanche'];
  recommended?: boolean;
}) {
  return (
    <div
      className={cn(
        'rounded-lg border p-4',
        recommended ? 'border-[var(--color-primary)]/50 bg-[var(--color-primary)]/5' : 'border-[var(--color-border)]',
      )}
    >
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-semibold">{title}</h3>
          <p className="text-xs text-[var(--color-muted-foreground)]">{subtitle}</p>
        </div>
        {recommended && <Badge variant="success">Cheapest</Badge>}
      </div>

      <div className="mt-3 space-y-1.5 text-sm">
        <div className="flex justify-between">
          <span className="text-[var(--color-muted-foreground)]">Debt free in</span>
          <span className="tnum font-medium">
            {result.years > 0 && `${result.years}y `}
            {result.remainingMonths}m
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-[var(--color-muted-foreground)]">Total interest</span>
          <Money value={result.totalInterest} className="font-medium" />
        </div>
        <div className="flex justify-between">
          <span className="text-[var(--color-muted-foreground)]">Total paid</span>
          <Money value={result.totalPaid} className="font-medium" />
        </div>
      </div>

      <ol className="mt-3 space-y-1 border-t border-[var(--color-border)] pt-3 text-xs">
        {result.payoffOrder.map((p, i) => (
          <li key={p.cardId} className="flex items-center gap-2">
            <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[var(--color-muted)] text-[9px] font-medium">
              {i + 1}
            </span>
            <span className="truncate">{p.name}</span>
            <span className="ml-auto whitespace-nowrap text-[var(--color-muted-foreground)]">
              month {p.clearedInMonth}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

function CardDialog({ card, onClose }: { card: CreditCard | null; onClose: () => void }) {
  const [form, setForm] = React.useState({
    cardName: card?.cardName ?? '',
    issuer: card?.issuer ?? 'HDFC Bank',
    last4: card?.last4 ?? '',
    creditLimit: card?.creditLimit ?? 0,
    statementDay: card?.statementDay ?? 18,
    dueDay: card?.dueDay ?? 8,
    apr: card?.apr ?? 43.2,
    madPercent: card?.madPercent ?? 5,
    madVariant: card?.madVariant ?? ('STANDARD' as 'STANDARD' | 'HDFC'),
  });
  const [error, setError] = React.useState<string | null>(null);

  function setIssuer(issuer: string) {
    const d = ISSUER_DEFAULTS[issuer];
    setForm((f) => ({ ...f, issuer, ...(d ? { apr: d.apr, madPercent: d.madPercent, madVariant: d.madVariant } : {}) }));
  }

  async function save() {
    if (!form.cardName.trim()) return setError('Give the card a name.');
    if (!/^\d{4}$/.test(form.last4)) return setError('Last 4 digits must be exactly four numbers.');
    if (form.creditLimit <= 0) return setError('Enter the credit limit.');

    const payload = { ...form, cardName: form.cardName.trim(), userId: 'user_sample', isActive: true };
    if (card) {
      await update<CreditCard>('creditCards', card.id, payload);
      toast.success('Card updated');
    } else {
      await create<CreditCard>('creditCards', 'card', payload as Omit<CreditCard, 'id' | 'createdAt' | 'updatedAt' | 'deviceId' | 'deletedAt'>);
      toast.success('Card added');
    }
    onClose();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{card ? 'Edit card' : 'Add a credit card'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Issuer">
              <Select value={form.issuer} onValueChange={setIssuer}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ISSUERS.map((i) => <SelectItem key={i} value={i}>{i}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Card name" required>
              <Input
                value={form.cardName}
                onChange={(e) => setForm((f) => ({ ...f, cardName: e.target.value }))}
                placeholder="Millennia"
              />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Last 4 digits" required>
              <Input
                inputMode="numeric"
                maxLength={4}
                value={form.last4}
                onChange={(e) => setForm((f) => ({ ...f, last4: e.target.value.replace(/\D/g, '') }))}
                placeholder="4821"
                className="tnum"
              />
            </Field>
            <Field label="Credit limit" required>
              <MoneyInput
                value={form.creditLimit}
                onChange={(v) => setForm((f) => ({ ...f, creditLimit: v }))}
              />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Statement day" hint="Day of month the bill is generated">
              <DayInput value={form.statementDay} onChange={(v) => setForm((f) => ({ ...f, statementDay: v }))} />
            </Field>
            <Field label="Due day" hint="Usually in the following month">
              <DayInput value={form.dueDay} onChange={(v) => setForm((f) => ({ ...f, dueDay: v }))} />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Interest rate (APR)" hint={`${(form.apr / 12).toFixed(2)}% per month`}>
              <PercentInput value={form.apr} onChange={(v) => setForm((f) => ({ ...f, apr: v }))} max={70} />
            </Field>
            <Field label="Minimum due" hint="5% for most issuers, 2% for IndusInd">
              <PercentInput
                value={form.madPercent}
                onChange={(v) => setForm((f) => ({ ...f, madPercent: v }))}
                max={20}
              />
            </Field>
          </div>

          {error && <p role="alert" className="text-sm text-[var(--color-danger)]">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void save()}>{card ? 'Save changes' : 'Add card'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function StatementDialog({ card, onClose }: { card: CreditCard; onClose: () => void }) {
  const stmtDate = currentStatementDate(new Date(), card.statementDay);
  const [form, setForm] = React.useState({
    statementDate: toISODate(stmtDate),
    totalAmountDue: 0,
    minimumDue: 0,
    interestCharged: 0,
    autoMinimum: true,
  });

  // The minimum due follows the issuer's formula unless the user overrides it.
  const computedMinimum = React.useMemo(
    () =>
      calculateMinimumDue({
        totalOutstanding: form.totalAmountDue,
        financeCharges: form.interestCharged,
        retailSpends: clampZero(form.totalAmountDue - form.interestCharged),
        madPercent: card.madPercent,
        variant: card.madVariant,
      }),
    [form.totalAmountDue, form.interestCharged, card],
  );

  const minimumDue = form.autoMinimum ? computedMinimum : form.minimumDue;

  async function save() {
    if (form.totalAmountDue <= 0) {
      toast.error('Enter the total amount due.');
      return;
    }
    const due = dueDateFor(form.statementDate, card.dueDay);
    await create<CreditCardStatement>('statements', 'stmt', {
      cardId: card.id,
      statementMonth: monthKey(form.statementDate),
      statementDate: form.statementDate,
      dueDate: toISODate(due),
      previousStatementDate: toISODate(currentStatementDate(new Date(new Date(form.statementDate).getTime() - 86400000), card.statementDay)),
      openingBalance: 0,
      totalAmountDue: form.totalAmountDue,
      minimumDue,
      transactions: [],
      payments: [],
      totalPaid: 0,
      minimumPaid: false,
      interestCharged: form.interestCharged,
      lateFee: 0,
      overlimitFee: 0,
      cashAdvanceFee: 0,
      gst: Math.round(form.interestCharged * 0.18),
      status: 'UNPAID',
      revolving: form.interestCharged > 0,
    } as Omit<CreditCardStatement, 'id' | 'createdAt' | 'updatedAt' | 'deviceId' | 'deletedAt'>);
    toast.success('Statement logged');
    onClose();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Log a statement</DialogTitle>
          <p className="text-sm text-[var(--color-muted-foreground)]">
            {card.issuer} {card.cardName} ····{card.last4}
          </p>
        </DialogHeader>

        <div className="space-y-4">
          <Field label="Statement date">
            <Input
              type="date"
              value={form.statementDate}
              onChange={(e) => setForm((f) => ({ ...f, statementDate: e.target.value }))}
            />
          </Field>

          <Field label="Total amount due" required>
            <MoneyInput
              value={form.totalAmountDue}
              onChange={(v) => setForm((f) => ({ ...f, totalAmountDue: v }))}
            />
          </Field>

          <Field
            label="Interest charged"
            hint="Leave at zero if this statement carried no interest."
          >
            <MoneyInput
              value={form.interestCharged}
              onChange={(v) => setForm((f) => ({ ...f, interestCharged: v }))}
            />
          </Field>

          <Field
            label="Minimum due"
            hint={
              form.autoMinimum
                ? `Computed with the ${card.madVariant === 'HDFC' ? 'HDFC' : 'standard'} ${card.madPercent}% formula. Click to override.`
                : 'Using your figure.'
            }
          >
            <div className="flex gap-2">
              <MoneyInput
                value={minimumDue}
                onChange={(v) => setForm((f) => ({ ...f, minimumDue: v, autoMinimum: false }))}
              />
              {!form.autoMinimum && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setForm((f) => ({ ...f, autoMinimum: true }))}
                >
                  Auto
                </Button>
              )}
            </div>
          </Field>

          <p className="text-xs text-[var(--color-muted-foreground)]">
            Due on {formatDate(dueDateFor(form.statementDate, card.dueDay))}.
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void save()}>Log statement</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PaymentDialog({ statement, onClose }: { statement: CreditCardStatement; onClose: () => void }) {
  const outstanding = clampZero(statement.totalAmountDue - statement.totalPaid);
  const [amount, setAmount] = React.useState(outstanding);
  const [date, setDate] = React.useState(todayISO());

  const newTotal = statement.totalPaid + amount;
  const clearsFully = newTotal >= statement.totalAmountDue;
  const coversMinimum = newTotal >= statement.minimumDue;

  async function save() {
    if (amount <= 0) {
      toast.error('Enter an amount.');
      return;
    }
    const status: StatementStatus = clearsFully
      ? 'PAID'
      : coversMinimum
        ? newTotal > statement.minimumDue ? 'PARTIAL' : 'MIN_PAID'
        : new Date(date) > new Date(statement.dueDate) ? 'OVERDUE' : 'PARTIAL';

    await update<CreditCardStatement>('statements', statement.id, {
      totalPaid: newTotal,
      minimumPaid: coversMinimum,
      status,
      payments: [
        ...statement.payments,
        { id: `pay_${crypto.randomUUID()}`, date, amount },
      ],
    });
    toast.success(clearsFully ? 'Statement cleared' : 'Payment logged');
    onClose();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Log a payment</DialogTitle>
          <p className="text-sm text-[var(--color-muted-foreground)]">
            Statement of {formatDate(statement.statementDate)} · <Money value={outstanding} /> outstanding
          </p>
        </DialogHeader>

        <div className="space-y-4">
          <Field label="Amount">
            <MoneyInput value={amount} onChange={setAmount} />
          </Field>

          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setAmount(statement.minimumDue)}>
              Minimum ({formatINR(statement.minimumDue)})
            </Button>
            <Button size="sm" variant="outline" onClick={() => setAmount(outstanding)}>
              Full ({formatINR(outstanding)})
            </Button>
          </div>

          <Field label="Paid on">
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>

          {!clearsFully && amount > 0 && (
            <div className="flex items-start gap-2 rounded-md border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 p-3 text-xs">
              <WarningIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-warning)]" weight="fill" />
              <p>
                This leaves <Money value={clampZero(statement.totalAmountDue - newTotal)} className="font-medium" />{' '}
                unpaid, so you lose the interest-free period — interest will be charged from each
                transaction date, not from the statement date.
              </p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void save()}>Log payment</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
