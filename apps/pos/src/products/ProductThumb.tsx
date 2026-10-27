import { useEffect, useState } from 'react';
import { getDb } from '../data/db.ts';
import { getFile } from '../data/fileCache.ts';
import { tileBg } from './tiles.ts';

/** Object URL of a cached photo for the active shop, or null (works offline, 01 §PWA). */
export function useFileUrl(key: string | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!key) {
      setUrl(null);
      return;
    }
    let alive = true;
    let made: string | null = null;
    void getFile(getDb().tenantId, key).then((blob) => {
      if (!alive || !blob) return;
      made = URL.createObjectURL(blob);
      setUrl(made);
    });
    return () => {
      alive = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [key]);
  return url;
}

/** Product photo, or a coloured tile with the first letter (category colour). */
export function ProductThumb({
  name,
  imageKey,
  color,
  size = 'sm',
}: {
  name: string;
  imageKey: unknown;
  color: unknown;
  size?: 'sm' | 'lg';
}) {
  const url = useFileUrl(typeof imageKey === 'string' ? imageKey : null);
  const box =
    size === 'lg' ? 'size-20 rounded-card text-h1' : 'size-10 rounded-control';
  if (url) {
    return (
      <img
        src={url}
        alt=""
        data-testid="product-photo"
        className={`${box} shrink-0 object-cover`}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className={`flex shrink-0 items-center justify-center font-semibold text-tile-ink ${box} ${tileBg(color)}`}
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}
