import { Tool, AgentState } from '../agent/state';
import { ToolRegistry } from './registry';

/** Adds Phase 4 Android and browser controls without coupling the core registry to native adapters. */
export function registerAndroidControlTools(registry: ToolRegistry, state: AgentState): void {
  const tools: Tool[] = [
    { name: 'android.control.health', description: 'Check the paired native Android AccessibilityService bridge', parameters: {}, returns: 'object', permissions: ['android.control'], isAvailable: true },
    { name: 'android.control.tree', description: 'Read the active Android accessibility UI tree', parameters: {}, returns: 'array', permissions: ['android.control'], isAvailable: true },
    { name: 'android.control.tap', description: 'Tap an Android UI node by text, view id, content description or class', parameters: { selector: { type: 'object' } }, returns: 'object', permissions: ['android.control'], isAvailable: true },
    { name: 'android.control.type', description: 'Set text on an Android editable UI node', parameters: { selector: { type: 'object' }, text: { type: 'string' } }, returns: 'object', permissions: ['android.control'], isAvailable: true },
    { name: 'android.control.swipe', description: 'Perform an Android accessibility swipe gesture', parameters: { startX: { type: 'number' }, startY: { type: 'number' }, endX: { type: 'number' }, endY: { type: 'number' }, durationMs: { type: 'number', default: 400 } }, returns: 'object', permissions: ['android.control'], isAvailable: true },
    { name: 'android.control.back', description: 'Press Android Back through AccessibilityService', parameters: {}, returns: 'object', permissions: ['android.control'], isAvailable: true },
    { name: 'android.control.home', description: 'Press Android Home through AccessibilityService', parameters: {}, returns: 'object', permissions: ['android.control'], isAvailable: true },
    { name: 'android.control.launch', description: 'Launch an Android package or explicit activity', parameters: { packageName: { type: 'string' }, activity: { type: 'string' } }, returns: 'object', permissions: ['android.control'], isAvailable: true },
    { name: 'android.control.screenshot', description: 'Capture the Android screen through AccessibilityService', parameters: {}, returns: 'object', permissions: ['android.control'], isAvailable: true },
    { name: 'browser.select_tab', description: 'Select a Chromium tab by tab id or exact URL for subsequent browser actions', parameters: { idOrUrl: { type: 'string' } }, returns: 'object', permissions: ['browser.control'], isAvailable: true }
  ];
  for (const tool of tools) registry.registerTool(tool);
  if (process.env.LAYRA_ALLOW_ANDROID_CONTROL === 'true' && process.env.LAYRA_ANDROID_BRIDGE_URL && process.env.LAYRA_ANDROID_BRIDGE_TOKEN) {
    for (const tool of tools.filter(item => item.permissions.includes('android.control'))) registry.grantPermission(tool.name, 'system', 'Explicitly enabled by paired native Android bridge');
  }
  if (process.env.LAYRA_ALLOW_BROWSER === 'true' && process.env.LAYRA_CDP_WS_URL) registry.grantPermission('browser.select_tab', 'system', 'Explicitly enabled by LAYRA_ALLOW_BROWSER');
  state.availableTools = registry.getAvailableTools();
  state.toolPermissions = registry.getToolsWithPermissions().map(item => item.permission);
}
