/**
 * Reports — monthly and yearly, exportable as CSV or PDF.
 *
 * The PDF is produced client-side from the rendered DOM, so what you export is
 * exactly what you see and nothing is uploaded anywhere to generate it.
 */
import * as React from 'react';
import { toast } from 'sonner';
import Papa from 'papaparse';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
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
import { DownloadIcon, ReportIcon, ReceiptIcon } from '@/components/icons';
import { PageHeader } from '@/components/layout/AppShell';
import { Money } from '@/components/Money';
import { CategoryDonut, mountAllCharts, SimpleBarChart, TrendChart } from '@/components/LazyCharts';
import { useDashboardData } from '@/hooks/useData';
import {
  monthSnapshot,
  monthlyTrend,
  spendByCategory,
  topMerchants,
} from '@/lib/finance/dashboard';
import {
  financialYearLabel,
  financialYearMonths,
  formatMonthKey,
  lastNMonths,
  monthKey,
  todayISO,
} from '@/lib/finance/dates';
import { formatINR, percentage, sumMoney, toRupeeString } from '@/lib/finance/money';
import { downloadBlob, humanise } from '@/lib/utils';

export function Reports() {
  const data = useDashboardData();
  const [month, setMonth] = React.useState(monthKey(new Date()));
  const [exporting, setExporting] = React.useState(false);
  const printRef = React.useRef<HTMLDivElement>(null);

  const months = React.useMemo(() => lastNMonths(12).reverse(), []);
  const snapshot = React.useMemo(() => monthSnapshot({ month, ...data }), [month, data]);
  const categories = React.useMemo(() => spendByCategory(data.expenses, month), [data.expenses, month]);
  const merchants = React.useMemo(() => topMerchants(data.expenses, month), [data.expenses, month]);
  const trend = React.useMemo(() => monthlyTrend({ ...data, months: 12 }), [data]);

  const fyStartYear =
    new Date().getMonth() + 1 >= 4 ? new Date().getFullYear() : new Date().getFullYear() - 1;
  const fyMonths = React.useMemo(() => financialYearMonths(fyStartYear), [fyStartYear]);
  const fyRows = React.useMemo(
    () => fyMonths.map((m) => monthSnapshot({ month: m, ...data })),
    [fyMonths, data],
  );

  const hasData = data.expenses.length > 0 || data.income.length > 0;

  function exportMonthCSV() {
    const rows = categories.map((c) => ({
      month,
      category: c.category,
      amount: toRupeeString(c.amount),
      transactions: c.count,
      percentOfSpend: c.percent.toFixed(2),
    }));
    downloadBlob(
      Papa.unparse(rows),
      `paisatrack-${month}-by-category.csv`,
      'text/csv;charset=utf-8',
    );
    toast.success('Report exported');
  }

  function exportYearCSV() {
    const rows = fyRows.map((r) => ({
      month: r.month,
      income: toRupeeString(r.incomeExpected),
      expenses: toRupeeString(r.expensesTotal),
      bills: toRupeeString(r.billsTotal),
      emi: toRupeeString(r.emiTotal),
      savings: toRupeeString(r.savings),
      savingsRatePercent: r.savingsRatePercent.toFixed(2),
    }));
    downloadBlob(
      Papa.unparse(rows),
      `paisatrack-${financialYearLabel(new Date()).replace(/\s/g, '')}.csv`,
      'text/csv;charset=utf-8',
    );
    toast.success('Report exported');
  }

  /**
   * PDF export. jsPDF and html2canvas are a heavy pair, so they are imported
   * only when someone actually asks for a PDF rather than on every page load.
   */
  async function exportPDF() {
    if (!printRef.current) return;
    setExporting(true);
    try {
      // Charts mount only when scrolled near, so anything below the fold is
      // still a skeleton right now. Force them in and let React commit before
      // html2canvas photographs the page, or the PDF contains grey boxes.
      const [{ default: jsPDF }, { default: html2canvas }] = await Promise.all([
        import('jspdf'),
        import('html2canvas'),
        mountAllCharts(),
      ]);

      const canvas = await html2canvas(printRef.current, {
        scale: 2,
        backgroundColor: getComputedStyle(document.body).backgroundColor,
        logging: false,
      });

      const pdf = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });
      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      const margin = 24;
      const usableWidth = pageWidth - margin * 2;
      const imgHeight = (canvas.height * usableWidth) / canvas.width;

      let remaining = imgHeight;
      let offset = 0;
      const image = canvas.toDataURL('image/png');

      // Slice a tall capture across as many A4 pages as it needs.
      while (remaining > 0) {
        pdf.addImage(image, 'PNG', margin, margin - offset, usableWidth, imgHeight);
        remaining -= pageHeight - margin * 2;
        offset += pageHeight - margin * 2;
        if (remaining > 0) pdf.addPage();
      }

      pdf.save(`paisatrack-${month}-report.pdf`);
      toast.success('PDF saved');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not build the PDF');
    } finally {
      setExporting(false);
    }
  }

  if (!hasData) {
    return (
      <>
        <PageHeader title="Reports" />
        <Card>
          <EmptyState
            icon={ReportIcon}
            title="Nothing to report yet"
            description="Once you have logged some income and expenses, this becomes a month-by-month picture of where your money goes."
          />
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Reports"
        subtitle={financialYearLabel(new Date())}
        actions={
          <>
            <Select value={month} onValueChange={setMonth}>
              <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
              <SelectContent>
                {months.map((m) => (
                  <SelectItem key={m} value={m}>{formatMonthKey(m)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" onClick={exportMonthCSV} className="gap-1.5">
              <DownloadIcon className="h-4 w-4" weight="bold" />
              CSV
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void exportPDF()}
              disabled={exporting}
              className="gap-1.5"
            >
              <DownloadIcon className="h-4 w-4" weight="bold" />
              {exporting ? 'Building…' : 'PDF'}
            </Button>
          </>
        }
      />

      <Tabs defaultValue="month">
        <TabsList>
          <TabsTrigger value="month">Monthly</TabsTrigger>
          <TabsTrigger value="year">Financial year</TabsTrigger>
        </TabsList>

        <TabsContent value="month">
          <div ref={printRef} className="space-y-5 bg-[var(--color-background)]">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
              <Tile label="Income" value={snapshot.incomeExpected} />
              <Tile label="Expenses" value={snapshot.expensesTotal} />
              <Tile label="Bills" value={snapshot.billsTotal} />
              <Tile label="EMIs" value={snapshot.emiTotal} />
              <Tile
                label="Saved"
                value={snapshot.savings}
                sub={`${snapshot.savingsRatePercent.toFixed(0)}% rate`}
                tone="good"
              />
            </div>

            <div className="grid gap-5 lg:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">
                    Spending by category — {formatMonthKey(month)}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {categories.length === 0 ? (
                    <p className="py-10 text-center text-sm text-[var(--color-muted-foreground)]">
                      No expenses logged this month.
                    </p>
                  ) : (
                    <CategoryDonut data={categories} />
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Where it went most</CardTitle>
                </CardHeader>
                <CardContent>
                  {merchants.length === 0 ? (
                    <p className="py-10 text-center text-sm text-[var(--color-muted-foreground)]">
                      Nothing to show.
                    </p>
                  ) : (
                    <Table>
                      <THead>
                        <TR>
                          <TH>Description</TH>
                          <TH className="text-right">Times</TH>
                          <TH className="text-right">Total</TH>
                        </TR>
                      </THead>
                      <TBody>
                        {merchants.map((m) => (
                          <TR key={m.description}>
                            <TD>
                              <div className="flex items-center gap-2">
                                <ReceiptIcon
                                  className="h-3.5 w-3.5 shrink-0 text-[var(--color-muted-foreground)]"
                                  weight="duotone"
                                />
                                <span className="truncate">{m.description}</span>
                              </div>
                            </TD>
                            <TD className="tnum text-right text-[var(--color-muted-foreground)]">
                              {m.count}
                            </TD>
                            <TD className="text-right">
                              <Money value={m.amount} className="font-medium" />
                            </TD>
                          </TR>
                        ))}
                      </TBody>
                    </Table>
                  )}
                </CardContent>
              </Card>
            </div>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Category detail</CardTitle>
              </CardHeader>
              <CardContent>
                <Table>
                  <THead>
                    <TR>
                      <TH>Category</TH>
                      <TH className="text-right">Transactions</TH>
                      <TH className="text-right">Amount</TH>
                      <TH className="text-right">Share</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {categories.map((c) => (
                      <TR key={c.category}>
                        <TD>{humanise(c.category)}</TD>
                        <TD className="tnum text-right text-[var(--color-muted-foreground)]">
                          {c.count}
                        </TD>
                        <TD className="text-right"><Money value={c.amount} className="font-medium" /></TD>
                        <TD className="tnum text-right text-[var(--color-muted-foreground)]">
                          {c.percent.toFixed(1)}%
                        </TD>
                      </TR>
                    ))}
                    <TR className="bg-[var(--color-muted)]/40">
                      <TD className="font-semibold">Total</TD>
                      <TD className="tnum text-right font-semibold">
                        {categories.reduce((s, c) => s + c.count, 0)}
                      </TD>
                      <TD className="text-right">
                        <Money
                          value={sumMoney(categories.map((c) => c.amount))}
                          className="font-semibold"
                        />
                      </TD>
                      <TD className="text-right font-semibold">100%</TD>
                    </TR>
                  </TBody>
                </Table>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">12-month trend</CardTitle>
              </CardHeader>
              <CardContent>
                <TrendChart data={trend} />
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="year" className="space-y-5">
          <div className="flex justify-end">
            <Button variant="outline" size="sm" onClick={exportYearCSV} className="gap-1.5">
              <DownloadIcon className="h-4 w-4" weight="bold" />
              Export year as CSV
            </Button>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">{financialYearLabel(new Date())}</CardTitle>
              <p className="text-sm text-[var(--color-muted-foreground)]">
                April to March, the Indian financial year.
              </p>
            </CardHeader>
            <CardContent>
              <Table>
                <THead>
                  <TR>
                    <TH>Month</TH>
                    <TH className="text-right">Income</TH>
                    <TH className="text-right">Expenses</TH>
                    <TH className="text-right hidden sm:table-cell">Bills</TH>
                    <TH className="text-right hidden sm:table-cell">EMIs</TH>
                    <TH className="text-right">Saved</TH>
                    <TH className="text-right">Rate</TH>
                  </TR>
                </THead>
                <TBody>
                  {fyRows.map((r) => {
                    const future = r.month > monthKey(new Date());
                    return (
                      <TR key={r.month} className={future ? 'opacity-40' : ''}>
                        <TD className="text-xs">{formatMonthKey(r.month)}</TD>
                        <TD className="text-right"><Money value={r.incomeExpected} /></TD>
                        <TD className="text-right"><Money value={r.expensesTotal} /></TD>
                        <TD className="hidden text-right sm:table-cell">
                          <Money value={r.billsTotal} />
                        </TD>
                        <TD className="hidden text-right sm:table-cell">
                          <Money value={r.emiTotal} />
                        </TD>
                        <TD className="text-right">
                          <Money value={r.savings} className="font-medium" colour />
                        </TD>
                        <TD className="text-right">
                          <Badge
                            variant={
                              r.savingsRatePercent >= 30 ? 'success'
                              : r.savingsRatePercent >= 15 ? 'warning'
                              : 'danger'
                            }
                          >
                            {r.savingsRatePercent.toFixed(0)}%
                          </Badge>
                        </TD>
                      </TR>
                    );
                  })}
                  <TR className="bg-[var(--color-muted)]/40">
                    <TD className="font-semibold">Year</TD>
                    <TD className="text-right">
                      <Money value={sumMoney(fyRows.map((r) => r.incomeExpected))} className="font-semibold" />
                    </TD>
                    <TD className="text-right">
                      <Money value={sumMoney(fyRows.map((r) => r.expensesTotal))} className="font-semibold" />
                    </TD>
                    <TD className="hidden text-right sm:table-cell">
                      <Money value={sumMoney(fyRows.map((r) => r.billsTotal))} className="font-semibold" />
                    </TD>
                    <TD className="hidden text-right sm:table-cell">
                      <Money value={sumMoney(fyRows.map((r) => r.emiTotal))} className="font-semibold" />
                    </TD>
                    <TD className="text-right">
                      <Money value={sumMoney(fyRows.map((r) => r.savings))} className="font-semibold" />
                    </TD>
                    <TD className="text-right font-semibold">
                      {percentage(
                        sumMoney(fyRows.map((r) => r.savings)),
                        sumMoney(fyRows.map((r) => r.incomeExpected)),
                      ).toFixed(0)}
                      %
                    </TD>
                  </TR>
                </TBody>
              </Table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Savings by month</CardTitle>
            </CardHeader>
            <CardContent>
              <SimpleBarChart
                data={fyRows.map((r) => ({
                  label: formatMonthKey(r.month).slice(0, 3),
                  value: r.savings,
                }))}
                name="Saved"
              />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <p className="mt-5 text-center text-xs text-[var(--color-muted-foreground)]">
        Generated {todayISO()} · {formatINR(sumMoney(data.expenses.map((e) => e.amount)))} tracked in
        total across {data.expenses.length} expenses
      </p>
    </>
  );
}

function Tile({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: number;
  sub?: string;
  tone?: 'good';
}) {
  return (
    <Card>
      <CardContent className="pt-5">
        <p className="text-xs text-[var(--color-muted-foreground)]">{label}</p>
        <Money
          value={value}
          className={`text-xl font-semibold ${tone === 'good' ? 'text-[var(--color-success)]' : ''}`}
          animate
        />
        {sub && <p className="mt-0.5 text-xs text-[var(--color-muted-foreground)]">{sub}</p>}
      </CardContent>
    </Card>
  );
}
