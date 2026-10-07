/**
 * Import a statement.
 *
 * Bank, credit card, UPI app or a mutual-fund CAS. The file is read **in this
 * browser** — there is no server to send it to, and nothing leaves the device.
 * For a document carrying someone's salary and account numbers that is not a
 * limitation to apologise for, it is the feature.
 *
 * The flow is deliberately three steps, not one. Nothing is written until the
 * last: a parser working across a dozen bank layouts will misread rows, and a
 * wrong row in someone's finances is worse than a missing one.
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
  Checkbox,
  EmptyState,
  Field,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui';
import {
  CheckCircleIcon,
  InfoIcon,
  LockIcon,
  ReceiptIcon,
  SpinnerIcon,
  UploadIcon,
  WarningIcon,
} from '@/components/icons';
import { PageHeader } from '@/components/layout/AppShell';
import { Money } from '@/components/Money';
import { Reveal } from '@/components/motion';
import { useCashAccounts, useCreditCards, useExpenses } from '@/hooks/useData';
import { bulkPut, create } from '@/lib/db/repository';
import { EXPENSE_CATEGORIES } from '@/lib/validation';
import { fingerprint } from '@/lib/import/statement';
import { formatDate, todayISO } from '@/lib/finance/dates';
import { cn, humanise } from '@/lib/utils';
import type { Expense, ExpenseCategory, Investment, PaymentMethod } from '@/types';
import type { ImportResult, ParsedTxn } from '@/lib/import';

type Stage = 'PICK' | 'PASSWORD' | 'OFFER_OCR' | 'WORKING' | 'REVIEW';

/** A candidate plus the edits made to it in review. */
interface Row extends ParsedTxn {
  include: boolean;
  duplicate: boolean;
}

