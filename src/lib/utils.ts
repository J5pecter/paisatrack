import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Merge Tailwind classes, letting later ones win over earlier conflicts. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * Acronyms that must stay upper-case. Nobody writes "Ppf" or "Upi", and a
 * finance app that does looks like it does not know the domain.
 */
const ACRONYMS = new Set([
  'PPF', 'EPF', 'SIP', 'NPS', 'FD', 'RD', 'UPI', 'EMI', 'DTH', 'LAP',
  'HRA', 'CTC', 'TDS', 'GST', 'APR', 'MAD', 'CIBIL', 'ATM', 'NEFT', 'IMPS', 'RTGS',
]);

/**
 * Title Case a SCREAMING_SNAKE enum for display.
 *   CASH_ADVANCE   -> "Cash advance"
 *   MUTUAL_FUND    -> "Mutual fund"
 *   PPF            -> "PPF"
 *   EMERGENCY_FUND -> "Emergency fund"
 */
export function humanise(value: string): string {
  // Split on underscores AND camelCase humps, so both `CREDIT_CARD` and the
  // table name `creditCards` read as "Credit cards" rather than "Creditcards".
  const words = value.replace(/([a-z0-9])([A-Z])/g, '$1_$2').split('_');
  return words
    .map((word, i) => {
      const upper = word.toUpperCase();
      if (ACRONYMS.has(upper)) return upper;
      const lower = word.toLowerCase();
      // Only the first word is capitalised; the rest read as a sentence.
      return i === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
    })
    .join(' ');
}

/** Deterministic colour index for a label, so the same category keeps its colour. */
export function colourIndex(label: string, buckets: number): number {
  let hash = 0;
  for (let i = 0; i < label.length; i++) hash = (hash * 31 + label.charCodeAt(i)) | 0;
  return Math.abs(hash) % buckets;
}

export function downloadBlob(content: BlobPart, filename: string, type: string): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
