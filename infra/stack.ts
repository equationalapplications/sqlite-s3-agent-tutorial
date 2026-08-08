import * as cdk from 'aws-cdk-lib';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { type Construct } from 'constructs';

const STACK_NAME = 'SqliteS3AgentTutorial';
const IMAGE_DIR = '.';

interface AgentStackProps extends cdk.StackProps {
  bedrockModelId?: string;
}

/**
 * Provisions the full tutorial substrate: one bucket, one Lambda function (both ops), one
 * EventBridge schedule, one Function URL (spec §2). `reservedConcurrentExecutions: 1`
 * enforces the single-writer invariant (spec §2).
 */
class AgentStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AgentStackProps = {}) {
    super(scope, id, props);

    const bedrockModelId = props.bedrockModelId ?? 'zai.glm-4.7-flash';

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

    const environment: Record<string, string> = {
      SNAPSHOT_BUCKET: bucket.bucketName,
      BEDROCK_MODEL_ID: bedrockModelId,
      NODE_OPTIONS: '--enable-source-maps',
    };

    const agentFunction = new lambda.DockerImageFunction(this, 'AgentFunction', {
      code: lambda.DockerImageCode.fromImageAsset(IMAGE_DIR, {
        platform: Platform.LINUX_ARM64,
      }),
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.seconds(30),
      // Single-writer invariant (spec §2): without this, two overlapping `fetch`
      // invocations could both hydrate the same version and silently overwrite each
      // other's writes.
      reservedConcurrentExecutions: 1,
      logGroup,
      environment,
    });

    bucket.grantReadWrite(agentFunction);

    // ---- Bedrock IAM ----

    const bedrockPolicy = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['bedrock:InvokeModel', 'bedrock:Converse'],
      resources: buildBedrockResources(bedrockModelId, this.region),
    });
    agentFunction.addToRolePolicy(bedrockPolicy);

    // ---- Function URL (status reads, PR3 completes the op) ----

    const functionUrl = agentFunction.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.AWS_IAM,
    });

    // ---- EventBridge schedule (op: fetch, once a day) ----

    // Constant JSON input, not a transformed event payload (spec §2): the handler reads
    // event.op directly without unwrapping EventBridge's own envelope shape.
    new events.Rule(this, 'FetchSchedule', {
      enabled: true,
      schedule: events.Schedule.rate(cdk.Duration.days(1)),
      targets: [
        new targets.LambdaFunction(agentFunction, {
          event: events.RuleTargetInput.fromObject({ op: 'fetch' }),
        }),
      ],
    });

    // ---- Outputs ----

    new cdk.CfnOutput(this, 'SnapshotBucketName', { value: bucket.bucketName });
    new cdk.CfnOutput(this, 'AgentFunctionName', { value: agentFunction.functionName });
    new cdk.CfnOutput(this, 'AgentFunctionUrl', { value: functionUrl.url });
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
    return [`arn:aws:bedrock:${region}::foundation-model/zai.*`];
  }
  if (bedrockModelId.startsWith('amazon.nova-')) {
    return [
      `arn:aws:bedrock:${region}::foundation-model/amazon.nova-*`,
      `arn:aws:bedrock:${region}:${account}:inference-profile/us.amazon.nova-*`,
    ];
  }
  if (bedrockModelId.startsWith('anthropic.claude-')) {
    return [
      `arn:aws:bedrock:*::foundation-model/anthropic.claude-*`,
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

// ---- App entry point ----

const app = new cdk.App();

new AgentStack(app, STACK_NAME, {
  env: {
    ...(process.env.CDK_DEFAULT_ACCOUNT ? { account: process.env.CDK_DEFAULT_ACCOUNT } : {}),
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  ...(process.env.BEDROCK_MODEL_ID ? { bedrockModelId: process.env.BEDROCK_MODEL_ID } : {}),
});
