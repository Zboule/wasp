import { describe, expect, it } from 'vitest';

import { runtimeName } from './names.ts';

describe('runtimeName', () => {
  it('keeps a name that fits as it always was', () => {
    expect(runtimeName('toptoptime', 'dev', 'AgentReviewer')).toBe('toptoptime_dev_AgentReviewer');
    expect(runtimeName('wasp-demo', 'production', 'Agent')).toBe('wasp_demo_production_Agent');
    expect(runtimeName('9lives', 'dev', 'Agent')).toBe('wlives_dev_Agent');
  });

  it('gives each agent of a long stage its own valid name', () => {
    const stage = 'feature-v1-a-very-long-branch-name-here';
    const names = ['AgentReviewer', 'AgentAssistant'].map((agent) => runtimeName('toptoptime', stage, agent));
    expect(new Set(names).size).toBe(2);
    for (const name of names) expect(name).toMatch(/^[A-Za-z][A-Za-z0-9_]{0,47}$/);
    expect(names[0]).toMatch(/^toptoptime_feature_v1_a_very_long_br/);
  });

  it('tells apart two long stages sharing a prefix, and names that only sanitize alike', () => {
    const a = runtimeName('toptoptime', 'feature-v1-a-very-long-branch-name-one', 'Agent');
    const b = runtimeName('toptoptime', 'feature-v1-a-very-long-branch-name-two', 'Agent');
    expect(a).not.toBe(b);
    expect(runtimeName('app', 'x.y', 'Agent_with_a_long_name_that_overflows_the_limit')).not.toBe(
      runtimeName('app', 'x-y', 'Agent_with_a_long_name_that_overflows_the_limit')
    );
  });
});
