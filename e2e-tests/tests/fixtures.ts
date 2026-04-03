import { test as base } from '@playwright/test';

export type AgentConfig = { name: string; planning: string; implementation: string };

export const test = base.extend<{ agentConfig: AgentConfig }>({
  agentConfig: [{ name: '', planning: '', implementation: '' }, { option: true }],
});

export { expect } from '@playwright/test';
