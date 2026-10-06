/**
 * Loans — amortization, prepayment maths, and the lender rate database.
 *
 * Picking a lender fills in a plausible rate so you are not hunting for it, but
 * the field stays editable because the rate you were actually sanctioned is the
 * only one that matters.
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
  SelectLabel,
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
  CarLoanIcon,
  DeleteIcon,
  EditIcon,
  EducationLoanIcon,
  GoldLoanIcon,
  HomeLoanIcon,
  LoanIcon,
  PersonalLoanIcon,
  PlusIcon,
  PropertyLoanIcon,
  PayIcon,
  TipIcon,
  UndoIcon,
} from '@/components/icons';
import { PageHeader } from '@/components/layout/AppShell';
import { Money } from '@/components/Money';
import { DayInput, MoneyInput, PercentInput } from '@/components/MoneyInput';
import { BalanceOverTimeChart, CHART_COLOURS } from '@/components/LazyCharts';
import { useLoanPayments, useLoans } from '@/hooks/useData';
import {
  isInstallmentPaid,
  resolveAllLoanStates,
  resolveLoanState,
  type LoanState,
} from '@/lib/finance/loanState';
import { create, remove, update } from '@/lib/db/repository';
import {
  calculateEMI,
  generateAmortization,
  simulatePrepayment,
  tenureForEMI,
} from '@/lib/finance/emi';
import { formatDate, todayISO } from '@/lib/finance/dates';
import { clampZero, formatINR, percentage, sumMoney, toPaise } from '@/lib/finance/money';
import lenderData from '@/data/lenders.json';
import { humanise } from '@/lib/utils';
import type { LenderDatabase, Loan, LoanPayment, LoanType } from '@/types';

const LENDERS = lenderData as unknown as LenderDatabase;

/** The lender-database keys, excluding the lastUpdated metadata field. */
type LenderCategory = Exclude<keyof LenderDatabase, 'lastUpdated'>;

const LOAN_TYPES: Array<{ value: LoanType; label: string; key: LenderCategory | null }> = [
  { value: 'HOME', label: 'Home loan', key: 'home' },
  { value: 'PERSONAL', label: 'Personal loan', key: 'personal' },
  { value: 'CAR', label: 'Car loan', key: 'car' },
  { value: 'EDUCATION', label: 'Education loan', key: 'education' },
  { value: 'GOLD', label: 'Gold loan', key: 'gold' },
  { value: 'LAP', label: 'Loan against property', key: 'lap' },
  { value: 'OTHER', label: 'Other', key: null },
];

const LOAN_ICONS: Record<LoanType, typeof LoanIcon> = {
  HOME: HomeLoanIcon,
  CAR: CarLoanIcon,
  PERSONAL: PersonalLoanIcon,
  EDUCATION: EducationLoanIcon,
  GOLD: GoldLoanIcon,
  LAP: PropertyLoanIcon,
  OTHER: LoanIcon,
};

