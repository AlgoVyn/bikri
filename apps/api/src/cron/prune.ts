/**
 * Nightly retention prune for all tenants (03 §4.4), within the Free plan's 50 D1 calls per
 * invocation: stops after 40 calls and continues the next night. Platform code: every statement
 * names its tenant.
 */
import { pruneAll } from '../platform/prune.ts';

export async function scheduled(
  _controller: ScheduledController,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  const report = await pruneAll(env, Date.now());
  console.log(JSON.stringify({ cron: 'prune', ...report }));
}
