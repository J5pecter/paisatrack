/**
 * The card ledger.
 *
 * This is where the interest engine becomes visible. Log what you actually
 * spent and paid, and PaisaTrack computes the statements itself — including
 * the thing no bank app shows you: *why* you were charged interest, and from
 * which transaction date it started running.
 *
 * Entering statement totals by hand still works and is simpler; this is for
 * when you want to know exactly what a late payment cost.
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
  Tooltip,
} from '@/components/ui';
import {
  CheckCircleIcon,
  DeleteIcon,
  InfoIcon,
  PayIcon,
  PlusIcon,
  ReceiptIcon,
  TipIcon,
  WarningIcon,
} from '@/components/icons';
import { Money } from '@/components/Money';
import { MoneyInput } from '@/components/MoneyInput';
import { UtilizationTrendChart } from '@/components/LazyCharts';
import { useCardPayments, useCardTxns } from '@/hooks/useData';
import { create, remove } from '@/lib/db/repository';
import { runCardLedger, type ComputedStatement } from '@/lib/finance/creditCard';
import { formatDate, todayISO } from '@/lib/finance/dates';
import { formatINR } from '@/lib/finance/money';
import { cn, humanise } from '@/lib/utils';
import type {
  CardPaymentRecord,
  CardTxnRecord,
  CardTxnType,
  CreditCard,
  StatementStatus,
} from '@/types';

const TXN_TYPES: Array<{ value: CardTxnType; label: string; hint?: string }> = [
  { value: 'RETAIL', label: 'Purchase' },
  { value: 'CASH_ADVANCE', label: 'Cash withdrawal', hint: 'Interest from day one, plus a fee. No grace period, ever.' },
  { value: 'EMI', label: 'EMI conversion', hint: '100% of this is always part of the minimum due.' },
  { value: 'FEE', label: 'Fee charged by the issuer' },
  { value: 'REFUND', label: 'Refund received' },
];

export function CardLedger({ card }: { card: CreditCard }) {
  const txns = useCardTxns(card.id);
  const payments = useCardPayments(card.id);
  const [addTxn, setAddTxn] = React.useState(false);
  const [addPayment, setAddPayment] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState<
    { kind: 'txn' | 'payment'; id: string; label: string } | null
  >(null);

  const ledger = React.useMemo(
    () =>
      runCardLedger({
        statementDay: card.statementDay,
        dueDay: card.dueDay,
        apr: card.apr,
        creditLimit: card.creditLimit,
        madPercent: card.madPercent,
        madVariant: card.madVariant,
        transactions: txns.map((t) => ({
          id: t.id,
          date: t.date,
          amount: t.amount,
          type: t.type,
          description: t.description,
        })),
        payments: payments.map((p) => ({ id: p.id, date: p.date, amount: p.amount })),
      }),
    [card, txns, payments],
  );

  const hasActivity = txns.length > 0 || payments.length > 0;

  // One merged, date-ordered list — how a passbook reads.
  const activity = React.useMemo(
    () =>
      [
        ...txns.map((t) => ({ kind: 'txn' as const, id: t.id, date: t.date, amount: t.amount, type: t.type, label: t.description || humanise(t.type) })),
        ...payments.map((p) => ({ kind: 'payment' as const, id: p.id, date: p.date, amount: p.amount, type: 'PAYMENT' as const, label: 'Payment' })),
      ].sort((a, b) => b.date.localeCompare(a.date)),
    [txns, payments],
  );

  // Utilization at each statement date — the series CIBIL actually reacts to.
  // Declared before the early return below: a hook after a conditional return
  // changes the hook count between renders the moment a card gets its first
  // transaction, and React throws.
  const utilisationSeries = React.useMemo(
    () =>
      ledger.statements.map((s) => ({
        label: formatDate(s.statementDate).slice(3),
        percent: s.utilizationPercent,
        outstanding: s.totalAmountDue,
      })),
    [ledger.statements],
  );

  if (!hasActivity) {
    return (
      <>
        <Card>
          <EmptyState
            icon={ReceiptIcon}
            title="Nothing logged on this card yet"
            description="Log what you spend and what you pay, and PaisaTrack computes the statements itself — the interest, the minimum due, the late fee, and exactly which transaction date each charge runs from."
            action={
              <div className="flex flex-col gap-2 sm:flex-row">
                <Button onClick={() => setAddTxn(true)}>Log a transaction</Button>
                <Button variant="outline" onClick={() => setAddPayment(true)}>
                  Log a payment
                </Button>
              </div>
            }
          />
        </Card>
        {addTxn && <TxnDialog card={card} onClose={() => setAddTxn(false)} />}
        {addPayment && <PaymentDialog card={card} onClose={() => setAddPayment(false)} />}
      </>
    );
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-4 [&>*]:min-w-0">
        <Tile label="Outstanding now" value={ledger.currentOutstanding} />
        <Tile
          label="Unbilled interest"
          value={ledger.unbilledInterest}
          tone={ledger.unbilledInterest > 0 ? 'bad' : undefined}
          hint="Interest accrued since the last statement that has not been billed yet."
        />
        <Tile label="Interest charged to date" value={ledger.totalInterestPaid} tone="bad" />
        <Tile label="Fees charged to date" value={ledger.totalFeesPaid} tone="bad" />
      </div>

      {ledger.revolving && (
        <div className="flex items-start gap-3 rounded-lg border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 p-4">
          <WarningIcon className="mt-0.5 h-5 w-5 shrink-0 text-[var(--color-danger)]" weight="fill" />
          <div className="text-sm">
            <p className="font-semibold">This card is revolving.</p>
            <p className="mt-1 text-[var(--color-muted-foreground)]">
              A statement went past its due date without being cleared in full, so the
              interest-free period is gone. Every new purchase now accrues interest from the day
              you make it — not from the statement date — and it will keep doing so until the whole
              balance is cleared.
            </p>
          </div>
        </div>
      )}

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle className="text-base">Computed statements</CardTitle>
            <p className="mt-0.5 text-sm text-[var(--color-muted-foreground)]">
              Worked out from your transactions using the Average Daily Balance method, the way
              your issuer does it.
            </p>
          </div>
        </CardHeader>
        <CardContent>
          {ledger.statements.length === 0 ? (
            <p className="py-6 text-center text-sm text-[var(--color-muted-foreground)]">
              No statement date has passed yet. The first one falls on{' '}
              {formatDate(ledger.nextStatementDate)}.
            </p>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Statement</TH>
                  <TH className="text-right">Spend</TH>
                  <TH className="text-right">Interest</TH>
                  <TH className="text-right hidden sm:table-cell">Fees + GST</TH>
                  <TH className="text-right">Total due</TH>
                  <TH className="text-right hidden sm:table-cell">Minimum</TH>
                  <TH>Status</TH>
                </TR>
              </THead>
              <TBody>
                {[...ledger.statements].reverse().map((s) => (
                  <StatementRow key={s.statementDate} s={s} />
                ))}
              </TBody>
            </Table>
          )}

          <div className="mt-4 flex items-start gap-2 rounded-md border border-[var(--color-border)] p-3 text-xs">
            <TipIcon className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-info)]" weight="duotone" />
            <p className="text-[var(--color-muted-foreground)]">
              Next statement {formatDate(ledger.nextStatementDate)}, due{' '}
              {formatDate(ledger.nextDueDate)}. Clear the full amount by the due date and retail
              spends cost you nothing.
            </p>
          </div>
        </CardContent>
      </Card>

      {utilisationSeries.length >= 2 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Utilization over time</CardTitle>
            <p className="text-sm text-[var(--color-muted-foreground)]">
              What this card reported to the bureaus at each statement. Staying under 30% is the
              single cheapest thing you can do for your CIBIL score.
            </p>
          </CardHeader>
          <CardContent>
            <UtilizationTrendChart data={utilisationSeries} />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">Activity</CardTitle>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setAddPayment(true)} className="gap-1.5">
              <PayIcon className="h-3.5 w-3.5" weight="bold" />
              Payment
            </Button>
            <Button size="sm" onClick={() => setAddTxn(true)} className="gap-1.5">
              <PlusIcon className="h-3.5 w-3.5" weight="bold" />
              Transaction
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <Table>
            <THead>
              <TR>
                <TH>Date</TH>
                <TH>Description</TH>
                <TH className="hidden sm:table-cell">Type</TH>
                <TH className="text-right">Amount</TH>
                <TH className="w-10" />
              </TR>
            </THead>
            <TBody>
              {activity.map((a) => (
                <TR key={`${a.kind}-${a.id}`}>
                  <TD className="whitespace-nowrap text-xs">{formatDate(a.date)}</TD>
                  <TD className="font-medium">{a.label}</TD>
                  <TD className="hidden sm:table-cell">
                    <Badge
                      variant={
                        a.kind === 'payment' ? 'success'
                        : a.type === 'CASH_ADVANCE' ? 'danger'
                        : a.type === 'REFUND' ? 'info'
                        : 'outline'
                      }
                    >
                      {a.kind === 'payment' ? 'Payment' : humanise(a.type)}
                    </Badge>
                  </TD>
                  <TD className="text-right">
                    <Money
                      value={a.kind === 'payment' || a.type === 'REFUND' ? -a.amount : a.amount}
                      className="font-medium"
                      colour
                      invertColour
                    />
                  </TD>
                  <TD>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 text-[var(--color-danger)]"
                      onClick={() =>
                        setConfirmDelete({ kind: a.kind, id: a.id, label: `${a.label} · ${formatINR(a.amount)}` })
                      }
                      aria-label={`Delete ${a.label}`}
                    >
                      <DeleteIcon className="h-3.5 w-3.5" />
                    </Button>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </CardContent>
      </Card>

      {addTxn && <TxnDialog card={card} onClose={() => setAddTxn(false)} />}
      {addPayment && <PaymentDialog card={card} onClose={() => setAddPayment(false)} />}

      <ConfirmDialog
        open={confirmDelete !== null}
        onOpenChange={(open) => !open && setConfirmDelete(null)}
        title="Delete this entry?"
        description={`${confirmDelete?.label ?? ''} — removing it will recompute every statement after its date.`}
        onConfirm={async () => {
          if (!confirmDelete) return;
          await remove(confirmDelete.kind === 'txn' ? 'cardTxns' : 'cardPayments', confirmDelete.id);
          toast.success('Entry deleted');
          setConfirmDelete(null);
        }}
      />
    </div>
  );
}

function Tile({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: number;
  tone?: 'bad';
  hint?: string;
}) {
  const body = (
    <Card>
      <CardContent className="pt-5">
        <div className="flex items-center gap-1">
          <p className="text-xs text-[var(--color-muted-foreground)]">{label}</p>
          {hint && <InfoIcon className="h-3 w-3 text-[var(--color-muted-foreground)]" />}
        </div>
        <Money
          value={value}
          className={cn('text-lg font-semibold', tone === 'bad' && value > 0 && 'text-[var(--color-danger)]')}
          animate
        />
      </CardContent>
    </Card>
  );
  return hint ? <Tooltip content={hint}>{body}</Tooltip> : body;
}

function StatementRow({ s }: { s: ComputedStatement }) {
  const spend = s.retailSpends + s.cashAdvances + s.emiSpends - s.refunds;
  const feesAndGst = s.overlimitFee + s.cashAdvanceFee + s.gst;

  return (
    <TR>
      <TD className="whitespace-nowrap text-xs">
        {formatDate(s.statementDate)}
        {s.lateFee > 0 && (
          <Badge variant="danger" className="ml-1.5">
            late fee <Money value={s.lateFee} />
          </Badge>
        )}
      </TD>
      <TD className="text-right"><Money value={spend} /></TD>
      <TD className="text-right">
        {s.interestCharged > 0 ? (
          <Money value={s.interestCharged} className="font-medium text-[var(--color-danger)]" />
        ) : (
          <span className="text-[var(--color-success)]">nil</span>
        )}
      </TD>
      <TD className="hidden text-right sm:table-cell text-[var(--color-muted-foreground)]">
        <Money value={feesAndGst} />
      </TD>
      <TD className="text-right"><Money value={s.totalAmountDue} className="font-medium" /></TD>
      <TD className="hidden text-right sm:table-cell text-[var(--color-muted-foreground)]">
        <Money value={s.minimumDue} />
      </TD>
      <TD>
        <StatusBadge status={s.status} paidInFull={s.paidInFull} />
      </TD>
    </TR>
  );
}

function StatusBadge({ status, paidInFull }: { status: StatementStatus; paidInFull: boolean }) {
  if (paidInFull) {
    return (
      <Badge variant="success">
        <CheckCircleIcon className="h-3 w-3" weight="fill" />
        Paid
      </Badge>
    );
  }
  const variant =
    status === 'OVERDUE' ? 'danger'
    : status === 'MIN_PAID' || status === 'PARTIAL' ? 'warning'
    : 'outline';
  return <Badge variant={variant}>{humanise(status)}</Badge>;
}

// ---------------------------------------------------------------------------

function TxnDialog({ card, onClose }: { card: CreditCard; onClose: () => void }) {
  const [form, setForm] = React.useState({
    date: todayISO(),
    amount: 0,
    type: 'RETAIL' as CardTxnType,
    description: '',
  });
  const [error, setError] = React.useState<string | null>(null);

  const typeInfo = TXN_TYPES.find((t) => t.value === form.type);

  async function save(keepOpen: boolean) {
    if (form.amount <= 0) return setError('Enter an amount greater than zero.');

    await create<CardTxnRecord>('cardTxns', 'ctxn', {
      cardId: card.id,
      date: form.date,
      amount: form.amount,
      type: form.type,
      ...(form.description.trim() ? { description: form.description.trim() } : {}),
    });
    toast.success('Transaction logged');

    if (keepOpen) {
      setForm((f) => ({ ...f, amount: 0, description: '' }));
      setError(null);
    } else {
      onClose();
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Log a transaction</DialogTitle>
          <p className="text-sm text-[var(--color-muted-foreground)]">
            {card.issuer} {card.cardName} ····{card.last4}
          </p>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Date" hint="Interest runs from this date, not the statement date.">
              <Input
                type="date"
                value={form.date}
                onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
              />
            </Field>
            <Field label="Amount" required error={error ?? undefined}>
              <MoneyInput
                value={form.amount}
                onChange={(v) => {
                  setForm((f) => ({ ...f, amount: v }));
                  setError(null);
                }}
              />
            </Field>
          </div>

          <Field label="Type" hint={typeInfo?.hint}>
            <Select
              value={form.type}
              onValueChange={(v) => setForm((f) => ({ ...f, type: v as CardTxnType }))}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {TXN_TYPES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field label="Description">
            <Input
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              placeholder="Amazon order"
            />
          </Field>

          {form.type === 'CASH_ADVANCE' && form.amount > 0 && (
            <div className="flex items-start gap-2 rounded-md border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 p-3 text-xs">
              <WarningIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-warning)]" weight="fill" />
              <p>
                A cash withdrawal costs{' '}
                <Money value={Math.max(Math.round(form.amount * 0.025), 50_000)} className="font-medium" />{' '}
                in fees immediately, and interest starts the same day — there is no grace period on
                cash, even if you clear the statement in full.
              </p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button variant="secondary" onClick={() => void save(true)}>Save and add another</Button>
          <Button onClick={() => void save(false)}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PaymentDialog({ card, onClose }: { card: CreditCard; onClose: () => void }) {
  const [form, setForm] = React.useState({ date: todayISO(), amount: 0, notes: '' });
  const [error, setError] = React.useState<string | null>(null);

  async function save() {
    if (form.amount <= 0) return setError('Enter an amount greater than zero.');

    await create<CardPaymentRecord>('cardPayments', 'cpay', {
      cardId: card.id,
      date: form.date,
      amount: form.amount,
      ...(form.notes.trim() ? { notes: form.notes.trim() } : {}),
    });
    toast.success('Payment logged');
    onClose();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Log a payment</DialogTitle>
          <p className="text-sm text-[var(--color-muted-foreground)]">
            {card.issuer} {card.cardName} ····{card.last4}
          </p>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Date" hint="A payment stops interest from this day.">
              <Input
                type="date"
                value={form.date}
                onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
              />
            </Field>
            <Field label="Amount" required error={error ?? undefined}>
              <MoneyInput
                value={form.amount}
                onChange={(v) => {
                  setForm((f) => ({ ...f, amount: v }));
                  setError(null);
                }}
              />
            </Field>
          </div>

          <Field label="Note">
            <Input
              value={form.notes}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
              placeholder="Optional"
            />
          </Field>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void save()}>Log payment</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
