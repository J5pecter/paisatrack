/**
 * Icons — Phosphor.
 *
 * Every icon in the app comes from here, aliased to an app-level name. That
 * keeps the icon vocabulary consistent, makes a future swap a one-file change,
 * and lets us pick Phosphor's India-specific glyphs (CurrencyInr) where a
 * generic set would only offer a dollar sign.
 *
 * Phosphor ships six weights. The convention in this app:
 *   - regular  — body text and table rows
 *   - bold     — navigation, buttons, anything that needs to read at 16px
 *   - duotone  — feature cards and empty states, where an icon is decorative
 *   - fill     — the active state of a toggle
 */
export { IconContext } from '@phosphor-icons/react';
export type { Icon as PhosphorIcon, IconWeight } from '@phosphor-icons/react';

export {
  // Navigation
  SquaresFour as DashboardIcon,
  Receipt as ExpenseIcon,
  CreditCard as CardIcon,
  Bank as LoanIcon,
  ArrowsLeftRight as BillIcon,
  Wallet as IncomeIcon,
  PiggyBank as BudgetIcon,
  ChartLineUp as InvestmentIcon,
  ChartBar as ReportIcon,
  GearSix as SettingsIcon,

  // Chrome
  List as MenuIcon,
  MagnifyingGlass as SearchIcon,
  Plus as PlusIcon,
  X as CloseIcon,
  Check as CheckIcon,
  CaretDown as CaretDownIcon,
  CaretUp as CaretUpIcon,
  CaretRight as CaretRightIcon,
  ArrowRight as ArrowRightIcon,
  ArrowUp as ArrowUpIcon,
  ArrowDown as ArrowDownIcon,
  DotsThreeVertical as MoreIcon,
  Moon as MoonIcon,
  Sun as SunIcon,

  // Status
  Warning as WarningIcon,
  WarningCircle as WarningCircleIcon,
  CheckCircle as CheckCircleIcon,
  Info as InfoIcon,
  Prohibit as BlockedIcon,
  CircleNotch as SpinnerIcon,
  Clock as ClockIcon,
  Fire as HotIcon,

  // Trends
  TrendUp as TrendUpIcon,
  TrendDown as TrendDownIcon,
  ChartPieSlice as PieIcon,
  ChartDonut as DonutIcon,

  // Sync
  Cloud as CloudIcon,
  CloudSlash as CloudOffIcon,
  CloudCheck as CloudSyncedIcon,
  ArrowsClockwise as SyncIcon,
  GithubLogo as GithubIcon,

  // Actions
  PencilSimple as EditIcon,
  Trash as DeleteIcon,
  Copy as DuplicateIcon,
  DownloadSimple as DownloadIcon,
  UploadSimple as UploadIcon,
  FunnelSimple as FilterIcon,
  CalendarBlank as CalendarIcon,
  Eye as ShowIcon,
  EyeSlash as HideIcon,
  Lock as LockIcon,
  FloppyDisk as SaveIcon,
  ArrowCounterClockwise as UndoIcon,

  // Money and finance
  CurrencyInr as RupeeIcon,
  Calculator as CalculatorIcon,
  Scales as ScalesIcon,
  Coins as CoinsIcon,
  HandCoins as PayIcon,
  Receipt as ReceiptIcon,
  Percent as PercentIcon,
  Target as GoalIcon,
  Sparkle as SparkleIcon,
  Lightbulb as TipIcon,
  ShieldCheck as ShieldIcon,
  Bell as ReminderIcon,
  ListChecks as ChecklistIcon,
  Equals as EqualsIcon,

  // Loan types
  HouseLine as HomeLoanIcon,
  Car as CarLoanIcon,
  GraduationCap as EducationLoanIcon,
  Buildings as PropertyLoanIcon,
  User as PersonalLoanIcon,
  Medal as GoldLoanIcon,

  // Bill categories
  Lightning as ElectricityIcon,
  Drop as WaterIcon,
  WifiHigh as InternetIcon,
  DeviceMobile as MobileIcon,
  Flame as GasIcon,
  Television as DthIcon,
  Broom as MaidIcon,
  CookingPot as CookIcon,
  Barbell as GymIcon,
  Play as SubscriptionIcon,
  Umbrella as InsuranceIcon,
  HouseSimple as RentIcon,

  // Expense categories
  ForkKnife as FoodIcon,
  ShoppingCart as GroceriesIcon,
  Bus as TransportIcon,
  GasPump as FuelIcon,
  ShoppingBag as ShoppingIcon,
  FilmSlate as EntertainmentIcon,
  FirstAid as HealthIcon,
  AirplaneTilt as TravelIcon,
  Scissors as PersonalCareIcon,
  Gift as GiftIcon,
  Armchair as HouseholdIcon,
  DotsThreeCircle as OtherIcon,
} from '@phosphor-icons/react';
