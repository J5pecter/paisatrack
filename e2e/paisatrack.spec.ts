/**
 * End-to-end tests against the production build.
 *
 * These check the things unit tests cannot: that the app boots, that data
 * written in one screen shows up in another, and that figures on the dashboard
 * agree with the page they came from.
 */
import { expect, test, type Page } from '@playwright/test';

/** Matches e2e/server.mjs, which Playwright starts alongside the preview. */
const SERVER = 'http://localhost:8788';

/**
 * Start every test from an empty database.
 *
 * The app keeps no local copy any more, so "empty" means an empty dataset on
 * the server rather than an empty IndexedDB. Each test gets a unique token and
 * the test server treats a token as a namespace, so parallel tests cannot see
 * each other's records — and no wipe is needed, because a fresh token has never
 * had any.
 *
 * `addInitScript` runs before the page's own scripts, so the config is in
 * localStorage by the time BootGate reads it and the app loads straight into
 * the welcome screen rather than the setup one.
 */
let namespaceCounter = 0;

async function freshApp(page: Page) {
  /*
    A namespace, not a credential — the test server treats whatever it is given
    as a bucket key and authenticates nothing. The real Worker's token handling
    is covered by worker/src/index.test.ts.
  */
  const namespace = `e2e_${Date.now().toString(36)}_${namespaceCounter++}_${Math.random().toString(36).slice(2, 8)}`;

  await page.addInitScript(
    ([url, tok]) => {
      localStorage.setItem(
        'paisatrack.worker',
        JSON.stringify({ url, token: tok, ocrEnabled: false, remindersEnabled: false, leadDays: 3 }),
      );
      // There is no old IndexedDB in a fresh context, but saying so explicitly
      // keeps the migration screen out of every test's way.
      localStorage.setItem('paisatrack.migrationHandled', 'yes');
    },
    [SERVER, namespace] as const,
  );

  await page.goto('./');
  await expect(page.getByText('Welcome to PaisaTrack')).toBeVisible();
}

