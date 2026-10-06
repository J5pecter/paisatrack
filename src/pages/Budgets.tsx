/**
 * Budgets — a monthly limit per category, and the safe-to-spend number that
 * falls out of it.
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
  Progress,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from '@/components/ui';
import {
  BudgetIcon,
  DeleteIcon,
  DuplicateIcon,
  EditIcon,
  PlusIcon,
  TipIcon,
  WarningIcon,
} from '@/components/icons';
import { PageHeader } from '@/components/layout/AppShell';
import { Money } from '@/components/Money';
import { MoneyInput } from '@/components/MoneyInput';
import { useBudgets, useExpenses } from '@/hooks/useData';
import { bulkPut, create, remove, update } from '@/lib/db/repository';
import { budgetProgress, safeToSpend, spendByCategory } from '@/lib/finance/dashboard';
import { formatMonthKey, lastNMonths, monthKey } from '@/lib/finance/dates';
import { clampZero, formatINR, sumMoney } from '@/lib/finance/money';
import { EXPENSE_CATEGORIES } from '@/components/QuickAdd';
import { cn, humanise } from '@/lib/utils';
import type { Budget, ExpenseCategory } from '@/types';

export function Budgets() {
  const allBudgets = useBudgets();
  const expenses = useExpenses();
  const [month, setMonth] = React.useState(monthKey(new Date()));
  const [dialog, setDialog] = React.useState<Budget | 'new' | null>(null);
  const [confirmDelete, setConfirmDelete] = React.useState<Budget | null>(null);

  const months = React.useMemo(() => lastNMonths(6).concat(monthKey(new Date())), []);
  const uniqueMonths = React.useMemo(() => [...new Set(months)].reverse(), [months]);

  const progress = React.useMemo(
    () => budgetProgress(allBudgets, expenses, month),
    [allBudgets, expenses, month],
  );
  const safe = React.useMemo(
    () => safeToSpend(allBudgets, expenses, month),
    [allBudgets, expenses, month],
  );

  const totalLimit = sumMoney(progress.map((p) => p.budget.limitAmount));
  const totalSpent = sumMoney(progress.map((p) => p.spent));
  const overBudget = progress.filter((p) => p.isOver);

  // Categories with spend this month but no budget set — the obvious next thing to do.
  const unbudgeted = React.useMemo(() => {
    const budgeted = new Set(progress.map((p) => p.budget.category));
    return spendByCategory(expenses, month).filter((c) => !budgeted.has(c.category)).slice(0, 5);
  }, [progress, expenses, month]);

  async function copyLastMonth() {
    const previous = lastNMonths(2)[0];
    const source = allBudgets.filter((b) => b.month === previous);
    if (source.length === 0) {
      toast.info(`No budgets set for ${formatMonthKey(previous)} to copy.`);
      return;
    }
    const existing = new Set(progress.map((p) => p.budget.category));
    const toCopy = source.filter((b) => !existing.has(b.category));
    if (toCopy.length === 0) {
      toast.info('Every category from last month already has a budget here.');
      return;
    }
    const now = new Date().toISOString();
    await bulkPut(
      'budgets',
      toCopy.map((b) => ({
        ...b,
        id: `budget_${crypto.randomUUID()}`,
        month,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      })),
    );
    toast.success(`Copied ${toCopy.length} budget${toCopy.length === 1 ? '' : 's'}`);
  }

  return (
    <>
      <PageHeader
        title="Budgets"
        subtitle={
          totalLimit > 0
            ? `${formatINR(totalSpent)} of ${formatINR(totalLimit)} used in ${formatMonthKey(month)}`
            : undefined
        }
        actions={
          <>
            <Select value={month} onValueChange={setMonth}>
              <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
              <SelectContent>
                {uniqueMonths.map((m) => (
                  <SelectItem key={m} value={m}>{formatMonthKey(m)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" onClick={() => void copyLastMonth()} className="gap-1.5">
              <DuplicateIcon className="h-4 w-4" weight="bold" />
              <span className="hidden sm:inline">Copy last month</span>
            </Button>
            <Button size="sm" onClick={() => setDialog('new')} className="gap-1.5">
              <PlusIcon className="h-4 w-4" weight="bold" />
              Set budget
            </Button>
          </>
        }
      />

      {progress.length === 0 ? (
        <Card>
          <EmptyState
            icon={BudgetIcon}
            title={`No budgets for ${formatMonthKey(month)}`}
            description="Set a limit per category and PaisaTrack will tell you how much you can safely spend each remaining day of the month."
            action={<Button onClick={() => setDialog('new')}>Set your first budget</Button>}
          />
        </Card>
      ) : (
        <>
          <Card className="mb-5">
            <CardContent className="pt-5">
              <div className="grid gap-4 sm:grid-cols-3">
                <div>
                  <p className="text-xs text-[var(--color-muted-foreground)]">Budget left</p>
                  <Money
                    value={safe.remaining}
                    className="text-2xl font-semibold text-[var(--color-success)]"
                    animate
                  />
                </div>
                <div>
                  <p className="text-xs text-[var(--color-muted-foreground)]">Safe to spend per day</p>
                  <Money value={safe.perDay} className="text-2xl font-semibold" animate />
                  <p className="mt-0.5 text-xs text-[var(--color-muted-foreground)]">
                    over {safe.daysLeft} remaining day{safe.daysLeft === 1 ? '' : 's'}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-[var(--color-muted-foreground)]">Over budget</p>
                  <p
                    className={cn(
                      'tnum text-2xl font-semibold',
                      overBudget.length > 0 && 'text-[var(--color-danger)]',
                    )}
                  >
                    {overBudget.length}
                    <span className="ml-1 text-sm font-normal text-[var(--color-muted-foreground)]">
                      of {progress.length}
                    </span>
                  </p>
                </div>
              </div>

              {totalLimit > 0 && (
                <div className="mt-4">
                  <Progress
                    value={Math.min(100, (totalSpent / totalLimit) * 100)}
                    barClassName={
                      totalSpent > totalLimit
                        ? 'bg-[var(--color-danger)]'
                        : totalSpent / totalLimit > 0.85
                          ? 'bg-[var(--color-warning)]'
                          : 'bg-[var(--color-success)]'
                    }
                  />
                </div>
              )}
            </CardContent>
          </Card>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {progress.map((p) => (
              <Card key={p.budget.id}>
                <CardContent className="pt-5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{humanise(p.budget.category)}</p>
                      <p className="text-xs text-[var(--color-muted-foreground)]">
                        <Money value={p.spent} /> of <Money value={p.budget.limitAmount} />
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-0.5">
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7"
                        onClick={() => setDialog(p.budget)}
                        aria-label={`Edit ${humanise(p.budget.category)} budget`}
                      >
                        <EditIcon className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 text-[var(--color-danger)]"
                        onClick={() => setConfirmDelete(p.budget)}
                        aria-label={`Delete ${humanise(p.budget.category)} budget`}
                      >
                        <DeleteIcon className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>

                  <Progress
                    value={Math.min(100, p.percentUsed)}
                    className="mt-3"
                    barClassName={
                      p.isOver
                        ? 'bg-[var(--color-danger)]'
                        : p.percentUsed > 85
                          ? 'bg-[var(--color-warning)]'
                          : 'bg-[var(--color-success)]'
                    }
                  />

                  <div className="mt-2 flex items-center justify-between text-xs">
                    <span
                      className={cn(
                        'font-medium',
                        p.isOver ? 'text-[var(--color-danger)]' : 'text-[var(--color-muted-foreground)]',
                      )}
                    >
                      {p.percentUsed.toFixed(0)}% used
                    </span>
                    {p.isOver ? (
                      <Badge variant="danger">
                        <Money value={clampZero(-p.remaining)} /> over
                      </Badge>
                    ) : (
                      <span className="text-[var(--color-muted-foreground)]">
                        <Money value={p.remaining} /> left
                      </span>
                    )}
                  </div>

                  {p.budget.rollover && (
                    <Badge variant="info" className="mt-2">Rolls over</Badge>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>

          {overBudget.length > 0 && (
            <div className="mt-5 flex items-start gap-3 rounded-lg border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 p-4">
              <WarningIcon className="mt-0.5 h-5 w-5 shrink-0 text-[var(--color-danger)]" weight="fill" />
              <div className="text-sm">
                <p className="font-medium">
                  {overBudget.length} categor{overBudget.length === 1 ? 'y is' : 'ies are'} over budget
                  by <Money value={sumMoney(overBudget.map((p) => clampZero(-p.remaining)))} className="font-semibold" />.
                </p>
                <p className="mt-1 text-[var(--color-muted-foreground)]">
                  {overBudget.map((p) => humanise(p.budget.category)).join(', ')}
                </p>
              </div>
            </div>
          )}

          {unbudgeted.length > 0 && (
            <Card className="mt-5">
              <CardHeader>
                <CardTitle className="text-base">Spending without a budget</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex flex-wrap gap-2">
                  {unbudgeted.map((c) => (
                    <Button
                      key={c.category}
                      size="sm"
                      variant="outline"
                      onClick={() => setDialog('new')}
                      className="gap-1.5"
                    >
                      <PlusIcon className="h-3.5 w-3.5" weight="bold" />
                      {humanise(c.category)}
                      <span className="text-[var(--color-muted-foreground)]">
                        {formatINR(c.amount)}
                      </span>
                    </Button>
                  ))}
                </div>
                <div className="mt-3 flex items-start gap-2 text-xs text-[var(--color-muted-foreground)]">
                  <TipIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-info)]" weight="duotone" />
                  <p>
                    These categories had spending this month but no limit set, so they are not counted
                    in your safe-to-spend figure.
                  </p>
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}

      {dialog && (
        <BudgetDialog
          budget={dialog === 'new' ? null : dialog}
          month={month}
          existing={progress.map((p) => p.budget.category)}
          onClose={() => setDialog(null)}
        />
      )}

      <ConfirmDialog
        open={confirmDelete !== null}
        onOpenChange={(open) => !open && setConfirmDelete(null)}
        title={`Remove the ${confirmDelete ? humanise(confirmDelete.category) : ''} budget?`}
        description="Your expenses stay; only the limit is removed."
        confirmLabel="Remove"
        onConfirm={async () => {
          if (!confirmDelete) return;
          await remove('budgets', confirmDelete.id);
          toast.success('Budget removed');
          setConfirmDelete(null);
        }}
      />
    </>
  );
}

function BudgetDialog({
  budget,
  month,
  existing,
  onClose,
}: {
  budget: Budget | null;
  month: string;
  existing: ExpenseCategory[];
  onClose: () => void;
}) {
  const available = EXPENSE_CATEGORIES.filter(
    (c) => !existing.includes(c) || c === budget?.category,
  );

  const [form, setForm] = React.useState({
    category: budget?.category ?? available[0] ?? 'FOOD',
    limitAmount: budget?.limitAmount ?? 0,
    rollover: budget?.rollover ?? false,
  });
  const [error, setError] = React.useState<string | null>(null);

  async function save() {
    if (form.limitAmount <= 0) return setError('Enter a limit greater than zero.');

    const payload = {
      userId: 'user_sample',
      month,
      category: form.category,
      limitAmount: form.limitAmount,
      rollover: form.rollover,
    };

    if (budget) {
      await update<Budget>('budgets', budget.id, payload);
      toast.success('Budget updated');
    } else {
      await create<Budget>('budgets', 'budget', payload as Omit<Budget, 'id' | 'createdAt' | 'updatedAt' | 'deviceId' | 'deletedAt'>);
      toast.success('Budget set');
    }
    onClose();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {budget ? 'Edit budget' : `Set a budget for ${formatMonthKey(month)}`}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <Field label="Category">
            <Select
              value={form.category}
              onValueChange={(v) => setForm((f) => ({ ...f, category: v as ExpenseCategory }))}
              disabled={Boolean(budget)}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {available.map((c) => (
                  <SelectItem key={c} value={c}>{humanise(c)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field label="Monthly limit" required>
            <MoneyInput
              value={form.limitAmount}
              onChange={(v) => setForm((f) => ({ ...f, limitAmount: v }))}
            />
          </Field>

          <label className="flex items-center justify-between gap-3 rounded-md border border-[var(--color-border)] p-3 text-sm">
            <span>
              Roll over what is left
              <span className="block text-xs text-[var(--color-muted-foreground)]">
                Unspent budget carries into next month.
              </span>
            </span>
            <Switch
              checked={form.rollover}
              onCheckedChange={(v) => setForm((f) => ({ ...f, rollover: v }))}
            />
          </label>

          {error && <p role="alert" className="text-sm text-[var(--color-danger)]">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void save()}>{budget ? 'Save changes' : 'Set budget'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
