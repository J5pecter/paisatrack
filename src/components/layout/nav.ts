/**
 * The navigation model.
 *
 * Kept in its own module so the shell and the command palette can both read it
 * without importing each other — the palette lives inside the shell, and a
 * circular import between the two is the kind of thing that works until it
 * suddenly does not.
 */
import {
  BillIcon,
  BudgetIcon,
  CardIcon,
  CashIcon,
  DashboardIcon,
  ExpenseIcon,
  IncomeIcon,
  InvestmentIcon,
  LoanIcon,
  ReportIcon,
  UploadIcon,
  SettingsIcon,
  TipIcon,
} from '@/components/icons';
import type { PhosphorIcon } from '@/components/icons';

export interface NavItem {
  to: string;
  label: string;
  icon: PhosphorIcon;
  /** Shown in the mobile tab bar, which has room for five. */
  primary?: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: DashboardIcon, primary: true },
  { to: '/accounts', label: 'Cash', icon: CashIcon, primary: true },
  { to: '/expenses', label: 'Expenses', icon: ExpenseIcon, primary: true },
  { to: '/cards', label: 'Cards', icon: CardIcon, primary: true },
  { to: '/loans', label: 'Loans', icon: LoanIcon },
  { to: '/bills', label: 'Bills', icon: BillIcon },
  { to: '/income', label: 'Income', icon: IncomeIcon },
  { to: '/budgets', label: 'Budgets', icon: BudgetIcon },
  { to: '/investments', label: 'Invest', icon: InvestmentIcon },
  { to: '/reports', label: 'Reports', icon: ReportIcon },
  { to: '/import', label: 'Import', icon: UploadIcon },
  { to: '/settings', label: 'Settings', icon: SettingsIcon },
  { to: '/help', label: 'Help', icon: TipIcon },
];
