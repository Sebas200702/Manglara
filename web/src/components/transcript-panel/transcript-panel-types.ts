import type { TranscriptRole } from "@manglara/shared";
export interface TranscriptEntry {
    id: string;
    role: TranscriptRole;
    text: string;
  }
  
  export interface TranscriptPanelProps {
    entries: TranscriptEntry[];
  }
  