import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { monthKey } from '@/lib/finance/dates';

export type Theme = 'dark' | 'light';

interface UIState {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;

  /** Month the reports and budget screens are looking at. */
  selectedMonth: string;
  setSelectedMonth: (month: string) => void;

  commandOpen: boolean;
  setCommandOpen: (open: boolean) => void;

  quickAddOpen: boolean;
  setQuickAddOpen: (open: boolean) => void;

  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
}

export const useUI = create<UIState>()(
  persist(
    (set, get) => ({
      theme: 'dark',
      setTheme: (theme) => {
        applyTheme(theme);
        set({ theme });
      },
      toggleTheme: () => get().setTheme(get().theme === 'dark' ? 'light' : 'dark'),

      selectedMonth: monthKey(new Date()),
      setSelectedMonth: (selectedMonth) => set({ selectedMonth }),

      commandOpen: false,
      setCommandOpen: (commandOpen) => set({ commandOpen }),

      quickAddOpen: false,
      setQuickAddOpen: (quickAddOpen) => set({ quickAddOpen }),

      sidebarCollapsed: false,
      toggleSidebar: () => set({ sidebarCollapsed: !get().sidebarCollapsed }),
    }),
    {
      name: 'paisatrack.ui',
      // Transient UI state must not survive a reload.
      partialize: (s) => ({
        theme: s.theme,
        sidebarCollapsed: s.sidebarCollapsed,
      }) as UIState,
    },
  ),
);

export function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return;
  document.documentElement.classList.toggle('dark', theme === 'dark');
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', theme === 'dark' ? '#0f172a' : '#ffffff');
}

/** Called once at boot so the DOM matches the persisted preference. */
export function initTheme(): void {
  applyTheme(useUI.getState().theme);
}
