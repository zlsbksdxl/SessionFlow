import { EventEmitter } from 'node:events'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ChatProjectConnection } from '../../../shared/chat-projects.js'

export const sshBridgeProtocol = 'orrery-ssh-provider-v1'
export const sshBridgeMaxLineBytes = 16 * 1024 * 1024
type JsonRecord = Record<string, any>

export function normalizeWorkspaceConnection(value: unknown): ChatProjectConnection | undefined {
  if (value === undefined || value === null) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Choose a local or SSH project connection.')
  const record = value as JsonRecord
  if (record.kind === 'local') {
    if (Object.keys(record).some((key) => key !== 'kind')) throw new Error('Local connections do not accept extra settings.')
    return { kind: 'local' }
  }
  if (record.kind !== 'ssh') throw new Error('Choose a local or SSH project connection.')
  if (Object.keys(record).some((key) => !['kind', 'host', 'runtimePath'].includes(key))) {
    throw new Error('SSH connections accept a host and runtime folder only. Configure authentication in SSH config or an SSH agent.')
  }
  const host = typeof record.host === 'string' ? record.host.trim() : ''
  // An argv operand, never SSH flags or a shell fragment. Host aliases and user@host are supported.
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.@%+\-:[\]]{0,254}$/.test(host)) {
    throw new Error('Use an SSH config host alias or user@host without spaces or SSH options.')
  }
  const runtimePath = typeof record.runtimePath === 'string' ? record.runtimePath.trim() : ''
  if (!runtimePath.startsWith('/') || runtimePath.length > 4096 || ['\0', '\r', '\n'].some((character) => runtimePath.includes(character))) {
    throw new Error('Enter the absolute SessionFlow runtime folder on the SSH host.')
  }
  return { kind: 'ssh', host, runtimePath: path.posix.normalize(runtimePath) }
}

export function workspaceConnectionKey(value: unknown) {
  const connection = normalizeWorkspaceConnection(value)
  return connection?.kind === 'ssh' ? JSON.stringify(['ssh', connection.host, connection.runtimePath]) : 'local'
}

export function validateRemoteWorkspaceCwd(value: unknown) {
  if (typeof value !== 'string' || !value.trim().startsWith('/') || ['\0', '\r', '\n'].some((character) => value.includes(character)) || value.length > 4096) {
    throw new Error('Enter an absolute project folder on the SSH host.')
  }
  return path.posix.normalize(value.trim())
}

