import { Tool, AgentState } from '../agent/state';
import { ToolRegistry } from './registry';

/** Adds Phase 5 memory/knowledge capabilities while keeping policy in the central registry. */
export function registerPhase5MemoryTools(registry: ToolRegistry, state: AgentState): void {
  const tools: Tool[] = [
    { name: 'memory.related', description: 'Retrieve memories connected to a durable memory record', parameters: { id: { type: 'string' }, limit: { type: 'number', default: 8 } }, returns: 'array', permissions: ['memory.get'], isAvailable: true },
    { name: 'memory.consolidate', description: 'Consolidate durable memory into the local knowledge vault and daily note', parameters: {}, returns: 'object', permissions: ['memory.set'], isAvailable: true },
    { name: 'memory.rebuild_index', description: 'Rebuild the Obsidian-compatible knowledge vault index from durable memory', parameters: {}, returns: 'object', permissions: ['memory.set'], isAvailable: true },
    { name: 'memory.vault_info', description: 'Return the local knowledge vault location and capability status', parameters: {}, returns: 'object', permissions: ['memory.get'], isAvailable: true }
  ];
  for (const tool of tools) registry.registerTool(tool);
  for (const tool of tools) registry.grantPermission(tool.name, 'system', 'Safe local memory capability');
  state.availableTools = registry.getAvailableTools();
  state.toolPermissions = registry.getToolsWithPermissions().map(item => item.permission);
}
