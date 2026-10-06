/**
 * Sample data.
 *
 * A realistic profile for a bachelor in India: one salary, two credit cards
 * (one of them revolving, so the interest engine has something to chew on),
 * a personal loan, the usual monthly bills, and three months of expenses.
 *
 * Amounts are deliberately plausible rather than round, and the random walk is
 * seeded so the sample looks the same every time you load it.
 */
import { addMonths, format, startOfMonth } from 'date-fns';
import { db } from './schema';
import { getDeviceId, nowISO } from './repository';
import { toPaise } from '@/lib/finance/money';
import { calculateEMI } from '@/lib/finance/emi';
import { ctcToInHand } from '@/lib/finance/salary';
import { dayOfMonthClamped, monthKey, toISODate } from '@/lib/finance/dates';
import type {
  Bill,
  BillEntry,
  Budget,
  CreditCard,
  CreditCardStatement,
  Expense,
  ExpenseCategory,
  Goal,
  Income,
  Investment,
  Loan,
  PaymentMethod,
  SalaryProfile,
  User,
} from '@/types';

/** Deterministic PRNG so the sample data never shifts between loads. */
function makeRandom(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const rand = makeRandom(20260930);
const pick = <T,>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];
const between = (min: number, max: number) => Math.round(min + rand() * (max - min));

function envelope() {
  const now = nowISO();
  return { createdAt: now, updatedAt: now, deviceId: getDeviceId(), deletedAt: null };
}

const USER_ID = 'user_sample';

