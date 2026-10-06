/**
 * Help.
 *
 * Answers the questions a reasonable person actually asks of a finance app that
 * wants a GitHub token — starting with "where is my data" and "what happens if
 * I lose this laptop". Written to be read, not skimmed past.
 */
import * as React from 'react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui';
import {
  CalculatorIcon,
  CardIcon,
  GithubIcon,
  LockIcon,
  RupeeIcon,
  ShieldIcon,
  TipIcon,
} from '@/components/icons';
import { PageHeader } from '@/components/layout/AppShell';
import { CopyButton, Expandable } from '@/components/Chrome';
import { formatINR, toPaise } from '@/lib/finance/money';
import { interestForDays, simulateMinimumPayments } from '@/lib/finance/creditCard';

/** Worked once at render so the copy quotes the engine, not a stale constant. */
function useWorkedExamples() {
  return React.useMemo(() => {
    const trap = simulateMinimumPayments(toPaise(1_00_000), 43.2, 5);
    return {
      hdfcInterest: interestForDays(toPaise(15_000), 45, 32),
      trapYears: trap.years,
      trapMonths: trap.remainingMonths,
      trapInterest: trap.totalInterest,
    };
  }, []);
}

export function Help() {
  const ex = useWorkedExamples();

  return (
    <>
      <PageHeader
        title="Help"
        subtitle="How this works, and what it does with your money and your data"
      />

      <div className="grid gap-5 lg:grid-cols-2 [&>*]:min-w-0">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <LockIcon className="h-5 w-5 text-[var(--color-primary)]" weight="duotone" />
              Your data
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <Expandable question="Where is my data stored?" defaultOpen>
              In this browser, in IndexedDB. That is the only copy unless you turn
              on sync, in which case a second copy lives in a private GitHub repo
              that you own. There is no PaisaTrack server — there is nowhere else
              for it to be.
            </Expandable>

            <Expandable question="What happens if I clear my browser data?">
              It is gone from this device. That is the honest answer, and it is
              why two safety nets exist: <strong>Download backup</strong> in
              Settings gives you a JSON file you keep, and GitHub sync keeps a
              copy with full version history. Use at least one.
            </Expandable>

            <Expandable question="Can PaisaTrack see my finances?">
              No. There is no server to send anything to. The only network request
              this app can make is to <code>api.github.com</code>, and the browser
              enforces that — the Content Security Policy names that one host and
              blocks everything else.
            </Expandable>

            <Expandable question="Is my GitHub token safe?">
              It is stored in this browser&rsquo;s IndexedDB, masked once saved,
              and sent only to <code>api.github.com</code>. It is never logged and
              never placed in a URL. Use a <strong>fine-grained</strong> token
              scoped to the one data repo with Contents access only — then even if
              it leaked, it reaches nothing else. Disconnect in Settings removes it.
            </Expandable>

            <Expandable question="Someone has my unlocked laptop. What can they see?">
              Everything, the same as with your notes or your email. There is no
              app password, because a password stored on the same device it
              protects is theatre rather than security. Use your operating
              system&rsquo;s lock screen and full-disk encryption — those are real.
            </Expandable>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <GithubIcon className="h-5 w-5" weight="fill" />
              Sync and cost
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <Expandable question="Do I have to use GitHub sync?" defaultOpen>
              No. Without a token this is a complete, working, local-only tracker.
              Sync exists so a second device sees the same data, and so every save
              becomes a commit you can restore from.
            </Expandable>

            <Expandable question="Will this ever cost money?">
              No. Everything here is on GitHub&rsquo;s permanently free tier —
              Pages for hosting, a private repo for data, Actions for the nightly
              backup. No card at any step. If a feature ever needed a paid
              service, it would not be built.
            </Expandable>

            <Expandable question="Will I hit GitHub's rate limit?">
              Very unlikely. The limit is 5,000 requests an hour; normal use is
              around 100 a day. Polling uses a conditional request, so when
              nothing has changed GitHub answers 304 and it costs nothing at all.
              PaisaTrack also caps its own outbound calls, so a bug cannot burn
              your quota.
            </Expandable>

            <Expandable question="What if I edit on two devices at once?">
              Last write wins, decided by timestamp. If the timestamps tie, a
              device identifier breaks it — arbitrary, but both devices reach the
              same answer, which is what stops them disagreeing forever. Deletions
              are recorded as deletions, so deleting on one device is never undone
              by the other.
            </Expandable>

            <Expandable question="How do I restore an old version?">
              Three ways: <strong>Settings → Restore from file</strong> with a
              downloaded backup; copy a file out of <code>snapshots/</code> in
              your data repo over <code>data.json</code>; or
              <code> git checkout &lt;commit&gt; -- data.json</code>. Then open
              PaisaTrack and press Sync now.
            </Expandable>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <CardIcon className="h-5 w-5 text-[var(--color-primary)]" weight="duotone" />
              Credit card interest
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <Expandable question="Why was I charged interest when I paid most of the bill?" defaultOpen>
              Because &ldquo;most&rdquo; is not &ldquo;all&rdquo;. Clear the
              statement in full by the due date and retail spends cost nothing.
              Pay even one rupee less and you lose that interest-free period{' '}
              <strong>retroactively, from each transaction date</strong> — not
              from the statement date. A ₹15,000 purchase held 32 days at 45%
              costs <strong>{formatINR(ex.hdfcInterest, { paise: true })}</strong>,
              and the clock started the day you swiped.
            </Expandable>

            <Expandable question="What does paying the minimum actually cost?">
              On ₹1,00,000 at 43.2%, paying only the minimum keeps you in debt for{' '}
              <strong>
                {ex.trapYears} years{ex.trapMonths > 0 ? ` and ${ex.trapMonths} months` : ''}
              </strong>{' '}
              and costs <strong>{formatINR(ex.trapInterest)}</strong> in interest —
              more than the balance itself. The Cards page will run this on your
              own figures.
            </Expandable>

            <Expandable question="Why is cash withdrawal treated differently?">
              A cash advance has no grace period at all. Interest starts the day
              you withdraw, even if you clear the statement in full, and there is
              a fee of 2.5% or ₹500 — whichever is higher — on top.
            </Expandable>

            <Expandable question="Why does 30% utilization keep coming up?">
              Credit bureaus react to the proportion of your limit you are using.
              Above 30% your CIBIL score suffers even if you have never missed a
              payment. The card panels show the figure and the chart marks the
              line.
            </Expandable>

            <Expandable question="Statements or the ledger — which should I use?">
              Statements if you want it simple: type the totals off your bill.
              The ledger if you want precision: log transactions and payments, and
              PaisaTrack computes the statements itself, including exactly which
              transaction date each interest charge runs from. Either is fine, per
              card, and the rest of the app reads whichever you use.
            </Expandable>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <CalculatorIcon className="h-5 w-5 text-[var(--color-primary)]" weight="duotone" />
              The numbers
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <Expandable question="Are the tax figures reliable?" defaultOpen>
              They use the FY 2025-26 slabs as revised in Budget 2025, including
              the standard deduction, the section 87A rebate with marginal relief,
              surcharge with marginal relief, and 4% cess. They are an{' '}
              <strong>estimate for planning</strong>, not tax advice — capital
              gains and perquisites are not modelled. Confirm with your CA before
              acting.
            </Expandable>

            <Expandable question="Where do the lender rates come from?">
              A seeded table of indicative ranges for the major Indian banks and
              NBFCs, nudged monthly towards the published MCLR benchmark. They are
              a starting point — the only rate that matters is the one on your
              sanction letter, so the field stays editable.
            </Expandable>

            <Expandable question="Why do amounts sometimes differ by a rupee?">
              Each figure is rounded to the rupee for display while the arithmetic
              runs in paise. Add four rounded numbers and the total can differ by
              a rupee from the rounded total. The stored values are exact — money
              is held as whole paise and never as a floating-point number.
            </Expandable>

            <Expandable question="Can I get my data out?">
              Always. CSV export on Expenses, CSV and PDF on Reports, and a full
              JSON backup in Settings. With sync on, <code>data.json</code> in
              your repo is plain readable JSON. Nothing here is a lock-in format.
            </Expandable>
          </CardContent>
        </Card>
      </div>

      <Card className="mt-5">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldIcon className="h-5 w-5 text-[var(--color-primary)]" weight="duotone" />
            Setting up sync
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <ol className="space-y-3 text-sm">
            <li className="flex gap-3">
              <Badge variant="outline" className="h-5 shrink-0">1</Badge>
              <span>
                Create a <strong>private</strong> repo named{' '}
                <code className="rounded bg-[var(--color-muted)] px-1">paisatrack-data</code>.
                <CopyButton value="paisatrack-data" label="Copy name" className="ml-2 align-middle" />
              </span>
            </li>
            <li className="flex gap-3">
              <Badge variant="outline" className="h-5 shrink-0">2</Badge>
              <span>
                GitHub → Settings → Developer settings → Personal access tokens →{' '}
                <strong>Fine-grained tokens</strong>.
              </span>
            </li>
            <li className="flex gap-3">
              <Badge variant="outline" className="h-5 shrink-0">3</Badge>
              <span>
                Scope it to <strong>only</strong> that repo, with{' '}
                <strong>Contents: Read and write</strong>. Nothing else.
              </span>
            </li>
            <li className="flex gap-3">
              <Badge variant="outline" className="h-5 shrink-0">4</Badge>
              <span>Paste it into Settings → GitHub sync → Connect.</span>
            </li>
          </ol>

          <div className="flex items-start gap-2 rounded-md border border-[var(--color-border)] p-3 text-xs">
            <TipIcon className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-info)]" weight="duotone" />
            <p className="text-[var(--color-muted-foreground)]">
              Give the token an expiry. When it lapses, sync stops and says so —
              which is a far better failure than a token that works forever.
            </p>
          </div>

          <Button asChild variant="outline" size="sm">
            <a
              href="https://github.com/settings/personal-access-tokens/new"
              target="_blank"
              rel="noopener noreferrer"
              className="gap-1.5"
            >
              <GithubIcon className="h-4 w-4" weight="fill" />
              Create a token on GitHub
            </a>
          </Button>
        </CardContent>
      </Card>

      <p className="mt-5 flex items-center justify-center gap-1.5 text-center text-xs text-[var(--color-muted-foreground)]">
        <RupeeIcon className="h-3.5 w-3.5" weight="bold" />
        PaisaTrack runs at ₹0 and asks for no card, ever.
      </p>
    </>
  );
}
