/**
 * Runtime Detector
 *
 * Detects which runtime (bundled vs system) NCP is currently running with.
 * This is detected fresh on every boot to respect Claude Desktop's dynamic settings.
 */

import { existsSync } from 'fs';
import { execSync } from 'child_process';
import { dirname, join } from 'path';
import { userInfo } from 'os';
import { getBundledRuntimePath } from './client-registry.js';
import { logger } from './logger.js';

// Cache for resolved Windows commands to avoid repeated 'where' calls
const windowsCommandCache = new Map<string, string>();

/**
 * Resolve a command to its full path on Windows using 'where' command.
 * This handles all installation methods (Scoop, Chocolatey, nvm-windows, etc.)
 */
function resolveWindowsCommand(command: string): string | null {
  if (process.platform !== 'win32') {
    return null;
  }

  // Check cache first
  const cached = windowsCommandCache.get(command);
  if (cached !== undefined) {
    return cached || null;
  }

  try {
    // Use 'where' command to find the executable in PATH
    // 'where' is Windows equivalent of 'which'
    const result = execSync(`where ${command}`, {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();

    // 'where' returns multiple lines if found in multiple locations, take first
    const firstMatch = result.split(/\r?\n/)[0];
    if (firstMatch && existsSync(firstMatch)) {
      windowsCommandCache.set(command, firstMatch);
      logger.debug(`Resolved ${command} to ${firstMatch}`);
      return firstMatch;
    }
  } catch {
    // Command not found in PATH
    logger.debug(`Could not resolve ${command} via 'where' command`);
  }

  windowsCommandCache.set(command, '');
  return null;
}

export interface RuntimeInfo {
  /** The runtime being used ('bundled' or 'system') */
  type: 'bundled' | 'system';

  /** Path to Node.js runtime to use */
  nodePath: string;

  /** Path to Python runtime to use (if available) */
  pythonPath?: string;
}

/**
 * Detect which runtime NCP is currently running with.
 *
 * Strategy:
 * 1. Check process.execPath (how NCP was launched)
 * 2. Compare with known bundled runtime paths
 * 3. If match → we're running via bundled runtime
 * 4. If no match → we're running via system runtime
 */
export function detectRuntime(): RuntimeInfo {
  const currentNodePath = process.execPath;

  // Check if we're running via Claude Desktop's bundled Node
  const claudeBundledNode = getBundledRuntimePath('claude-desktop', 'node');
  const claudeBundledPython = getBundledRuntimePath('claude-desktop', 'python');

  // If our execPath matches the bundled Node path, we're running via bundled runtime
  if (claudeBundledNode && currentNodePath === claudeBundledNode) {
    return {
      type: 'bundled',
      nodePath: claudeBundledNode,
      pythonPath: claudeBundledPython || undefined
    };
  }

  // Check if we're running inside Claude Desktop (as .dxt extension or otherwise)
  // Note: Claude Desktop does NOT provide bundled Node/Python - it uses system runtimes
  const isInsideClaudeApp = currentNodePath.includes('/Claude.app/') ||
                            currentNodePath.includes('\\Claude\\') ||
                            currentNodePath.includes('/Claude/') ||
                            currentNodePath.includes('Claude Helper') ||
                            currentNodePath.includes('Electron');

  if (isInsideClaudeApp) {
    // Running inside Claude Desktop - use platform-specific system runtimes
    // Claude Desktop expects node/npx/python3 to be available on the system
    const platform = process.platform;
    let nodePath: string;
    let pythonPath: string;

    if (platform === 'darwin') {
      // macOS: Use Homebrew paths (most common install method)
      const arch = process.arch;
      if (arch === 'arm64') {
        // Apple Silicon - Homebrew installs to /opt/homebrew
        nodePath = '/opt/homebrew/bin/node';
        pythonPath = '/opt/homebrew/bin/python3';
      } else {
        // Intel Mac - Homebrew installs to /usr/local
        nodePath = '/usr/local/bin/node';
        pythonPath = '/usr/local/bin/python3';
      }
    } else if (platform === 'win32') {
      // Windows - use 'where' command to find actual installation paths
      // This handles Scoop, Chocolatey, nvm-windows, manual installs, etc.
      nodePath = resolveWindowsCommand('node.exe') || resolveWindowsCommand('node') || 'node';
      pythonPath = resolveWindowsCommand('python.exe') || resolveWindowsCommand('python') || 'python';
    } else {
      // Linux - use system paths
      nodePath = '/usr/bin/node';
      pythonPath = '/usr/bin/python3';
    }

    return {
      type: 'system',
      nodePath,
      pythonPath
    };
  }

  return {
    type: 'system',
    nodePath: 'node', // Use system node
    pythonPath: 'python3' // Use system python
  };
}

/**
 * Get runtime to use for spawning .dxt extension processes.
 * Uses the same runtime that NCP itself is running with.
 *
 * On Windows, uses 'where' command to find actual executable paths,
 * which handles all installation methods (Scoop, Chocolatey, nvm-windows, etc.)
 */
export function getRuntimeForExtension(command: string): string {
  const runtime = detectRuntime();
  const platform = process.platform;

  // On Windows, try to resolve the command using 'where' first
  // This provides a general solution for all commands
  if (platform === 'win32') {
    // For node-related commands, use our special handling
    if (command === 'node' || command.endsWith('/node') || command.endsWith('\\node.exe')) {
      return runtime.nodePath;
    }

    // For npx, find it relative to node or via 'where'
    if (command === 'npx' || command.endsWith('/npx') || command.endsWith('\\npx.cmd')) {
      // First, try to find npx.cmd next to node.exe (most reliable)
      if (runtime.nodePath && runtime.nodePath !== 'node') {
        const nodeDir = dirname(runtime.nodePath);
        const npxPath = join(nodeDir, 'npx.cmd');
        if (existsSync(npxPath)) {
          logger.debug(`Found npx.cmd at ${npxPath}`);
          return npxPath;
        }
      }
      // Fallback: try 'where npx.cmd' or 'where npx'
      const resolved = resolveWindowsCommand('npx.cmd') || resolveWindowsCommand('npx');
      if (resolved) {
        return resolved;
      }
      // Last resort: return bare command
      return 'npx.cmd';
    }

    // For python, use detected path
    if (command === 'python3' || command === 'python' ||
        command.endsWith('/python3') || command.endsWith('/python') ||
        command.endsWith('\\python.exe') || command.endsWith('\\python3.exe')) {
      return runtime.pythonPath || command;
    }

    // For uvx, try to resolve via 'where'
    if (command === 'uvx' || command.endsWith('/uvx') || command.endsWith('\\uvx.exe')) {
      const resolved = resolveWindowsCommand('uvx.exe') || resolveWindowsCommand('uvx');
      if (resolved) {
        return resolved;
      }
      return 'uvx';
    }

    // For uv, try to resolve via 'where'
    if (command === 'uv' || command.endsWith('/uv') || command.endsWith('\\uv.exe')) {
      const resolved = resolveWindowsCommand('uv.exe') || resolveWindowsCommand('uv');
      if (resolved) {
        return resolved;
      }
      return 'uv';
    }

    // For wsl, it should be wsl.exe in System32
    if (command === 'wsl' || command === 'wsl.exe') {
      const resolved = resolveWindowsCommand('wsl.exe');
      if (resolved) {
        return resolved;
      }
      // Fallback to common location
      return 'C:\\Windows\\System32\\wsl.exe';
    }

    // For any other command on Windows, try to resolve it
    // Add .exe extension if not present and try to resolve
    const commandsToTry = [command];
    if (!command.endsWith('.exe') && !command.endsWith('.cmd') && !command.endsWith('.bat')) {
      commandsToTry.push(`${command}.exe`, `${command}.cmd`);
    }

    for (const cmd of commandsToTry) {
      const resolved = resolveWindowsCommand(cmd);
      if (resolved) {
        return resolved;
      }
    }

    // Return original command as fallback
    return command;
  }

  // Non-Windows platforms: original logic

  // If command is 'node' or ends with '/node', use detected Node runtime
  if (command === 'node' || command.endsWith('/node') || command.endsWith('\\node.exe')) {
    return runtime.nodePath;
  }

  // If command is 'npx', use npx from detected Node runtime
  if (command === 'npx' || command.endsWith('/npx') || command.endsWith('\\npx.cmd')) {
    // If using bundled runtime, construct npx path from node path
    if (runtime.type === 'bundled') {
      // Bundled node path: /Applications/Claude.app/.../node
      // Bundled npx path: /Applications/Claude.app/.../npx
      const npxPath = runtime.nodePath.replace(/\/node$/, '/npx').replace(/\\node\.exe$/, '\\npx.cmd');
      return npxPath;
    }
    // For system runtime, derive npx from node path
    // If node path is absolute (starts with /), derive npx from it
    if (runtime.nodePath.startsWith('/')) {
      const npxPath = runtime.nodePath.replace(/\/node$/, '/npx');
      return npxPath;
    }
    // Otherwise use system npx
    return 'npx';
  }

  // If command is 'python3'/'python', use detected Python runtime
  if (command === 'python3' || command === 'python' ||
      command.endsWith('/python3') || command.endsWith('/python') ||
      command.endsWith('\\python.exe') || command.endsWith('\\python3.exe')) {
    return runtime.pythonPath || command; // Fallback to original if no Python detected
  }

  // Handle other common tools that may not be in PATH when running from .dxt
  // Only resolve if running as .dxt (when node path is absolute)
  if (runtime.nodePath.startsWith('/')) {
    // Handle uv (Python package manager)
    if (command === 'uv' || command.endsWith('/uv')) {
      // Use platform-specific UV path (don't check existence due to sandbox)
      const arch = process.arch;

      if (platform === 'darwin') {
        // Try user install first, then homebrew
        const userUv = '/Users/' + userInfo().username + '/.local/bin/uv';
        return userUv;  // Prefer user install
      } else {
        return '/usr/bin/uv';  // Linux
      }
    }
  }

  // For other commands, return as-is
  return command;
}

/**
 * Log runtime detection info for debugging
 */
export function logRuntimeInfo(): void {
  const runtime = detectRuntime();
  logger.debug('[Runtime Detection]');
  logger.debug(`  Type: ${runtime.type}`);
  logger.debug(`  Node: ${runtime.nodePath}`);
  if (runtime.pythonPath) {
    logger.debug(`  Python: ${runtime.pythonPath}`);
  }
  logger.debug(`  Process execPath: ${process.execPath}`);
}
