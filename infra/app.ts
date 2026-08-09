// infra/app.ts — CDK CLI entrypoint.
//
// Kept separate from `infra/stack.ts` so importing `AgentStack` from the test
// suite (`tests/infra.test.ts`) has no side effects — the `cdk.App` is created
// and `AgentStack` is instantiated only when this module is loaded by the CDK
// CLI via `cdk.json`'s `app` directive. Previously the bootstrap lived at the
// bottom of `infra/stack.ts`, which caused the stack to be synthesized at
// module load during tests.
import * as cdk from 'aws-cdk-lib';
import { AgentStack } from './stack.js';

const STACK_NAME = 'SqliteS3AgentTutorial';

const app = new cdk.App();

new AgentStack(app, STACK_NAME, {
  env: {
    ...(process.env.CDK_DEFAULT_ACCOUNT ? { account: process.env.CDK_DEFAULT_ACCOUNT } : {}),
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  ...(process.env.BEDROCK_MODEL_ID ? { bedrockModelId: process.env.BEDROCK_MODEL_ID } : {}),
  ...(process.env.WEATHER_LOCATION ? { weatherLocation: process.env.WEATHER_LOCATION } : {}),
  ...(process.env.FETCH_TRIGGER_TOKEN ? { fetchTriggerToken: process.env.FETCH_TRIGGER_TOKEN } : {}),
});