export async function seedSampleData(): Promise<{ counts: Record<string, number> }> {
  const today = new Date();
  const thisMonth = startOfMonth(today);

  // --- User -----------------------------------------------------------------
  const user: User = {
    id: USER_ID,
    name: 'Sample User',
    currency: 'INR',
    financialYearStartMonth: 4,
    ...envelope(),
  };

  // --- Salary ---------------------------------------------------------------
  const ctc = toPaise(12_00_000);
  const breakdown = ctcToInHand({
    ctcAnnual: ctc,
    basicPercent: 45,
    hraPercent: 50,
    professionalTaxMonthly: toPaise(200),
    tdsMonthly: toPaise(2_100),
  });

  const salaryProfile: SalaryProfile = {
    id: 'salary_sample',
    userId: USER_ID,
    ctcAnnual: ctc,
    basicPercent: 45,
    hraPercent: 50,
    pfEmployeePercent: 12,
    pfEmployerPercent: 12,
    gratuityPercent: 4.81,
    professionalTaxMonthly: toPaise(200),
    tdsMonthly: toPaise(2_100),
    otherDeductionsMonthly: 0,
    inHandMonthly: breakdown.inHandMonthly,
    effectiveFrom: toISODate(addMonths(thisMonth, -18)),
    ...envelope(),
  };

  const income: Income[] = [
    {
      id: 'inc_salary',
      userId: USER_ID,
      source: 'Monthly salary',
      type: 'SALARY',
      amount: breakdown.inHandMonthly,
      frequency: 'MONTHLY',
      creditedOn: 1,
      effectiveFrom: toISODate(addMonths(thisMonth, -18)),
      isActive: true,
      ...envelope(),
    },
    {
      id: 'inc_freelance',
      userId: USER_ID,
      source: 'Weekend freelance',
      type: 'FREELANCE',
      amount: toPaise(18_000),
      frequency: 'MONTHLY',
      creditedOn: 20,
      effectiveFrom: toISODate(addMonths(thisMonth, -6)),
      isActive: true,
      ...envelope(),
    },
    {
      id: 'inc_fd',
      userId: USER_ID,
      source: 'FD interest',
      type: 'INTEREST',
      amount: toPaise(9_400),
      frequency: 'QUARTERLY',
      effectiveFrom: toISODate(addMonths(thisMonth, -12)),
      isActive: true,
      ...envelope(),
    },
  ];

  // --- Credit cards ---------------------------------------------------------
  const creditCards: CreditCard[] = [
    {
      id: 'card_hdfc',
      userId: USER_ID,
      cardName: 'Millennia',
      issuer: 'HDFC Bank',
      last4: '4821',
      creditLimit: toPaise(2_00_000),
      statementDay: 18,
      dueDay: 8,
      apr: 43.2,
      network: 'VISA',
      madPercent: 5,
      madVariant: 'HDFC',
      isActive: true,
      ...envelope(),
    },
    {
      id: 'card_sbi',
      userId: USER_ID,
      cardName: 'SimplyCLICK',
      issuer: 'SBI Card',
      last4: '9033',
      creditLimit: toPaise(1_00_000),
      statementDay: 5,
      dueDay: 25,
      apr: 45,
      network: 'MASTERCARD',
      madPercent: 5,
      madVariant: 'STANDARD',
      isActive: true,
      ...envelope(),
    },
  ];

  // The SBI card is deliberately left revolving so the interest engine and the
  // minimum-due trap simulator both have something real to show.
  const statements: CreditCardStatement[] = [];
  for (let i = 3; i >= 1; i--) {
    const stmtDate = dayOfMonthClamped(addMonths(thisMonth, -i), 5);
    const dueDate = dayOfMonthClamped(addMonths(thisMonth, -i + 1), 25);
    const total = toPaise(between(32_000, 48_000));
    const minimum = Math.round(total * 0.05);
    const paid = i === 1 ? minimum : Math.round(total * (0.1 + rand() * 0.3));

    statements.push({
      id: `stmt_sbi_${i}`,
      cardId: 'card_sbi',
      statementMonth: monthKey(stmtDate),
      statementDate: toISODate(stmtDate),
      dueDate: toISODate(dueDate),
      previousStatementDate: toISODate(dayOfMonthClamped(addMonths(thisMonth, -i - 1), 5)),
      openingBalance: toPaise(between(10_000, 20_000)),
      totalAmountDue: total,
      minimumDue: minimum,
      transactions: [],
      payments: [],
      totalPaid: paid,
      minimumPaid: paid >= minimum,
      interestCharged: toPaise(between(900, 1_600)),
      lateFee: 0,
      overlimitFee: 0,
      cashAdvanceFee: 0,
      gst: toPaise(between(160, 290)),
      status: paid >= total ? 'PAID' : paid >= minimum ? 'MIN_PAID' : 'PARTIAL',
      revolving: true,
      ...envelope(),
    });
  }

  // --- Loans ----------------------------------------------------------------
  const loanPrincipal = toPaise(3_50_000);
  const loanRate = 10.49;
  const loanTenure = 48;
  const loans: Loan[] = [
    {
      id: 'loan_personal',
      userId: USER_ID,
      loanName: 'Personal loan',
      lender: 'IDFC FIRST Bank',
      type: 'PERSONAL',
      principalAmount: loanPrincipal,
      interestRate: loanRate,
      tenureMonths: loanTenure,
      emiAmount: calculateEMI(loanPrincipal, loanRate, loanTenure),
      startDate: toISODate(addMonths(thisMonth, -14)),
      emiDay: 5,
      outstandingPrincipal: toPaise(2_62_400),
      isActive: true,
      ...envelope(),
    },
  ];

  // --- Bills ----------------------------------------------------------------
  const billDefs: Array<Partial<Bill> & Pick<Bill, 'name' | 'category' | 'type' | 'defaultAmount' | 'frequency' | 'dueDay'>> = [
    { name: 'Flat rent', category: 'RENT', type: 'FIXED', defaultAmount: toPaise(18_000), frequency: 'MONTHLY', dueDay: 5, isAutopay: false },
    { name: 'Electricity', category: 'ELECTRICITY', type: 'VARIABLE', defaultAmount: toPaise(1_400), frequency: 'MONTHLY', dueDay: 12, tracksUnits: true, provider: 'MSEDCL' },
    { name: 'Water', category: 'WATER', type: 'FIXED', defaultAmount: toPaise(350), frequency: 'MONTHLY', dueDay: 10 },
    { name: 'Broadband', category: 'INTERNET', type: 'FIXED', defaultAmount: toPaise(999), frequency: 'MONTHLY', dueDay: 3, isAutopay: true, provider: 'Airtel Xstream' },
    { name: 'Mobile', category: 'MOBILE', type: 'FIXED', defaultAmount: toPaise(399), frequency: 'MONTHLY', dueDay: 15, isAutopay: true, provider: 'Jio' },
    { name: 'Piped gas', category: 'GAS', type: 'VARIABLE', defaultAmount: toPaise(620), frequency: 'MONTHLY', dueDay: 20 },
    { name: 'Maid', category: 'MAID', type: 'FIXED', defaultAmount: toPaise(2_500), frequency: 'MONTHLY', dueDay: 1 },
    { name: 'Gym', category: 'GYM', type: 'FIXED', defaultAmount: toPaise(1_500), frequency: 'MONTHLY', dueDay: 7, isAutopay: true },
    { name: 'Netflix', category: 'SUBSCRIPTION', type: 'FIXED', defaultAmount: toPaise(649), frequency: 'MONTHLY', dueDay: 14, isAutopay: true },
    { name: 'Term insurance', category: 'INSURANCE', type: 'FIXED', defaultAmount: toPaise(14_800), frequency: 'ANNUAL', dueDay: 18, anchorMonth: 7 },
  ];

  const bills: Bill[] = billDefs.map((b, i) => ({
    id: `bill_${i}`,
    userId: USER_ID,
    isAutopay: false,
    isActive: true,
    ...b,
    ...envelope(),
  } as Bill));

  // Six months of bill entries, with the electricity bill spiking in summer.
  const billEntries: BillEntry[] = [];
  for (let m = 5; m >= 0; m--) {
    const month = addMonths(thisMonth, -m);
    const key = monthKey(month);
    const isSummer = [3, 4, 5].includes(month.getMonth()); // Apr-Jun

    for (const bill of bills) {
      if (bill.frequency === 'ANNUAL' && month.getMonth() + 1 !== bill.anchorMonth) continue;

      let amount = bill.defaultAmount;
      let units: number | undefined;
      if (bill.category === 'ELECTRICITY') {
        units = isSummer ? between(310, 420) : between(120, 190);
        amount = toPaise(Math.round(units * (rand() * 1.2 + 8.4)));
      } else if (bill.type === 'VARIABLE') {
        amount = toPaise(between(480, 780));
      }

      const dueDate = toISODate(dayOfMonthClamped(month, bill.dueDay));
      const isCurrentMonth = m === 0;
      const paid = !isCurrentMonth || bill.isAutopay || rand() > 0.5;

      billEntries.push({
        id: `be_${bill.id}_${key}`,
        billId: bill.id,
        billingMonth: key,
        amount,
        dueDate,
        ...(units !== undefined ? { unitsConsumed: units } : {}),
        paidOn: paid ? dueDate : null,
        status: paid ? 'PAID' : new Date(dueDate) < today ? 'OVERDUE' : 'PENDING',
        ...envelope(),
      });
    }
  }

  // --- Expenses -------------------------------------------------------------
  const expenseTemplates: Array<{ desc: string; category: ExpenseCategory; min: number; max: number }> = [
    { desc: 'Swiggy order', category: 'FOOD', min: 220, max: 680 },
    { desc: 'Zomato order', category: 'FOOD', min: 180, max: 540 },
    { desc: 'Office canteen', category: 'FOOD', min: 60, max: 150 },
    { desc: 'BigBasket groceries', category: 'GROCERIES', min: 900, max: 2_600 },
    { desc: 'Local kirana', category: 'GROCERIES', min: 180, max: 700 },
    { desc: 'Uber to office', category: 'TRANSPORT', min: 90, max: 320 },
    { desc: 'Metro recharge', category: 'TRANSPORT', min: 200, max: 500 },
    { desc: 'Petrol', category: 'FUEL', min: 800, max: 2_200 },
    { desc: 'Amazon order', category: 'SHOPPING', min: 400, max: 4_500 },
    { desc: 'Myntra order', category: 'SHOPPING', min: 900, max: 3_800 },
    { desc: 'Movie tickets', category: 'ENTERTAINMENT', min: 300, max: 900 },
    { desc: 'Weekend out', category: 'ENTERTAINMENT', min: 700, max: 2_400 },
    { desc: 'Pharmacy', category: 'HEALTH', min: 150, max: 900 },
    { desc: 'Haircut', category: 'PERSONAL_CARE', min: 200, max: 500 },
    { desc: 'Coffee', category: 'FOOD', min: 120, max: 380 },
    { desc: 'Udemy course', category: 'EDUCATION', min: 400, max: 1_400 },
    { desc: 'Gift for friend', category: 'GIFTS', min: 500, max: 2_500 },
    { desc: 'Household supplies', category: 'HOUSEHOLD', min: 250, max: 1_100 },
  ];

  const methods: PaymentMethod[] = ['UPI', 'UPI', 'UPI', 'CREDIT_CARD', 'CREDIT_CARD', 'CASH', 'DEBIT_CARD'];
  const expenses: Expense[] = [];
  let expenseSeq = 0;

  for (let m = 2; m >= 0; m--) {
    const month = addMonths(thisMonth, -m);
    const daysInThisMonth = m === 0 ? today.getDate() : new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
    const count = m === 0 ? Math.max(6, Math.round(daysInThisMonth * 0.9)) : between(28, 38);

    for (let i = 0; i < count; i++) {
      const tpl = pick(expenseTemplates);
      const day = between(1, daysInThisMonth);
      const method = pick(methods);
      const cardId = method === 'CREDIT_CARD' ? pick(['card_hdfc', 'card_sbi']) : null;

      expenses.push({
        id: `exp_${expenseSeq++}`,
        userId: USER_ID,
        amount: toPaise(between(tpl.min, tpl.max)),
        category: tpl.category,
        description: tpl.desc,
        date: format(new Date(month.getFullYear(), month.getMonth(), day), 'yyyy-MM-dd'),
        paymentMethod: method,
        creditCardId: cardId,
        isRecurring: false,
        ...envelope(),
      });
    }
  }

  // --- Investments ----------------------------------------------------------
  const investments: Investment[] = [
    {
      id: 'inv_sip',
      userId: USER_ID,
      name: 'Parag Parikh Flexi Cap',
      type: 'SIP',
      investedAmount: toPaise(2_40_000),
      currentValue: toPaise(2_91_500),
      startDate: toISODate(addMonths(thisMonth, -24)),
      monthlyContribution: toPaise(10_000),
      ...envelope(),
    },
    {
      id: 'inv_index',
      userId: USER_ID,
      name: 'UTI Nifty 50 Index',
      type: 'MUTUAL_FUND',
      investedAmount: toPaise(1_20_000),
      currentValue: toPaise(1_34_800),
      startDate: toISODate(addMonths(thisMonth, -12)),
      monthlyContribution: toPaise(5_000),
      ...envelope(),
    },
    {
      id: 'inv_emergency',
      userId: USER_ID,
      name: 'Emergency fund',
      type: 'EMERGENCY_FUND',
      investedAmount: toPaise(1_80_000),
      currentValue: toPaise(1_86_200),
      startDate: toISODate(addMonths(thisMonth, -20)),
      monthlyContribution: toPaise(8_000),
      ...envelope(),
    },
    {
      id: 'inv_ppf',
      userId: USER_ID,
      name: 'PPF',
      type: 'PPF',
      investedAmount: toPaise(3_00_000),
      currentValue: toPaise(3_46_900),
      startDate: toISODate(addMonths(thisMonth, -48)),
      monthlyContribution: toPaise(5_000),
      ...envelope(),
    },
  ];

  // --- Budgets --------------------------------------------------------------
  const currentKey = monthKey(today);
  const budgetDefs: Array<[ExpenseCategory, number]> = [
    ['FOOD', 9_000],
    ['GROCERIES', 6_000],
    ['TRANSPORT', 3_000],
    ['SHOPPING', 6_000],
    ['ENTERTAINMENT', 4_000],
    ['FUEL', 3_500],
  ];
  const budgets: Budget[] = budgetDefs.map(([category, limit], i) => ({
    id: `budget_${i}`,
    userId: USER_ID,
    month: currentKey,
    category,
    limitAmount: toPaise(limit),
    rollover: false,
    ...envelope(),
  }));

  // --- Goals ----------------------------------------------------------------
  const goals: Goal[] = [
    {
      id: 'goal_emergency',
      userId: USER_ID,
      name: '6-month emergency fund',
      targetAmount: toPaise(5_40_000),
      currentAmount: toPaise(1_86_200),
      targetDate: toISODate(addMonths(thisMonth, 18)),
      type: 'EMERGENCY_FUND',
      ...envelope(),
    },
    {
      id: 'goal_debtfree',
      userId: USER_ID,
      name: 'Clear all card debt',
      targetAmount: toPaise(45_000),
      currentAmount: toPaise(12_000),
      targetDate: toISODate(addMonths(thisMonth, 8)),
      type: 'DEBT_FREE',
      ...envelope(),
    },
    {
      id: 'goal_trip',
      userId: USER_ID,
      name: 'Japan trip',
      targetAmount: toPaise(2_20_000),
      currentAmount: toPaise(48_000),
      targetDate: toISODate(addMonths(thisMonth, 14)),
      type: 'TRAVEL',
      ...envelope(),
    },
  ];

  // --- Write ----------------------------------------------------------------
  //
  // All of it in one transaction. Writing table by table would let the UI
  // observe a half-seeded database — real income against zero spending — and
  // would leave that mess behind if a write failed partway through.
  //
  // Seeding is a local demo action, so these writes deliberately bypass the
  // repository's sync queue — there is nothing here worth committing to GitHub.
  // Dexie's transaction zone does not survive an async wrapper, so the tables
  // are written directly rather than through bulkPut().
  await db.transaction(
    'rw',
    [
      db.users, db.salaryProfile, db.income, db.creditCards, db.statements,
      db.loans, db.bills, db.billEntries, db.expenses, db.investments,
      db.budgets, db.goals,
    ],
    () =>
      Promise.all([
        db.users.bulkPut([user]),
        db.salaryProfile.bulkPut([salaryProfile]),
        db.income.bulkPut(income),
        db.creditCards.bulkPut(creditCards),
        db.statements.bulkPut(statements),
        db.loans.bulkPut(loans),
        db.bills.bulkPut(bills),
        db.billEntries.bulkPut(billEntries),
        db.expenses.bulkPut(expenses),
        db.investments.bulkPut(investments),
        db.budgets.bulkPut(budgets),
        db.goals.bulkPut(goals),
      ]),
  );

  return {
    counts: {
      income: income.length,
      creditCards: creditCards.length,
      statements: statements.length,
      loans: loans.length,
      bills: bills.length,
      billEntries: billEntries.length,
      expenses: expenses.length,
      investments: investments.length,
      budgets: budgets.length,
      goals: goals.length,
    },
  };
}

/** Is the database empty? Drives the first-run empty state. */
export async function isEmpty(): Promise<boolean> {
  const [expenses, cards, bills, loans, income] = await Promise.all([
    db.expenses.count(),
    db.creditCards.count(),
    db.bills.count(),
    db.loans.count(),
    db.income.count(),
  ]);
  return expenses + cards + bills + loans + income === 0;
}

/** Remove everything the seeder added, leaving real data alone. */
export async function removeSampleData(): Promise<void> {
  const isSample = (id: string) =>
    id.startsWith('exp_') || id.startsWith('bill_') || id.startsWith('be_') ||
    id.startsWith('card_') || id.startsWith('stmt_') || id.startsWith('loan_') ||
    id.startsWith('inv_') || id.startsWith('budget_') || id.startsWith('goal_') ||
    id.startsWith('inc_') || id === USER_ID || id === 'salary_sample';

  for (const table of db.tables) {
    if (table.name.startsWith('_')) continue;
    const rows = (await table.toArray()) as Array<{ id: string }>;
    const ids = rows.filter((r) => isSample(r.id)).map((r) => r.id);
    if (ids.length) await table.bulkDelete(ids);
  }
}
