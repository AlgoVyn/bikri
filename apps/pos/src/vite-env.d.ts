/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  /** `dev` in `--mode e2e` builds (.env.e2e): open bikri-dev without enrolment (D-088). */
  readonly VITE_LOCAL_TENANT?: string;
}

export {};