export function Import() {
  const expenses = useExpenses();
  const cards = useCreditCards();
  const accounts = useCashAccounts();

  const [stage, setStage] = React.useState<Stage>('PICK');
  const [file, setFile] = React.useState<File | null>(null);
  const [password, setPassword] = React.useState('');
  const [passwordError, setPasswordError] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<ImportResult | null>(null);
  const [ocrOffer, setOcrOffer] = React.useState<{ pages: number; isImage: boolean } | null>(null);
  const [progress, setProgress] = React.useState<{ ratio: number; message: string } | null>(null);
  const pendingOcr = React.useRef<unknown>(null);
  const [rows, setRows] = React.useState<Row[]>([]);
  const [target, setTarget] = React.useState<string>('__none__');
  const fileRef = React.useRef<HTMLInputElement>(null);

  /** Everything already stored, so a re-import of an overlapping period is safe. */
  const existing = React.useMemo(
    () => new Set(expenses.map((e) => fingerprint(e.date, e.amount, e.description))),
    [expenses],
  );

  async function run(picked: File, pass?: string) {
    setStage('WORKING');
    setError(null);
    setPasswordError(null);

    try {
      // Lazy: pdf.js and the parsers are ~150 kB plus a worker, and have no
      // business on the critical path of a dashboard.
      const { parseStatement, PasswordRequired, NeedsOcr } = await import('@/lib/import');

      try {
        accept(await parseStatement(picked, pass));
      } catch (e) {
        if (e instanceof PasswordRequired) {
          setPasswordError(e.wrongPassword ? 'That password did not open the file.' : null);
          setStage('PASSWORD');
          return;
        }
        if (e instanceof NeedsOcr) {
          // Never silently. OCR downloads a model, spins up a worker and can
          // take a minute — none of which should happen because someone picked
          // the wrong file. And its output is worse, so the choice is the
          // user's to make knowingly.
          pendingOcr.current = e;
          setOcrOffer({
            pages: e.pages,
            isImage: /\.(png|jpe?g|webp|bmp)$/i.test(picked.name),
          });
          setStage('OFFER_OCR');
          return;
        }
        throw e;
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That file could not be read.');
      setStage('PICK');
    }
  }

  /** Turn a parsed result into reviewable rows. Shared by the text and OCR paths. */
  function accept(parsed: ImportResult) {
    setResult(parsed);
    setRows(
      parsed.transactions.map((t) => {
        const duplicate = existing.has(t.fingerprint);
        return {
          ...t,
          duplicate,
          // Credits are off by default: a salary or a transfer in is not an
          // expense, and the app has no "income transaction" to put it in.
          // Nothing from OCR is pre-ticked at all — it has not earned it.
          include: !duplicate && t.direction === 'DEBIT' && !parsed.viaOcr,
        };
      }),
    );
    setStage('REVIEW');
  }

  async function runOcr() {
    if (!pendingOcr.current || !ocrOffer) return;
    setStage('WORKING');
    setProgress({ ratio: 0, message: 'Starting…' });

    try {
      const { parseViaOcr } = await import('@/lib/import');
      const parsed = await parseViaOcr(
        pendingOcr.current as never,
        ocrOffer.isImage,
        (p) => setProgress(p),
      );
      accept(parsed);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The scan could not be read.');
      setStage('PICK');
    } finally {
      setProgress(null);
      pendingOcr.current = null;
    }
  }

  function reset() {
    setStage('PICK');
    setFile(null);
    setPassword('');
    setResult(null);
    setRows([]);
    setError(null);
    setPasswordError(null);
    setOcrOffer(null);
    setProgress(null);
    pendingOcr.current = null;
    if (fileRef.current) fileRef.current.value = '';
  }

  const selected = rows.filter((r) => r.include);
  const selectedTotal = selected.reduce((s, r) => s + r.amount, 0);

  async function commit() {
    if (!result) return;

    // A CAS carries both: holdings go to Investments, movements go to expenses.
    if (result.kind === 'CAS' && result.holdings.length > 0) {
      for (const h of result.holdings) {
        await create<Investment>('investments', 'inv', {
          userId: 'local',
          name: h.name,
          type: h.kind === 'EQUITY' ? 'STOCKS' : 'MUTUAL_FUND',
          investedAmount: h.invested ?? h.currentValue,
          currentValue: h.currentValue,
          startDate: todayISO(),
        } as never);
      }
      if (selected.length === 0) {
        toast.success(`Added ${result.holdings.length} holdings`);
        reset();
        return;
      }
      toast.success(`Added ${result.holdings.length} holdings`);
    }

    const now = new Date().toISOString();
    const method: PaymentMethod =
      target.startsWith('card:') ? 'CREDIT_CARD' : result.kind === 'UPI' ? 'UPI' : 'NET_BANKING';

    const toWrite: Expense[] = selected.map((r, i) => ({
      id: `exp_imp_${Date.now()}_${i}`,
      userId: 'local',
      amount: r.amount,
      category: r.category,
      description: r.description,
      date: r.date,
      paymentMethod: method,
      creditCardId: target.startsWith('card:') ? target.slice(5) : null,
      cashAccountId: target.startsWith('acc:') ? target.slice(4) : null,
      isRecurring: false,
      notes: `Imported from ${result.source}`,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    })) as Expense[];

    await bulkPut('expenses', toWrite);
    toast.success(`Imported ${toWrite.length} transactions`);
    reset();
  }

  return (
    <>
      <PageHeader
        title="Import a statement"
        subtitle="Bank, credit card, UPI app or a mutual-fund CAS"
      />

      {/* The reassurance that matters most on this screen, stated once, up front. */}
      <div className="mb-5 flex items-start gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-muted)]/40 p-3 text-xs">
        <LockIcon className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-primary)]" weight="duotone" />
        <p>
          <strong className="text-[var(--color-foreground)]">The file never leaves this device.</strong>{' '}
          It is read in your browser — there is no server to upload it to. Nothing is sent anywhere,
          including the password.
        </p>
      </div>

      {error && (
        <div className="mb-5 flex items-start gap-2 rounded-md border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 p-3 text-sm">
          <WarningIcon className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-danger)]" weight="fill" />
          <p>{error}</p>
        </div>
      )}

      {stage === 'PICK' && <PickStep fileRef={fileRef} onPick={(f) => { setFile(f); void run(f); }} />}

      {stage === 'PASSWORD' && (
        <PasswordStep
          name={file?.name ?? ''}
          error={passwordError}
          password={password}
          setPassword={setPassword}
          onSubmit={() => file && void run(file, password)}
          onCancel={reset}
        />
      )}

      {stage === 'OFFER_OCR' && ocrOffer && (
        <OcrOffer
          name={file?.name ?? ''}
          pages={ocrOffer.pages}
          isImage={ocrOffer.isImage}
          onRun={() => void runOcr()}
          onCancel={reset}
        />
      )}

      {stage === 'WORKING' && (
        <div className="flex flex-col items-center justify-center gap-3 py-16 text-sm text-[var(--color-muted-foreground)]">
          <SpinnerIcon className="h-5 w-5 animate-spin" />
          <p>{progress?.message ?? `Reading ${file?.name}…`}</p>
          {progress && (
            <div className="h-1 w-56 overflow-hidden rounded-full bg-[var(--color-muted)]">
              <div
                className="h-full rounded-full bg-[var(--color-primary)] transition-[width] duration-300"
                style={{ width: `${Math.round(progress.ratio * 100)}%` }}
              />
            </div>
          )}
        </div>
      )}

      {stage === 'REVIEW' && result && (
        <ReviewStep
          result={result}
          rows={rows}
          setRows={setRows}
          cards={cards}
          accounts={accounts}
          target={target}
          setTarget={setTarget}
          selectedCount={selected.length}
          selectedTotal={selectedTotal}
          onCommit={() => void commit()}
          onCancel={reset}
        />
      )}
    </>
  );
}