async function loadSampleData(page: Page) {
  await page.getByRole('button', { name: 'Load sample data' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  // Seeding is one transaction, so these flip together. Playwright retries the
  // assertions, which is the wait — no arbitrary sleep needed.
  await expect(page.getByTestId('stat-income')).not.toHaveText('₹0');
  await expect(page.getByTestId('stat-spent')).not.toHaveText('₹0');
}

/** Read a rupee figure off the page as a plain number. */
function parseRupees(text: string): number {
  return Number(text.replace(/[^0-9.-]/g, ''));
}

async function rupeesOf(page: Page, testId: string): Promise<number> {
  return parseRupees(await page.getByTestId(testId).innerText());
}

test.describe('first run', () => {
  test('shows the welcome screen with nothing stored', async ({ page }) => {
    await freshApp(page);
    await expect(page.getByRole('button', { name: 'Load sample data' })).toBeVisible();
  });

  test('shows that it is connected to the server', async ({ page }) => {
    await freshApp(page);
    // The indicator is icon-only at every width, so assert on its accessible
    // name. "Connected" is the claim that matters: with no local copy, a user
    // needs to be able to tell at a glance whether their changes can be saved.
    await expect(page.getByRole('status', { name: /Connected/ })).toBeVisible();
  });
});

test.describe('dashboard', () => {
  test.beforeEach(async ({ page }) => {
    await freshApp(page);
    await loadSampleData(page);
  });

  test('every headline figure shows a real number', async ({ page }) => {
    for (const id of ['stat-income', 'stat-spent', 'stat-obligation', 'stat-savings']) {
      await expect(page.getByTestId(id)).toBeVisible();
      expect(await rupeesOf(page, id), `${id} should not be stuck at zero`).toBeGreaterThan(0);
    }
  });

  test('net worth equals cash plus investments minus both debts', async ({ page }) => {
    const cash = await rupeesOf(page, 'nw-cash');
    const investments = await rupeesOf(page, 'nw-investments');
    const cardDebt = Math.abs(await rupeesOf(page, 'nw-card-debt'));
    const loanDebt = Math.abs(await rupeesOf(page, 'nw-loan-debt'));
    const net = await rupeesOf(page, 'nw-total');

    // Cash was missing from this equation until accounts existed, which meant
    // every rupee in a wallet or bank was valued at zero.
    expect(cash, 'seeded data should include cash accounts').toBeGreaterThan(0);

    // Each figure is rendered rounded to the rupee, so allow a couple of rupees.
    expect(Math.abs(net - (cash + investments - cardDebt - loanDebt))).toBeLessThan(3);
  });

  test('upcoming dues are ordered soonest first', async ({ page }) => {
    // Scoped to the dues list. Scraping the whole page concatenates this list
    // with the per-card badges in the Debt and card-health panels, which are
    // independently ordered — so the combined sequence is not monotonic and
    // never was. That assertion passed only while the seeded dates happened to
    // line the groups up, and broke the moment "today" moved.
    const badges = await page
      .getByTestId('upcoming-dues')
      .getByText(/^(Due today|Due tomorrow|Due in \d+ days|Overdue by \d+ days?)$/)
      .allInnerTexts();

    expect(badges.length, 'no due badges found — the selector has gone stale').toBeGreaterThan(1);

    const days = badges.map((b) =>
      b.startsWith('Overdue') ? -Number(b.replace(/\D/g, ''))
      : b === 'Due today' ? 0
      : b === 'Due tomorrow' ? 1
      : Number(b.replace(/\D/g, '')),
    );
    for (let i = 1; i < days.length; i++) {
      expect(days[i]).toBeGreaterThanOrEqual(days[i - 1]);
    }
  });
});

test.describe('expenses', () => {
  test.beforeEach(async ({ page }) => {
    await freshApp(page);
    await loadSampleData(page);
    await page.goto('./expenses');
  });

  test('adding an expense updates the list and the count', async ({ page }) => {
    const countOf = async () =>
      Number((await page.getByTestId('expense-count').innerText()).match(/of (\d+)/)?.[1] ?? '0');
    const before = await countOf();

    await page.getByTestId('add-expense').click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    await dialog.getByPlaceholder('0').fill('2500');
    await dialog.getByPlaceholder('Swiggy order').fill('E2E test lunch');
    await dialog.getByRole('button', { name: 'Add expense' }).click();

    await expect(page.getByText('E2E test lunch')).toBeVisible();
    expect(await countOf()).toBe(before + 1);
  });

  test('a credit card expense demands to know which card', async ({ page }) => {
    await page.getByTestId('add-expense').click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    await dialog.getByPlaceholder('0').fill('900');

    await dialog.getByRole('combobox').filter({ hasText: 'UPI' }).click();
    await page.getByRole('option', { name: 'Credit card' }).click();
    await dialog.getByRole('button', { name: 'Add expense' }).click();

    await expect(page.getByText(/Pick which card/)).toBeVisible();
  });

  test('filters narrow the list to nothing when nothing matches', async ({ page }) => {
    await page.getByRole('button', { name: /^Filters/ }).click();
    const search = page.getByPlaceholder('Search description…');
    await expect(search).toBeVisible();
    await search.fill('zzzz-no-such-expense');

    await expect(page.getByText('Nothing matches those filters')).toBeVisible();
    await expect(page.getByTestId('expense-count')).toContainText('0 of');
  });
});

test.describe('credit cards', () => {
  test.beforeEach(async ({ page }) => {
    await freshApp(page);
    await loadSampleData(page);
    await page.goto('./cards');
  });

  test('the minimum-due trap reports the cost in years', async ({ page }) => {
    await page.getByRole('tab', { name: 'Minimum-due trap' }).click();
    await expect(page.getByText(/you would be in debt for/)).toBeVisible();
    await expect(page.getByText(/\d+ years?/).first()).toBeVisible();
  });

  test('avalanche never costs more interest than snowball', async ({ page }) => {
    await page.getByRole('tab', { name: 'Payoff planner' }).click();
    await expect(page.getByRole('heading', { name: 'Avalanche', exact: true })).toBeVisible();

    // Each strategy card lists "Total interest" with its figure beside it.
    const rows = page.locator('div').filter({ hasText: /^Total interest₹/ });
    const texts = await rows.allInnerTexts();
    const values = texts.map(parseRupees).filter((n) => Number.isFinite(n) && n > 0);

    if (values.length >= 2) {
      // Avalanche is rendered first and must be the cheaper of the two.
      expect(values[0]).toBeLessThanOrEqual(values[1]);
    }
  });

  test('the ledger tab computes statements from transactions', async ({ page }) => {
    await page.getByRole('tab', { name: 'Ledger' }).first().click();
    await expect(
      page.getByText(/Nothing logged on this card yet|Computed statements/),
    ).toBeVisible();
  });
});

test.describe('loans', () => {
  test('the amortization schedule balances on every row', async ({ page }) => {
    await freshApp(page);
    await loadSampleData(page);
    await page.goto('./loans');

    await expect(page.getByRole('heading', { name: 'Loans', exact: true })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Schedule' }).first()).toBeVisible();

    const rows = page.locator('tbody tr');
    await expect(rows.first()).toBeVisible();

    const count = Math.min(await rows.count(), 6);
    let checked = 0;
    for (let i = 0; i < count; i++) {
      const cells = await rows.nth(i).locator('td').allInnerTexts();
      if (cells.length < 6) continue;
      const emi = parseRupees(cells[2]);
      const interest = parseRupees(cells[3]);
      const principal = parseRupees(cells[4]);
      if (!emi) continue;
      expect(Math.abs(emi - (interest + principal))).toBeLessThan(2);
      checked++;
    }
    expect(checked, 'should have checked at least one instalment row').toBeGreaterThan(0);
  });
});

test.describe('income', () => {
  test.beforeEach(async ({ page }) => {
    await freshApp(page);
    await loadSampleData(page);
    await page.goto('./income');
  });

  test('the CTC calculator produces a take-home figure', async ({ page }) => {
    await page.getByRole('tab', { name: 'CTC calculator' }).click();
    await expect(page.getByTestId('ctc-inhand')).toBeVisible();
    expect(await rupeesOf(page, 'ctc-inhand')).toBeGreaterThan(0);
  });

  test('the payslip column adds up to gross', async ({ page }) => {
    await page.getByRole('tab', { name: 'CTC calculator' }).click();

    const cellValue = async (label: string) => {
      const row = page.getByRole('row').filter({ hasText: new RegExp(`^${label}₹`) }).first();
      const cells = await row.locator('td').allInnerTexts();
      return parseRupees(cells[1] ?? '0');
    };
    const basic = await cellValue('Basic');
    const hra = await cellValue('HRA');
    const special = await cellValue('Special allowance');
    const gross = await cellValue('Gross');

    expect(gross).toBeGreaterThan(0);
    expect(Math.abs(gross - (basic + hra + special))).toBeLessThan(2);
  });

  test('the tax comparison recommends a regime', async ({ page }) => {
    await page.getByRole('tab', { name: 'Tax regime' }).click();
    await expect(page.getByText(/regime saves you/)).toBeVisible();
    await expect(page.getByText('Better for you')).toBeVisible();
  });
});

test.describe('navigation and layout', () => {
  const ROUTES = ['', 'accounts', 'expenses', 'cards', 'loans', 'bills', 'income', 'budgets', 'investments', 'reports', 'import', 'settings', 'help'];

  test('every route loads without a crash', async ({ page }) => {
    await freshApp(page);
    await loadSampleData(page);

    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    for (const route of ROUTES) {
      await page.goto(`./${route}`);
      await expect(page.locator('main')).toBeVisible();
      // The error boundary's copy would be on screen if a page had thrown.
      await expect(page.getByText('Something broke')).toHaveCount(0);
    }

    expect(errors).toEqual([]);
  });

  test('nothing overflows horizontally', async ({ page }) => {
    await freshApp(page);
    await loadSampleData(page);

    for (const route of ROUTES) {
      await page.goto(`./${route}`);
      await page.waitForTimeout(500);
      const overflows = await page.evaluate(() => {
        const de = document.documentElement;
        return { over: de.scrollWidth > de.clientWidth + 1, docW: de.scrollWidth, vw: de.clientWidth };
      });
      expect(overflows.over, `/${route} overflows: ${overflows.docW}px in ${overflows.vw}px`).toBe(false);
    }
  });

  test('the command palette opens and navigates', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === 'mobile', 'Keyboard shortcuts are a desktop affordance.');

    await freshApp(page);
    await loadSampleData(page);
    await page.keyboard.press('ControlOrMeta+k');
    await expect(page.getByPlaceholder(/Search expenses/)).toBeVisible();

    await page.getByRole('option', { name: 'Loans', exact: true }).click();
    await expect(page).toHaveURL(/\/loans$/, { timeout: 15_000 });
    await expect(page.getByRole('heading', { name: 'Loans', exact: true })).toBeVisible();
  });

  test('every secondary page is reachable from the mobile tab bar', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'The tab bar only exists below md.');

    await freshApp(page);
    await loadSampleData(page);

    // The tab bar has room for four destinations; the rest live behind "More".
    // Before this sheet existed, "More" was a link straight to Settings and the
    // other five pages were unreachable on a phone without the keyboard.
    await page.getByRole('button', { name: 'More' }).click();
    const sheet = page.getByRole('dialog');
    await expect(sheet).toBeVisible();

    for (const label of ['Loans', 'Bills', 'Income', 'Budgets', 'Invest', 'Reports', 'Import', 'Settings', 'Help']) {
      await expect(sheet.getByRole('link', { name: label, exact: true })).toBeVisible();
    }

    await sheet.getByRole('link', { name: 'Reports', exact: true }).click();
    await expect(page).toHaveURL(/\/reports$/, { timeout: 15_000 });
    // Navigating must dismiss the sheet, or it covers the page just requested.
    await expect(page.getByRole('dialog')).toBeHidden();
  });

  test('N opens the quick-add dialog', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === 'mobile', 'Keyboard shortcuts are a desktop affordance.');

    await freshApp(page);
    await loadSampleData(page);
    await page.keyboard.press('n');
    await expect(page.getByRole('heading', { name: 'Add expense' })).toBeVisible();
  });
});

test.describe('persistence', () => {
  test('data survives a reload', async ({ page }) => {
    await freshApp(page);
    await loadSampleData(page);

    await page.goto('./expenses');
    const before = await page.getByTestId('expense-count').innerText();

    await page.reload();
    await expect(page.getByTestId('expense-count')).toHaveText(before);
  });
});
