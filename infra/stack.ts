import * as cdk from 'aws-cdk-lib';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { type Construct } from 'constructs';

const IMAGE_DIR = '.';

interface AgentStackProps extends cdk.StackProps {
  bedrockModelId?: string;
  weatherLocation?: string;
  fetchTriggerToken?: string;
}

/**
 * Provisions the full tutorial substrate: one bucket, one Lambda function (both ops), one
 * EventBridge schedule, one Function URL (spec §2). `reservedConcurrentExecutions: 1`
 * enforces the single-writer invariant (spec §2).
 *
 * Exported for `tests/infra.test.ts`, which instantiates the stack under a deterministic
 * synth environment. The CDK CLI entrypoint lives in `infra/app.ts`; this module is
 * side-effect-free on import.
 */
export class AgentStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AgentStackProps = {}) {
    super(scope, id, props);

    const bedrockModelId = props.bedrockModelId ?? 'zai.glm-4.7-flash';
    const weatherLocation = props.weatherLocation ?? 'NYC';

    // ---- S3 bucket ----

    const bucket = new s3.Bucket(this, 'SnapshotBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // Tutorial-quality cleanup ergonomics (spec §9): cdk destroy must succeed even
      // when the bucket holds the SQLite snapshot. Production code generally wants
      // RemovalPolicy.RETAIN and explicit lifecycle ownership instead.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // ---- Log group ----

    const logGroup = new logs.LogGroup(this, 'AgentLogGroup', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ---- Lambda function (one image, one function, both ops) ----

    // loadConfig requires DISCORD_WEBHOOK_URL (spec §11). Reading it here at synth time
    // surfaces the missing-credential failure at `npm run deploy`, not on the first
    // scheduled fetch 24 hours later — the worst place to discover it. Production code
    // would source the URL from SSM Parameter Store; for the tutorial, an env var is the
    // simplest path and the deploy script already exports it.
    const discordWebhookUrl = process.env.DISCORD_WEBHOOK_URL;
    if (discordWebhookUrl === undefined || discordWebhookUrl === '') {
      throw new Error(
        'DISCORD_WEBHOOK_URL must be set in the deploy environment. ' +
          '`loadConfig` requires it at runtime, so the CDK stack wires it into the ' +
          'Lambda environment at synth time (export DISCORD_WEBHOOK_URL=... before ' +
          '`npm run deploy`).',
      );
    }

    const environment: Record<string, string> = {
      SNAPSHOT_BUCKET: bucket.bucketName,
      BEDROCK_MODEL_ID: bedrockModelId,
      BEDROCK_REGION: this.region,
      WEATHER_LOCATION: weatherLocation,
      DISCORD_WEBHOOK_URL: discordWebhookUrl,
      NODE_OPTIONS: '--enable-source-maps',
      // Omitted entirely (not set to '') when unconfigured: config.ts's optionalStr
      // treats a present-but-blank value the same as absent, but omitting the key is
      // the more honest signal that on-demand HTTP fetch triggering is off by default.
      ...(props.fetchTriggerToken ? { FETCH_TRIGGER_TOKEN: props.fetchTriggerToken } : {}),
    };

    const agentFunction = new lambda.DockerImageFunction(this, 'AgentFunction', {
      code: lambda.DockerImageCode.fromImageAsset(IMAGE_DIR, {
        platform: Platform.LINUX_ARM64,
      }),
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.seconds(60),
      // Single-writer invariant (spec §2): without this, two overlapping `fetch`
      // invocations could both hydrate the same version and silently overwrite each
      // other's writes. Reader-overridable via RESERVED_CONCURRENCY env at synth time.
      reservedConcurrentExecutions: parseReservedConcurrency(process.env.RESERVED_CONCURRENCY),
      logGroup,
      environment,
    });

    bucket.grantReadWrite(agentFunction);

    // ---- Bedrock IAM ----

    const bedrockPolicy = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['bedrock:InvokeModel', 'bedrock:Converse'],
      resources: [
        ...buildBedrockResources(bedrockModelId, this.region),
        // Titan Text Embeddings V2 for RAG (RAG design spec §8) — fixed, unlike the chat
        // model: it isn't configurable, so it needs no family-resolution branch through
        // buildBedrockResources.
        `arn:aws:bedrock:${this.region}::foundation-model/amazon.titan-embed-text-v2:0`,
      ],
    });
    agentFunction.addToRolePolicy(bedrockPolicy);

    // ---- Function URL (status reads, op:status) ----