function PickStep({
  fileRef,
  onPick,
}: {
  fileRef: React.RefObject<HTMLInputElement | null>;
  onPick: (f: File) => void;
}) {
  const [dragging, setDragging] = React.useState(false);

  return (
    <>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const f = e.dataTransfer.files?.[0];
          if (f) onPick(f);
        }}
        className={cn(
          'rounded-xl border-2 border-dashed p-8 text-center transition-colors',
          dragging
            ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/5'
            : 'border-[var(--color-border)]',
        )}
      >
        <UploadIcon className="mx-auto h-8 w-8 text-[var(--color-muted-foreground)]" weight="duotone" />
        <p className="mt-3 text-sm font-medium">Drop a statement here</p>
        <p className="mt-1 text-xs text-[var(--color-muted-foreground)]">PDF, CSV, XLSX — or a photo, up to 5 MB</p>
        <Button className="mt-4" onClick={() => fileRef.current?.click()}>
          Choose a file
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept=".pdf,.csv,.xlsx,.xls,.png,.jpg,.jpeg,text/csv,application/pdf,image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onPick(f);
          }}
        />
      </div>

      <Card className="mt-5">
        <CardHeader>
          <CardTitle className="text-base">What works, and what does not</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex items-start gap-2">
            <CheckCircleIcon className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-success)]" weight="fill" />
            <p>
              <strong>Statements downloaded from a bank, card or app portal.</strong> These are
              generated as text, so every figure is read exactly. Bank and card statements, PhonePe,
              Google Pay and Paytm exports, and CAMS/KFintech CAS for mutual funds.
            </p>
          </div>
          <div className="flex items-start gap-2">
            <CheckCircleIcon className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-success)]" weight="fill" />
            <p>
              <strong>Password-protected PDFs.</strong> You will be asked for the password. It is
              used in this browser and never stored.
            </p>
          </div>
          <div className="flex items-start gap-2">
            <InfoIcon className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-warning)]" weight="fill" />
            <p>
              <strong>Scans and photographs do not work.</strong> A photo of a statement has no text
              to read — that needs OCR, which is a large download and unreliable on financial tables,
              so PaisaTrack does not pretend to do it. Download the original instead; every bank
              offers one.
            </p>
          </div>
          <div className="flex items-start gap-2">
            <InfoIcon className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-info)]" weight="fill" />
            <p>
              <strong>CSV is better than PDF where your bank offers it.</strong> The columns are
              already separated, so nothing has to be inferred from the layout.
            </p>
          </div>
        </CardContent>
      </Card>
    </>
  );
}

/**
 * Offering OCR.
 *
 * Deliberately not a one-click "we'll handle it". OCR on a statement is slow,
 * downloads a model, and is materially less accurate than the text PDF the
 * same bank will hand over for free. Saying all of that plainly is more useful
 * than a spinner that produces quietly wrong numbers.
 */
