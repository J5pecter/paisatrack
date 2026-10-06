/**
 * Quick-add expense — the single most used action in the app.
 *
 * Keyboard first: opens on N or Ctrl/Cmd+K → "Add expense", focuses the amount
 * field, and Ctrl/Cmd+Enter saves without touching the mouse. Selecting
 * "Credit card" as the payment method forces you to say *which* card, because
 * that is what feeds the card outstanding calculation.
 */
import * as React from 'react';
import { toast } from 'sonner';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui';
import { MoneyInput } from './MoneyInput';
import { create } from '@/lib/db/repository';
import { useCashAccounts, useCreditCards } from '@/hooks/useData';
import { useUI } from '@/stores/ui';
import { todayISO } from '@/lib/finance/dates';
import { humanise } from '@/lib/utils';
import type { Expense, ExpenseCategory, PaymentMethod } from '@/types';

export const EXPENSE_CATEGORIES: ExpenseCategory[] = [
  'FOOD', 'GROCERIES', 'TRANSPORT', 'FUEL', 'SHOPPING', 'ENTERTAINMENT',
  'HEALTH', 'EDUCATION', 'TRAVEL', 'PERSONAL_CARE', 'GIFTS', 'HOUSEHOLD',
  'BILLS', 'RENT', 'EMI', 'INVESTMENT', 'FEES', 'OTHER',
];

export const PAYMENT_METHODS: PaymentMethod[] = [
  'UPI', 'CASH', 'CREDIT_CARD', 'DEBIT_CARD', 'NET_BANKING', 'WALLET', 'AUTO_DEBIT',
];

export interface ExpenseDraft {
  amount: number;
  category: ExpenseCategory;
  description: string;
  date: string;
  paymentMethod: PaymentMethod;
  creditCardId: string | null;
  cashAccountId: string | null;
  notes: string;
}

export function emptyDraft(): ExpenseDraft {
  return {
    amount: 0,
    category: 'FOOD',
    description: '',
    date: todayISO(),
    paymentMethod: 'UPI',
    creditCardId: null,
    cashAccountId: null,
    notes: '',
  };
}

export function QuickAdd() {
  const { quickAddOpen, setQuickAddOpen } = useUI();
  return (
    <ExpenseDialog
      open={quickAddOpen}
      onOpenChange={setQuickAddOpen}
      title="Add expense"
      description="Ctrl+Enter to save and close."
    />
  );
}

export function ExpenseDialog({
  open,
  onOpenChange,
  title,
  description,
  initial,
  expenseId,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  initial?: ExpenseDraft;
  expenseId?: string;
  onSaved?: () => void;
}) {
  const cards = useCreditCards();
  const accounts = useCashAccounts();
  const [draft, setDraft] = React.useState<ExpenseDraft>(initial ?? emptyDraft());
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const amountRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (open) {
      setDraft(initial ?? emptyDraft());
      setError(null);
      // Wait for the dialog's mount animation before grabbing focus.
      const t = setTimeout(() => amountRef.current?.focus(), 60);
      return () => clearTimeout(t);
    }
  }, [open, initial]);

  const set = <K extends keyof ExpenseDraft>(key: K, value: ExpenseDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  async function save(keepOpen = false) {
    if (draft.amount <= 0) {
      setError('Enter an amount greater than zero.');
      amountRef.current?.focus();
      return;
    }
    if (draft.paymentMethod === 'CREDIT_CARD' && !draft.creditCardId) {
      setError('Pick which card — this feeds the card outstanding.');
      return;
    }

    setSaving(true);
    try {
      const payload = {
        userId: 'user_sample',
        amount: draft.amount,
        category: draft.category,
        description: draft.description.trim() || humanise(draft.category),
        date: draft.date,
        paymentMethod: draft.paymentMethod,
        creditCardId: draft.paymentMethod === 'CREDIT_CARD' ? draft.creditCardId : null,
        cashAccountId: draft.paymentMethod === 'CREDIT_CARD' ? null : draft.cashAccountId,
        isRecurring: false,
        notes: draft.notes.trim() || undefined,
      };

      if (expenseId) {
        const { update } = await import('@/lib/db/repository');
        await update<Expense>('expenses', expenseId, payload);
        toast.success('Expense updated');
      } else {
        await create<Expense>('expenses', 'exp', payload as Omit<Expense, 'id' | 'createdAt' | 'updatedAt' | 'deviceId' | 'deletedAt'>);
        toast.success('Expense added');
      }

      onSaved?.();
      if (keepOpen) {
        // Keep the date and method — most people add several in a row.
        setDraft({
          ...emptyDraft(),
          date: draft.date,
          paymentMethod: draft.paymentMethod,
          creditCardId: draft.creditCardId,
          cashAccountId: draft.cashAccountId,
        });
        amountRef.current?.focus();
      } else {
        onOpenChange(false);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            void save(false);
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>

        <div className="space-y-4">
          <Field label="Amount" required error={error ?? undefined}>
            <MoneyInput
              ref={amountRef}
              value={draft.amount}
              onChange={(v) => {
                set('amount', v);
                setError(null);
              }}
              placeholder="0"
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Category">
              <Select value={draft.category} onValueChange={(v) => set('category', v as ExpenseCategory)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {EXPENSE_CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c}>{humanise(c)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <Field label="Date">
              <Input type="date" value={draft.date} onChange={(e) => set('date', e.target.value)} />
            </Field>
          </div>

          <Field label="Description" hint="Leave blank to use the category name.">
            <Input
              value={draft.description}
              onChange={(e) => set('description', e.target.value)}
              placeholder="Swiggy order"
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Paid with">
              <Select
                value={draft.paymentMethod}
                onValueChange={(v) => {
                  set('paymentMethod', v as PaymentMethod);
                  if (v !== 'CREDIT_CARD') set('creditCardId', null);
                  setError(null);
                }}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PAYMENT_METHODS.map((m) => (
                    <SelectItem key={m} value={m}>{humanise(m)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            {draft.paymentMethod === 'CREDIT_CARD' && (
              <Field label="Which card" required>
                {cards.length === 0 ? (
                  <p className="pt-2 text-xs text-[var(--color-muted-foreground)]">
                    No cards yet — add one on the Cards page first.
                  </p>
                ) : (
                  <Select
                    value={draft.creditCardId ?? ''}
                    onValueChange={(v) => {
                      set('creditCardId', v);
                      setError(null);
                    }}
                  >
                    <SelectTrigger><SelectValue placeholder="Select a card" /></SelectTrigger>
                    <SelectContent>
                      {cards.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.issuer} {c.cardName} ····{c.last4}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </Field>
            )}

            {draft.paymentMethod !== 'CREDIT_CARD' && accounts.length > 0 && (
              <Field
                label="From which account"
                hint="Optional. Tagging it lets the Accounts page tell you what should be left."
              >
                <Select
                  value={draft.cashAccountId ?? '__none__'}
                  onValueChange={(v) => set('cashAccountId', v === '__none__' ? null : v)}
                >
                  <SelectTrigger><SelectValue placeholder="Not specified" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">Not specified</SelectItem>
                    {accounts.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.name}
                        {a.kind === 'BANK' && a.last4 ? ` ····${a.last4}` : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          {!expenseId && (
            <Button variant="secondary" onClick={() => void save(true)} disabled={saving}>
              Save and add another
            </Button>
          )}
          <Button onClick={() => void save(false)} disabled={saving}>
            {saving ? 'Saving…' : expenseId ? 'Save changes' : 'Add expense'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
