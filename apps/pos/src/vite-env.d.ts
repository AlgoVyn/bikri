/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

// biome-ignore lint/correctness/noUnusedVariables: ambient Vite environment declaration
interface ImportMetaEnv {
  /** `dev` in `--mode e2e` builds (.env.e2e): open bikri-dev without enrolment (D-088). */
  readonly VITE_LOCAL_TENANT?: string;
}

export {};
