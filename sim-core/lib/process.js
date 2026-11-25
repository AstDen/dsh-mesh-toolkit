/**
 * sim-core/lib/process.js — shell execution with an optional OpenFOAM environment.
 * @module sim-core/lib/process
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Shell-quote one argument. */
export function q(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/**
 * Candidate start directories from a tool execution (the agent session cwd).
 * The DSH host process keeps its own cwd (often the home directory), so the tool
 * must be told where the user actually works.
 */
export function executionCwd(exec) {
  const starts = []
  try {
    const cwd = exec?.agent?.session?.header?.cwd
    if (typeof cwd === 'string' && cwd) starts.push(cwd)
  } catch { /* agent is optional */ }
  try {
    const cwd = exec?.agent?.cwd
    if (typeof cwd === 'string' && cwd) starts.push(cwd)
  } catch { /* ignore */ }
  return starts
}

/**
 * Run a bash command, optionally sourcing the OpenFOAM environment first.
 * Returns status/stdout/stderr/duration; never throws on a non-zero code.
 */
export function runBash(command, options = {}) {
  const {
    cwd = process.cwd(),
    timeoutMs = 600000,
    openfoamBashrc = '',
    env = {},
    maxBuffer = 64 * 1024 * 1024,
  } = options
  // NOTE: `set -u` before an OpenFOAM bashrc makes the script exit 127 silently,
  // so the environment is sourced first and nounset is enabled afterwards.
  const source = openfoamBashrc ? `source ${q(openfoamBashrc)} >/dev/null 2>&1; set -u; ` : 'set -u; '
  const started = Date.now()
  const result = spawnSync('bash', ['-c', `set -o pipefail; ${source}${command}`], {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer,
    env: { ...process.env, ...env },
  })
  return {
    code: result.status ?? (result.signal ? 124 : 1),
    signal: result.signal ?? null,
    timedOut: Boolean(result.error && result.error.code === 'ETIMEDOUT'),
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    durationMs: Date.now() - started,
  }
}

/** Run the configured Python interpreter on a script with an argument list. */
export function runPython(config, script, args = [], options = {}) {
  const command = [config.python, script, ...args].map(q).join(' ')
  return runBash(command, {
    cwd: options.cwd ?? config.rootDir ?? config.projectRoot ?? process.cwd(),
    timeoutMs: options.timeoutMs ?? config.timeoutMs,
    openfoamBashrc: options.openfoamBashrc ?? '',
    env: options.env,
  })
}

/** Where python3 lives, preferring the project virtualenv. */
export function pickPython(projectRoot = '') {
  const venv = projectRoot ? join(projectRoot, '.venv', 'bin', 'python') : ''
  if (venv && existsSync(venv)) return venv
  const which = spawnSync('which', ['python3'], { encoding: 'utf8' })
  return which.status === 0 ? which.stdout.trim() : 'python3'
}
