/**
 * Income — salary sources, the CTC-to-in-hand calculator, and the new-vs-old
 * tax regime comparison for FY 2025-26.
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
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui';
import {
  DeleteIcon,
  EditIcon,
  IncomeIcon,
  PlusIcon,
  ScalesIcon,
  TipIcon,
  WarningIcon,
} from '@/components/icons';
import { PageHeader } from '@/components/layout/AppShell';
import { Money } from '@/components/Money';
import { DayInput, MoneyInput, PercentInput } from '@/components/MoneyInput';
import { CHART_COLOURS } from '@/components/LazyCharts';
import { useIncome, useSalaryProfile } from '@/hooks/useData';
import { create, remove, update } from '@/lib/db/repository';
import {
  calculateHRAExemption,
  compareTaxRegimes,
  ctcToInHand,
  monthlyEquivalent,
} from '@/lib/finance/salary';
import { financialYearLabel, todayISO } from '@/lib/finance/dates';
import { formatINR, percentage, sumMoney, toPaise } from '@/lib/finance/money';
import { cn, humanise } from '@/lib/utils';
import type { Income as IncomeRecord, IncomeFrequency, IncomeType, SalaryProfile } from '@/types';

const INCOME_TYPES: IncomeType[] = ['SALARY', 'FREELANCE', 'BONUS', 'INTEREST', 'RENTAL', 'OTHER'];
const FREQUENCIES: IncomeFrequency[] = ['MONTHLY', 'QUARTERLY', 'ANNUAL', 'ONE_TIME'];

export function Income() {
  const income = useIncome();
  const profile = useSalaryProfile();
  const [dialog, setDialog] = React.useState<IncomeRecord | 'new' | null>(null);
  const [confirmDelete, setConfirmDelete] = React.useState<IncomeRecord | null>(null);

  const active = income.filter((i) => i.isActive);
  const monthlyTotal = sumMoney(active.map((i) => monthlyEquivalent(i.amount, i.frequency)));
  const annualTotal = monthlyTotal * 12;

  return (
    <>
      <PageHeader
        title="Income"
        subtitle={
          active.length > 0
            ? `${formatINR(monthlyTotal)}/month · ${formatINR(annualTotal)} a year · ${financialYearLabel(new Date())}`
            : undefined
        }
        actions={
          <Button size="sm" onClick={() => setDialog('new')} className="gap-1.5">
            <PlusIcon className="h-4 w-4" weight="bold" />
            Add source
          </Button>
        }
      />

      <Tabs defaultValue="sources">
        <TabsList>
          <TabsTrigger value="sources">Sources</TabsTrigger>
          <TabsTrigger value="ctc">CTC calculator</TabsTrigger>
          <TabsTrigger value="tax">Tax regime</TabsTrigger>
        </TabsList>

        <TabsContent value="sources">
          <Card>
            {income.length === 0 ? (
              <EmptyState
                icon={IncomeIcon}
                title="No income sources"
                description="Add your salary and anything else that comes in — the dashboard uses this to work out what is left each month."
                action={<Button onClick={() => setDialog('new')}>Add your salary</Button>}
              />
            ) : (
              <>
                <CardContent className="pt-5">
                  <div className="grid gap-4 sm:grid-cols-3">
                    <div>
                      <p className="text-xs text-[var(--color-muted-foreground)]">Per month</p>
                      <Money value={monthlyTotal} className="text-xl font-semibold" animate />
                    </div>
                    <div>
                      <p className="text-xs text-[var(--color-muted-foreground)]">Per year</p>
                      <Money value={annualTotal} className="text-xl font-semibold" animate />
                    </div>
                    <div>
                      <p className="text-xs text-[var(--color-muted-foreground)]">Sources</p>
                      <p className="tnum text-xl font-semibold">{active.length}</p>
                    </div>
                  </div>
                </CardContent>

                <Table>
                  <THead>
                    <TR>
                      <TH>Source</TH>
                      <TH className="hidden sm:table-cell">Type</TH>
                      <TH>Frequency</TH>
                      <TH className="text-right">Amount</TH>
                      <TH className="text-right hidden md:table-cell">Per month</TH>
                      <TH className="w-20" />
                    </TR>
                  </THead>
                  <TBody>
                    {income.map((i) => (
                      <TR key={i.id} className={i.isActive ? '' : 'opacity-50'}>
                        <TD>
                          <p className="font-medium">{i.source}</p>
                          {i.creditedOn && (
                            <p className="text-xs text-[var(--color-muted-foreground)]">
                              Credited on day {i.creditedOn}
                            </p>
                          )}
                        </TD>
                        <TD className="hidden sm:table-cell">
                          <Badge variant="outline">{humanise(i.type)}</Badge>
                        </TD>
                        <TD className="text-xs">{humanise(i.frequency)}</TD>
                        <TD className="text-right"><Money value={i.amount} className="font-medium" /></TD>
                        <TD className="hidden text-right md:table-cell text-[var(--color-muted-foreground)]">
                          <Money value={monthlyEquivalent(i.amount, i.frequency)} />
                        </TD>
                        <TD>
                          <div className="flex justify-end gap-0.5">
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-7 w-7"
                              onClick={() => setDialog(i)}
                              aria-label={`Edit ${i.source}`}
                            >
                              <EditIcon className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-7 w-7 text-[var(--color-danger)]"
                              onClick={() => setConfirmDelete(i)}
                              aria-label={`Delete ${i.source}`}
                            >
                              <DeleteIcon className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </>
            )}
          </Card>
        </TabsContent>

        <TabsContent value="ctc">
          <CTCCalculator profile={profile} />
        </TabsContent>

        <TabsContent value="tax">
          <TaxComparison annualIncome={annualTotal} profile={profile} />
        </TabsContent>
      </Tabs>

      {dialog && (
        <IncomeDialog income={dialog === 'new' ? null : dialog} onClose={() => setDialog(null)} />
      )}

      <ConfirmDialog
        open={confirmDelete !== null}
        onOpenChange={(open) => !open && setConfirmDelete(null)}
        title={`Delete ${confirmDelete?.source}?`}
        description="This income source will no longer count towards your monthly totals."
        onConfirm={async () => {
          if (!confirmDelete) return;
          await remove('income', confirmDelete.id);
          toast.success('Income source deleted');
          setConfirmDelete(null);
        }}
      />
    </>
  );
}

// ---------------------------------------------------------------------------

function CTCCalculator({ profile }: { profile: SalaryProfile | undefined }) {
  const [form, setForm] = React.useState({
    ctcAnnual: profile?.ctcAnnual ?? toPaise(12_00_000),
    basicPercent: profile?.basicPercent ?? 45,
    hraPercent: profile?.hraPercent ?? 50,
    pfEmployeePercent: profile?.pfEmployeePercent ?? 12,
    professionalTaxMonthly: profile?.professionalTaxMonthly ?? toPaise(200),
    tdsMonthly: profile?.tdsMonthly ?? 0,
    capPfAtWageCeiling: false,
  });

  const b = React.useMemo(
    () =>
      ctcToInHand({
        ctcAnnual: form.ctcAnnual,
        basicPercent: form.basicPercent,
        hraPercent: form.hraPercent,
        pfEmployeePercent: form.pfEmployeePercent,
        pfEmployerPercent: form.pfEmployeePercent,
        professionalTaxMonthly: form.professionalTaxMonthly,
        tdsMonthly: form.tdsMonthly,
        capPfAtWageCeiling: form.capPfAtWageCeiling,
      }),
    [form],
  );

  async function saveProfile() {
    const payload = {
      userId: 'user_sample',
      ctcAnnual: form.ctcAnnual,
      basicPercent: form.basicPercent,
      hraPercent: form.hraPercent,
      pfEmployeePercent: form.pfEmployeePercent,
      pfEmployerPercent: form.pfEmployeePercent,
      gratuityPercent: 4.81,
      professionalTaxMonthly: form.professionalTaxMonthly,
      tdsMonthly: form.tdsMonthly,
      otherDeductionsMonthly: 0,
      inHandMonthly: b.inHandMonthly,
      effectiveFrom: todayISO(),
    };
    if (profile) {
      await update<SalaryProfile>('salaryProfile', profile.id, payload);
    } else {
      await create<SalaryProfile>('salaryProfile', 'salary', payload as Omit<SalaryProfile, 'id' | 'createdAt' | 'updatedAt' | 'deviceId' | 'deletedAt'>);
    }
    toast.success('Salary profile saved');
  }

  const components = [
    { label: 'Basic', value: b.monthly.basic, colour: CHART_COLOURS[0] },
    { label: 'HRA', value: b.monthly.hra, colour: CHART_COLOURS[1] },
    { label: 'Special allowance', value: b.monthly.specialAllowance, colour: CHART_COLOURS[2] },
  ];

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Your package</CardTitle>
          <p className="text-sm text-[var(--color-muted-foreground)]">
            HRA is a percentage of basic (50% in metros, 40% elsewhere), which is how Indian payslips
            are structured.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <Field label="Annual CTC" required>
            <MoneyInput
              value={form.ctcAnnual}
              onChange={(v) => setForm((f) => ({ ...f, ctcAnnual: v }))}
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Basic (% of CTC)">
              <PercentInput
                value={form.basicPercent}
                onChange={(v) => setForm((f) => ({ ...f, basicPercent: v }))}
              />
            </Field>
            <Field label="HRA (% of basic)">
              <PercentInput
                value={form.hraPercent}
                onChange={(v) => setForm((f) => ({ ...f, hraPercent: v }))}
              />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="PF (% of basic)">
              <PercentInput
                value={form.pfEmployeePercent}
                onChange={(v) => setForm((f) => ({ ...f, pfEmployeePercent: v }))}
                max={25}
              />
            </Field>
            <Field label="Professional tax / month">
              <MoneyInput
                value={form.professionalTaxMonthly}
                onChange={(v) => setForm((f) => ({ ...f, professionalTaxMonthly: v }))}
                showPreview={false}
              />
            </Field>
          </div>

          <Field label="TDS / month" hint="Leave at zero to see pre-tax take-home.">
            <MoneyInput
              value={form.tdsMonthly}
              onChange={(v) => setForm((f) => ({ ...f, tdsMonthly: v }))}
              showPreview={false}
            />
          </Field>

          {b.componentsExceedGross && (
            <div className="flex items-start gap-2 rounded-md border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 p-3 text-xs">
              <WarningIcon className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-warning)]" weight="fill" />
              <p>
                Basic plus HRA come to more than your gross pay at these percentages — the structure
                cannot exist as entered. Lower the basic or HRA percentage.
              </p>
            </div>
          )}

          <Button onClick={() => void saveProfile()} className="w-full">
            Save as my salary profile
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Monthly payslip</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-lg bg-[var(--color-muted)] p-4 text-center">
            <p className="text-xs text-[var(--color-muted-foreground)]">In hand, every month</p>
            <Money
              value={b.inHandMonthly}
              className="text-3xl font-semibold"
              animate
              data-testid="ctc-inhand"
            />
            <p className="mt-1 text-xs text-[var(--color-muted-foreground)]">
              <Money value={b.inHandAnnual} /> a year ·{' '}
              {percentage(b.inHandAnnual, b.ctcAnnual).toFixed(0)}% of CTC
            </p>
          </div>

          {/* Stacked bar showing how gross splits across the components. */}
          <div>
            <div className="mb-1.5 flex h-2.5 overflow-hidden rounded-full">
              {components.map((c) => (
                <div
                  key={c.label}
                  style={{
                    width: `${(c.value / Math.max(1, b.monthly.gross)) * 100}%`,
                    backgroundColor: c.colour,
                  }}
                  title={c.label}
                />
              ))}
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
              {components.map((c) => (
                <span key={c.label} className="flex items-center gap-1.5">
                  <span
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: c.colour }}
                    aria-hidden
                  />
                  <span className="text-[var(--color-muted-foreground)]">{c.label}</span>
                  <Money value={c.value} className="font-medium" />
                </span>
              ))}
            </div>
          </div>

          <Table>
            <TBody>
              <PayslipRow label="Basic" value={b.monthly.basic} />
              <PayslipRow label="HRA" value={b.monthly.hra} />
              <PayslipRow label="Special allowance" value={b.monthly.specialAllowance} />
              <PayslipRow label="Gross" value={b.monthly.gross} bold />
              <PayslipRow label="Employee PF" value={-b.monthly.employeePf} deduction />
              <PayslipRow label="Professional tax" value={-b.monthly.professionalTax} deduction />
              {b.monthly.tds > 0 && <PayslipRow label="TDS" value={-b.monthly.tds} deduction />}
              <PayslipRow label="In hand" value={b.monthly.inHand} bold />
            </TBody>
          </Table>

          <div className="flex items-start gap-2 rounded-md border border-[var(--color-border)] p-3 text-xs">
            <TipIcon className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-info)]" weight="duotone" />
            <p className="text-[var(--color-muted-foreground)]">
              Your employer also puts <Money value={b.monthly.employerPf} className="font-medium" /> a
              month into your PF and accrues{' '}
              <Money value={Math.round(b.gratuityAnnual / 12)} className="font-medium" /> towards
              gratuity. Both are part of your CTC but never reach your bank account.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function PayslipRow({
  label,
  value,
  bold,
  deduction,
}: {
  label: string;
  value: number;
  bold?: boolean;
  deduction?: boolean;
}) {
  return (
    <TR className={bold ? 'bg-[var(--color-muted)]/40' : ''}>
      <TD className={cn('text-sm', bold && 'font-semibold')}>{label}</TD>
      <TD className="text-right">
        <Money
          value={value}
          className={cn(
            bold && 'font-semibold',
            deduction && 'text-[var(--color-danger)]',
          )}
        />
      </TD>
    </TR>
  );
}

