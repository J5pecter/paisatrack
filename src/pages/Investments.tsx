/**
 * Investments and goals.
 *
 * Invested versus current value for each holding, and for each goal the one
 * number that matters: what you need to put aside every month to land on the
 * target date.
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
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui';
import {
  CoinsIcon,
  DeleteIcon,
  EditIcon,
  GoalIcon,
  InvestmentIcon,
  PlusIcon,
  ShieldIcon,
  TipIcon,
  TrendDownIcon,
  TrendUpIcon,
} from '@/components/icons';
import { PageHeader } from '@/components/layout/AppShell';
import { Money } from '@/components/Money';
import { MoneyInput } from '@/components/MoneyInput';
import { CategoryDonut } from '@/components/LazyCharts';
import { useGoals, useInvestments } from '@/hooks/useData';
import { create, remove, update } from '@/lib/db/repository';
import { goalProgress } from '@/lib/finance/dashboard';
import { formatDate, todayISO } from '@/lib/finance/dates';
import { formatINR, percentage, sumMoney } from '@/lib/finance/money';
import { cn, humanise } from '@/lib/utils';
import type { Goal, GoalType, Investment, InvestmentType } from '@/types';

const INVESTMENT_TYPES: InvestmentType[] = [
  'SIP', 'MUTUAL_FUND', 'STOCKS', 'PPF', 'EPF', 'FD', 'RD',
  'NPS', 'GOLD', 'CRYPTO', 'EMERGENCY_FUND', 'OTHER',
];

const GOAL_TYPES: GoalType[] = ['EMERGENCY_FUND', 'PURCHASE', 'TRAVEL', 'DEBT_FREE', 'INVESTMENT', 'OTHER'];

export function Investments() {
  const investments = useInvestments();
  const goals = useGoals();
  const [invDialog, setInvDialog] = React.useState<Investment | 'new' | null>(null);
  const [goalDialog, setGoalDialog] = React.useState<Goal | 'new' | null>(null);
  const [confirmDelete, setConfirmDelete] = React.useState<
    { kind: 'investment' | 'goal'; id: string; name: string } | null
  >(null);

  const invested = sumMoney(investments.map((i) => i.investedAmount));
  const current = sumMoney(investments.map((i) => i.currentValue));
  const gains = current - invested;
  const monthlyContribution = sumMoney(investments.map((i) => i.monthlyContribution));

  const allocation = React.useMemo(
    () =>
      investments.map((i) => ({
        category: i.type as unknown as never,
        amount: i.currentValue,
        count: 1,
        percent: percentage(i.currentValue, current),
      })),
    [investments, current],
  );

  const progress = React.useMemo(() => goalProgress(goals), [goals]);

  return (
    <>
      <PageHeader
        title="Investments"
        subtitle={
          investments.length > 0
            ? `${formatINR(current)} across ${investments.length} holding${investments.length === 1 ? '' : 's'} · ${formatINR(monthlyContribution)}/month going in`
            : undefined
        }
      />

      <Tabs defaultValue="holdings">
        <TabsList>
          <TabsTrigger value="holdings">Holdings</TabsTrigger>
          <TabsTrigger value="goals">Goals</TabsTrigger>
        </TabsList>

        <TabsContent value="holdings" className="space-y-5">
          {investments.length === 0 ? (
            <Card>
              <EmptyState
                icon={InvestmentIcon}
                title="No investments tracked"
                description="Add your SIPs, mutual funds, PPF and emergency fund to see them in your net worth."
                action={<Button onClick={() => setInvDialog('new')}>Add an investment</Button>}
              />
            </Card>
          ) : (
            <>
              <div className="grid gap-4 sm:grid-cols-4">
                <SummaryTile label="Invested" value={invested} />
                <SummaryTile label="Current value" value={current} />
                <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-4">
                  <p className="text-xs text-[var(--color-muted-foreground)]">Gains</p>
                  <div className="flex items-center gap-1.5">
                    <Money
                      value={gains}
                      className="text-xl font-semibold"
                      colour
                      showSign
                      animate
                    />
                    {gains !== 0 &&
                      (gains > 0 ? (
                        <TrendUpIcon className="h-4 w-4 text-[var(--color-success)]" weight="bold" />
                      ) : (
                        <TrendDownIcon className="h-4 w-4 text-[var(--color-danger)]" weight="bold" />
                      ))}
                  </div>
                  <p className="mt-0.5 text-xs text-[var(--color-muted-foreground)]">
                    {invested > 0 ? `${percentage(gains, invested).toFixed(1)}% return` : '—'}
                  </p>
                </div>
                <SummaryTile label="Monthly SIP" value={monthlyContribution} />
              </div>

              <div className="grid gap-5 lg:grid-cols-3">
                <Card className="lg:col-span-2">
                  <CardHeader className="flex-row items-center justify-between space-y-0">
                    <CardTitle className="text-base">Holdings</CardTitle>
                    <Button size="sm" onClick={() => setInvDialog('new')} className="gap-1.5">
                      <PlusIcon className="h-4 w-4" weight="bold" />
                      Add
                    </Button>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {investments.map((inv) => {
                      const gain = inv.currentValue - inv.investedAmount;
                      const gainPct = percentage(gain, inv.investedAmount);
                      return (
                        <div
                          key={inv.id}
                          className="rounded-lg border border-[var(--color-border)] p-3.5"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <p className="truncate font-medium">{inv.name}</p>
                              <p className="text-xs text-[var(--color-muted-foreground)]">
                                {humanise(inv.type)}
                                {inv.monthlyContribution > 0 &&
                                  ` · ${formatINR(inv.monthlyContribution)}/month`}
                                {' · since '}
                                {formatDate(inv.startDate).slice(3)}
                              </p>
                            </div>
                            <div className="flex shrink-0 gap-0.5">
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-7 w-7"
                                onClick={() => setInvDialog(inv)}
                                aria-label={`Edit ${inv.name}`}
                              >
                                <EditIcon className="h-3.5 w-3.5" />
                              </Button>
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-7 w-7 text-[var(--color-danger)]"
                                onClick={() =>
                                  setConfirmDelete({ kind: 'investment', id: inv.id, name: inv.name })
                                }
                                aria-label={`Delete ${inv.name}`}
                              >
                                <DeleteIcon className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          </div>

                          <div className="mt-2.5 flex flex-wrap items-baseline gap-x-5 gap-y-1 text-sm">
                            <span>
                              <span className="text-xs text-[var(--color-muted-foreground)]">Value </span>
                              <Money value={inv.currentValue} className="font-semibold" />
                            </span>
                            <span>
                              <span className="text-xs text-[var(--color-muted-foreground)]">Invested </span>
                              <Money value={inv.investedAmount} />
                            </span>
                            <span className="ml-auto">
                              <Money value={gain} colour showSign className="font-medium" />
                              <span
                                className={cn(
                                  'ml-1 text-xs',
                                  gain >= 0
                                    ? 'text-[var(--color-success)]'
                                    : 'text-[var(--color-danger)]',
                                )}
                              >
                                ({gainPct >= 0 ? '+' : ''}
                                {gainPct.toFixed(1)}%)
                              </span>
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Allocation</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <CategoryDonut data={allocation} height={220} />
                  </CardContent>
                </Card>
              </div>
            </>
          )}
        </TabsContent>

        <TabsContent value="goals" className="space-y-5">
          {goals.length === 0 ? (
            <Card>
              <EmptyState
                icon={GoalIcon}
                title="No goals set"
                description="Set a target and a date, and PaisaTrack works out what you need to put aside each month to get there."
                action={<Button onClick={() => setGoalDialog('new')}>Set a goal</Button>}
              />
            </Card>
          ) : (
            <>
              <div className="flex justify-end">
                <Button size="sm" onClick={() => setGoalDialog('new')} className="gap-1.5">
                  <PlusIcon className="h-4 w-4" weight="bold" />
                  Add goal
                </Button>
              </div>

              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {progress.map((p) => (
                  <Card key={p.goal.id}>
                    <CardContent className="pt-5">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-start gap-2.5 min-w-0">
                          {p.goal.type === 'EMERGENCY_FUND' ? (
                            <ShieldIcon className="mt-0.5 h-5 w-5 shrink-0 text-[var(--color-primary)]" weight="duotone" />
                          ) : (
                            <GoalIcon className="mt-0.5 h-5 w-5 shrink-0 text-[var(--color-primary)]" weight="duotone" />
                          )}
                          <div className="min-w-0">
                            <p className="truncate font-medium">{p.goal.name}</p>
                            <p className="text-xs text-[var(--color-muted-foreground)]">
                              by {formatDate(p.goal.targetDate)}
                            </p>
                          </div>
                        </div>
                        <div className="flex shrink-0 gap-0.5">
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7"
                            onClick={() => setGoalDialog(p.goal)}
                            aria-label={`Edit ${p.goal.name}`}
                          >
                            <EditIcon className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7 text-[var(--color-danger)]"
                            onClick={() =>
                              setConfirmDelete({ kind: 'goal', id: p.goal.id, name: p.goal.name })
                            }
                            aria-label={`Delete ${p.goal.name}`}
                          >
                            <DeleteIcon className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>

                      <div className="mt-3">
                        <div className="mb-1.5 flex items-baseline justify-between text-sm">
                          <Money value={p.goal.currentAmount} className="font-semibold" />
                          <span className="text-xs text-[var(--color-muted-foreground)]">
                            of <Money value={p.goal.targetAmount} />
                          </span>
                        </div>
                        <Progress
                          value={p.percentComplete}
                          barClassName={
                            p.percentComplete >= 100
                              ? 'bg-[var(--color-success)]'
                              : 'bg-[var(--color-primary)]'
                          }
                        />
                      </div>

                      <div className="mt-2.5 flex items-center justify-between text-xs">
                        <span className="font-medium">{p.percentComplete.toFixed(0)}%</span>
                        {p.remaining === 0 ? (
                          <Badge variant="success">Reached</Badge>
                        ) : p.monthsLeft === 0 ? (
                          <Badge variant="danger">Date passed</Badge>
                        ) : (
                          <span className="text-[var(--color-muted-foreground)]">
                            <Money value={p.monthlyNeeded} className="font-medium" />/month for{' '}
                            {p.monthsLeft} month{p.monthsLeft === 1 ? '' : 's'}
                          </span>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>

              <div className="flex items-start gap-2 rounded-md border border-[var(--color-border)] p-3 text-xs">
                <TipIcon className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-info)]" weight="duotone" />
                <p className="text-[var(--color-muted-foreground)]">
                  A six-month emergency fund comes before everything else — it is what stops the next
                  surprise turning into credit card debt at 45% a year.
                </p>
              </div>
            </>
          )}
        </TabsContent>
      </Tabs>

      {invDialog && (
        <InvestmentDialog
          investment={invDialog === 'new' ? null : invDialog}
          onClose={() => setInvDialog(null)}
        />
      )}
      {goalDialog && (
        <GoalDialog goal={goalDialog === 'new' ? null : goalDialog} onClose={() => setGoalDialog(null)} />
      )}

      <ConfirmDialog
        open={confirmDelete !== null}
        onOpenChange={(open) => !open && setConfirmDelete(null)}
        title={`Delete ${confirmDelete?.name}?`}
        description="This will be removed from your net worth."
        onConfirm={async () => {
          if (!confirmDelete) return;
          await remove(confirmDelete.kind === 'investment' ? 'investments' : 'goals', confirmDelete.id);
          toast.success('Deleted');
          setConfirmDelete(null);
        }}
      />
    </>
  );
}

function SummaryTile({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <CardContent className="pt-5">
        <p className="text-xs text-[var(--color-muted-foreground)]">{label}</p>
        <Money value={value} className="text-xl font-semibold" animate />
      </CardContent>
    </Card>
  );
}

function InvestmentDialog({
  investment,
  onClose,
}: {
  investment: Investment | null;
  onClose: () => void;
}) {
  const [form, setForm] = React.useState({
    name: investment?.name ?? '',
    type: investment?.type ?? ('SIP' as InvestmentType),
    investedAmount: investment?.investedAmount ?? 0,
    currentValue: investment?.currentValue ?? 0,
    monthlyContribution: investment?.monthlyContribution ?? 0,
    startDate: investment?.startDate ?? todayISO(),
  });
  const [error, setError] = React.useState<string | null>(null);

  const gain = form.currentValue - form.investedAmount;

  async function save() {
    if (!form.name.trim()) return setError('Name the investment.');
    if (form.investedAmount <= 0) return setError('Enter how much you have put in.');

    const payload = {
      userId: 'user_sample',
      name: form.name.trim(),
      type: form.type,
      investedAmount: form.investedAmount,
      currentValue: form.currentValue > 0 ? form.currentValue : form.investedAmount,
      monthlyContribution: form.monthlyContribution,
      startDate: form.startDate,
    };

    if (investment) {
      await update<Investment>('investments', investment.id, payload);
      toast.success('Investment updated');
    } else {
      await create<Investment>('investments', 'inv', payload as Omit<Investment, 'id' | 'createdAt' | 'updatedAt' | 'deviceId' | 'deletedAt'>);
      toast.success('Investment added');
    }
    onClose();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{investment ? 'Edit investment' : 'Add an investment'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" required>
              <Input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Parag Parikh Flexi Cap"
              />
            </Field>
            <Field label="Type">
              <Select
                value={form.type}
                onValueChange={(v) => setForm((f) => ({ ...f, type: v as InvestmentType }))}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {INVESTMENT_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>{humanise(t)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Total invested" required>
              <MoneyInput
                value={form.investedAmount}
                onChange={(v) => setForm((f) => ({ ...f, investedAmount: v }))}
              />
            </Field>
            <Field label="Current value" hint="Leave blank to use the invested amount.">
              <MoneyInput
                value={form.currentValue}
                onChange={(v) => setForm((f) => ({ ...f, currentValue: v }))}
              />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Monthly contribution" hint="Your SIP amount, if any.">
              <MoneyInput
                value={form.monthlyContribution}
                onChange={(v) => setForm((f) => ({ ...f, monthlyContribution: v }))}
                showPreview={false}
              />
            </Field>
            <Field label="Started">
              <Input
                type="date"
                value={form.startDate}
                onChange={(e) => setForm((f) => ({ ...f, startDate: e.target.value }))}
              />
            </Field>
          </div>

          {form.currentValue > 0 && form.investedAmount > 0 && (
            <div className="rounded-md border border-[var(--color-border)] p-3 text-sm">
              <span className="text-[var(--color-muted-foreground)]">Unrealised </span>
              <Money value={gain} colour showSign className="font-medium" />
              <span className="text-[var(--color-muted-foreground)]">
                {' '}({percentage(gain, form.investedAmount).toFixed(1)}%)
              </span>
            </div>
          )}

          {error && <p role="alert" className="text-sm text-[var(--color-danger)]">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void save()}>{investment ? 'Save changes' : 'Add investment'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function GoalDialog({ goal, onClose }: { goal: Goal | null; onClose: () => void }) {
  const [form, setForm] = React.useState({
    name: goal?.name ?? '',
    type: goal?.type ?? ('PURCHASE' as GoalType),
    targetAmount: goal?.targetAmount ?? 0,
    currentAmount: goal?.currentAmount ?? 0,
    targetDate: goal?.targetDate ?? todayISO(),
  });
  const [error, setError] = React.useState<string | null>(null);

  const monthsLeft = React.useMemo(() => {
    const target = new Date(form.targetDate);
    const now = new Date();
    return Math.max(
      0,
      (target.getFullYear() - now.getFullYear()) * 12 + (target.getMonth() - now.getMonth()),
    );
  }, [form.targetDate]);

  const needed =
    monthsLeft > 0 ? Math.ceil(Math.max(0, form.targetAmount - form.currentAmount) / monthsLeft) : 0;

  async function save() {
    if (!form.name.trim()) return setError('Name the goal.');
    if (form.targetAmount <= 0) return setError('Enter a target amount.');

    const payload = {
      userId: 'user_sample',
      name: form.name.trim(),
      type: form.type,
      targetAmount: form.targetAmount,
      currentAmount: form.currentAmount,
      targetDate: form.targetDate,
    };

    if (goal) {
      await update<Goal>('goals', goal.id, payload);
      toast.success('Goal updated');
    } else {
      await create<Goal>('goals', 'goal', payload as Omit<Goal, 'id' | 'createdAt' | 'updatedAt' | 'deviceId' | 'deletedAt'>);
      toast.success('Goal set');
    }
    onClose();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{goal ? 'Edit goal' : 'Set a goal'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Goal" required>
              <Input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="6-month emergency fund"
              />
            </Field>
            <Field label="Type">
              <Select value={form.type} onValueChange={(v) => setForm((f) => ({ ...f, type: v as GoalType }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {GOAL_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>{humanise(t)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Target amount" required>
              <MoneyInput
                value={form.targetAmount}
                onChange={(v) => setForm((f) => ({ ...f, targetAmount: v }))}
              />
            </Field>
            <Field label="Saved so far">
              <MoneyInput
                value={form.currentAmount}
                onChange={(v) => setForm((f) => ({ ...f, currentAmount: v }))}
              />
            </Field>
          </div>

          <Field label="Target date">
            <Input
              type="date"
              value={form.targetDate}
              onChange={(e) => setForm((f) => ({ ...f, targetDate: e.target.value }))}
            />
          </Field>

          {needed > 0 && (
            <div className="flex items-start gap-2 rounded-md border border-[var(--color-border)] p-3 text-sm">
              <CoinsIcon className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-primary)]" weight="duotone" />
              <p>
                You need <Money value={needed} className="font-semibold" /> a month for the next{' '}
                {monthsLeft} month{monthsLeft === 1 ? '' : 's'} to hit this.
              </p>
            </div>
          )}

          {error && <p role="alert" className="text-sm text-[var(--color-danger)]">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void save()}>{goal ? 'Save changes' : 'Set goal'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
