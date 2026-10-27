// Secrets set with `wrangler secret put` (not in wrangler.jsonc, so `wrangler types` cannot see them),
// and test-only vars (10 §5). Merged into the generated Env.
interface __BaseEnv_Env {
  ACCESS_AUD: string;
  OWNER_EMAILS: string;
  OWNER_CODE_KEY: string;
  OWNER_SESSION_KEY: string;
  /** Only honoured when ENV = 'test'. */
  ACCESS_TEST_EMAIL?: string;
}