// ---------------------------------------------------------------------------

function TaxComparison({
  annualIncome,
  profile,
}: {
  annualIncome: number;
  profile: SalaryProfile | undefined;
}) {
  const [gross, setGross] = React.useState(
    profile?.ctcAnnual ? Math.round(profile.ctcAnnual * 0.92) : annualIncome || toPaise(12_00_000),
  );
  const [deductions, setDeductions] = React.useState({
    section80C: toPaise(1_50_000),
    section80CCD1B: 0,
    section80D: toPaise(25_000),
    homeLoanInterest: 0,
    rentPaidAnnual: 0,
    isMetro: true,
  });

  const basicAnnual = profile ? Math.round((profile.ctcAnnual * profile.basicPercent) / 100) : Math.round(gross * 0.45);
  const hraReceived = profile ? Math.round((basicAnnual * profile.hraPercent) / 100) : Math.round(basicAnnual * 0.5);

  const hraExemption = React.useMemo(
    () =>
      deductions.rentPaidAnnual > 0
        ? calculateHRAExemption({
            basicAnnual,
            hraReceivedAnnual: hraReceived,
            rentPaidAnnual: deductions.rentPaidAnnual,
            isMetro: deductions.isMetro,
          })
        : 0,
    [basicAnnual, hraReceived, deductions],
  );

  const comparison = React.useMemo(
    () =>
      compareTaxRegimes(gross, {
        section80C: deductions.section80C,
        section80CCD1B: deductions.section80CCD1B,
        section80D: deductions.section80D,
        homeLoanInterest: deductions.homeLoanInterest,
        hraExemption,
      }),
    [gross, deductions, hraExemption],
  );

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">New vs old regime, {financialYearLabel(new Date())}</CardTitle>
          <p className="text-sm text-[var(--color-muted-foreground)]">
            Slabs as revised in Budget 2025. The new regime ignores deductions entirely, so it wins
            unless yours are substantial.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <Field label="Gross annual salary" hint="Your CTC less employer PF and gratuity.">
            <MoneyInput value={gross} onChange={setGross} />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="80C" hint="PF, ELSS, insurance. Capped at ₹1.5L.">
              <MoneyInput
                value={deductions.section80C}
                onChange={(v) => setDeductions((d) => ({ ...d, section80C: v }))}
                showPreview={false}
              />
            </Field>
            <Field label="80CCD(1B) — NPS" hint="Capped at ₹50,000.">
              <MoneyInput
                value={deductions.section80CCD1B}
                onChange={(v) => setDeductions((d) => ({ ...d, section80CCD1B: v }))}
                showPreview={false}
              />
            </Field>
            <Field label="80D — health insurance" hint="Capped at ₹1L.">
              <MoneyInput
                value={deductions.section80D}
                onChange={(v) => setDeductions((d) => ({ ...d, section80D: v }))}
                showPreview={false}
              />
            </Field>
            <Field label="Home loan interest" hint="Section 24(b), capped at ₹2L.">
              <MoneyInput
                value={deductions.homeLoanInterest}
                onChange={(v) => setDeductions((d) => ({ ...d, homeLoanInterest: v }))}
                showPreview={false}
              />
            </Field>
            <Field label="Annual rent paid" hint={hraExemption > 0 ? `HRA exemption: ${formatINR(hraExemption)}` : 'For the HRA exemption.'}>
              <MoneyInput
                value={deductions.rentPaidAnnual}
                onChange={(v) => setDeductions((d) => ({ ...d, rentPaidAnnual: v }))}
                showPreview={false}
              />
            </Field>
            <Field label="City">
              <Select
                value={deductions.isMetro ? 'metro' : 'non'}
                onValueChange={(v) => setDeductions((d) => ({ ...d, isMetro: v === 'metro' }))}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="metro">Metro (50% of basic)</SelectItem>
                  <SelectItem value="non">Non-metro (40% of basic)</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-5 md:grid-cols-2">
        <RegimeCard
          title="New regime"
          computation={comparison.newRegime}
          recommended={comparison.recommended === 'NEW'}
        />
        <RegimeCard
          title="Old regime"
          computation={comparison.oldRegime}
          recommended={comparison.recommended === 'OLD'}
        />
      </div>

      <Card>
        <CardContent className="flex items-start gap-3 pt-5">
          <ScalesIcon className="mt-0.5 h-5 w-5 shrink-0 text-[var(--color-primary)]" weight="duotone" />
          <div>
            <p className="font-medium">
              The {comparison.recommended === 'NEW' ? 'new' : 'old'} regime saves you{' '}
              <Money value={comparison.savings} className="text-[var(--color-success)]" /> this year.
            </p>
            <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">{comparison.reason}</p>
            <p className="mt-2 text-xs text-[var(--color-muted-foreground)]">
              An estimate for planning, not tax advice. Surcharge and marginal relief are included;
              capital gains and perquisites are not.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function RegimeCard({
  title,
  computation,
  recommended,
}: {
  title: string;
  computation: ReturnType<typeof compareTaxRegimes>['newRegime'];
  recommended: boolean;
}) {
  return (
    <Card className={recommended ? 'border-[var(--color-primary)]/50' : ''}>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">{title}</CardTitle>
        {recommended && <Badge variant="success">Better for you</Badge>}
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="rounded-lg bg-[var(--color-muted)] p-3 text-center">
          <p className="text-xs text-[var(--color-muted-foreground)]">Total tax</p>
          <Money value={computation.totalTax} className="text-2xl font-semibold" animate />
          <p className="mt-0.5 text-xs text-[var(--color-muted-foreground)]">
            {computation.effectiveRatePercent.toFixed(1)}% effective ·{' '}
            <Money value={computation.monthlyTds} /> a month
          </p>
        </div>

        <Table>
          <TBody>
            <TaxRow label="Gross income" value={computation.grossIncome} />
            <TaxRow label="Standard deduction" value={-computation.standardDeduction} />
            {computation.otherDeductions > 0 && (
              <TaxRow label="Other deductions" value={-computation.otherDeductions} />
            )}
            <TaxRow label="Taxable income" value={computation.taxableIncome} bold />
            <TaxRow label="Tax on slabs" value={computation.taxBeforeRebate} />
            {computation.rebate > 0 && <TaxRow label="87A rebate" value={-computation.rebate} />}
            {computation.surcharge > 0 && <TaxRow label="Surcharge" value={computation.surcharge} />}
            <TaxRow label="Health & education cess" value={computation.cess} />
            <TaxRow label="Total tax" value={computation.totalTax} bold />
          </TBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function TaxRow({ label, value, bold }: { label: string; value: number; bold?: boolean }) {
  return (
    <TR className={bold ? 'bg-[var(--color-muted)]/40' : ''}>
      <TD className={cn('text-sm', bold && 'font-semibold')}>{label}</TD>
      <TD className="text-right">
        <Money value={value} className={bold ? 'font-semibold' : ''} />
      </TD>
    </TR>
  );
}

// ---------------------------------------------------------------------------

function IncomeDialog({ income, onClose }: { income: IncomeRecord | null; onClose: () => void }) {
  const [form, setForm] = React.useState({
    source: income?.source ?? '',
    type: income?.type ?? ('SALARY' as IncomeType),
    amount: income?.amount ?? 0,
    frequency: income?.frequency ?? ('MONTHLY' as IncomeFrequency),
    creditedOn: income?.creditedOn ?? 1,
    effectiveFrom: income?.effectiveFrom ?? todayISO(),
    isActive: income?.isActive ?? true,
  });
  const [error, setError] = React.useState<string | null>(null);

  async function save() {
    if (!form.source.trim()) return setError('Name the source.');
    if (form.amount <= 0) return setError('Enter the amount.');

    const payload = {
      userId: 'user_sample',
      source: form.source.trim(),
      type: form.type,
      amount: form.amount,
      frequency: form.frequency,
      ...(form.frequency === 'MONTHLY' ? { creditedOn: form.creditedOn } : {}),
      effectiveFrom: form.effectiveFrom,
      isActive: form.isActive,
    };

    if (income) {
      await update<IncomeRecord>('income', income.id, payload);
      toast.success('Income updated');
    } else {
      await create<IncomeRecord>('income', 'inc', payload as Omit<IncomeRecord, 'id' | 'createdAt' | 'updatedAt' | 'deviceId' | 'deletedAt'>);
      toast.success('Income added');
    }
    onClose();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{income ? 'Edit income' : 'Add an income source'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <Field label="Source" required>
            <Input
              value={form.source}
              onChange={(e) => setForm((f) => ({ ...f, source: e.target.value }))}
              placeholder="Monthly salary"
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Type">
              <Select value={form.type} onValueChange={(v) => setForm((f) => ({ ...f, type: v as IncomeType }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {INCOME_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>{humanise(t)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Frequency">
              <Select
                value={form.frequency}
                onValueChange={(v) => setForm((f) => ({ ...f, frequency: v as IncomeFrequency }))}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {FREQUENCIES.map((f) => (
                    <SelectItem key={f} value={f}>{humanise(f)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Amount" required>
              <MoneyInput value={form.amount} onChange={(v) => setForm((f) => ({ ...f, amount: v }))} />
            </Field>
            {form.frequency === 'MONTHLY' && (
              <Field label="Credited on" hint="Day of the month.">
                <DayInput
                  value={form.creditedOn}
                  onChange={(v) => setForm((f) => ({ ...f, creditedOn: v }))}
                />
              </Field>
            )}
          </div>

          <Field label="Effective from">
            <Input
              type="date"
              value={form.effectiveFrom}
              onChange={(e) => setForm((f) => ({ ...f, effectiveFrom: e.target.value }))}
            />
          </Field>

          {form.amount > 0 && form.frequency !== 'MONTHLY' && (
            <p className="text-xs text-[var(--color-muted-foreground)]">
              Counts as <Money value={monthlyEquivalent(form.amount, form.frequency)} className="font-medium" />{' '}
              a month on the dashboard.
            </p>
          )}

          {error && <p role="alert" className="text-sm text-[var(--color-danger)]">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void save()}>{income ? 'Save changes' : 'Add income'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
