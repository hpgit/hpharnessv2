// Build/test this candidate, then use improvements.propose -> approve -> validate -> apply.
// Its entry is intentionally self-contained: mutable transitive imports cannot be safely hot-reloaded.
export function apply(ctx) {
  ctx.set('agentCore', {
    version: 'inspect-and-verify-1',
    stateVersion: 1,
    systemPrompt: 'You are a development agent. Read project instructions. Inspect before editing. Verify changes with relevant tests. Preserve source records. Answer in Korean.',
    async nextStep(api) {
      const result = await api.complete();
      return { ...result, continue: Boolean(result.toolCalls?.length) };
    },
  });
}
