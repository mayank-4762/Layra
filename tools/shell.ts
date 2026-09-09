// Shell Tool - Provides shell command execution for the agent
// Implements safe shell execution with permission checking and timeout control

import { Tool } from '../agent/state';
import { AgentState } from '../agent/state';
import { exec } from 'child_process';

export class ShellTool {
  private state: AgentState;
  private defaultTimeout: number; // Default timeout in seconds
  
  constructor(state: AgentState, defaultTimeout: number = 30) {
    this.state = state;
    this.defaultTimeout = defaultTimeout;
  }
  
  /**
   * Get the tool definition for registration
   * @returns Tool definition
   */
  getTool(): Tool {
    return {
      name: 'shell.execute',
      description: 'Execute a shell command',
      parameters: {
        command: { type: 'string', description: 'Shell command to execute' },
        timeout: { type: 'number', description: 'Timeout in seconds', default: this.defaultTimeout }
      },
      returns: 'Command output (stdout/stderr) and exit code',
      permissions: ['shell.execute'],
      isAvailable: false // Will be set to true when permission granted
    };
  }
  
  /**
   * Execute a shell command
   * @param command - Shell command to execute
   * @param timeout - Timeout in seconds (optional, uses default if not provided)
   * @returns Promise resolving to command output and exit code
   */
  async executeCommand(command: string, timeout: number = this.defaultTimeout): Promise<{success: boolean; stdout: string; stderr: string; exitCode: number}> {
    return new Promise((resolve, reject) => {
      // Execute the command with timeout
      const childProcess = exec(command, { timeout: timeout * 1000 }, (error, stdout, stderr) => {
        if (error) {
          // Handle timeout or other errors
          if (error.code === 'ETIMEDOUT') {
            reject(new Error(`Command timed out after ${timeout} seconds`));
          } else {
            resolve({
              success: false,
              stdout: stdout || '',
              stderr: stderr || error.message,
              exitCode: error.code ?? 1
            });
          }
        } else {
          resolve({
            success: true,
            stdout: stdout || '',
            stderr: stderr || '',
            exitCode: error.code ?? 0
          });
        }
      });
      
      // Handle process events
      childProcess.on('error', (err) => {
        reject(new Error(`Failed to execute command: ${err.message}`));
      });
    });
  }
  
  /**
   * Register this tool with the tool registry
   * @param executor - Tool executor to use for execution
   */
  register(executor: any): void {
    // Register the shell.execute tool
    const tool = this.getTool();
    executor.toolRegistry.registerTool(tool);
  }
}