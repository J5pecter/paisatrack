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
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui';
import {
  CalculatorIcon,
  CardIcon,
  CloudIcon,
  LockIcon,
  RupeeIcon,
  TipIcon,
} from '@/components/icons';
import { PageHeader } from '@/components/layout/AppShell';
import { Expandable } from '@/components/Chrome';
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
              On the Cloudflare Worker you deployed — your account, your database,
              running on their free plan. That is the only copy, which is what lets
              it follow you between devices, and is also why the backup below
              matters. There is no PaisaTrack company server and no shared
              database; nobody but you has the token that reaches yours.
            </Expandable>

            <Expandable question="What happens if I clear my browser data?">
              Nothing happens to your records — they are on the server, not in the
              browser. All you lose is the saved server address and token, which you
              paste back in.
              <strong className="mt-2 block">
                The real risk moved rather than disappearing.
              </strong>
              Losing the Cloudflare account, or deleting the database, takes
              everything, and no device holds a replica.{' '}
              <strong>Download backup</strong> in Settings writes a JSON file to your
              own disk. It is now the only copy that does not depend on the server —
              take one periodically.
            </Expandable>

            <Expandable question="Can PaisaTrack see my finances?">
              No. There is no PaisaTrack company and no shared database. The server
              your data sits on is one you created in your own Cloudflare account,
              and the token that reaches it is one you generated. The app can only
              talk to the origin named in its Content Security Policy — the browser
              enforces that, and it is your Worker.
            </Expandable>

            <Expandable question="How protected is my server token?">
              Treat it as the password to your finances, because that is what it is
              now. It is stored in this browser, masked once saved, sent only to
              your Worker, never logged and never placed in a URL.
              <strong className="mt-2 block">Anyone holding it has your data.</strong>
              Not just on your device — from anywhere. If you think it has leaked,
              change <code>API_TOKEN</code> on the Worker
              (<code>wrangler secret put API_TOKEN</code>) and paste the new one into
              Settings. The old one stops working immediately.
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
              <CloudIcon className="h-5 w-5 text-[var(--color-primary)]" weight="duotone" />
              Your server and what it costs
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <Expandable question="Why do I need to run a server?" defaultOpen>
              Because that is where your records are. PaisaTrack used to keep them
              in whichever browser typed them, which meant your phone and your
              laptop held different data and neither was complete. One database that
              every device reads is simpler to reason about and simpler to trust.
              <strong className="mt-2 block">The cost is that it needs a connection.</strong>
              Nothing is cached on the device, so with no network there is nothing
              to show. That was a deliberate trade for never wondering which copy is
              the real one.
            </Expandable>

            <Expandable question="Will this ever cost money?">
              No. GitHub Pages hosts the app; Cloudflare&rsquo;s free Workers plan
              runs the server and its database. Neither asked for a card. The D1
              free allowance is 5 GB and 100,000 row-writes a day, against which one
              person&rsquo;s finances are a rounding error — a few megabytes and
              perhaps fifty writes. If a feature ever needed a paid service, it would
              not be built.
            </Expandable>

            <Expandable question="Will I run out of free quota?">
              Realistically no. Cloudflare allows 100,000 requests a day and
              PaisaTrack makes one per change plus one per app open. The one
              allowance worth watching is Workers AI, at 10,000 neurons a day —
              roughly 50 to 150 statement pages — and only if you use server OCR.
              Running out makes that feature return an error until the next day;
              nothing else is affected, and Cloudflare does not ask for a card.
            </Expandable>

            <Expandable question="What if I edit on two devices at once?">
              Nothing clever happens, because nothing needs to. Both devices read and
              write the same database, so the later save is simply the current value
              — the same as two browser tabs open on one spreadsheet. The older
              version of this app needed conflict resolution, timestamps and
              tiebreakers precisely because each device had its own copy.
            </Expandable>

            <Expandable question="How do I restore an old version?">
              From a backup file: <strong>Settings → Restore from file</strong>. That
              is the only route, which makes taking one occasionally worth the ten
              seconds. There is no version history on the server — D1 stores the
              current value of each record, not its past.
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
            <CloudIcon className="h-5 w-5 text-[var(--color-primary)]" weight="duotone" />
            Setting up your server
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <p className="text-[var(--color-muted-foreground)]">
            Once, in about five minutes, with no credit card. The full guide is{' '}
            <code>worker/README.md</code> in the repository; this is the shape of it.
          </p>

          <ol className="space-y-2.5 text-sm">
            <li className="flex gap-3">
              <Badge variant="outline" className="h-5 shrink-0">1</Badge>
              <span>
                Create a free Cloudflare account, then from the <code>worker/</code> folder run{' '}
                <code>npx wrangler login</code>.
              </span>
            </li>
            <li className="flex gap-3">
              <Badge variant="outline" className="h-5 shrink-0">2</Badge>
              <span>
                Create the database and the push store —{' '}
                <code>npx wrangler d1 create paisatrack</code> and{' '}
                <code>npx wrangler kv namespace create PUSH</code> — and paste both ids into{' '}
                <code>wrangler.toml</code>.
              </span>
            </li>
            <li className="flex gap-3">
              <Badge variant="outline" className="h-5 shrink-0">3</Badge>
              <span>
                Set a long random <code>API_TOKEN</code> secret. This is the password to your
                finances, so generate it rather than inventing it.
              </span>
            </li>
            <li className="flex gap-3">
              <Badge variant="outline" className="h-5 shrink-0">4</Badge>
              <span>
                <code>npx wrangler deploy</code>, then set the repository variable{' '}
                <code>VITE_WORKER_ORIGIN</code> to the URL it prints and redeploy the site.
              </span>
            </li>
            <li className="flex gap-3">
              <Badge variant="outline" className="h-5 shrink-0">5</Badge>
              <span>Paste the URL and token into Settings → Your server.</span>
            </li>
          </ol>

          <div className="flex items-start gap-2 rounded-md border border-[var(--color-border)] p-3 text-xs">
            <TipIcon className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-info)]" weight="duotone" />
            <p className="text-[var(--color-muted-foreground)]">
              Step 4 is the one people miss. The app&rsquo;s Content Security Policy names your
              Worker&rsquo;s origin at build time, so until the site is rebuilt with it the browser
              blocks the request before it is sent — and the Worker&rsquo;s own logs stay empty,
              because nothing ever arrived. Settings checks for this and says so.
            </p>
          </div>
        </CardContent>
      </Card>

      <p className="mt-5 flex items-center justify-center gap-1.5 text-center text-xs text-[var(--color-muted-foreground)]">
        <RupeeIcon className="h-3.5 w-3.5" weight="bold" />
        PaisaTrack runs at ₹0 and asks for no card, ever.
      </p>
    </>
  );
}
