/**
 * Cash and bank.
 *
 * The money you can actually spend today, which until now the app did not track
 * at all — net worth was investments minus debt, valuing every rupee in your
 * wallet at zero.
 *
 * The balance here is *confirmed*, not derived: there is no bank feed, so you
 * are the sensor. Tagged spending is subtracted from what you last confirmed to
 * project a current figure, and when you recount, the gap is reported as
 * unaccounted — which is the number that actually tells you something.
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
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from '@/components/ui';
import {
  BankIcon,
  CashIcon,
  DeleteIcon,
  EditIcon,
  PlusIcon,
  TipIcon,
  WarningIcon,
} from '@/components/icons';
import { PageHeader } from '@/components/layout/AppShell';
import { Money } from '@/components/Money';
import { MoneyInput } from '@/components/MoneyInput';
import { Reveal, SpringBar, TiltCard } from '@/components/motion';
import { useCashAccounts, useExpenses } from '@/hooks/useData';
import { create, remove, update } from '@/lib/db/repository';
import { projectAccount, reconcile, summariseAccounts } from '@/lib/finance/cash';
import { formatDate, todayISO } from '@/lib/finance/dates';
import { formatINR } from '@/lib/finance/money';
import { cn } from '@/lib/utils';
import type { CashAccount, CashAccountKind } from '@/types';

/** After this long a confirmed balance is more memory than measurement. */
const STALE_AFTER_DAYS = 14;

