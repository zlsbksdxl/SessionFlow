import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { SshBridgeTransport, normalizeWorkspaceConnection } from '../workspace/remoteWorkspace.js'

type JsonRecord = Record<string, any>
type TransportFactory = (connection: unknown) => SshBridgeTransport

export function sshChannelSnapshot(directory: unknown) {
  if (typeof directory !== 'string' || !directory) return undefined
  const root = fs.realpathSync(directory)
  const files: { name: string; data: string }[] = []
  let bytes = 0
  const visit = (folder: string, depth: number) => {
    if (depth > 12) throw new Error('The context inbox is too deeply nested for SSH transfer.')
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const absolute = path.join(folder, entry.name)
      if (entry.isSymbolicLink()) throw new Error('SSH context transfer does not follow inbox symlinks.')
      if (entry.isDirectory()) { visit(absolute, depth + 1); continue }
      if (!entry.isFile()) continue
      bytes += fs.statSync(absolute).size
      if (bytes > 4 * 1024 * 1024 || files.length >= 256) throw new Error('The context inbox exceeds the supported SSH transfer size.')
      files.push({ name: path.relative(root, absolute).split(path.sep).join('/'), data: fs.readFileSync(absolute).toString('base64') })
    }
  }
  visit(root, 0)
  return { sourceDir: directory, files }
}

function remoteTurnInput(input: JsonRecord) {
  const fields = ['providerKind', 'providerInstanceId', 'prompt', 'attachments', 'cwd', 'sessionId', 'turnId', 'backendSessionId',
    'providerFork', 'providerResumeCursor', 'runtimeSettings', 'providerOperation']
  const result = Object.fromEntries(fields.filter((field) => input[field] !== undefined).map((field) => [field, input[field]]))
  return {
    ...result,
    ...(input.membrane ? { membrane: { token: input.membrane.token, toolProfile: input.membrane.toolProfile } } : {}),
    ...(input.channelDir ? { channelSnapshot: sshChannelSnapshot(input.channelDir) } : {}),
  }
}

export class SshProviderTurnRun extends EventEmitter {
  #input: JsonRecord
  #transport: SshBridgeTransport | undefined
  #closed = false
  #killRequested = false
  #killTimer: ReturnType<typeof setTimeout> | undefined
  #closedPromise: Promise<void>
  #resolveClosed!: () => void

  constructor(input: JsonRecord, transportFactory: TransportFactory) {
    super()
    this.#input = input
    this.#closedPromise = new Promise((resolve) => { this.#resolveClosed = resolve })
    queueMicrotask(() => { void this.#start(transportFactory) })
  }

  async #start(transportFactory: TransportFactory) {
    if (this.#killRequested) { this.#finish({ code: 130, signal: 'SIGTERM', killed: true }); return }
    try {
      const connection = normalizeWorkspaceConnection(this.#input.workspaceConnection)
      if (connection?.kind !== 'ssh') throw new Error('The remote provider requires an SSH project connection.')
      this.#transport = transportFactory(connection)
      this.#transport.on('event', (message) => {
        if (this.#closed || !['native', 'providerEvent', 'providerSession', 'stderr', 'result', 'error', 'close', 'goalPauseFailed'].includes(message.event)) return
        if (message.event === 'close') this.#finish({ ...message.data, killed: this.#killRequested || message.data?.killed === true })
        else if (message.event === 'error') {
          const error = new Error(String(message.data?.message ?? 'Remote provider failed.')) as Error & { code?: string }
          if (message.data?.code) error.code = message.data.code
          this.emit('error', error)
        } else this.emit(message.event, message.data)
      })
      this.#transport.on('relay', (message) => { void this.#relay(message) })
      this.#transport.on('failure', (error) => {
        if (this.#closed) return
        if (!this.#killRequested) this.emit('error', error)
        this.#finish({ code: this.#killRequested ? 130 : 1, signal: this.#killRequested ? 'SIGTERM' : null, killed: this.#killRequested })
      })
      await this.#transport.request('start', remoteTurnInput(this.#input), 25_000)
    } catch (error) {
      if (this.#closed) return
      if (!this.#killRequested) this.emit('error', error)
      this.#finish({ code: this.#killRequested ? 130 : 1, signal: this.#killRequested ? 'SIGTERM' : null, killed: this.#killRequested })
    }
  }

  async #relay(message: JsonRecord) {
    const transport = this.#transport
    if (!transport || this.#closed) return
    try {
      if (!this.#input.membrane || !/^\/membrane\/[a-z_]+$/.test(String(message.path)) || typeof message.body !== 'string' || Buffer.byteLength(message.body) > 1024 * 1024) {
        throw new Error('Invalid remote graph request.')
      }
      const base = new URL(this.#input.membrane.bridgeUrl)
      if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1') throw new Error('The graph relay must use the local loopback bridge.')
      const response = await fetch(new URL(message.path, base), {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${this.#input.membrane.token}` },
        body: message.body, signal: AbortSignal.timeout(55_000),
      })
      const body = await response.text()
      if (Buffer.byteLength(body) > 4 * 1024 * 1024) throw new Error('The graph response exceeds the SSH relay size.')
      transport.send({ type: 'relay-response', id: message.id, status: response.status, body,
        ...(this.#input.channelDir ? { channelSnapshot: sshChannelSnapshot(this.#input.channelDir) } : {}) })
    } catch (error) {
      try { transport.send({ type: 'relay-response', id: message.id, status: 502, body: JSON.stringify({ error: error.message }) }) } catch {}
    }
  }

  #control(method: string, input: JsonRecord) {
    if (this.#closed || !this.#transport) return Promise.reject(new Error('The remote provider turn is no longer available.'))
    return this.#transport.request(method, input, 20_000)
  }

  respondRuntimeRequest(input: JsonRecord) { return this.#control('respondRuntimeRequest', input) }
  answerUserInput(input: JsonRecord) { return this.#control('answerUserInput', input) }
  controlThreadGoal(input: JsonRecord) { return this.#control('controlThreadGoal', input) }

  kill() {
    if (this.#closed) return false
    if (this.#killRequested) return true
    this.#killRequested = true
    if (this.#transport) void this.#transport.request('kill', {}, 5_000).catch(() => undefined)
    this.#killTimer = setTimeout(() => this.#finish({ code: 130, signal: 'SIGTERM', killed: true }), 8_000)
    this.#killTimer.unref?.()
    return true
  }

  waitForClose() { return this.#closedPromise }

  #finish(event: JsonRecord) {
    if (this.#closed) return
    this.#closed = true
    if (this.#killTimer) clearTimeout(this.#killTimer)
    this.#transport?.close()
    this.emit('close', event)
    this.#resolveClosed()
  }
}

export class SshProviderAdapter {
  #runs = new Set<SshProviderTurnRun>()
  #transportFactory: TransportFactory
  constructor({ transportFactory = (connection) => new SshBridgeTransport(connection) }: { transportFactory?: TransportFactory } = {}) {
    this.#transportFactory = transportFactory
  }
  startTurn(input: JsonRecord) {
    const run = new SshProviderTurnRun(input, this.#transportFactory)
    this.#runs.add(run)
    run.once('close', () => this.#runs.delete(run))
    return run
  }
  async closeAll() {
    const runs = [...this.#runs]
    for (const run of runs) run.kill()
    await Promise.allSettled(runs.map((run) => run.waitForClose()))
  }
}
