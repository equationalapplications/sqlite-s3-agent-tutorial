// tests/infra.test.ts
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, it } from 'vitest';
import { AgentStack } from '../infra/stack.js';

// DockerImageCode.fromImageAsset builds the local Dockerfile during synth, which
// takes longer than the default vitest testTimeout on a cold cache. Give this
// suite a long timeout rather than parallelizing — the synth is deterministic
// and the assertions are read-only.
const TEST_TIMEOUT = 180_000;

describe('AgentStack Function URL auth', () => {
  it(
    'synthesizes an AWS::Lambda::Url with AuthType AWS_IAM and pins the URL grants + EventBridge state',
    () => {
      // Deterministic synth environment — never deploys.
      process.env.DISCORD_WEBHOOK_URL = 'https://discord.example/webhook';

      const app = new App();
      const stack = new AgentStack(app, 'SqliteS3AgentTutorial', {
        env: { account: '123456789012', region: 'us-east-1' },
      });
      const template = Template.fromStack(stack);

      // 1. AWS::Lambda::Url exists with AuthType: AWS_IAM and points at the deployed function.
      template.hasResourceProperties('AWS::Lambda::Url', {
        AuthType: 'AWS_IAM',
        TargetFunctionArn: { 'Fn::GetAtt': [Match.anyValue(), 'Arn'] },
      });

      // 2. lambda:InvokeFunctionUrl permission with same-account principal + AuthType scoped.
      template.hasResourceProperties('AWS::Lambda::Permission', {
        Action: 'lambda:InvokeFunctionUrl',
        Principal: '123456789012',
        FunctionUrlAuthType: 'AWS_IAM',
      });

      // 3. lambda:InvokeFunction permission with same-account principal + InvokedViaFunctionUrl.
      template.hasResourceProperties('AWS::Lambda::Permission', {
        Action: 'lambda:InvokeFunction',
        Principal: '123456789012',
        InvokedViaFunctionUrl: true,
      });

      // 4. EventBridge rule still ENABLED with the 5-minute cadence (unchanged).
      template.hasResourceProperties('AWS::Events::Rule', {
        State: 'ENABLED',
        ScheduleExpression: 'rate(5 minutes)',
      });

      // 5. The two stack outputs the smoke + loop scripts depend on still exist.
      template.hasOutput('LoopRuleName', {});
      template.hasOutput('AgentFunctionUrl', {});
    },
    TEST_TIMEOUT,
  );
});
