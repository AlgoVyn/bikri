// Vite's eager raw glob, used by the I19 static check (vite is not a direct dependency of the API).
interface ImportMeta {
  glob<T>(
    pattern: string,
    options: { query: '?raw'; import: 'default'; eager: true },
  ): Record<string, T>;
}
