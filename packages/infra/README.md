# @zboule/wasp-infra

`WaspAgent` deploys [wasp](https://github.com/Zboule/wasp) into your AWS account with [SST v3](https://sst.dev):
the AgentCore runtime and its image, the table and bucket that keep threads, a KMS key, the waker, and IAM
built for a hostile sandbox.

```ts
import { WaspAgent } from '@zboule/wasp-infra';

const agent = new WaspAgent('Agent', {
  claudeCredentialsParameter: '/my-app/claude', // SSM SecureString: {"CLAUDE_CODE_OAUTH_TOKEN":"…"} or {"ANTHROPIC_API_KEY":"…"}
  definition: 'agent',                          // agent/prompt.md
  flavor: 'browser'                             // adds Chromium to the sandbox
});
new sst.aws.Function('Api', { handler: 'src/api.handler', link: [agent] });
```

Your `sst.config.ts` must list the `aws-native` (1.72.0), `docker-build` (>= 0.0.14) and `time` (0.1.1)
providers. Deploying builds a `linux/arm64` image, so Docker must be running.