export function Accounts() {
  const accounts = useCashAccounts();
  const expenses = useExpenses();
  const today = todayISO();

  const [editing, setEditing] = React.useState<CashAccount | 'new' | null>(null);
  const [recounting, setRecounting] = React.useState<CashAccount | null>(null);
  const [confirmDelete, setConfirmDelete] = React.useState<CashAccount | null>(null);

  const summary = React.useMemo(
    () => summariseAccounts(accounts, expenses, today),
    [accounts, expenses, today],
  );

  const stale = summary.accounts.filter((a) => a.staleDays >= STALE_AFTER_DAYS);

  return (
    <>
      <PageHeader
        title="Cash and bank"
        subtitle="What you can spend today"
        actions={
          <Button onClick={() => setEditing('new')} className="gap-1.5">
            <PlusIcon className="h-4 w-4" weight="bold" />
            Add account
          </Button>
        }
      />

      {accounts.length === 0 ? (
        <EmptyState
          icon={CashIcon}
          title="No accounts yet"
          description="Add your wallet and your bank account. Net worth counts them from the moment you do."
          action={<Button onClick={() => setEditing('new')}>Add an account</Button>}
        />
      ) : (
        <>
          {/* Headline split. Cash and bank are materially different situations
              at the same total, so they are never shown merged. */}
          <div className="tilt-scene grid gap-4 sm:grid-cols-3 [&>*]:min-w-0">
            {[
              { label: 'In hand', value: summary.cash, icon: CashIcon, hint: 'Notes and coins' },
              { label: 'In bank', value: summary.bank, icon: BankIcon, hint: 'Across all accounts' },
              { label: 'Total liquid', value: summary.total, icon: TipIcon, hint: 'Spendable today' },
            ].map((tile, i) => (
              <Reveal key={tile.label} delay={i * 60}>
                <TiltCard>
                  <Card className="h-full">
                    <CardContent className="p-5">
                      <div className="flex items-start justify-between">
                        <p className="text-xs font-medium uppercase tracking-wide text-[var(--color-muted-foreground)]">
                          {tile.label}
                        </p>
                        <tile.icon
                          className="h-5 w-5 text-[var(--color-primary)]"
                          weight="duotone"
                        />
                      </div>
                      <Money
                        value={tile.value}
                        animate
                        className="mt-2 block text-2xl font-semibold tracking-tight"
                      />
                      <p className="mt-1 text-xs text-[var(--color-muted-foreground)]">
                        {tile.hint}
                      </p>
                    </CardContent>
                  </Card>
                </TiltCard>
              </Reveal>
            ))}
          </div>

          {stale.length > 0 && (
            <Reveal delay={200}>
              <div className="mt-5 flex items-start gap-2 rounded-md border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 p-3 text-xs">
                <WarningIcon
                  className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-warning)]"
                  weight="fill"
                />
                <p>
                  {stale.length === 1
                    ? `${stale[0].name} was last confirmed ${stale[0].staleDays} days ago.`
                    : `${stale.length} balances were last confirmed over ${STALE_AFTER_DAYS} days ago.`}{' '}
                  Count it and press <strong>Recount</strong> — the gap is the part worth seeing.
                </p>
              </div>
            </Reveal>
          )}

          <div className="tilt-scene mt-5 grid gap-4 lg:grid-cols-2 [&>*]:min-w-0">
            {summary.accounts.map((p, i) => {
              const account = accounts.find((a) => a.id === p.accountId);
              if (!account) return null;
              const isStale = p.staleDays >= STALE_AFTER_DAYS;

              return (
                <Reveal key={p.accountId} delay={i * 50}>
                  <TiltCard maxTilt={4}>
                    <Card className="h-full">
                      <CardHeader className="flex-row items-start justify-between space-y-0 pb-3">
                        <div className="min-w-0">
                          <CardTitle className="flex items-center gap-2 text-base">
                            {p.kind === 'CASH' ? (
                              <CashIcon className="h-4 w-4 shrink-0" weight="duotone" />
                            ) : (
                              <BankIcon className="h-4 w-4 shrink-0" weight="duotone" />
                            )}
                            <span className="truncate">{p.name}</span>
                          </CardTitle>
                          <p className="mt-1 text-xs text-[var(--color-muted-foreground)]">
                            {account.kind === 'BANK' && account.bankName
                              ? `${account.bankName}${account.last4 ? ` ····${account.last4}` : ''}`
                              : 'Cash in hand'}
                          </p>
                        </div>
                        <div className="flex shrink-0 gap-1">
                          <button
                            type="button"
                            onClick={() => setEditing(account)}
                            aria-label={`Edit ${p.name}`}
                            className="tap-row inline-flex items-center justify-center rounded-md p-1.5 text-[var(--color-muted-foreground)] transition-colors hover:bg-[var(--color-accent)] hover:text-[var(--color-foreground)]"
                          >
                            <EditIcon className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDelete(account)}
                            aria-label={`Delete ${p.name}`}
                            className="tap-row inline-flex items-center justify-center rounded-md p-1.5 text-[var(--color-muted-foreground)] transition-colors hover:bg-[var(--color-danger)]/10 hover:text-[var(--color-danger)]"
                          >
                            <DeleteIcon className="h-4 w-4" />
                          </button>
                        </div>
                      </CardHeader>

                      <CardContent className="space-y-4">
                        <div>
                          <p className="text-xs text-[var(--color-muted-foreground)]">
                            Should be there now
                          </p>
                          <Money
                            value={p.expected}
                            animate
                            colour={p.expected < 0}
                            className="block text-2xl font-semibold tracking-tight"
                          />
                        </div>

                        <dl className="grid grid-cols-2 gap-3 text-xs">
                          <div>
                            <dt className="text-[var(--color-muted-foreground)]">You confirmed</dt>
                            <dd className="mt-0.5 font-medium">
                              {formatINR(p.recorded)}{' '}
                              <span className="font-normal text-[var(--color-muted-foreground)]">
                                on {formatDate(p.recordedAsOf)}
                              </span>
                            </dd>
                          </div>
                          <div>
                            <dt className="text-[var(--color-muted-foreground)]">Spent since</dt>
                            <dd className="mt-0.5 font-medium">{formatINR(p.spentSince)}</dd>
                          </div>
                        </dl>

                        {/* How much of the confirmed balance has gone. Springs
                            to its value so the eye is drawn to a nearly-empty
                            wallet rather than having to read for it. */}
                        {p.recorded > 0 && (
                          <SpringBar
                            value={Math.min(p.spentSince, p.recorded)}
                            max={p.recorded}
                            label={`${p.name}: spent since the balance was confirmed`}
                            barClassName={
                              p.spentSince >= p.recorded
                                ? 'bg-[var(--color-danger)]'
                                : p.spentSince > p.recorded * 0.7
                                  ? 'bg-[var(--color-warning)]'
                                  : undefined
                            }
                          />
                        )}

                        <div className="flex items-center justify-between gap-2">
                          <span
                            className={cn(
                              'text-xs',
                              isStale
                                ? 'text-[var(--color-warning)]'
                                : 'text-[var(--color-muted-foreground)]',
                            )}
                          >
                            {p.staleDays === 0
                              ? 'Confirmed today'
                              : `${p.staleDays} day${p.staleDays === 1 ? '' : 's'} since you counted`}
                          </span>
                          <Button size="sm" variant="outline" onClick={() => setRecounting(account)}>
                            Recount
                          </Button>
                        </div>

                        {!account.includeInNetWorth && (
                          <Badge variant="outline" className="text-[10px]">
                            Not counted in net worth
                          </Badge>
                        )}
                      </CardContent>
                    </Card>
                  </TiltCard>
                </Reveal>
              );
            })}
          </div>
        </>
      )}

      {editing && (
        <AccountDialog
          account={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}

      {recounting && (
        <RecountDialog
          account={recounting}
          projection={projectAccount(recounting, expenses, today)}
          onClose={() => setRecounting(null)}
        />
      )}

      <ConfirmDialog
        open={confirmDelete !== null}
        onOpenChange={(o) => !o && setConfirmDelete(null)}
        title={`Delete ${confirmDelete?.name}?`}
        description="The account stops counting towards net worth. Expenses tagged to it are kept."
        confirmLabel="Delete"
        onConfirm={async () => {
          if (!confirmDelete) return;
          await remove('cashAccounts', confirmDelete.id);
          setConfirmDelete(null);
          toast.success('Account deleted');
        }}
      />
    </>
  );
}

