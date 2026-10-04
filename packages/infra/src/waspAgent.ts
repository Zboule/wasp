import type * as Aws from '@pulumi/aws';
import type * as AwsNative from '@pulumi/aws-native';
import type * as DockerBuild from '@pulumi/docker-build';
import type * as Pulumi from '@pulumi/pulumi';
import type * as Time from '@pulumiverse/time';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/*
 * SST injects these into every file it bundles for `sst.config.ts`, packages
 * under node_modules included. Declared here, module-scoped, so the types do not
 * leak into the app's own globals. The app must list the `aws-native`,
 * `docker-build` (>= 0.0.14) and `time` providers in its sst.config.
 */
declare const aws: typeof Aws;
declare const awsnative: typeof AwsNative;
declare const dockerbuild: typeof DockerBuild;
declare const time: typeof Time;
declare const $util: typeof Pulumi;
declare const $interpolate: typeof Pulumi.interpolate;
declare const $jsonStringify: typeof Pulumi.jsonStringify;
declare const $app: { name: string; stage: string };
declare const sst: { aws: { permission(args: { actions: string[]; resources: Pulumi.Input<string>[] }): unknown } };

export type WaspAgentArgs = {
  /**
   * SSM SecureString holding the Claude credential as JSON:
   * {"CLAUDE_CODE_OAUTH_TOKEN": "…"} or {"ANTHROPIC_API_KEY": "…"}.
   * Only the waker reads it; it reaches a microVM in the invocation.
   */
  claudeCredentialsParameter: string;
  /** A folder with `prompt.md`, appended to the Claude Code system prompt. Baked into the image. */
  definition?: string;
  /** `browser` adds Chromium and playwright-core to the sandbox. */
  flavor?: 'base' | 'browser';
  model?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  /** Let `sst remove` delete the bucket with its transcripts. Off by default. */
  removable?: boolean;
};

export type WaspAgentLink = { tableName: string; bucketName: string; kmsKeyId: string; region: string };

/** Where the published package keeps the runner image and the waker bundle. */
function packageDir(): string {
  const require = createRequire(path.join(process.cwd(), 'package.json'));
  return path.dirname(require.resolve('@zboule/wasp-infra/package.json'));
}

/**
 * Wasp in the app's AWS account: the AgentCore runtime that runs turns, the
 * table and bucket it keeps threads in, the KMS key for caller tokens, and the
 * waker that wakes it. Link it to the app's API and use `@zboule/wasp-client`.
 *
 * Security model (CLAUDE.md in the wasp repo): the runtime's own role reaches no
 * data; the waker assumes the thread role with a per-thread session policy and
 * hands those credentials to the one microVM serving that thread.
 */
export class WaspAgent extends $util.ComponentResource {
  readonly table: Aws.dynamodb.Table;
  readonly bucket: Aws.s3.BucketV2;
  readonly key: Aws.kms.Key;
  readonly runtime: AwsNative.bedrockagentcore.Runtime;
  readonly waker: Aws.lambda.Function;

