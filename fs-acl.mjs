/**
 * Cross-platform file permission helper.
 *
 * On Unix: mode 0o600/0o700 works natively.
 * On Windows: mode flags are silently ignored by Node.js,
 * so we use icacls to restrict access to the current user.
 */

import { execSync } from 'node:child_process'

/**
 * Restrict a file or directory to the current user only (Windows).
 * On non-Windows, this is a no-op (Unix mode flags handle it).
 */
export function restrictToCurrentUser(filepath) {
  if (process.platform !== 'win32') return

  try {
    // Disable inheritance and remove all inherited ACLs,
    // then grant full control only to the current user.
    execSync(`icacls "${filepath}" /inheritance:r /grant:r "%USERNAME%:(F)" /remove:g "Everyone" /remove:g "BUILTIN\\Users"`, {
      stdio: 'ignore',
      windowsHide: true,
    })
  } catch (err) {
    console.error(`[cc2wx] Warning: could not restrict permissions on ${filepath}: ${err instanceof Error ? err.message : String(err)}`)
  }
}