function OcrOffer({
  name,
  pages,
  isImage,
  onRun,
  onCancel,
}: {
  name: string;
  pages: number;
  isImage: boolean;
  onRun: () => void;
  onCancel: () => void;
}) {
  return (
    <Card className="max-w-xl">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <WarningIcon className="h-4 w-4 text-[var(--color-warning)]" weight="fill" />
          {isImage ? 'This is a photo' : 'This PDF is a scan'}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <p className="text-[var(--color-muted-foreground)]">
          {isImage
            ? `${name} is an image, so there is no text in it to read.`
            : `${name} has no text layer — it is a picture of a statement rather than a statement.`}{' '}
          PaisaTrack can try to read it with OCR, but you should know what that means.
        </p>

        <div className="space-y-2 rounded-md border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 p-3 text-xs">
          <p className="flex items-start gap-2">
            <WarningIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-warning)]" weight="fill" />
            <span>
              <strong>It will misread some figures.</strong> OCR is good at prose and noticeably
              worse at dense numeric tables — 8 against B, 0 against O, 1 against 7. Every row it
              produces is flagged for checking and none is pre-selected.
            </span>
          </p>
          <p className="flex items-start gap-2">
            <InfoIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              A <strong>statement downloaded from your bank or card portal</strong> is read exactly,
              with no guessing. Every Indian bank offers one. That is worth two minutes if you have
              the option.
            </span>
          </p>
        </div>

        <div className="space-y-1.5 text-xs text-[var(--color-muted-foreground)]">
          <p>
            <strong className="text-[var(--color-foreground)]">What happens:</strong> the OCR engine
            and an English language model (about 2 MB) download once from a CDN and are then cached
            by your browser.
          </p>
          <p>
            <strong className="text-[var(--color-foreground)]">
              Your statement is not part of that.
            </strong>{' '}
            It is never uploaded — the reading happens in a worker on this device. The download is
            one-directional.
          </p>
          {!isImage && pages > 10 && (
            <p>
              This document has {pages} pages; only the first 10 will be read. OCR is slow enough
              that the whole thing would hang the tab.
            </p>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          <Button onClick={onRun}>Read it with OCR</Button>
          <Button variant="outline" onClick={onCancel}>
            I'll get the original instead
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function PasswordStep({
  name,
  error,
  password,
  setPassword,
  onSubmit,
  onCancel,
}: {
  name: string;
  error: string | null;
  password: string;
  setPassword: (v: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  return (
    <Card className="max-w-md">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <LockIcon className="h-4 w-4 text-[var(--color-primary)]" weight="duotone" />
          This statement is protected
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-[var(--color-muted-foreground)]">
          {name} needs a password. Banks usually use your date of birth as DDMMYYYY, your PAN in
          lower case, or a combination of the two — the covering email says which.
        </p>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit();
          }}
        >
          <Field label="Password" required error={error ?? undefined}>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
              autoComplete="off"
            />
          </Field>

          <div className="mt-4 flex gap-2">
            <Button type="submit" disabled={!password}>
              Open
            </Button>
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function ReviewStep({
  result,
  rows,
  setRows,
  cards,
  accounts,
  target,
  setTarget,
  selectedCount,
  selectedTotal,
  onCommit,
  onCancel,
}: {
  result: ImportResult;
  rows: Row[];
  setRows: React.Dispatch<React.SetStateAction<Row[]>>;
  cards: ReturnType<typeof useCreditCards>;
  accounts: ReturnType<typeof useCashAccounts>;
  target: string;
  setTarget: (v: string) => void;
  selectedCount: number;
  selectedTotal: number;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const update = (i: number, patch: Partial<Row>) =>
    setRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const duplicates = rows.filter((r) => r.duplicate).length;

  /*
    Counted only for rows that came from a text layer.

    The OCR path demotes every row to LOW wholesale, so counting them here
    would print "N rows had no debit/credit marker and no usable balance" about
    rows whose direction the running-balance arithmetic resolved exactly — the
    number would be right and the stated reason would be false. Tesseract
    collapses runs of spaces, so the column signal is gone on a scan, but the
    balance signal is arithmetic rather than positional and survives intact.

    Nothing is lost by staying quiet: the OCR banner above already tells the
    reader to check every figure on every row, which is strictly stronger than
    what this banner would say.
  */
  const lowConfidence = result.viaOcr ? 0 : rows.filter((r) => r.confidence === 'LOW').length;

  const casHoldings = result.kind === 'CAS' ? result.holdings : [];

  if (result.kind === 'CAS' && rows.length === 0) {
    return (
      <>
        <Summary result={result} />
        {result.holdings.length === 0 ? (
          <EmptyState
            icon={ReceiptIcon}
            title="No holdings recognised"
            description="CAS layouts differ between CAMS, KFintech and the depositories. The holdings can be entered on the Investments page instead."
            action={<Button onClick={onCancel}>Try another file</Button>}
          />
        ) : (
          <Card className="mt-5">
            <CardHeader>
              <CardTitle className="text-base">{result.holdings.length} holdings found</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {result.holdings.map((h, i) => (
                <div
                  key={i}
                  className="flex items-start justify-between gap-3 border-b border-[var(--color-border)] py-2 last:border-0"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{h.name}</p>
                    <p className="text-xs text-[var(--color-muted-foreground)]">
                      {h.folio && `Folio ${h.folio} · `}
                      {h.units !== undefined && `${h.units.toLocaleString('en-IN')} units`}
                    </p>
                  </div>
                  <Money value={h.currentValue} className="shrink-0 text-sm font-semibold" />
                </div>
              ))}
              <div className="flex gap-2 pt-3">
                <Button onClick={onCommit}>Add {result.holdings.length} holdings</Button>
                <Button variant="outline" onClick={onCancel}>
                  Cancel
                </Button>
              </div>
            </CardContent>
          </Card>
        )}
      </>
    );
  }

  return (
    <>
      <Summary result={result} />

      {result.viaOcr && (
        <div className="mt-5 flex items-start gap-2 rounded-md border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 p-3 text-xs">
          <WarningIcon className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-warning)]" weight="fill" />
          <p>
            <strong>These were read by OCR from a scan.</strong> Check every figure against the
            document before importing — nothing is pre-selected, because a misread digit in a rupee
            amount is not a rounding error.
          </p>
        </div>
      )}

      {casHoldings.length > 0 && (
        <Card className="mt-5">
          <CardHeader>
            <CardTitle className="text-base">
              {casHoldings.length} holdings in this statement
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {casHoldings.map((h, i) => (
              <div
                key={i}
                className="flex items-start justify-between gap-3 border-b border-[var(--color-border)] py-2 last:border-0"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{h.name}</p>
                  <p className="text-xs text-[var(--color-muted-foreground)]">
                    {h.folio && `Folio ${h.folio} · `}
                    {h.units !== undefined && `${h.units.toLocaleString('en-IN')} units`}
                  </p>
                </div>
                <Money value={h.currentValue} className="shrink-0 text-sm font-semibold" />
              </div>
            ))}
            <p className="pt-2 text-xs text-[var(--color-muted-foreground)]">
              Holdings are added to Investments when you import. The movements below are the SIPs
              and purchases that produced them, and go in as expenses.
            </p>
          </CardContent>
        </Card>
      )}

      {rows.length === 0 ? (
        <EmptyState
          icon={ReceiptIcon}
          title="No transactions recognised"
          description="If this is a scan there is no text to read. Download the statement from your bank or card portal instead."
          action={<Button onClick={onCancel}>Try another file</Button>}
        />
      ) : (
        <>
          <Card className="mt-5">
            <CardContent className="space-y-4 pt-5">
              <Field
                label="Add these against"
                hint="Attributing them lets the Cash page tell you what should be left, and keeps card spending on the right card."
              >
                <Select value={target} onValueChange={setTarget}>
                  <SelectTrigger>
                    <SelectValue placeholder="Not specified" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">Not specified</SelectItem>
                    {accounts.map((a) => (
                      <SelectItem key={a.id} value={`acc:${a.id}`}>
                        {a.name}
                      </SelectItem>
                    ))}
                    {cards.map((c) => (
                      <SelectItem key={c.id} value={`card:${c.id}`}>
                        {c.issuer} ····{c.last4}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              {(duplicates > 0 || lowConfidence > 0) && (
                <div className="space-y-2 text-xs">
                  {duplicates > 0 && (
                    <p className="flex items-start gap-2 text-[var(--color-muted-foreground)]">
                      <CheckCircleIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-success)]" weight="fill" />
                      {duplicates} row{duplicates === 1 ? ' is' : 's are'} already in PaisaTrack and
                      have been left unticked, so importing the same period twice is safe.
                    </p>
                  )}
                  {lowConfidence > 0 && (
                    <p className="flex items-start gap-2 text-[var(--color-warning)]">
                      <WarningIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" weight="fill" />
                      {lowConfidence} row{lowConfidence === 1 ? '' : 's'} had no debit/credit marker
                      and no usable balance — check the direction on those.
                    </p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          <div className="mt-5 space-y-2">
            {rows.map((row, i) => (
              <Reveal key={`${row.fingerprint}-${i}`} delay={Math.min(i * 12, 240)}>
                <div
                  className={cn(
                    'rounded-lg border p-3 transition-colors',
                    row.include
                      ? 'border-[var(--color-primary)]/40 bg-[var(--color-primary)]/5'
                      : 'border-[var(--color-border)] opacity-70',
                  )}
                >
                  <div className="flex items-start gap-3">
                    <Checkbox
                      checked={row.include}
                      onCheckedChange={(v) => update(i, { include: Boolean(v) })}
                      aria-label={`Import ${row.description}`}
                      className="mt-1"
                    />

                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                        <span className="text-sm font-medium">{row.description}</span>
                        {row.duplicate && (
                          <Badge variant="outline" className="text-[10px]">
                            Already imported
                          </Badge>
                        )}
                        {row.confidence === 'LOW' && (
                          <Badge variant="warning" className="text-[10px]">
                            Check direction
                          </Badge>
                        )}
                      </div>

                      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--color-muted-foreground)]">
                        <span>{formatDate(row.date)}</span>
                        <span>·</span>
                        <button
                          type="button"
                          onClick={() =>
                            update(i, { direction: row.direction === 'DEBIT' ? 'CREDIT' : 'DEBIT' })
                          }
                          className="tap-row rounded px-1.5 py-0.5 underline underline-offset-2 hover:bg-[var(--color-accent)]"
                        >
                          {row.direction === 'DEBIT' ? 'Money out' : 'Money in'}
                        </button>
                      </div>

                      {row.direction === 'DEBIT' && (
                        <Select
                          value={row.category}
                          onValueChange={(v) => update(i, { category: v as ExpenseCategory })}
                        >
                          <SelectTrigger className="mt-2 h-8 w-44 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {EXPENSE_CATEGORIES.map((c) => (
                              <SelectItem key={c} value={c}>
                                {humanise(c)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    </div>

                    <Money
                      value={row.amount}
                      className={cn(
                        'shrink-0 text-sm font-semibold',
                        row.direction === 'CREDIT' && 'text-[var(--color-success)]',
                      )}
                    />
                  </div>
                </div>
              </Reveal>
            ))}
          </div>

          {/* Sticky so the commit is reachable without scrolling a long list. */}
          <div className="safe-bottom sticky bottom-16 z-10 mt-5 rounded-lg border border-[var(--color-border)] bg-[var(--color-card)]/95 p-3 backdrop-blur md:bottom-0">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm">
                <strong>{selectedCount}</strong> selected ·{' '}
                <Money value={selectedTotal} className="font-semibold" />
              </p>
              <div className="flex gap-2">
                <Button variant="outline" onClick={onCancel}>
                  Cancel
                </Button>
                <Button onClick={onCommit} disabled={selectedCount === 0}>
                  Import {selectedCount}
                </Button>
              </div>
            </div>
          </div>
        </>
      )}
    </>
  );
}

function Summary({ result }: { result: ImportResult }) {
  return (
    <Card>
      <CardContent className="pt-5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="info">{result.source}</Badge>
          {result.period && (
            <span className="text-xs text-[var(--color-muted-foreground)]">
              {formatDate(result.period.from)} – {formatDate(result.period.to)}
            </span>
          )}
          <span className="text-xs text-[var(--color-muted-foreground)]">
            {result.stats.pages ? `${result.stats.pages} pages · ` : ''}
            {result.stats.lines} lines read
          </span>
        </div>

        {result.warnings.length > 0 && (
          <ul className="mt-3 space-y-1">
            {result.warnings.map((w, i) => (
              <li key={i} className="flex items-start gap-2 text-xs text-[var(--color-muted-foreground)]">
                <InfoIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {w}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
