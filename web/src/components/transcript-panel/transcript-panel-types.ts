import type { TranscriptRole } from "@manglara/shared";
export interface TranscriptEntry {
    id: string;
    role: TranscriptRole;
    text: string;
  }

  export interface TranscriptPanelProps {
    entries: TranscriptEntry[];
    /** Speaker label per side. Defaults to the 1:1 call ("Tú" / "Manglara"). */
    labels?: Record<TranscriptRole, string>;
    /** Placeholder shown before the first entry. */
    emptyText?: string;
  }
