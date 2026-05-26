import type { TranscriptRole } from "@manglara/shared";
import "./TranscriptPanel.css";

export interface TranscriptEntry {
  id: string;
  role: TranscriptRole;
  text: string;
}

interface TranscriptPanelProps {
  entries: TranscriptEntry[];
}

export function TranscriptPanel({ entries }: TranscriptPanelProps) {
  return (
    <div className="transcript-panel">
      <h2 className="transcript-panel__title">Conversación</h2>
      <div className="transcript-panel__list">
        {entries.length === 0 ? (
          <p className="transcript-panel__empty">
            La transcripción aparecerá aquí cuando empieces a hablar.
          </p>
        ) : (
          entries.map((entry) => (
            <div
              key={entry.id}
              className={`transcript-panel__entry transcript-panel__entry--${entry.role}`}
            >
              <span className="transcript-panel__role">
                {entry.role === "user" ? "Tú" : "Manglara"}
              </span>
              <p>{entry.text}</p>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