export function Loans() {
  const loans = useLoans();
  const payments = useLoanPayments();
  const [dialog, setDialog] = React.useState<Loan | 'new' | null>(null);
  const [confirmDelete, setConfirmDelete] = React.useState<Loan | null>(null);

  // One resolver for the page: recorded payments where they exist, the
  // schedule read at today's date otherwise.
  const states = React.useMemo(
    () => resolveAllLoanStates({ loans, payments }),
    [loans, payments],
  );
  const stateFor = React.useCallback(
    (loanId: string) => states.find((s) => s.loan.id === loanId),
    [states],
  );

  const active = loans.filter((l) => l.isActive);
  const totalOutstanding = sumMoney(states.map((s) => s.outstandingPrincipal));
  const totalEmi = sumMoney(active.map((l) => l.emiAmount));
  const totalBorrowed = sumMoney(active.map((l) => l.principalAmount));

  if (loans.length === 0) {
    return (
      <>
        <PageHeader title="Loans" />
        <Card>
          <EmptyState
            icon={LoanIcon}
            title="No loans tracked"
            description="Add a loan to see its full amortization schedule, how much of each EMI is interest, and what a prepayment would save you."
            action={<Button onClick={() => setDialog('new')}>Add a loan</Button>}
          />
        </Card>
        {dialog && <LoanDialog loan={null} onClose={() => setDialog(null)} />}
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Loans"
        subtitle={`${formatINR(totalOutstanding)} outstanding · ${formatINR(totalEmi)}/month across ${active.length} loan${active.length === 1 ? '' : 's'}`}
        actions={
          <Button size="sm" onClick={() => setDialog('new')} className="gap-1.5">
            <PlusIcon className="h-4 w-4" weight="bold" />
            Add loan
          </Button>
        }
      />

      {active.length > 1 && (
        <Card className="mb-5">
          <CardContent className="grid gap-4 pt-5 sm:grid-cols-4">
            <div>
              <p className="text-xs text-[var(--color-muted-foreground)]">Total borrowed</p>
              <Money value={totalBorrowed} className="text-lg font-semibold" />
            </div>
            <div>
              <p className="text-xs text-[var(--color-muted-foreground)]">Still owed</p>
              <Money value={totalOutstanding} className="text-lg font-semibold" />
            </div>
            <div>
              <p className="text-xs text-[var(--color-muted-foreground)]">Monthly EMI outflow</p>
              <Money value={totalEmi} className="text-lg font-semibold" />
            </div>
            <div>
              <p className="text-xs text-[var(--color-muted-foreground)]">Repaid</p>
              <p className="tnum text-lg font-semibold text-[var(--color-success)]">
                {percentage(clampZero(totalBorrowed - totalOutstanding), totalBorrowed).toFixed(0)}%
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="space-y-5">
        {loans.map((loan) => (
          <LoanPanel
            key={loan.id}
            loan={loan}
            state={stateFor(loan.id)}
            payments={payments.filter((p) => p.loanId === loan.id)}
            onEdit={() => setDialog(loan)}
            onDelete={() => setConfirmDelete(loan)}
          />
        ))}
      </div>

      {dialog && <LoanDialog loan={dialog === 'new' ? null : dialog} onClose={() => setDialog(null)} />}

      <ConfirmDialog
        open={confirmDelete !== null}
        onOpenChange={(open) => !open && setConfirmDelete(null)}
        title={`Delete ${confirmDelete?.loanName}?`}
        description="The loan and its payment history will be removed from PaisaTrack."
        onConfirm={async () => {
          if (!confirmDelete) return;
          await remove('loans', confirmDelete.id);
          toast.success('Loan deleted');
          setConfirmDelete(null);
        }}
      />
    </>
  );
}

// ---------------------------------------------------------------------------

function LoanPanel({
  loan,
  state,
  payments,
  onEdit,
  onDelete,
}: {
  loan: Loan;
  state?: LoanState;
  payments: LoanPayment[];
  onEdit: () => void;
  onDelete: () => void;
}) {
  const Icon = LOAN_ICONS[loan.type];

  // Fall back only if the page somehow did not resolve this loan.
  const resolved = state ?? resolveLoanState({ loan, payments });
  const { schedule, paidInstallments: paidCount, repaidPercent, nextDue: nextRow } = resolved;
  const today = todayISO();

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <div className="flex items-start gap-3">
          <div className="rounded-lg bg-[var(--color-muted)] p-2">
            <Icon className="h-5 w-5 text-[var(--color-primary)]" weight="duotone" />
          </div>
          <div>
            <CardTitle className="text-base">{loan.loanName}</CardTitle>
            <p className="mt-0.5 text-xs text-[var(--color-muted-foreground)]">
              {loan.lender} · {loan.interestRate}% p.a. · {loan.tenureMonths} months ·{' '}
              {humanise(loan.type)}
            </p>
          </div>
        </div>
        <div className="flex gap-0.5">
          <Button size="icon" variant="ghost" className="h-8 w-8" onClick={onEdit} aria-label="Edit loan">
            <EditIcon className="h-4 w-4" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-8 w-8 text-[var(--color-danger)]"
            onClick={onDelete}
            aria-label="Delete loan"
          >
            <DeleteIcon className="h-4 w-4" />
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-4">
          <div>
            <p className="text-xs text-[var(--color-muted-foreground)]">EMI</p>
            <Money value={loan.emiAmount} className="text-lg font-semibold" />
          </div>
          <div>
            <p className="text-xs text-[var(--color-muted-foreground)]">Outstanding</p>
            <Money value={resolved.outstandingPrincipal} className="text-lg font-semibold" />
          </div>
          <div>
            <p className="text-xs text-[var(--color-muted-foreground)]">Total interest</p>
            <Money value={schedule.totalInterest} className="text-lg font-semibold text-[var(--color-warning)]" />
          </div>
          <div>
            <p className="text-xs text-[var(--color-muted-foreground)]">Closes</p>
            <p className="text-lg font-semibold">{formatDate(schedule.lastPaymentDate).slice(3)}</p>
          </div>
        </div>

        <div>
          <div className="mb-1.5 flex justify-between text-xs">
            <span className="text-[var(--color-muted-foreground)]">
              {paidCount} of {schedule.months} instalments
              {resolved.source === 'PAYMENTS' ? ' recorded' : ' by date'}
            </span>
            <span className="font-medium">{repaidPercent.toFixed(0)}% repaid</span>
          </div>
          <Progress value={repaidPercent} barClassName="bg-[var(--color-success)]" />
        </div>

        {nextRow && (
          <p className="text-xs text-[var(--color-muted-foreground)]">
            Next EMI {formatDate(nextRow.dueDate)} — <Money value={nextRow.interestComponent} /> interest,{' '}
            <Money value={nextRow.principalComponent} /> principal.
          </p>
        )}

        <Tabs defaultValue="schedule">
          <TabsList>
            <TabsTrigger value="schedule">Schedule</TabsTrigger>
            <TabsTrigger value="prepay">Prepayment</TabsTrigger>
          </TabsList>

          <TabsContent value="schedule">
            <AmortizationTable
              loan={loan}
              schedule={schedule}
              today={today}
              payments={payments}
              paidInstallments={paidCount}
            />
          </TabsContent>

          <TabsContent value="prepay">
            <PrepaymentPlanner loan={loan} paidCount={paidCount} />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

function AmortizationTable({
  loan,
  schedule,
  today,
  payments,
  paidInstallments,
}: {
  loan: Loan;
  schedule: ReturnType<typeof generateAmortization>;
  today: string;
  payments: LoanPayment[];
  paidInstallments: number;
}) {
  const [showAll, setShowAll] = React.useState(false);
  const [busy, setBusy] = React.useState<number | null>(null);

  // Centre the window on where the loan actually is today.
  const firstUpcoming = Math.max(0, schedule.rows.findIndex((r) => r.dueDate > today) - 2);
  const rows = showAll ? schedule.rows : schedule.rows.slice(firstUpcoming, firstUpcoming + 12);

  async function markPaid(row: (typeof schedule.rows)[number]) {
    setBusy(row.installmentNumber);
    try {
      await create<LoanPayment>('loanPayments', 'lpay', {
        loanId: loan.id,
        paidOn: row.dueDate,
        amount: row.emi,
        principalComponent: row.principalComponent,
        interestComponent: row.interestComponent,
        isPrepayment: false,
        installmentNumber: row.installmentNumber,
      });
      // Keep the stored figure in step, so anything still reading the record
      // directly sees the same number the resolver computes.
      await update<Loan>('loans', loan.id, {
        outstandingPrincipal: row.closingBalance,
        ...(row.closingBalance <= 0 ? { isActive: false } : {}),
      });
      toast.success(
        row.closingBalance <= 0
          ? `EMI ${row.installmentNumber} recorded — loan closed`
          : `EMI ${row.installmentNumber} recorded`,
      );
    } finally {
      setBusy(null);
    }
  }

  async function undoPayment(installmentNumber: number) {
    const existing = payments.find(
      (p) => !p.isPrepayment && p.installmentNumber === installmentNumber,
    );
    if (!existing) return;

    setBusy(installmentNumber);
    try {
      await remove('loanPayments', existing.id);
      const previous = schedule.rows[installmentNumber - 2];
      await update<Loan>('loans', loan.id, {
        outstandingPrincipal: previous ? previous.closingBalance : loan.principalAmount,
        isActive: true,
      });
      toast.success(`EMI ${installmentNumber} un-recorded`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3">
      <Table>
        <THead>
          <TR>
            <TH className="w-10">#</TH>
            <TH>Due</TH>
            <TH className="text-right">EMI</TH>
            <TH className="text-right">Interest</TH>
            <TH className="text-right">Principal</TH>
            <TH className="text-right hidden sm:table-cell">Balance</TH>
            <TH className="w-24" />
          </TR>
        </THead>
        <TBody>
          {rows.map((row) => {
            const n = row.installmentNumber;
            const recorded = isInstallmentPaid(payments, loan.id, n);
            const due = row.dueDate <= today;
            // Only the very next unrecorded instalment can be marked, so the
            // ledger cannot develop holes.
            const isNext = n === paidInstallments + 1;

            return (
              <TR key={n} className={recorded ? 'opacity-70' : ''}>
                <TD className="tnum text-xs">{n}</TD>
                <TD className="text-xs">
                  {formatDate(row.dueDate)}
                  {recorded ? (
                    <Badge variant="success" className="ml-1.5">Paid</Badge>
                  ) : due ? (
                    <Badge variant="warning" className="ml-1.5">Due</Badge>
                  ) : null}
                </TD>
                <TD className="text-right"><Money value={row.emi} /></TD>
                <TD className="text-right text-[var(--color-warning)]">
                  <Money value={row.interestComponent} />
                </TD>
                <TD className="text-right text-[var(--color-success)]">
                  <Money value={row.principalComponent} />
                </TD>
                <TD className="hidden text-right sm:table-cell">
                  <Money value={row.closingBalance} />
                </TD>
                <TD className="text-right">
                  {recorded && n === paidInstallments ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy !== null}
                      onClick={() => void undoPayment(n)}
                      className="gap-1"
                    >
                      <UndoIcon className="h-3.5 w-3.5" />
                      Undo
                    </Button>
                  ) : isNext ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy !== null}
                      onClick={() => void markPaid(row)}
                      className="gap-1"
                    >
                      <PayIcon className="h-3.5 w-3.5" weight="bold" />
                      {busy === n ? 'Saving…' : 'Mark paid'}
                    </Button>
                  ) : null}
                </TD>
              </TR>
            );
          })}
        </TBody>
      </Table>

      <div className="flex items-center justify-between text-xs text-[var(--color-muted-foreground)]">
        <span>
          Over the full tenure you pay <Money value={schedule.totalInterest} className="font-medium" />{' '}
          in interest on a <Money value={loan.principalAmount} /> loan —{' '}
          {percentage(schedule.totalInterest, loan.principalAmount).toFixed(0)}% of what you borrowed.
        </span>
        <Button size="sm" variant="ghost" onClick={() => setShowAll((v) => !v)}>
          {showAll ? 'Show less' : `All ${schedule.rows.length}`}
        </Button>
      </div>
    </div>
  );
}

function PrepaymentPlanner({ loan, paidCount }: { loan: Loan; paidCount: number }) {
  const [amount, setAmount] = React.useState(toPaise(1_00_000));
  const [mode, setMode] = React.useState<'REDUCE_TENURE' | 'REDUCE_EMI'>('REDUCE_TENURE');

  const input = {
    principal: loan.principalAmount,
    annualRatePercent: loan.interestRate,
    tenureMonths: loan.tenureMonths,
    startDate: loan.startDate,
    emiDay: loan.emiDay,
    emiAmount: loan.emiAmount,
  };

  const result = React.useMemo(
    () =>
      simulatePrepayment(input, {
        afterInstallment: Math.max(1, paidCount),
        amount,
        mode,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [loan, amount, mode, paidCount],
  );

  const baseSchedule = React.useMemo(() => generateAmortization(input), [loan]); // eslint-disable-line react-hooks/exhaustive-deps
  const withSchedule = React.useMemo(
    () =>
      generateAmortization({
        ...input,
        prepayments: [{ afterInstallment: Math.max(1, paidCount), amount, mode }],
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [loan, amount, mode, paidCount],
  );

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Prepayment amount">
          <MoneyInput value={amount} onChange={setAmount} />
        </Field>
        <Field
          label="Take the saving as"
          hint={mode === 'REDUCE_TENURE' ? 'Usually the cheaper option.' : 'Lower EMI, same end date.'}
        >
          <Select value={mode} onValueChange={(v) => setMode(v as typeof mode)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="REDUCE_TENURE">A shorter tenure</SelectItem>
              <SelectItem value="REDUCE_EMI">A smaller EMI</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </div>

      {amount > 0 && (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="rounded-lg border border-[var(--color-success)]/40 bg-[var(--color-success)]/10 p-3">
              <p className="text-xs text-[var(--color-muted-foreground)]">Interest saved</p>
              <Money value={result.interestSaved} className="text-lg font-semibold text-[var(--color-success)]" />
            </div>
            <div className="rounded-lg border border-[var(--color-border)] p-3">
              <p className="text-xs text-[var(--color-muted-foreground)]">
                {mode === 'REDUCE_TENURE' ? 'Months saved' : 'New EMI'}
              </p>
              {mode === 'REDUCE_TENURE' ? (
                <p className="tnum text-lg font-semibold">
                  {result.monthsSaved} month{result.monthsSaved === 1 ? '' : 's'}
                </p>
              ) : (
                <Money value={result.newEmi} className="text-lg font-semibold" />
              )}
            </div>
            <div className="rounded-lg border border-[var(--color-border)] p-3">
              <p className="text-xs text-[var(--color-muted-foreground)]">Loan closes</p>
              <p className="text-lg font-semibold">
                {formatDate(result.withPrepayment.lastPaymentDate).slice(3)}
              </p>
            </div>
          </div>

          <BalanceOverTimeChart
            series={[
              {
                name: 'As scheduled',
                colour: CHART_COLOURS[4],
                points: baseSchedule.rows.map((r) => ({ month: r.installmentNumber, balance: r.closingBalance })),
              },
              {
                name: 'With prepayment',
                colour: CHART_COLOURS[0],
                points: withSchedule.rows.map((r) => ({ month: r.installmentNumber, balance: r.closingBalance })),
              },
            ]}
            height={220}
          />

          <div className="flex items-start gap-2 rounded-md border border-[var(--color-border)] p-3 text-xs">
            <TipIcon className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-warning)]" weight="duotone" />
            <p className="text-[var(--color-muted-foreground)]">
              Prepaying early saves far more than prepaying late, because the early instalments are
              almost all interest. Check your loan agreement for prepayment charges —
              floating-rate home loans to individuals cannot be charged, but fixed-rate and personal
              loans usually can.
            </p>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function LoanDialog({ loan, onClose }: { loan: Loan | null; onClose: () => void }) {
  const [form, setForm] = React.useState({
    loanName: loan?.loanName ?? '',
    lender: loan?.lender ?? '',
    type: loan?.type ?? ('PERSONAL' as LoanType),
    principalAmount: loan?.principalAmount ?? 0,
    interestRate: loan?.interestRate ?? 10.5,
    tenureMonths: loan?.tenureMonths ?? 48,
    startDate: loan?.startDate ?? todayISO(),
    emiDay: loan?.emiDay ?? 5,
    outstandingPrincipal: loan?.outstandingPrincipal ?? 0,
    emiOverride: loan?.emiAmount ?? 0,
    useComputedEmi: !loan,
  });
  const [error, setError] = React.useState<string | null>(null);

  const typeConfig = LOAN_TYPES.find((t) => t.value === form.type);
  const lenders = typeConfig?.key ? LENDERS[typeConfig.key] : [];

  const computedEmi = React.useMemo(() => {
    if (form.principalAmount <= 0 || form.tenureMonths <= 0) return 0;
    return calculateEMI(form.principalAmount, form.interestRate, form.tenureMonths);
  }, [form.principalAmount, form.interestRate, form.tenureMonths]);

  const emi = form.useComputedEmi ? computedEmi : form.emiOverride;

  // Sanity check: does the EMI they typed actually amortise this loan?
  const impliedTenure = React.useMemo(
    () => (emi > 0 ? tenureForEMI(form.principalAmount, form.interestRate, emi) : null),
    [emi, form.principalAmount, form.interestRate],
  );

  function pickLender(name: string) {
    const match = lenders.find((l) => l.name === name);
    setForm((f) => ({
      ...f,
      lender: name,
      // Mid-point of the published range is the honest default.
      ...(match ? { interestRate: Number(((match.rateMin + match.rateMax) / 2).toFixed(2)) } : {}),
    }));
  }

  async function save() {
    if (!form.loanName.trim()) return setError('Give the loan a name.');
    if (!form.lender.trim()) return setError('Pick a lender.');
    if (form.principalAmount <= 0) return setError('Enter the principal amount.');
    if (emi <= 0) return setError('The EMI works out to zero — check the rate and tenure.');

    const payload = {
      userId: 'user_sample',
      loanName: form.loanName.trim(),
      lender: form.lender,
      type: form.type,
      principalAmount: form.principalAmount,
      interestRate: form.interestRate,
      tenureMonths: form.tenureMonths,
      emiAmount: emi,
      startDate: form.startDate,
      emiDay: form.emiDay,
      outstandingPrincipal:
        form.outstandingPrincipal > 0 ? form.outstandingPrincipal : form.principalAmount,
      isActive: true,
    };

    if (loan) {
      await update<Loan>('loans', loan.id, payload);
      toast.success('Loan updated');
    } else {
      await create<Loan>('loans', 'loan', payload as Omit<Loan, 'id' | 'createdAt' | 'updatedAt' | 'deviceId' | 'deletedAt'>);
      toast.success('Loan added');
    }
    onClose();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{loan ? 'Edit loan' : 'Add a loan'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Loan type">
              <Select
                value={form.type}
                onValueChange={(v) => setForm((f) => ({ ...f, type: v as LoanType, lender: '' }))}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {LOAN_TYPES.map((t) => (
                    <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <Field label="Loan name" required>
              <Input
                value={form.loanName}
                onChange={(e) => setForm((f) => ({ ...f, loanName: e.target.value }))}
                placeholder="Flat purchase"
              />
            </Field>
          </div>

          <Field
            label="Lender"
            required
            hint={
              lenders.length > 0
                ? `Picking a lender fills in a typical rate — edit it to whatever you were actually sanctioned. Rates last refreshed ${LENDERS.lastUpdated}.`
                : undefined
            }
          >
            {lenders.length > 0 ? (
              <Select value={form.lender} onValueChange={pickLender}>
                <SelectTrigger><SelectValue placeholder="Choose a lender" /></SelectTrigger>
                <SelectContent>
                  <SelectLabel>Typical rate range</SelectLabel>
                  {lenders.map((l) => (
                    <SelectItem key={l.name} value={l.name}>
                      {l.name} — {l.rateMin}%–{l.rateMax}%
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                value={form.lender}
                onChange={(e) => setForm((f) => ({ ...f, lender: e.target.value }))}
                placeholder="Lender name"
              />
            )}
          </Field>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Principal" required>
              <MoneyInput
                value={form.principalAmount}
                onChange={(v) => setForm((f) => ({ ...f, principalAmount: v }))}
              />
            </Field>
            <Field label="Interest rate">
              <PercentInput
                value={form.interestRate}
                onChange={(v) => setForm((f) => ({ ...f, interestRate: v }))}
                max={40}
              />
            </Field>
            <Field label="Tenure (months)">
              <Input
                type="number"
                min={1}
                max={480}
                value={form.tenureMonths}
                onChange={(e) =>
                  setForm((f) => ({ ...f, tenureMonths: Math.max(1, Number(e.target.value) || 1) }))
                }
                className="tnum"
              />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="First disbursed">
              <Input
                type="date"
                value={form.startDate}
                onChange={(e) => setForm((f) => ({ ...f, startDate: e.target.value }))}
              />
            </Field>
            <Field label="EMI day">
              <DayInput value={form.emiDay} onChange={(v) => setForm((f) => ({ ...f, emiDay: v }))} />
            </Field>
            <Field
              label="EMI"
              hint={form.useComputedEmi ? 'Computed. Click to override.' : 'Using your figure.'}
            >
              <div className="flex gap-1">
                <MoneyInput
                  value={emi}
                  onChange={(v) => setForm((f) => ({ ...f, emiOverride: v, useComputedEmi: false }))}
                  showPreview={false}
                />
                {!form.useComputedEmi && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setForm((f) => ({ ...f, useComputedEmi: true }))}
                  >
                    Auto
                  </Button>
                )}
              </div>
            </Field>
          </div>

          {loan && (
            <Field
              label="Outstanding principal"
              hint="What you still owe today. Leave at zero to use the full principal."
            >
              <MoneyInput
                value={form.outstandingPrincipal}
                onChange={(v) => setForm((f) => ({ ...f, outstandingPrincipal: v }))}
              />
            </Field>
          )}

          {emi > 0 && form.principalAmount > 0 && (
            <div className="rounded-md border border-[var(--color-border)] p-3 text-xs">
              <p>
                <Money value={emi} className="font-medium" /> a month for {form.tenureMonths} months
                {impliedTenure === null ? (
                  <span className="text-[var(--color-danger)]">
                    {' '}— this EMI does not even cover the monthly interest, so the loan would never close.
                  </span>
                ) : (
                  <>
                    {' '}— <Money value={clampZero(emi * form.tenureMonths - form.principalAmount)} className="font-medium text-[var(--color-warning)]" />{' '}
                    of that is interest.
                    {!form.useComputedEmi && impliedTenure !== form.tenureMonths && (
                      <span className="text-[var(--color-muted-foreground)]">
                        {' '}At this EMI the loan actually runs {impliedTenure} months.
                      </span>
                    )}
                  </>
                )}
              </p>
            </div>
          )}

          {error && <p role="alert" className="text-sm text-[var(--color-danger)]">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void save()}>{loan ? 'Save changes' : 'Add loan'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
