import { useId, useRef } from 'react';
import { SearchIcon } from './icons.tsx';

const BARCODE_GAP_MS = 30;
const BARCODE_MIN_LENGTH = 4;

/** Rapid keystrokes ending in Enter are a barcode, not a typed search. */
export function isRapidBarcode(
  stamps: readonly number[],
  enterAt: number,
  value: string,
): boolean {
  const trimmed = value.trim();
  if (trimmed.length < BARCODE_MIN_LENGTH || stamps.length === 0) {
    return false;
  }
  const times = [...stamps, enterAt];
  for (let index = 1; index < times.length; index += 1) {
    const current = times[index];
    const previous = times[index - 1];
    if (
      current === undefined ||
      previous === undefined ||
      current - previous >= BARCODE_GAP_MS
    ) {
      return false;
    }
  }
  return true;
}

export function SearchBox({
  id,
  label,
  value,
  onChange,
  onSearch,
  onBarcode,
  placeholder,
  clock = () => performance.now(),
}: {
  id?: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  onSearch: (query: string) => void;
  onBarcode: (code: string) => void;
  placeholder?: string;
  clock?: () => number;
}) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const stamps = useRef<number[]>([]);

  return (
    <search>
      <label htmlFor={inputId} className="mb-1 block text-small text-text">
        {label}
      </label>
      <div className="flex h-11 items-center gap-2 rounded-control border border-border-strong bg-surface px-3">
        <SearchIcon />
        <input
          id={inputId}
          type="search"
          autoComplete="off"
          placeholder={placeholder}
          className="min-w-0 flex-1 bg-transparent text-body text-text outline-none"
          value={value}
          onChange={(event) => {
            const next = event.target.value;
            onChange(next);
            onSearch(next);
          }}
          onKeyDown={(event) => {
            const now = clock();
            if (event.key === 'Enter') {
              const barcode = isRapidBarcode(
                stamps.current,
                now,
                event.currentTarget.value,
              );
              stamps.current = [];
              event.preventDefault();
              if (barcode) {
                onBarcode(event.currentTarget.value.trim());
              } else {
                onSearch(event.currentTarget.value);
              }
              return;
            }
            if (event.key.length === 1) {
              stamps.current = [...stamps.current, now].slice(-64);
            }
          }}
        />
      </div>
    </search>
  );
}