  constructor(name: string, args: WaspAgentArgs, opts: Pulumi.ComponentResourceOptions = {}) {
    super('wasp:aws:WaspAgent', name, {}, opts);
    const parent = { parent: this };
    const region = aws.getRegionOutput({}, parent).name;
    const account = aws.getCallerIdentityOutput({}, parent).accountId;
    const pkg = packageDir();

    this.table = new aws.dynamodb.Table(
      `${name}Table`,
      {
        billingMode: 'PAY_PER_REQUEST',
        hashKey: 'PK',
        rangeKey: 'SK',
        attributes: [
          { name: 'PK', type: 'S' },
          { name: 'SK', type: 'S' }
        ],
        streamEnabled: true,
        streamViewType: 'KEYS_ONLY',
        ttl: { attributeName: 'expiresAt', enabled: true },
        pointInTimeRecovery: { enabled: true }
      },
      parent
    );

    this.bucket = new aws.s3.BucketV2(`${name}Bucket`, { forceDestroy: args.removable ?? false }, parent);
    new aws.s3.BucketPublicAccessBlock(
      `${name}BucketPrivate`,
      { bucket: this.bucket.id, blockPublicAcls: true, blockPublicPolicy: true, ignorePublicAcls: true, restrictPublicBuckets: true },
      parent
    );

    this.key = new aws.kms.Key(`${name}Key`, { description: `wasp ${name}: caller tokens`, enableKeyRotation: true, deletionWindowInDays: 7 }, parent);

    // The image: the packaged runner plus the app's definition folder.
    const buildDir = path.join(process.cwd(), '.sst', 'wasp', name);
    rmSync(buildDir, { recursive: true, force: true });
    mkdirSync(buildDir, { recursive: true });
    cpSync(path.join(pkg, 'image'), buildDir, { recursive: true });
    mkdirSync(path.join(buildDir, 'definition'), { recursive: true });
    if (args.definition) cpSync(path.resolve(args.definition), path.join(buildDir, 'definition'), { recursive: true });
    const hasPrompt = existsSync(path.join(buildDir, 'definition', 'prompt.md'));

    // ECR wants lowercase names, which Pulumi's auto-naming does not produce.
    const repositoryName = `${$app.name}-${$app.stage}-${name}`.toLowerCase().replace(/[^a-z0-9._/-]/g, '-');
    const repository = new aws.ecr.Repository(
      `${name}Repository`,
      { name: repositoryName, forceDelete: true, imageScanningConfiguration: { scanOnPush: true } },
      parent
    );
    const auth = aws.ecr.getAuthorizationTokenOutput({ registryId: repository.registryId }, parent);
    const image = new dockerbuild.Image(
      `${name}Image`,
      {
        context: { location: buildDir },
        platforms: ['linux/arm64'],
        buildArgs: { FLAVOR: args.flavor ?? 'base' },
        push: true,
        tags: [$interpolate`${repository.repositoryUrl}:latest`],
        registries: [{ address: repository.repositoryUrl, username: auth.userName, password: $util.secret(auth.password) }]
      },
      parent
    );

    // The runtime's own role: pull its image, write logs. NO data access, ever (invariant 2).
    const runtimeRole = new aws.iam.Role(
      `${name}RuntimeRole`,
      {
        assumeRolePolicy: $jsonStringify({
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Principal: { Service: 'bedrock-agentcore.amazonaws.com' },
              Action: 'sts:AssumeRole',
              Condition: {
                StringEquals: { 'aws:SourceAccount': account },
                ArnLike: { 'aws:SourceArn': $interpolate`arn:aws:bedrock-agentcore:${region}:${account}:*` }
              }
            }
          ]
        })
      },
      parent
    );
    const runtimeRolePolicy = new aws.iam.RolePolicy(
      `${name}RuntimeRolePolicy`,
      {
        role: runtimeRole.id,
        policy: $jsonStringify({
          Version: '2012-10-17',
          Statement: [
            { Effect: 'Allow', Action: 'ecr:GetAuthorizationToken', Resource: '*' },
            { Effect: 'Allow', Action: ['ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer', 'ecr:BatchCheckLayerAvailability'], Resource: repository.arn },
            {
              Effect: 'Allow',
              Action: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents', 'logs:DescribeLogStreams', 'logs:DescribeLogGroups'],
              Resource: $interpolate`arn:aws:logs:${region}:${account}:log-group:/aws/bedrock-agentcore/*`
            }
          ]
        })
      },
      parent
    );

    const wakerRole = new aws.iam.Role(
      `${name}WakerRole`,
      {
        assumeRolePolicy: $jsonStringify({
          Version: '2012-10-17',
          Statement: [{ Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' }]
        }),
        managedPolicyArns: ['arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole']
      },
      parent
    );

    // The thread role: assumable only by the waker, which always narrows it to
    // one thread with a session policy (waker/policy.ts). This is the union.
    const threadRole = new aws.iam.Role(
      `${name}ThreadRole`,
      {
        maxSessionDuration: 3600,
        assumeRolePolicy: $jsonStringify({
          Version: '2012-10-17',
          Statement: [{ Effect: 'Allow', Principal: { AWS: wakerRole.arn }, Action: 'sts:AssumeRole' }]
        })
      },
      parent
    );
    new aws.iam.RolePolicy(
      `${name}ThreadRolePolicy`,
      {
        role: threadRole.id,
        policy: $jsonStringify({
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Action: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:Query', 'dynamodb:BatchWriteItem'],
              Resource: this.table.arn
            },
            {
              Effect: 'Allow',
              Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
              Resource: [$interpolate`${this.bucket.arn}/sessions/*`, $interpolate`${this.bucket.arn}/payloads/*`]
            },
            { Effect: 'Allow', Action: 's3:ListBucket', Resource: this.bucket.arn },
            { Effect: 'Allow', Action: 'kms:Decrypt', Resource: this.key.arn }
          ]
        })
      },
      parent
    );

    // AgentCore validates the runtime role on create, and IAM is eventually consistent.
    const settled = new time.Sleep(`${name}RolesSettled`, { createDuration: '20s' }, { parent: this, dependsOn: [runtimeRolePolicy] });

    this.runtime = new awsnative.bedrockagentcore.Runtime(
      `${name}Runtime`,
      {
        // Create-only, [A-Za-z][A-Za-z0-9_]{0,47}: changing it replaces the runtime.
        agentRuntimeName: `${$app.name}_${$app.stage}_${name}`.replace(/[^A-Za-z0-9_]/g, '_').replace(/^[^A-Za-z]/, 'w').slice(0, 48),
        agentRuntimeArtifact: { containerConfiguration: { containerUri: image.ref } },
        roleArn: runtimeRole.arn,
        networkConfiguration: { networkMode: 'PUBLIC' },
        protocolConfiguration: 'HTTP',
        environmentVariables: {
          AWS_REGION: region,
          WASP_TABLE: this.table.name,
          WASP_BUCKET: this.bucket.bucket,
          WASP_MODEL: args.model ?? 'claude-sonnet-5-5',
          WASP_MAX_TURNS: String(args.maxTurns ?? 40),
          WASP_MAX_BUDGET_USD: String(args.maxBudgetUsd ?? 5),
          ...(hasPrompt ? { WASP_SYSTEM_PROMPT_FILE: '/app/definition/prompt.md' } : {})
        }
      },
      { parent: this, dependsOn: [settled] }
    );

    const parameterArn = $interpolate`arn:aws:ssm:${region}:${account}:parameter/${args.claudeCredentialsParameter.replace(/^\//, '')}`;
    new aws.iam.RolePolicy(
      `${name}WakerRolePolicy`,
      {
        role: wakerRole.id,
        policy: $jsonStringify({
          Version: '2012-10-17',
          Statement: [
            { Effect: 'Allow', Action: 'sts:AssumeRole', Resource: threadRole.arn },
            {
              Effect: 'Allow',
              Action: 'bedrock-agentcore:InvokeAgentRuntime',
              Resource: [this.runtime.agentRuntimeArn, $interpolate`${this.runtime.agentRuntimeArn}/*`]
            },
            { Effect: 'Allow', Action: 'ssm:GetParameter', Resource: parameterArn },
            {
              Effect: 'Allow',
              Action: 'kms:Decrypt',
              Resource: '*',
              Condition: { StringEquals: { 'kms:ViaService': $interpolate`ssm.${region}.amazonaws.com` } }
            },
            {
              Effect: 'Allow',
              Action: ['dynamodb:DescribeStream', 'dynamodb:GetRecords', 'dynamodb:GetShardIterator', 'dynamodb:ListStreams'],
              Resource: this.table.streamArn
            }
          ]
        })
      },
      parent
    );

    this.waker = new aws.lambda.Function(
      `${name}Waker`,
      {
        runtime: 'nodejs22.x',
        architectures: ['arm64'],
        handler: 'index.handler',
        code: new $util.asset.AssetArchive({ 'index.mjs': new $util.asset.FileAsset(path.join(pkg, 'assets', 'waker', 'index.mjs')) }),
        role: wakerRole.arn,
        // A cold microVM takes 10-15 s to answer its first invocation.
        timeout: 120,
        memorySize: 256,
        environment: {
          variables: {
            WASP_RUNTIME_ARN: this.runtime.agentRuntimeArn,
            WASP_THREAD_ROLE_ARN: threadRole.arn,
            WASP_TABLE_ARN: this.table.arn,
            WASP_BUCKET_ARN: this.bucket.arn,
            WASP_KEY_ARN: this.key.arn,
            WASP_CLAUDE_PARAM: args.claudeCredentialsParameter
          }
        }
      },
      parent
    );

    new aws.lambda.EventSourceMapping(
      `${name}WakerTrigger`,
      {
        eventSourceArn: this.table.streamArn,
        functionName: this.waker.arn,
        startingPosition: 'LATEST',
        batchSize: 10,
        maximumRetryAttempts: 2,
        bisectBatchOnFunctionError: true,
        // New messages, and explicit wake / credential requests. Not feed writes,
        // not a message being marked delivered.
        filterCriteria: {
          filters: [
            { pattern: JSON.stringify({ eventName: ['INSERT'], dynamodb: { Keys: { SK: { S: [{ prefix: 'Q#' }] } } } }) },
            { pattern: JSON.stringify({ eventName: ['INSERT', 'MODIFY'], dynamodb: { Keys: { SK: { S: ['CTL#WAKE', 'CTL#CREDENTIALS'] } } } }) }
          ]
        }
      },
      { parent: this, dependsOn: [this.waker] }
    );

    this.registerOutputs({});
  }

  /** `link: [agent]` gives the linked function `Resource.<name>`, which `createWaspClient` takes, and what the client needs. */
  getSSTLink() {
    return {
      properties: {
        tableName: this.table.name,
        bucketName: this.bucket.bucket,
        kmsKeyId: this.key.arn,
        region: aws.getRegionOutput({}, { parent: this }).name
      },
      include: [
        sst.aws.permission({
          actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:Query', 'dynamodb:BatchWriteItem'],
          resources: [this.table.arn]
        }),
        sst.aws.permission({ actions: ['kms:Encrypt'], resources: [this.key.arn] }),
        sst.aws.permission({ actions: ['s3:GetObject', 's3:DeleteObject'], resources: [$interpolate`${this.bucket.arn}/*`] }),
        sst.aws.permission({ actions: ['s3:ListBucket'], resources: [this.bucket.arn] })
      ]
    };
  }
}
