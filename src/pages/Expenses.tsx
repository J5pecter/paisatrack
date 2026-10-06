/**
 * Expenses — the list you live in.
 *
 * Filters are URL-free and instant (everything is already in memory), bulk
 * selection supports delete and duplicate, and CSV import/export round-trips
 * through the same column set so a file exported here re-imports cleanly.
 */
import * as React from 'react';
import { toast } from 'sonner';
import Papa from 'papaparse';
import {
  Badge,
  Button,
  Card,
  CardContent,
  Checkbox,
  ConfirmDialog,
  EmptyState,
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
} from '@/components/ui';
import {
  CalendarIcon,
  DeleteIcon,
  DownloadIcon,
  DuplicateIcon,
  EditIcon,
  ExpenseIcon,
  FilterIcon,
  PlusIcon,
  UploadIcon,
} from '@/components/icons';
import { PageHeader } from '@/components/layout/AppShell';
import { Money } from '@/components/Money';
import { MoneyInput } from '@/components/MoneyInput';
import {
  EXPENSE_CATEGORIES,
  ExpenseDialog,
  PAYMENT_METHODS,
  type ExpenseDraft,
} from '@/components/QuickAdd';
import { useCreditCards, useExpenses } from '@/hooks/useData';
import { useDebounced, useProgressiveList } from '@/hooks/usePerf';
import { bulkPut, create, remove } from '@/lib/db/repository';
import { formatDate, monthKey, todayISO } from '@/lib/finance/dates';
import { formatINR, sumMoney, toPaise, toRupeeString } from '@/lib/finance/money';
import { downloadBlob, humanise } from '@/lib/utils';
import { ValidationError, checkImportFile, csvSafe, validateCsvRows } from '@/lib/validation';
import { useUI } from '@/stores/ui';
import type { Expense, ExpenseCategory, PaymentMethod } from '@/types';

interface Filters {
  search: string;
  category: ExpenseCategory | 'ALL';
  method: PaymentMethod | 'ALL';
  from: string;
  to: string;
  minAmount: number;
  maxAmount: number;
}

const EMPTY_FILTERS: Filters = {
  search: '',
  category: 'ALL',
  method: 'ALL',
  from: '',
  to: '',
  minAmount: 0,
  maxAmount: 0,
};

