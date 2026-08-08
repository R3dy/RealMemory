export interface OpenCodePluginContext {
  project: unknown;
  client: unknown;
  directory: string;
  worktree: string;
}

export default async function realmemoryPlugin(
  _ctx: OpenCodePluginContext,
): Promise<Record<string, unknown>> {
  // Plugin hooks will be implemented in Epic 7
  return {};
}
