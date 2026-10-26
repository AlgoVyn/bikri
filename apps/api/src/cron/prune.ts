/** Nightly retention prune. Implemented in T-037. */
export async function scheduled(
  _controller: ScheduledController,
  _env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  await Promise.resolve();
}