function AccountDialog({
  account,
  onClose,
}: {
  account: CashAccount | null;
  onClose: () => void;
}) {
  const [name, setName] = React.useState(account?.name ?? '');
  const [kind, setKind] = React.useState<CashAccountKind>(account?.kind ?? 'CASH');
  const [balance, setBalance] = React.useState(account?.balance ?? 0);
  const [balanceAsOf, setBalanceAsOf] = React.useState(account?.balanceAsOf ?? todayISO());
  const [bankName, setBankName] = React.useState(account?.bankName ?? '');
  const [last4, setLast4] = React.useState(account?.last4 ?? '');
  const [includeInNetWorth, setInclude] = React.useState(account?.includeInNetWorth ?? true);

  async function save() {
    if (!name.trim()) {
      toast.error('Give the account a name.');
      return;
    }
    const fields = {
      name: name.trim(),
      kind,
      balance,
      balanceAsOf,
      includeInNetWorth,
      ...(kind === 'BANK' ? { bankName: bankName.trim(), last4: last4.trim() } : {}),
    };

    if (account) {
      await update<CashAccount>('cashAccounts', account.id, fields);
      toast.success('Account updated');
    } else {
      await create<CashAccount>('cashAccounts', 'acc', { userId: 'local', ...fields });
      toast.success('Account added');
    }
    onClose();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{account ? 'Edit account' : 'Add an account'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" required>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={kind === 'CASH' ? 'Wallet' : 'HDFC Savings'}
                autoFocus
              />
            </Field>
            <Field label="Type" required>
              <Select value={kind} onValueChange={(v) => setKind(v as CashAccountKind)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="CASH">Cash in hand</SelectItem>
                  <SelectItem value="BANK">Bank account</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>

          {kind === 'BANK' && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Bank">
                <Input
                  value={bankName}
                  onChange={(e) => setBankName(e.target.value)}
                  placeholder="HDFC Bank"
                />
              </Field>
              <Field label="Last 4 digits">
                <Input
                  value={last4}
                  onChange={(e) => setLast4(e.target.value.replace(/\D/g, '').slice(0, 4))}
                  placeholder="4321"
                  inputMode="numeric"
                />
              </Field>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Balance now"
              required
              hint="Count it rather than estimating — everything else is derived from this."
            >
              <MoneyInput value={balance} onChange={setBalance} />
            </Field>
            <Field label="As of" required>
              <Input
                type="date"
                value={balanceAsOf}
                max={todayISO()}
                onChange={(e) => setBalanceAsOf(e.target.value)}
              />
            </Field>
          </div>

          <div className="flex items-center justify-between gap-4 rounded-md border border-[var(--color-border)] p-3">
            <div className="min-w-0">
              <Label className="text-sm">Count towards net worth</Label>
              <p className="mt-0.5 text-xs text-[var(--color-muted-foreground)]">
                Turn off for a joint or business account you want to see but not count.
              </p>
            </div>
            <Switch checked={includeInNetWorth} onCheckedChange={setInclude} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void save()}>{account ? 'Save' : 'Add account'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Recount.
 *
 * The whole point of the feature. You count the real thing, and the difference
 * against what was expected is named out loud rather than quietly absorbed.
 */
function RecountDialog({
  account,
  projection,
  onClose,
}: {
  account: CashAccount;
  projection: ReturnType<typeof projectAccount>;
  onClose: () => void;
}) {
  const [counted, setCounted] = React.useState(projection.expected);
  const result = reconcile(projection, counted);

  async function save() {
    await update<CashAccount>('cashAccounts', account.id, {
      balance: counted,
      balanceAsOf: todayISO(),
    });
    onClose();
    toast.success(
      result.matches
        ? 'Balance confirmed — it matched'
        : `Balance updated. ${formatINR(Math.abs(result.drift))} ${
            result.direction === 'SHORT' ? 'unaccounted' : 'more than expected'
          }.`,
    );
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Recount {account.name}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-md border border-[var(--color-border)] p-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-[var(--color-muted-foreground)]">Expected</span>
              <span className="font-medium">{formatINR(projection.expected)}</span>
            </div>
            <div className="mt-1 flex items-center justify-between text-xs text-[var(--color-muted-foreground)]">
              <span>
                {formatINR(projection.recorded)} confirmed {formatDate(projection.recordedAsOf)}
              </span>
              <span>− {formatINR(projection.spentSince)} spent</span>
            </div>
          </div>

          <Field label="What is actually there" required>
            <MoneyInput value={counted} onChange={setCounted} autoFocus />
          </Field>

          {!result.matches && (
            <div
              className={cn(
                'flex items-start gap-2 rounded-md border p-3 text-xs',
                result.direction === 'SHORT'
                  ? 'border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10'
                  : 'border-[var(--color-info)]/40 bg-[var(--color-info)]/10',
              )}
            >
              <WarningIcon className="mt-0.5 h-4 w-4 shrink-0" weight="fill" />
              <p>
                <strong>{formatINR(Math.abs(result.drift))}</strong>{' '}
                {result.direction === 'SHORT' ? (
                  <>
                    less than expected. That is spending that never got recorded — the usual cause
                    is cash going out without a note.
                  </>
                ) : (
                  <>
                    more than expected. Usually income that was not logged: a refund, a transfer in,
                    or someone settling up.
                  </>
                )}
              </p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void save()}>Confirm balance</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