    // Locked to AWS_IAM (smoke-status-iam design §3.1): the URL enforces SigV4
    // at the AWS boundary; the on-demand `FETCH_TRIGGER_TOKEN` in src/handler.ts
    // is application-level defense in depth for the HTTP-triggered `fetch` op
    // (which EventBridge never invokes) — not a substitute for this grant.
    const functionUrl = agentFunction.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.AWS_IAM,
    });

    // Same-account principal (design §3.1). `grantInvokeUrl` synthesizes both
    // `lambda:InvokeFunctionUrl` and the URL-scoped `lambda:InvokeFunction`
    // permission required for Function URL invocation. Cross-account access is
    // out of scope (design §8); per-user auditability is a future spec.
    functionUrl.grantInvokeUrl(new iam.AccountPrincipal(this.account));

    // ---- EventBridge schedule (op: fetch, every 5 minutes) ----

    // Constant JSON input, not a transformed event payload (spec §2): the handler reads
    // event.op directly without unwrapping EventBridge's own envelope shape.
    const fetchSchedule = new events.Rule(this, 'FetchSchedule', {
      enabled: true,
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
      targets: [
        new targets.LambdaFunction(agentFunction, {
          event: events.RuleTargetInput.fromObject({ op: 'fetch' }),
          // Spec §6: EventBridge retries on invocation failure are disabled for this op
          // — the failure is informational, not transient. Without this, CDK's default
          // is 185 retries over ~24 hours, and a 412 from Store.put would replay.
          retryAttempts: 0,
        }),
      ],
    });

    // ---- Outputs ----

    new cdk.CfnOutput(this, 'SnapshotBucketName', { value: bucket.bucketName });
    new cdk.CfnOutput(this, 'AgentFunctionName', { value: agentFunction.functionName });
    new cdk.CfnOutput(this, 'AgentFunctionUrl', { value: functionUrl.url });
    new cdk.CfnOutput(this, 'LoopRuleName', { value: fetchSchedule.ruleName });
  }
}

/**
 * Builds the Bedrock resource ARNs for the IAM policy, narrowed to the configured model's
 * family (spec §12.2) — a wildcard grant across all families is the deliberate rejected
 * alternative; picking a model whose family this function does not know produces a
 * narrower-than-intended grant, surfacing as AccessDeniedException at first invoke rather
 * than at synth.
 */
function buildBedrockResources(bedrockModelId: string, region: string): string[] {
  const account = cdk.Aws.ACCOUNT_ID;

  if (bedrockModelId.startsWith('zai.')) {
    // Narrow to the configured model id (spec §12.2): a `zai.*` wildcard would be
    // broader than the tutorial's least-privilege intent and would also silently grant
    // access to any future zai models added to this account/region.
    return [`arn:aws:bedrock:${region}::foundation-model/${bedrockModelId}`];
  }
  if (bedrockModelId.startsWith('amazon.nova-')) {
    return [
      `arn:aws:bedrock:${region}::foundation-model/amazon.nova-*`,
      `arn:aws:bedrock:${region}:${account}:inference-profile/us.amazon.nova-*`,
    ];
  }
  if (bedrockModelId.startsWith('anthropic.claude-')) {
    return [
      `arn:aws:bedrock:${region}::foundation-model/anthropic.claude-*`,
      `arn:aws:bedrock:${region}:${account}:inference-profile/global.anthropic.claude-*`,
      `arn:aws:bedrock:${region}:${account}:inference-profile/us.anthropic.claude-*`,
    ];
  }

  throw new Error(
    `bedrockModelId "${bedrockModelId}" matches no known family in infra/stack.ts's ` +
      `buildBedrockResources. Add a branch here matching the entry added to ` +
      `src/format/families.ts.`,
  );
}

/**
 * Parses the `RESERVED_CONCURRENCY` env var. Unset → 1. Set but blank/whitespace → 1.
 * Set to a non-negative safe integer → that value. Anything else (negative, fractional,
 * partial parse, garbage) → throws. The Lambda service rejects reserved concurrency
 * outside `[0, 2^53 - 1]`, and `parseInt` accepts partial strings like `"2workers"` as 2,
 * which would silently break the single-writer invariant.
 */
function parseReservedConcurrency(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 1;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || !Number.isSafeInteger(parsed)) {
    throw new Error(
      `RESERVED_CONCURRENCY must be a non-negative safe integer, got: ${JSON.stringify(raw)}`,
    );
  }
  return parsed;
}
