// ─────────────────────────────────────────────
//  Cascade AI — Config Schema (Zod)
// ─────────────────────────────────────────────

import { z } from 'zod';

export const ProviderConfigSchema = z.object({
  type: z.enum(['anthropic', 'openai', 'gemini', 'azure', 'openai-compatible', 'ollama']),
  apiKey: z.string().optional(),
  baseUrl: z.string().url().optional(),
  deploymentName: z.string().optional(),
  apiVersion: z.string().optional(),
  model: z.string().optional(),
});

export const ModelOverridesSchema = z.object({
  t1: z.string().optional(),
  t2: z.string().optional(),
  t3: z.string().optional(),
  vision: z.string().optional(),
});

export const ToolsConfigSchema = z.object({
  shellAllowlist: z.array(z.string()).default([]),
  shellBlocklist: z.array(z.string()).default(['rm -rf', 'sudo rm', 'format', 'mkfs']),
  requireApprovalFor: z.array(z.string()).default([]),
  browserEnabled: z.boolean().default(false),
});

export const HookDefinitionSchema = z.object({
  command: z.string(),
  tools: z.array(z.string()).optional(),
  timeout: z.number().optional(),
});

export const HooksConfigSchema = z.object({
  preToolUse: z.array(HookDefinitionSchema).optional(),
  postToolUse: z.array(HookDefinitionSchema).optional(),
  preTask: z.array(HookDefinitionSchema).optional(),
  postTask: z.array(HookDefinitionSchema).optional(),
});

export const DashboardConfigSchema = z.object({
  port: z.number().default(4891),
  auth: z.boolean().default(true),
  teamMode: z.enum(['single', 'multi']).default('single'),
  secret: z.string().optional(),
});

export const TelemetryConfigSchema = z.object({
  enabled: z.boolean().default(false),
  posthogApiKey: z.string().optional(),
});

export const MemoryConfigSchema = z.object({
  maxSessionMessages: z.number().default(1000),
  autoSummarizeAt: z.number().default(150_000),
  retentionDays: z.number().default(90),
});

export const WorkspaceConfigSchema = z.object({
  cascadeMdPath: z.string().default('CASCADE.md'),
  configPath: z.string().default('.cascade/config.json'),
  keystorePath: z.string().default('.cascade/keystore.enc'),
  auditLogPath: z.string().default('.cascade/audit.log'),
});

export const CascadeConfigSchema = z.object({
  version: z.literal('1.0').default('1.0'),
  defaultIdentityId: z.string().optional(),
  providers: z.array(ProviderConfigSchema).default([]),
  models: ModelOverridesSchema.default({}),
  tools: ToolsConfigSchema.default({}),
  hooks: HooksConfigSchema.default({}),
  dashboard: DashboardConfigSchema.default({}),
  telemetry: TelemetryConfigSchema.default({}),
  memory: MemoryConfigSchema.default({}),
  theme: z.string().default('cascade'),
  workspace: WorkspaceConfigSchema.default({}),
});

export type CascadeConfigInput = z.input<typeof CascadeConfigSchema>;
