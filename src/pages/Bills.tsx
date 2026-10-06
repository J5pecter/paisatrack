/**
 * Bills — recurring templates and the month-by-month entries they generate.
 *
 * Variable bills (electricity, gas) start at zero each month so you are
 * prompted for the real figure. Electricity additionally tracks units, which is
 * the only way to tell a consumption spike apart from a tariff rise.
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
  Switch,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from '@/components/ui';
import {
  BillIcon,
  CheckCircleIcon,
  CookIcon,
  DeleteIcon,
  DthIcon,
  EditIcon,
  ElectricityIcon,
  GasIcon,
  GymIcon,
  InsuranceIcon,
  InternetIcon,
  MaidIcon,
  MobileIcon,
  OtherIcon,
  PlusIcon,
  RentIcon,
  SubscriptionIcon,
  SyncIcon,
  TipIcon,
  WarningIcon,
  WaterIcon,
} from '@/components/icons';
import { PageHeader } from '@/components/layout/AppShell';
import { Money } from '@/components/Money';
import { DayInput, MoneyInput } from '@/components/MoneyInput';
import { UnitsAndAmountChart } from '@/components/LazyCharts';
import { useBillEntries, useBills } from '@/hooks/useData';
import { bulkPut, create, remove, update } from '@/lib/db/repository';
import {
  calculateElectricityRate,
  detectConsumptionSpike,
  electricitySeries,
  generateMonthlyBillEntries,
  totalMonthlyCommitment,
} from '@/lib/finance/bills';
import {
  dueLabel,
  formatDate,
  formatMonthKey,
  lastNMonths,
  monthKey,
  todayISO,
} from '@/lib/finance/dates';
import { formatINR, sumMoney } from '@/lib/finance/money';
import { cn, humanise } from '@/lib/utils';
import type { Bill, BillCategory, BillEntry, BillFrequency } from '@/types';

const CATEGORY_ICONS: Record<BillCategory, typeof BillIcon> = {
  RENT: RentIcon,
  ELECTRICITY: ElectricityIcon,
  WATER: WaterIcon,
  INTERNET: InternetIcon,
  MOBILE: MobileIcon,
  GAS: GasIcon,
  DTH: DthIcon,
  MAID: MaidIcon,
  COOK: CookIcon,
  GYM: GymIcon,
  SUBSCRIPTION: SubscriptionIcon,
  INSURANCE: InsuranceIcon,
  OTHER: OtherIcon,
};

const CATEGORIES = Object.keys(CATEGORY_ICONS) as BillCategory[];

export function Bills() {
  const bills = useBills();
  const allEntries = useBillEntries();
  const [month, setMonth] = React.useState(monthKey(new Date()));
  const [dialog, setDialog] = React.useState<Bill | 'new' | null>(null);
  const [payFor, setPayFor] = React.useState<{ bill: Bill; entry: BillEntry } | null>(null);
  const [confirmDelete, setConfirmDelete] = React.useState<Bill | null>(null);

  const months = React.useMemo(() => lastNMonths(12), []);
  const entries = React.useMemo(
    () => allEntries.filter((e) => e.billingMonth === month),
    [allEntries, month],
  );
  const billById = React.useMemo(() => new Map(bills.map((b) => [b.id, b])), [bills]);

  const rows = React.useMemo(
    () =>
      entries
        .map((entry) => ({ entry, bill: billById.get(entry.billId) }))
        .filter((r): r is { entry: BillEntry; bill: Bill } => Boolean(r.bill))
        .sort((a, b) => a.entry.dueDate.localeCompare(b.entry.dueDate)),
    [entries, billById],
  );

  const totalDue = sumMoney(rows.filter((r) => r.entry.status !== 'SKIPPED').map((r) => r.entry.amount));
  const unpaid = rows.filter((r) => r.entry.status === 'PENDING' || r.entry.status === 'OVERDUE');
  const unpaidTotal = sumMoney(unpaid.map((r) => r.entry.amount));

  // Electricity history for the units chart.
  const electricityBill = bills.find((b) => b.category === 'ELECTRICITY');
  const electricity = React.useMemo(
    () =>
      electricityBill
        ? electricitySeries(
            allEntries.filter((e) => e.billId === electricityBill.id),
            months,
          )
        : [],
    [allEntries, electricityBill, months],
  );
  const spike = React.useMemo(() => detectConsumptionSpike(electricity), [electricity]);

  async function generateMissing() {
    const missing = generateMonthlyBillEntries(bills, month, allEntries);
    if (missing.length === 0) {
      toast.info('Every bill for this month already has an entry.');
      return;
    }
    const now = new Date().toISOString();
    await bulkPut(
      'billEntries',
      missing.map((m) => ({
        ...m,
        id: `be_${crypto.randomUUID()}`,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      })) as BillEntry[],
    );
    toast.success(`Created ${missing.length} entr${missing.length === 1 ? 'y' : 'ies'} for ${formatMonthKey(month)}`);
  }

  if (bills.length === 0) {
    return (
      <>
        <PageHeader title="Bills" />
        <Card>
          <EmptyState
            icon={BillIcon}
            title="No bills set up"
            description="Add rent, electricity, internet and the rest once. PaisaTrack creates a fresh entry every month so nothing slips past its due date."
            action={<Button onClick={() => setDialog('new')}>Add a bill</Button>}
          />
        </Card>
        {dialog && <BillDialog bill={null} onClose={() => setDialog(null)} />}
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Bills"
        subtitle={`${formatINR(totalMonthlyCommitment(bills))} a month committed across ${bills.filter((b) => b.isActive).length} bills`}
        actions={
          <>
            <Select value={month} onValueChange={setMonth}>
              <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
              <SelectContent>
                {months.slice().reverse().map((m) => (
                  <SelectItem key={m} value={m}>{formatMonthKey(m)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" onClick={() => void generateMissing()} className="gap-1.5">
              <SyncIcon className="h-4 w-4" weight="bold" />
              <span className="hidden sm:inline">Generate month</span>
            </Button>
            <Button size="sm" onClick={() => setDialog('new')} className="gap-1.5">
              <PlusIcon className="h-4 w-4" weight="bold" />
              Add bill
            </Button>
          </>
        }
      />

      <div className="mb-5 grid gap-4 sm:grid-cols-3">
        <SummaryTile label={`${formatMonthKey(month)} total`} value={totalDue} />
        <SummaryTile label="Still to pay" value={unpaidTotal} tone={unpaidTotal > 0 ? 'warning' : 'good'} />
        <SummaryTile
          label="Overdue"
          value={sumMoney(rows.filter((r) => r.entry.status === 'OVERDUE').map((r) => r.entry.amount))}
          tone="danger"
        />
      </div>

      <Card className="mb-5">
        <CardHeader>
          <CardTitle className="text-base">{formatMonthKey(month)}</CardTitle>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <div className="py-8 text-center">
              <p className="text-sm text-[var(--color-muted-foreground)]">
                No entries for {formatMonthKey(month)} yet.
              </p>
              <Button variant="outline" size="sm" className="mt-3" onClick={() => void generateMissing()}>
                Generate them
              </Button>
            </div>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Bill</TH>
                  <TH className="hidden sm:table-cell">Due</TH>
                  <TH className="text-right">Amount</TH>
                  <TH>Status</TH>
                  <TH className="w-24" />
                </TR>
              </THead>
              <TBody>
                {rows.map(({ bill, entry }) => {
                  const Icon = CATEGORY_ICONS[bill.category];
                  return (
                    <TR key={entry.id}>
                      <TD>
                        <div className="flex items-center gap-2.5">
                          <Icon
                            className="h-4 w-4 shrink-0 text-[var(--color-muted-foreground)]"
                            weight="duotone"
                          />
                          <div className="min-w-0">
                            <p className="truncate font-medium">{bill.name}</p>
                            <p className="truncate text-xs text-[var(--color-muted-foreground)]">
                              {bill.provider ?? humanise(bill.category)}
                              {bill.isAutopay && ' · Autopay'}
                              {entry.unitsConsumed ? ` · ${entry.unitsConsumed} units` : ''}
                            </p>
                          </div>
                        </div>
                      </TD>
                      <TD className="hidden sm:table-cell text-xs">
                        {entry.status === 'PAID' ? formatDate(entry.dueDate) : dueLabel(entry.dueDate)}
                      </TD>
                      <TD className="text-right">
                        <Money value={entry.amount} className="font-medium" />
                        {entry.unitsConsumed ? (
                          <span className="block text-xs text-[var(--color-muted-foreground)]">
                            {formatINR(calculateElectricityRate(entry.unitsConsumed, entry.amount), { paise: true })}/unit
                          </span>
                        ) : null}
                      </TD>
                      <TD>
                        <Badge
                          variant={
                            entry.status === 'PAID' ? 'success'
                            : entry.status === 'OVERDUE' ? 'danger'
                            : entry.status === 'SKIPPED' ? 'outline'
                            : 'warning'
                          }
                        >
                          {humanise(entry.status)}
                        </Badge>
                      </TD>
                      <TD className="text-right">
                        {entry.status !== 'PAID' && (
                          <Button size="sm" variant="outline" onClick={() => setPayFor({ bill, entry })}>
                            {bill.type === 'VARIABLE' && entry.amount === 0 ? 'Enter' : 'Pay'}
                          </Button>
                        )}
                        {entry.status === 'PAID' && (
                          <CheckCircleIcon
                            className="ml-auto h-4 w-4 text-[var(--color-success)]"
                            weight="fill"
                          />
                        )}
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {electricityBill && electricity.some((e) => e.units > 0) && (
        <Card className="mb-5">
          <CardHeader>
            <CardTitle className="text-base">Electricity</CardTitle>
            <p className="text-sm text-[var(--color-muted-foreground)]">
              Units against cost, so a consumption spike is distinguishable from a tariff rise.
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            <UnitsAndAmountChart data={electricity} />
            {spike && (
              <div className="flex items-start gap-2 rounded-md border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 p-3 text-xs">
                <WarningIcon className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-warning)]" weight="fill" />
                <p>
                  {formatMonthKey(spike.month)} used {spike.units} units — {spike.increasePercent}% above
                  your {spike.averageUnits}-unit average. Worth checking whether something is running
                  that should not be.
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Bill templates</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {bills.map((bill) => {
              const Icon = CATEGORY_ICONS[bill.category];
              return (
                <div
                  key={bill.id}
                  className={cn(
                    'rounded-lg border border-[var(--color-border)] p-3',
                    !bill.isActive && 'opacity-50',
                  )}
                >
                  <div className="flex items-start gap-2.5">
                    <Icon className="mt-0.5 h-5 w-5 shrink-0 text-[var(--color-primary)]" weight="duotone" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{bill.name}</p>
                      <p className="text-xs text-[var(--color-muted-foreground)]">
                        {humanise(bill.frequency)} · day {bill.dueDay} ·{' '}
                        {bill.type === 'FIXED' ? formatINR(bill.defaultAmount) : 'variable'}
                      </p>
                    </div>
                    <div className="flex gap-0.5">
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7"
                        onClick={() => setDialog(bill)}
                        aria-label={`Edit ${bill.name}`}
                      >
                        <EditIcon className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 text-[var(--color-danger)]"
                        onClick={() => setConfirmDelete(bill)}
                        aria-label={`Delete ${bill.name}`}
                      >
                        <DeleteIcon className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                  {bill.isAutopay && (
                    <Badge variant="info" className="mt-2">Autopay</Badge>
                  )}
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {dialog && <BillDialog bill={dialog === 'new' ? null : dialog} onClose={() => setDialog(null)} />}
      {payFor && <PayBillDialog bill={payFor.bill} entry={payFor.entry} onClose={() => setPayFor(null)} />}

      <ConfirmDialog
        open={confirmDelete !== null}
        onOpenChange={(open) => !open && setConfirmDelete(null)}
        title={`Delete ${confirmDelete?.name}?`}
        description="Past entries stay in your history; no new months will be generated for this bill."
        onConfirm={async () => {
          if (!confirmDelete) return;
          await remove('bills', confirmDelete.id);
          toast.success('Bill deleted');
          setConfirmDelete(null);
        }}
      />
    </>
  );
}

function SummaryTile({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: number;
  tone?: 'neutral' | 'good' | 'warning' | 'danger';
}) {
  const colour =
    value === 0 ? ''
    : tone === 'danger' ? 'text-[var(--color-danger)]'
    : tone === 'warning' ? 'text-[var(--color-warning)]'
    : tone === 'good' ? 'text-[var(--color-success)]'
    : '';
  return (
    <Card>
      <CardContent className="pt-5">
        <p className="text-xs text-[var(--color-muted-foreground)]">{label}</p>
        <Money value={value} className={cn('text-xl font-semibold', colour)} animate />
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------

function BillDialog({ bill, onClose }: { bill: Bill | null; onClose: () => void }) {
  const [form, setForm] = React.useState({
    name: bill?.name ?? '',
    category: bill?.category ?? ('OTHER' as BillCategory),
    type: bill?.type ?? ('FIXED' as 'FIXED' | 'VARIABLE'),
    defaultAmount: bill?.defaultAmount ?? 0,
    frequency: bill?.frequency ?? ('MONTHLY' as BillFrequency),
    dueDay: bill?.dueDay ?? 5,
    anchorMonth: bill?.anchorMonth ?? new Date().getMonth() + 1,
    isAutopay: bill?.isAutopay ?? false,
    provider: bill?.provider ?? '',
    tracksUnits: bill?.tracksUnits ?? false,
    isActive: bill?.isActive ?? true,
  });
  const [error, setError] = React.useState<string | null>(null);

  function setCategory(category: BillCategory) {
    setForm((f) => ({
      ...f,
      category,
      // Electricity and gas vary month to month and are worth metering.
      type: category === 'ELECTRICITY' || category === 'GAS' || category === 'WATER' ? 'VARIABLE' : f.type,
      tracksUnits: category === 'ELECTRICITY' ? true : f.tracksUnits,
    }));
  }

  async function save() {
    if (!form.name.trim()) return setError('Give the bill a name.');
    if (form.type === 'FIXED' && form.defaultAmount <= 0) {
      return setError('A fixed bill needs an amount.');
    }

    const payload = {
      userId: 'user_sample',
      name: form.name.trim(),
      category: form.category,
      type: form.type,
      defaultAmount: form.defaultAmount,
      frequency: form.frequency,
      dueDay: form.dueDay,
      ...(form.frequency !== 'MONTHLY' ? { anchorMonth: form.anchorMonth } : {}),
      isAutopay: form.isAutopay,
      ...(form.provider.trim() ? { provider: form.provider.trim() } : {}),
      tracksUnits: form.tracksUnits,
      isActive: form.isActive,
    };

    if (bill) {
      await update<Bill>('bills', bill.id, payload);
      toast.success('Bill updated');
    } else {
      await create<Bill>('bills', 'bill', payload as Omit<Bill, 'id' | 'createdAt' | 'updatedAt' | 'deviceId' | 'deletedAt'>);
      toast.success('Bill added');
    }
    onClose();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{bill ? 'Edit bill' : 'Add a bill'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" required>
              <Input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Flat rent"
              />
            </Field>
            <Field label="Category">
              <Select value={form.category} onValueChange={(v) => setCategory(v as BillCategory)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c}>{humanise(c)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Amount varies each month?">
              <Select
                value={form.type}
                onValueChange={(v) => setForm((f) => ({ ...f, type: v as 'FIXED' | 'VARIABLE' }))}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="FIXED">No — same every time</SelectItem>
                  <SelectItem value="VARIABLE">Yes — ask me each month</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field
              label={form.type === 'FIXED' ? 'Amount' : 'Typical amount'}
              required={form.type === 'FIXED'}
            >
              <MoneyInput
                value={form.defaultAmount}
                onChange={(v) => setForm((f) => ({ ...f, defaultAmount: v }))}
              />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Frequency">
              <Select
                value={form.frequency}
                onValueChange={(v) => setForm((f) => ({ ...f, frequency: v as BillFrequency }))}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="MONTHLY">Monthly</SelectItem>
                  <SelectItem value="QUARTERLY">Quarterly</SelectItem>
                  <SelectItem value="ANNUAL">Annually</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Due day">
              <DayInput value={form.dueDay} onChange={(v) => setForm((f) => ({ ...f, dueDay: v }))} />
            </Field>
          </div>

          <Field label="Provider" hint="Optional — e.g. MSEDCL, Airtel, Jio.">
            <Input
              value={form.provider}
              onChange={(e) => setForm((f) => ({ ...f, provider: e.target.value }))}
            />
          </Field>

          <div className="space-y-3 rounded-md border border-[var(--color-border)] p-3">
            <label className="flex items-center justify-between gap-3 text-sm">
              <span>
                Autopay
                <span className="block text-xs text-[var(--color-muted-foreground)]">
                  Autopaid bills stay in the list but never nag you.
                </span>
              </span>
              <Switch
                checked={form.isAutopay}
                onCheckedChange={(v) => setForm((f) => ({ ...f, isAutopay: v }))}
              />
            </label>

            <label className="flex items-center justify-between gap-3 text-sm">
              <span>
                Track units
                <span className="block text-xs text-[var(--color-muted-foreground)]">
                  Records consumption so you can see the cost per unit.
                </span>
              </span>
              <Switch
                checked={form.tracksUnits}
                onCheckedChange={(v) => setForm((f) => ({ ...f, tracksUnits: v }))}
              />
            </label>
          </div>

          {error && <p role="alert" className="text-sm text-[var(--color-danger)]">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void save()}>{bill ? 'Save changes' : 'Add bill'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PayBillDialog({
  bill,
  entry,
  onClose,
}: {
  bill: Bill;
  entry: BillEntry;
  onClose: () => void;
}) {
  const [amount, setAmount] = React.useState(entry.amount || bill.defaultAmount);
  const [units, setUnits] = React.useState(entry.unitsConsumed ?? 0);
  const [paidOn, setPaidOn] = React.useState(todayISO());

  const rate = units > 0 ? calculateElectricityRate(units, amount) : 0;

  async function save(markPaid: boolean) {
    if (amount <= 0) {
      toast.error('Enter the amount.');
      return;
    }
    await update<BillEntry>('billEntries', entry.id, {
      amount,
      ...(bill.tracksUnits ? { unitsConsumed: units } : {}),
      ...(markPaid ? { paidOn, status: 'PAID' as const } : { status: entry.status }),
    });
    toast.success(markPaid ? `${bill.name} marked paid` : 'Amount saved');
    onClose();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{bill.name}</DialogTitle>
          <p className="text-sm text-[var(--color-muted-foreground)]">
            {formatMonthKey(entry.billingMonth)} · due {formatDate(entry.dueDate)}
          </p>
        </DialogHeader>

        <div className="space-y-4">
          <Field label="Amount" required>
            <MoneyInput value={amount} onChange={setAmount} />
          </Field>

          {bill.tracksUnits && (
            <Field
              label="Units consumed"
              hint={rate > 0 ? `${formatINR(rate, { paise: true })} per unit` : undefined}
            >
              <Input
                type="number"
                min={0}
                value={units || ''}
                onChange={(e) => setUnits(Math.max(0, Number(e.target.value) || 0))}
                className="tnum"
                placeholder="0"
              />
            </Field>
          )}

          <Field label="Paid on">
            <Input type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
          </Field>

          {bill.isAutopay && (
            <div className="flex items-start gap-2 rounded-md border border-[var(--color-border)] p-3 text-xs">
              <TipIcon className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-info)]" weight="duotone" />
              <p className="text-[var(--color-muted-foreground)]">
                This bill is on autopay — record the amount so your spending totals stay accurate.
              </p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button variant="secondary" onClick={() => void save(false)}>Save amount only</Button>
          <Button onClick={() => void save(true)}>Mark paid</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
