import { useEffect, useMemo, useRef, useState } from "react";
import { fuzzyRank } from "../util/fuzzy";

export interface Command {
  id: string;
  title: string;
  /** Extra search terms, space-separated. */
  keywords?: string;
  /** Shortcut hint shown right-aligned, e.g. "⌘S". */
  hint?: string;
  section: string;
  run: () => void;
}

/**
 * ⌘K command palette: fuzzy-searchable access to every action. Executes the
 * selected command and closes; the palette itself owns no app state.
 */
export function CommandPalette({ commands, onClose }: { commands: Command[]; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const matches = useMemo(
    () => fuzzyRank(query, commands, (c) => [c.title, `${c.section} ${c.keywords ?? ""}`]),
    [query, commands],
  );
  const clamped = Math.min(sel, Math.max(0, matches.length - 1));

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${clamped}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [clamped, matches]);

  const runSelected = () => {
    const cmd = matches[clamped];
    if (!cmd) return;
    onClose();
    cmd.run();
  };

  return (
    <div
      className="palette-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <input
          ref={inputRef}
          className="palette__input"
          value={query}
          placeholder="Type a command…  (insert, export, dark, zoom…)"
          spellCheck={false}
          onChange={(e) => {
            setQuery(e.target.value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setSel((s) => Math.min(s + 1, matches.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSel((s) => Math.max(s - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              runSelected();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
            e.stopPropagation();
          }}
        />
        <ul className="palette__list" ref={listRef} role="listbox">
          {matches.length === 0 && <li className="palette__empty">No matching command</li>}
          {matches.map((c, i) => (
            <li key={c.id} role="presentation">
              <button
                type="button"
                role="option"
                aria-selected={i === clamped}
                data-index={i}
                className={`palette__item ${i === clamped ? "palette__item--sel" : ""}`}
                onPointerEnter={() => setSel(i)}
                onClick={() => {
                  setSel(i);
                  onClose();
                  c.run();
                }}
              >
                <span className="palette__section">{c.section}</span>
                <span className="palette__title">{c.title}</span>
                {c.hint && <kbd className="palette__hint">{c.hint}</kbd>}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
