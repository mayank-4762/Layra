// Filesystem Tool - Provides filesystem operations for the agent
// Implements safe filesystem operations with permission checking

import { Tool } from '../agent/state';
import { AgentState } from '../agent/state';
import * as fs from 'fs';
import * as path from 'path';

export class FilesystemTool {
  private state: AgentState;
  private basePath: string; // Base path for all filesystem operations (security sandbox)
  
  constructor(state: AgentState, basePath: string = '/') {
    this.state = state;
    this.basePath = path.resolve(basePath); // Ensure absolute path
    
    // Ensure base path exists
    try {
      if (!fs.existsSync(this.basePath)) {
        fs.mkdirSync(this.basePath, { recursive: true });
      }
    } catch (error) {
      console.error(`Failed to create base path ${this.basePath}:`, error);
    }
  }
  
  /**
   * Get the tool definition for registration
   * @returns Tool definition
   */
  getReadTool(): Tool {
    return {
      name: 'filesystem.read',
      description: 'Read contents of a file',
      parameters: {
        path: { type: 'string', description: 'Path to file to read (relative to base path)' },
        encoding: { type: 'string', description: 'File encoding (default: utf-8)', default: 'utf-8' }
      },
      returns: 'File contents as string',
      permissions: ['filesystem.read'],
      isAvailable: false // Will be set to true when permission granted
    };
  }
  
  /**
   * Get the tool definition for registration
   * @returns Tool definition
   */
  getWriteTool(): Tool {
    return {
      name: 'filesystem.write',
      description: 'Write contents to a file',
      parameters: {
        path: { type: 'string', description: 'Path to file to write (relative to base path)' },
        content: { type: 'string', description: 'Content to write' },
        encoding: { type: 'string', description: 'File encoding (default: utf-8)', default: 'utf-8' }
      },
      returns: 'Number of bytes written',
      permissions: ['filesystem.write'],
      isAvailable: false // Will be set to true when permission granted
    };
  }
  
  /**
   * Get the tool definition for registration
   * @returns Tool definition
   */
  getListTool(): Tool {
    return {
      name: 'filesystem.list',
      description: 'List directory contents',
      parameters: {
        path: { type: 'string', description: 'Path to directory to list (relative to base path)' },
        recursive: { type: 'boolean', description: 'Whether to list recursively', default: false }
      },
      returns: 'Array of file/directory information',
      permissions: ['filesystem.list'],
      isAvailable: false // Will be set to true when permission granted
    };
  }
  
  /**
   * Read a file
   * @param filePath - Path to file (relative to base path)
   * @param encoding - File encoding (default: utf-8)
   * @returns Promise resolving to file contents
   */
  async readFile(filePath: string, encoding: string = 'utf-8'): Promise<string> {
    try {
      // Security: Ensure path is within base path
      const fullPath = path.resolve(this.basePath, filePath);
      if (!fullPath.startsWith(this.basePath)) {
        throw new Error('Access denied: Path is outside of allowed directory');
      }
      
      // Check if file exists
      if (!fs.existsSync(fullPath)) {
        throw new Error(`File not found: ${filePath}`);
      }
      
      // Check if it's a file (not a directory)
      const stats = fs.statSync(fullPath);
      if (!stats.isFile()) {
        throw new Error(`Path is not a file: ${filePath}`);
      }
      
      // Read the file
      const data = fs.readFileSync(fullPath, encoding);
      return data;
    } catch (error) {
      throw new Error(`Failed to read file '${filePath}': ${error.message}`);
    }
  }
  
  /**
   * Write a file
   * @param filePath - Path to file (relative to base path)
   * @param content - Content to write
   * @param encoding - File encoding (default: utf-8)
   * @returns Promise resolving to number of bytes written
   */
  async writeFile(filePath: string, content: string, encoding: string = 'utf-8'): Promise<number> {
    try {
      // Security: Ensure path is within base path
      const fullPath = path.resolve(this.basePath, filePath);
      if (!fullPath.startsWith(this.basePath)) {
        throw new Error('Access denied: Path is outside of allowed directory');
      }
      
      // Ensure directory exists
      const dir = path.dirname(fullPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      
      // Write the file
      const bytesWritten = fs.writeFileSync(fullPath, content, encoding);
      return Buffer.byteLength(content, encoding);
    } catch (error) {
      throw new Error(`Failed to write file '${filePath}': ${error.message}`);
    }
  }
  
  /**
   * List directory contents
   * @param dirPath - Path to directory (relative to base path)
   * @param recursive - Whether to list recursively
   * @returns Promise resolving to array of file information
   */
  async listDirectory(dirPath: string = '', recursive: boolean = false): Promise<Array<{name: string; path: string; isDirectory: boolean; size: number; modified: Date}>> {
    try {
      // Security: Ensure path is within base path
      const fullPath = path.resolve(this.basePath, dirPath);
      if (!fullPath.startsWith(this.basePath)) {
        throw new Error('Access denied: Path is outside of allowed directory');
      }
      
      // Check if directory exists
      if (!fs.existsSync(fullPath)) {
        throw new Error(`Directory not found: ${dirPath}`);
      }
      
      // Check if it's a directory
      const stats = fs.statSync(fullPath);
      if (!stats.isDirectory()) {
        throw new Error(`Path is not a directory: ${dirPath}`);
      }
      
      // Read directory
      const items = fs.readdirSync(fullPath, { withFileTypes: true });
      
      const results: Array<{name: string; path: string; isDirectory: boolean; size: number; modified: Date}> = [];
      
      for (const item of items) {
        const fullItemPath = path.join(fullPath, item.name);
        const relativePath = path.join(dirPath, item.name);
        const itemStats = fs.statSync(fullItemPath);
        
        results.push({
          name: item.name,
          path: relativePath,
          isDirectory: item.isDirectory(),
          size: itemStats.size,
          modified: itemStats.mtime
        });
        
        // If recursive and it's a directory, add subdirectory contents
        if (recursive && item.isDirectory()) {
          const subItems = await this.listDirectory(relativePath, true);
          results.push(...subItems);
        }
      }
      
      return results;
    } catch (error) {
      throw new Error(`Failed to list directory '${dirPath}': ${error.message}`);
    }
  }
  
  /**
   * Register this tool's definitions with the tool registry
   * @param executor - Tool executor to use for execution (not used in this implementation, but kept for consistency)
   */
  register(executor: any): void {
    // Note: The actual registration of tools with the registry is done elsewhere.
    // This method is kept for compatibility with the previous design.
    // The tool registry is responsible for registering the tool definitions.
    // This tool class provides the implementation.
  }
}