function shellQuote(value: string) { return `'${value.replace(/'/g, `'\\''`)}'` }

export function sshBridgeLaunch(value: unknown) {
  const connection = normalizeWorkspaceConnection(value)
  if (connection?.kind !== 'ssh') throw new Error('An SSH project connection is required.')
  const entrypoint = path.posix.join(connection.runtimePath, 'dist-electron/electron/runtime/providers/sshProviderBridgeCli.js')
  // A login shell exposes the user's remote Node/provider PATH; quote both shell levels.
  const remoteCommand = `exec "\${SHELL:-/bin/sh}" -lc ${shellQuote(`exec node ${shellQuote(entrypoint)}`)}`
  return {
    command: 'ssh',
    args: ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'ConnectionAttempts=1', '-o', 'StrictHostKeyChecking=yes',
      '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2', '--', connection.host, remoteCommand],
  }
}

/** One owned SSH process. Only tagged protocol frames are trusted; login banners are ignored. */
export class SshBridgeTransport extends EventEmitter {
  #child: ChildProcessWithoutNullStreams
  #buffer = ''
  #stderr = ''
  #closed = false
  #pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  #shutdownTimer: ReturnType<typeof setTimeout> | undefined

  constructor(connection: unknown, { spawnImpl = spawn }: { spawnImpl?: typeof spawn } = {}) {
    super()
    const launch = sshBridgeLaunch(connection)
    this.#child = spawnImpl(launch.command, launch.args, { stdio: 'pipe', windowsHide: true }) as ChildProcessWithoutNullStreams
    this.#child.stdout.setEncoding('utf8')
    this.#child.stderr.setEncoding('utf8')
    this.#child.stdout.on('data', (chunk: string) => this.#read(chunk))
    this.#child.stderr.on('data', (chunk: string) => { this.#stderr = (this.#stderr + chunk).slice(-4096) })
    this.#child.stdin.on('error', (error) => this.#fail(error))
    this.#child.on('error', (error) => this.#fail(error))
    this.#child.on('close', (code, signal) => {
      if (this.#shutdownTimer) clearTimeout(this.#shutdownTimer)
      const detail = this.#stderr.trim()
      this.#fail(new Error(`SSH bridge closed${code == null ? '' : ` (exit ${code})`}${detail ? `: ${detail}` : '.'}`))
      this.emit('close', { code, signal })
    })
  }

  request(method: string, input: JsonRecord = {}, timeoutMs = 30_000): Promise<any> {
    if (this.#closed) return Promise.reject(new Error('The SSH connection is closed.'))
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`SSH ${method} timed out. Check the host, remote runtime folder, and provider login.`))
      }, timeoutMs)
      timer.unref?.()
      this.#pending.set(id, { resolve, reject, timer })
      try { this.send({ type: 'request', id, method, input }) }
      catch (error) { clearTimeout(timer); this.#pending.delete(id); reject(error) }
    })
  }

  send(message: JsonRecord) {
    if (this.#closed || this.#child.stdin.destroyed) throw new Error('The SSH connection is closed.')
    const line = JSON.stringify({ protocol: sshBridgeProtocol, ...message }) + '\n'
    if (Buffer.byteLength(line) > sshBridgeMaxLineBytes) throw new Error('The SSH request exceeds the supported size.')
    this.#child.stdin.write(line)
  }

  close() {
    if (this.#child.stdin.writable) this.#child.stdin.end()
    if (this.#shutdownTimer || this.#child.exitCode !== null) return
    this.#shutdownTimer = setTimeout(() => {
      this.#child.kill('SIGTERM')
      this.#shutdownTimer = setTimeout(() => this.#child.kill('SIGKILL'), 2_000)
      this.#shutdownTimer.unref?.()
    }, 5_000)
    this.#shutdownTimer.unref?.()
  }

  #read(chunk: string) {
    this.#buffer += chunk
    if (Buffer.byteLength(this.#buffer) > sshBridgeMaxLineBytes) {
      this.#fail(new Error('The SSH bridge returned an oversized frame.'))
      this.close()
      return
    }
    let newline: number
    while ((newline = this.#buffer.indexOf('\n')) >= 0) {
      const line = this.#buffer.slice(0, newline)
      this.#buffer = this.#buffer.slice(newline + 1)
      let message: JsonRecord
      try { message = JSON.parse(line) } catch { continue }
      if (message?.protocol !== sshBridgeProtocol) continue
      if (message.type === 'response') {
        const pending = this.#pending.get(message.id)
        if (!pending) continue
        clearTimeout(pending.timer); this.#pending.delete(message.id)
        if (message.error) {
          const error = new Error(String(message.error.message ?? 'Remote runtime request failed.')) as Error & { code?: string }
          if (typeof message.error.code === 'string') error.code = message.error.code
          pending.reject(error)
        } else pending.resolve(message.result)
      } else if (message.type === 'event' || message.type === 'relay') this.emit(message.type, message)
    }
  }

  #fail(error: Error) {
    if (this.#closed) return
    this.#closed = true
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(error) }
    this.#pending.clear()
    this.emit('failure', error)
  }
}

export async function testChatProjectConnection(input: { connection?: unknown; cwd: string; providerKind?: string }) {
  const connection = normalizeWorkspaceConnection(input.connection)
  if (connection?.kind !== 'ssh') {
    const cwd = fs.realpathSync(input.cwd)
    if (!fs.statSync(cwd).isDirectory()) throw new Error('Choose an existing project directory.')
    return { ok: true as const, cwd, host: os.hostname(), providers: {} }
  }
  const cwd = validateRemoteWorkspaceCwd(input.cwd)
  const transport = new SshBridgeTransport(connection)
  try {
    return await transport.request('probe', { cwd, ...(input.providerKind ? { providerKind: input.providerKind } : {}) }, 35_000)
  } finally { transport.close() }
}