export function Expenses() {
  const expenses = useExpenses();
  const cards = useCreditCards();
  const setQuickAddOpen = useUI((s) => s.setQuickAddOpen);

  const [filters, setFilters] = React.useState<Filters>(EMPTY_FILTERS);
  const [showFilters, setShowFilters] = React.useState(false);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [editing, setEditing] = React.useState<Expense | null>(null);
  const [confirmDelete, setConfirmDelete] = React.useState<string[] | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);

  const cardName = React.useCallback(
    (id?: string | null) => {
      const c = cards.find((x) => x.id === id);
      return c ? `${c.issuer} ····${c.last4}` : null;
    },
    [cards],
  );

  // Only the text filter is debounced. Amount and date filters change once, so
  // delaying them would just feel broken.
  const debouncedSearch = useDebounced(filters.search, 200);

  const filtered = React.useMemo(() => {
    const q = debouncedSearch.trim().toLowerCase();
    return expenses.filter((e) => {
      if (q && !e.description.toLowerCase().includes(q) && !humanise(e.category).toLowerCase().includes(q))
        return false;
      if (filters.category !== 'ALL' && e.category !== filters.category) return false;
      if (filters.method !== 'ALL' && e.paymentMethod !== filters.method) return false;
      if (filters.from && e.date < filters.from) return false;
      if (filters.to && e.date > filters.to) return false;
      if (filters.minAmount > 0 && e.amount < filters.minAmount) return false;
      if (filters.maxAmount > 0 && e.amount > filters.maxAmount) return false;
      return true;
    });
  }, [expenses, filters, debouncedSearch]);

  const total = React.useMemo(() => sumMoney(filtered.map((e) => e.amount)), [filtered]);
  const activeFilterCount = React.useMemo(
    () =>
      Object.entries(filters).filter(([k, v]) =>
        k === 'category' || k === 'method' ? v !== 'ALL' : Boolean(v),
      ).length,
    [filters],
  );

  // Render a growing window rather than every row. 1,000 expenses is 1,000
  // table rows and ~6,000 DOM nodes on arrival; this keeps the first paint
  // cheap and extends as the reader scrolls.
  const { visible, hasMore, remaining, sentinelRef, showAll } = useProgressiveList(filtered, 100);

  // Group by day so the list reads as a diary rather than an undifferentiated run.
  const grouped = React.useMemo(() => {
    const byDate = new Map<string, Expense[]>();
    for (const e of visible) {
      const list = byDate.get(e.date) ?? [];
      list.push(e);
      byDate.set(e.date, list);
    }
    return [...byDate.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [visible]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) => (prev.size === filtered.length ? new Set() : new Set(filtered.map((e) => e.id))));
  }

  async function deleteSelected(ids: string[]) {
    for (const id of ids) await remove('expenses', id);
    setSelected(new Set());
    setConfirmDelete(null);
    toast.success(`Deleted ${ids.length} expense${ids.length === 1 ? '' : 's'}`);
  }

  async function duplicateSelected() {
    const rows = expenses.filter((e) => selected.has(e.id));
    for (const e of rows) {
      await create<Expense>('expenses', 'exp', {
        userId: e.userId,
        amount: e.amount,
        category: e.category,
        description: e.description,
        date: todayISO(),
        paymentMethod: e.paymentMethod,
        creditCardId: e.creditCardId ?? null,
        isRecurring: e.isRecurring,
        ...(e.notes ? { notes: e.notes } : {}),
      });
    }
    setSelected(new Set());
    toast.success(`Duplicated ${rows.length} to today`);
  }

  function exportCSV() {
    // Free-text fields go through csvSafe: a description beginning = + - or @
    // is a live formula when the export is opened in Excel or Sheets, and these
    // descriptions often originated in a bank's own CSV. date/amount/category/
    // paymentMethod are derived or enum values and cannot start with one.
    const rows = filtered.map((e) => ({
      date: e.date,
      amount: toRupeeString(e.amount),
      category: e.category,
      description: csvSafe(e.description),
      paymentMethod: e.paymentMethod,
      card: csvSafe(cardName(e.creditCardId) ?? ''),
      notes: csvSafe(e.notes ?? ''),
    }));
    downloadBlob(Papa.unparse(rows), `paisatrack-expenses-${todayISO()}.csv`, 'text/csv;charset=utf-8');
    toast.success(`Exported ${rows.length} expenses`);
  }

  function importCSV(file: File) {
    // Check the file before reading it: a 2 GB pick would hang the tab.
    const check = checkImportFile(file, 'csv');
    if (!check.ok) {
      toast.error(check.message ?? 'That file cannot be imported.');
      return;
    }

    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      complete: async (result) => {
        try {
          // Every row is validated and sanitised before it can reach Dexie.
          const { rows: valid, problems } = validateCsvRows(result.data, toPaise);

          const now = new Date().toISOString();
          const rows: Expense[] = valid.map((r) => ({
            id: `exp_${crypto.randomUUID()}`,
            userId: 'user_sample',
            amount: r.amount,
            category: r.category,
            description: r.description,
            date: r.date,
            paymentMethod: r.paymentMethod,
            creditCardId: null,
            isRecurring: false,
            ...(r.notes ? { notes: r.notes } : {}),
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
          }));

          if (rows.length) await bulkPut('expenses', rows);

          if (problems.length) {
            toast.warning(`Imported ${rows.length}, skipped ${problems.length}`, {
              description: problems.slice(0, 3).join(' · '),
            });
          } else if (rows.length) {
            toast.success(`Imported ${rows.length} expenses`);
          } else {
            toast.error('Nothing in that file could be imported.');
          }
        } catch (e) {
          toast.error(
            e instanceof ValidationError ? e.message : 'That file could not be imported.',
          );
        }
      },
      error: (err) => toast.error(`Could not read that file: ${err.message}`),
    });
  }

  function editDraft(e: Expense): ExpenseDraft {
    return {
      amount: e.amount,
      category: e.category,
      description: e.description,
      date: e.date,
      paymentMethod: e.paymentMethod,
      creditCardId: e.creditCardId ?? null,
      notes: e.notes ?? '',
    };
  }

  return (
    <>
      <PageHeader
        title="Expenses"
        subtitle={`${filtered.length} of ${expenses.length} · ${formatINR(total)}`}
        subtitleTestId="expense-count"
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowFilters((v) => !v)}
              className="gap-1.5"
            >
              <FilterIcon className="h-4 w-4" weight="bold" />
              Filters
              {activeFilterCount > 0 && (
                <Badge variant="info" className="ml-1">{activeFilterCount}</Badge>
              )}
            </Button>
            {/* Label collapses below sm:, so name these explicitly. */}
            <Button
              variant="outline"
              size="sm"
              onClick={exportCSV}
              className="gap-1.5"
              aria-label="Export expenses as CSV"
            >
              <DownloadIcon className="h-4 w-4" weight="bold" />
              <span className="hidden sm:inline">Export</span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => fileRef.current?.click()}
              className="gap-1.5"
              aria-label="Import expenses from CSV"
            >
              <UploadIcon className="h-4 w-4" weight="bold" />
              <span className="hidden sm:inline">Import</span>
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) importCSV(file);
                e.target.value = '';
              }}
            />
            <Button
              size="sm"
              onClick={() => setQuickAddOpen(true)}
              className="gap-1.5"
              data-testid="add-expense"
            >
              <PlusIcon className="h-4 w-4" weight="bold" />
              Add
            </Button>
          </>
        }
      />

      {showFilters && (
        <Card className="mb-4">
          <CardContent className="grid gap-3 pt-5 sm:grid-cols-2 lg:grid-cols-3">
            <Input
              placeholder="Search description…"
              value={filters.search}
              onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
            />
            <Select
              value={filters.category}
              onValueChange={(v) => setFilters((f) => ({ ...f, category: v as Filters['category'] }))}
            >
              <SelectTrigger><SelectValue placeholder="Category" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All categories</SelectItem>
                {EXPENSE_CATEGORIES.map((c) => (
                  <SelectItem key={c} value={c}>{humanise(c)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={filters.method}
              onValueChange={(v) => setFilters((f) => ({ ...f, method: v as Filters['method'] }))}
            >
              <SelectTrigger><SelectValue placeholder="Paid with" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">Any method</SelectItem>
                {PAYMENT_METHODS.map((m) => (
                  <SelectItem key={m} value={m}>{humanise(m)}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            <div className="flex items-center gap-2">
              <CalendarIcon className="h-4 w-4 shrink-0 text-[var(--color-muted-foreground)]" />
              <Input
                type="date"
                value={filters.from}
                onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))}
                aria-label="From date"
              />
              <span className="text-xs text-[var(--color-muted-foreground)]">to</span>
              <Input
                type="date"
                value={filters.to}
                onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))}
                aria-label="To date"
              />
            </div>

            <div className="flex items-center gap-2">
              <MoneyInput
                value={filters.minAmount}
                onChange={(v) => setFilters((f) => ({ ...f, minAmount: v }))}
                placeholder="Min"
                showPreview={false}
                aria-label="Minimum amount"
              />
              <span className="text-xs text-[var(--color-muted-foreground)]">to</span>
              <MoneyInput
                value={filters.maxAmount}
                onChange={(v) => setFilters((f) => ({ ...f, maxAmount: v }))}
                placeholder="Max"
                showPreview={false}
                aria-label="Maximum amount"
              />
            </div>

            <Button variant="ghost" onClick={() => setFilters(EMPTY_FILTERS)}>
              Clear filters
            </Button>
          </CardContent>
        </Card>
      )}

      {selected.size > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-2.5 text-sm">
          <span className="font-medium">{selected.size} selected</span>
          <Button size="sm" variant="outline" onClick={() => void duplicateSelected()} className="ml-auto gap-1.5">
            <DuplicateIcon className="h-3.5 w-3.5" weight="bold" />
            Duplicate to today
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => setConfirmDelete([...selected])}
            className="gap-1.5"
          >
            <DeleteIcon className="h-3.5 w-3.5" weight="bold" />
            Delete
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            Cancel
          </Button>
        </div>
      )}

      <Card>
        {filtered.length === 0 ? (
          <EmptyState
            icon={ExpenseIcon}
            title={expenses.length === 0 ? 'No expenses yet' : 'Nothing matches those filters'}
            description={
              expenses.length === 0
                ? 'Press N anywhere in the app to add one without reaching for the mouse.'
                : 'Try widening the date range or clearing a filter.'
            }
            action={
              expenses.length === 0 ? (
                <Button onClick={() => setQuickAddOpen(true)}>Add your first expense</Button>
              ) : (
                <Button variant="outline" onClick={() => setFilters(EMPTY_FILTERS)}>
                  Clear filters
                </Button>
              )
            }
          />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH className="w-10">
                  <Checkbox
                    checked={selected.size === filtered.length && filtered.length > 0}
                    onCheckedChange={toggleAll}
                    aria-label="Select all"
                  />
                </TH>
                <TH>Description</TH>
                <TH className="hidden sm:table-cell">Category</TH>
                <TH className="hidden md:table-cell">Paid with</TH>
                <TH className="text-right">Amount</TH>
                <TH className="w-20" />
              </TR>
            </THead>
            <TBody>
              {grouped.map(([date, rows]) => (
                <React.Fragment key={date}>
                  <TR className="hover:bg-transparent">
                    <TD colSpan={6} className="bg-[var(--color-muted)]/40 py-1.5">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-medium text-[var(--color-muted-foreground)]">
                          {formatDate(date)}
                        </span>
                        <Money
                          value={sumMoney(rows.map((r) => r.amount))}
                          className="font-medium text-[var(--color-muted-foreground)]"
                        />
                      </div>
                    </TD>
                  </TR>
                  {rows.map((e) => (
                    <TR key={e.id}>
                      <TD>
                        <Checkbox
                          checked={selected.has(e.id)}
                          onCheckedChange={() => toggle(e.id)}
                          aria-label={`Select ${e.description}`}
                        />
                      </TD>
                      <TD>
                        <p className="font-medium">{e.description}</p>
                        <p className="text-xs text-[var(--color-muted-foreground)] sm:hidden">
                          {humanise(e.category)}
                        </p>
                      </TD>
                      <TD className="hidden sm:table-cell">
                        <Badge variant="outline">{humanise(e.category)}</Badge>
                      </TD>
                      <TD className="hidden md:table-cell text-xs text-[var(--color-muted-foreground)]">
                        {humanise(e.paymentMethod)}
                        {e.creditCardId && (
                          <span className="block">{cardName(e.creditCardId)}</span>
                        )}
                      </TD>
                      <TD className="text-right">
                        <Money value={e.amount} className="font-medium" />
                      </TD>
                      <TD>
                        <div className="flex justify-end gap-0.5">
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7"
                            onClick={() => setEditing(e)}
                            aria-label={`Edit ${e.description}`}
                          >
                            <EditIcon className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7 text-[var(--color-danger)]"
                            onClick={() => setConfirmDelete([e.id])}
                            aria-label={`Delete ${e.description}`}
                          >
                            <DeleteIcon className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </TD>
                    </TR>
                  ))}
                </React.Fragment>
              ))}

              {hasMore && (
                <TR className="hover:bg-transparent">
                  <TD colSpan={6} className="py-4 text-center">
                    {/* Scrolls into view 400px early and extends the window. */}
                    <div ref={sentinelRef} aria-hidden />
                    <p className="text-xs text-[var(--color-muted-foreground)]">
                      Showing {visible.length} of {filtered.length}
                    </p>
                    <Button size="sm" variant="ghost" className="mt-1" onClick={showAll}>
                      Show all {remaining} more
                    </Button>
                  </TD>
                </TR>
              )}
            </TBody>
          </Table>
        )}
      </Card>

      {filtered.length > 0 && (
        <p className="mt-3 text-right text-sm text-[var(--color-muted-foreground)]">
          {filtered.length} expense{filtered.length === 1 ? '' : 's'} ·{' '}
          <Money value={total} className="font-medium text-[var(--color-foreground)]" /> total
          {filters.from || filters.to ? '' : ` · ${monthKey(new Date())} and earlier`}
        </p>
      )}

      {editing && (
        <ExpenseDialog
          open
          onOpenChange={(open) => !open && setEditing(null)}
          title="Edit expense"
          initial={editDraft(editing)}
          expenseId={editing.id}
          onSaved={() => setEditing(null)}
        />
      )}

      <ConfirmDialog
        open={confirmDelete !== null}
        onOpenChange={(open) => !open && setConfirmDelete(null)}
        title={`Delete ${confirmDelete?.length === 1 ? 'this expense' : `${confirmDelete?.length} expenses`}?`}
        description="This cannot be undone from the app, though the change is recorded in your GitHub sync history if sync is on."
        confirmLabel="Delete"
        onConfirm={() => confirmDelete && void deleteSelected(confirmDelete)}
      />
    </>
  );
}
