// Auth resolution — the "catch" of this runtime.
//
// The Claude Agent SDK spawns a `claude` CLI subprocess that picks its
// credentials from the environment, in THIS precedence (per the auth docs):
//
//   1. Cloud provider   (CLAUDE_CODE_USE_BEDROCK / _VERTEX / _FOUNDRY)
//   2. ANTHROPIC_AUTH_TOKEN
//   3. ANTHROPIC_API_KEY          <-- wins over the OAuth token if present
//   4. apiKeyHelper
//   5. CLAUDE_CODE_OAUTH_TOKEN    <-- the Max/Pro subscription token
//   6. saved /login credentials
//
// So to run on a Max plan we must make sure nothing higher in the list is set:
// in `max` mode we delete ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN and the
// Bedrock/Vertex flags from the subprocess environment, leaving only the token.
//
// AGENT_AUTH_MODE forces a mode; otherwise we infer from what's present.
// Modes: "max" (subscription), "apikey" (Anthropic API), "bedrock" (AWS IAM).

export function resolveAuth(env = process.env) {
  const forced = (env.AGENT_AUTH_MODE || '').toLowerCase();

  const hasToken = !!env.CLAUDE_CODE_OAUTH_TOKEN;
  const hasKey = !!env.ANTHROPIC_API_KEY;
  const hasBedrock = env.CLAUDE_CODE_USE_BEDROCK === '1' || env.CLAUDE_CODE_USE_BEDROCK === 'true';

  const mode = forced || (hasBedrock ? 'bedrock' : hasKey ? 'apikey' : hasToken ? 'max' : '');

  if (!mode) {
    throw new Error(
      'No auth configured. Set one of: AGENT_AUTH_MODE=max + CLAUDE_CODE_OAUTH_TOKEN (dev), ' +
      'ANTHROPIC_API_KEY (prod), or CLAUDE_CODE_USE_BEDROCK=1 (+ AWS creds).',
    );
  }

  // Build the exact env the subprocess should inherit. We MUTATE process.env so
  // the SDK's spawned CLI sees the same thing (the SDK inherits process.env).
  switch (mode) {
    case 'max': {
      // Subscription auth resolves from EITHER a CLAUDE_CODE_OAUTH_TOKEN (the
      // headless/container path — mint it with `claude setup-token`) OR the
      // host's saved `claude login` credentials (the local/mini path, precedence
      // #6, what Nova uses). A fresh container has no saved login, so there the
      // token is mandatory; we warn rather than throw so local/mini still works.
      // Either way, everything ABOVE the token in the precedence list must go or
      // the subprocess silently switches to API billing / Bedrock.
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_AUTH_TOKEN;
      delete process.env.CLAUDE_CODE_USE_BEDROCK;
      delete process.env.CLAUDE_CODE_USE_VERTEX;
      delete process.env.CLAUDE_CODE_USE_FOUNDRY;
      const source = hasToken ? 'CLAUDE_CODE_OAUTH_TOKEN' : "host's saved `claude login`";
      if (!hasToken) {
        console.warn(
          '[auth] max mode without CLAUDE_CODE_OAUTH_TOKEN: relying on the host\'s saved ' +
          'login. Fine locally / on the mini; a fresh container MUST set the token.',
        );
      }
      return { mode, billing: 'subscription (Max/Pro plan)', source };
    }
    case 'apikey': {
      if (!hasKey) throw new Error('AGENT_AUTH_MODE=apikey but ANTHROPIC_API_KEY is not set.');
      // A leftover OAuth token is harmless (key outranks it), but drop it to
      // keep the mode unambiguous.
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      delete process.env.CLAUDE_CODE_USE_BEDROCK;
      return { mode, billing: 'Anthropic API (pay-as-you-go)' };
    }
    case 'bedrock': {
      process.env.CLAUDE_CODE_USE_BEDROCK = '1';
      // Bedrock uses AWS IAM creds; make sure no Anthropic creds shadow it.
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      return { mode, billing: 'AWS Bedrock (IAM, on the AWS invoice)', region: env.AWS_REGION || '(default)' };
    }
    default:
      throw new Error(`Unknown AGENT_AUTH_MODE: ${mode}`);
  }
}
