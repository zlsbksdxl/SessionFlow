#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import readline from 'node:readline'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { ClaudeAgentSdkAdapter } from './claudeAgentSdkAdapter.js'
import { CodexAppServerAdapter } from './codexAppServerAdapter.js'
import { GrokAcpAdapter } from './grokAcpAdapter.js'
import { probeCodexProvider } from './codexModelCatalogService.js'
import { probeClaudeProvider } from './claudeModelCatalogService.js'
import { resolveProviderLaunch } from './providerLaunch.js'
import { sshBridgeProtocol, sshBridgeMaxLineBytes, validateRemoteWorkspaceCwd } from '../workspace/remoteWorkspace.js'

type JsonRecord = Record<string, any>
const providerKinds = ['claude-code', 'codex', 'grok'] as const

function errorData(error: any) {
  return { message: String(error?.message ?? error), ...(typeof error?.code === 'string' ? { code: error.code } : {}) }
}

export async function probeRemoteWorkspace(input: JsonRecord) {
  const requestedCwd = validateRemoteWorkspaceCwd(input.cwd)
  const cwd = fs.realpathSync(requestedCwd)
  if (!fs.statSync(cwd).isDirectory()) throw new Error('The remote project path is not a directory.')
  if (input.providerKind && !providerKinds.includes(input.providerKind)) throw new Error('Choose a supported remote provider.')
  const kinds = input.providerKind ? [input.providerKind] : [...providerKinds]
  const providers: JsonRecord = {}
  await Promise.all(kinds.map(async (kind) => {
    const providerInstance = { providerInstanceId: `ssh-${kind}`, kind, label: kind }
    const launch = resolveProviderLaunch(kind, providerInstance)
    if (!launch.available) {
      providers[kind] = { available: false, status: 'unavailable', message: `${kind} is not installed on the remote login PATH.` }
      return
    }
    if (kind === 'grok') {
      providers[kind] = { available: true, status: 'not-tested', message: 'Grok is installed. Authentication is checked when a chat starts; a Grok readiness probe creates an upstream session.' }
      return
    }
    try {
      const probe = kind === 'codex'
        ? await probeCodexProvider({ providerInstance, cwd, totalTimeoutMs: 15_000, forceRefresh: true })
        : await probeClaudeProvider({ providerInstance, cwd, totalTimeoutMs: 15_000, forceRefresh: true })
      const auth = probe.auth?.status
      const failure = probe.protocolError ?? probe.accountError ?? probe.authError ?? probe.modelError
      const status = auth === 'unauthenticated' ? 'auth-error' : failure || auth === 'unknown' ? 'setup-error' : 'ready'
      providers[kind] = {
        available: true, status,
        message: auth === 'unauthenticated' ? `Log in to ${kind} on the SSH host.` : failure ?? (status === 'ready' ? 'Remote provider protocol and authentication are ready.' : 'Remote provider authentication could not be confirmed.'),
        modelCount: probe.catalog?.availableModels?.length ?? 0,
        ...(probe.catalog ? { models: probe.catalog.availableModels, defaultModelId: probe.catalog.defaultModelId ?? probe.catalog.currentModelId } : {}),
      }
    } catch (error) { providers[kind] = { available: true, status: 'setup-error', message: errorData(error).message } }
  }))
  return { ok: true as const, cwd, host: os.hostname(), nodeVersion: process.version, providers }
}

/** Remote stdio endpoint. No runtime DB, service installation, or repository writes. */
export async function serveSshProviderBridge({
  input = process.stdin,
  output = process.stdout,
  adapters = new Map<string, any>([
    ['claude-code', new ClaudeAgentSdkAdapter()], ['codex', new CodexAppServerAdapter()], ['grok', new GrokAcpAdapter()],
  ]),
  probe = probeRemoteWorkspace,
}: { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream; adapters?: Map<string, any>; probe?: (input: JsonRecord) => Promise<any> } = {}) {
  let run: any
  let turnStarted = false
  let closed = false
  let inboxRoot: string | undefined
  let sourceInbox: string | undefined
  let relayServer: http.Server | undefined
  const relayRequests = new Map<string, { resolve: (value: JsonRecord) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  const send = (message: JsonRecord) => {
    const line = JSON.stringify({ protocol: sshBridgeProtocol, ...message }) + '\n'
    if (Buffer.byteLength(line) > sshBridgeMaxLineBytes) throw new Error('The provider emitted an oversized SSH frame.')
    output.write(line)
  }
  const replaceInbox = (value: string) => sourceInbox && inboxRoot ? value.split(sourceInbox).join(inboxRoot) : value

  const applyInbox = (snapshot: JsonRecord | undefined) => {
    if (!snapshot) return
    if (!Array.isArray(snapshot.files) || snapshot.files.length > 256 || typeof snapshot.sourceDir !== 'string') throw new Error('Invalid remote inbox snapshot.')
    if (!inboxRoot) { inboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-ssh-inbox-')); fs.chmodSync(inboxRoot, 0o700) }
    sourceInbox = snapshot.sourceDir
    let bytes = 0
    for (const file of snapshot.files) {
      if (typeof file.name !== 'string' || typeof file.data !== 'string' || file.name.includes('\\')) throw new Error('Invalid remote inbox file.')
      const destination = path.resolve(inboxRoot, file.name)
      if (!destination.startsWith(inboxRoot + path.sep)) throw new Error('Remote inbox files must remain inside their temporary folder.')
      const raw = Buffer.from(file.data, 'base64')
      bytes += raw.length
      if (bytes > 4 * 1024 * 1024) throw new Error('The remote context inbox exceeds the supported size.')
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 })
      fs.writeFileSync(destination, replaceInbox(raw.toString('utf8')), { mode: 0o600 })
    }
  }

  const startRelay = async (token: string) => {
    relayServer = http.createServer((request, response) => {
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
      if (request.method !== 'POST' || !/^\/membrane\/[a-z_]+$/.test(pathname) || request.headers.authorization !== `Bearer ${token}`) {
        response.writeHead(403); response.end('Invalid membrane request.'); return
      }
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk) => {
        body += chunk
        if (Buffer.byteLength(body) > 1024 * 1024) request.destroy(new Error('Membrane request is too large.'))
      })
      request.on('error', () => { if (!response.writableEnded) { response.writeHead(400); response.end('Invalid request.'); } })
      request.on('end', () => {
        const id = randomUUID()
        const pending = new Promise<JsonRecord>((resolve, reject) => {
          const timer = setTimeout(() => { relayRequests.delete(id); reject(new Error('The local graph bridge timed out.')) }, 60_000)
          timer.unref?.()
          relayRequests.set(id, { resolve, reject, timer })
        })
        try { send({ type: 'relay', id, path: pathname, body }) }
        catch (error) { const entry = relayRequests.get(id); if (entry) { clearTimeout(entry.timer); relayRequests.delete(id); entry.reject(error) } }
        void pending.then((result) => {
          applyInbox(result.channelSnapshot)
          response.writeHead(Number(result.status) || 500, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          response.end(replaceInbox(String(result.body ?? '')))
        }).catch((error) => { response.writeHead(502, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: errorData(error).message })) })
      })
    })
    await new Promise<void>((resolve, reject) => {
      relayServer!.once('error', reject)
      relayServer!.listen(0, '127.0.0.1', () => { relayServer!.off('error', reject); resolve() })
    })
    const address = relayServer.address()
    if (!address || typeof address === 'string') throw new Error('Could not start the remote graph relay.')
    return `http://127.0.0.1:${address.port}`
  }

  const cleanup = async () => {
    if (closed) return
    closed = true
    try { run?.kill?.() } catch {}
    await Promise.allSettled([...adapters.values()].map((adapter) => Promise.resolve(adapter.closeAll?.())))
    for (const entry of relayRequests.values()) { clearTimeout(entry.timer); entry.reject(new Error('The SSH connection closed.')) }
    relayRequests.clear()
    relayServer?.closeAllConnections?.()
    if (relayServer) await new Promise<void>((resolve) => relayServer!.close(() => resolve()))
    if (inboxRoot) fs.rmSync(inboxRoot, { recursive: true, force: true })
  }

  const handle = async (message: JsonRecord) => {
    if (message.type === 'relay-response') {
      const pending = relayRequests.get(message.id)
      if (pending) { clearTimeout(pending.timer); relayRequests.delete(message.id); pending.resolve(message) }
      return
    }
    if (message.type !== 'request' || typeof message.id !== 'string') return
    try {
      const request = message.input ?? {}
      let result: any
      if (message.method === 'probe') {
        if (turnStarted) throw new Error('The bridge is already running a provider turn.')
        result = await probe(request)
      } else if (message.method === 'start') {
        if (turnStarted) throw new Error('The bridge can run only one turn.')
        turnStarted = true
        const cwd = fs.realpathSync(validateRemoteWorkspaceCwd(request.cwd))
        if (!fs.statSync(cwd).isDirectory()) throw new Error('The remote project path is not a directory.')
        const adapter = adapters.get(request.providerKind)
        if (!adapter) throw new Error('The selected provider is not supported by this remote runtime.')
        applyInbox(request.channelSnapshot)
        const membrane = request.membrane && typeof request.membrane.token === 'string'
          ? { ...request.membrane, bridgeUrl: await startRelay(request.membrane.token) } : undefined
        // Only provider-owned remote authentication and launch configuration are used.
        const providerInstance = { providerInstanceId: request.providerInstanceId ?? `ssh-${request.providerKind}`, kind: request.providerKind, label: request.providerKind }
        const turnInput = {
          providerKind: request.providerKind, providerInstanceId: providerInstance.providerInstanceId, providerInstance,
          prompt: replaceInbox(String(request.prompt ?? '')), cwd, attachments: request.attachments ?? [],
          sessionId: request.sessionId, turnId: request.turnId, backendSessionId: request.backendSessionId,
          providerFork: request.providerFork, providerResumeCursor: request.providerResumeCursor,
          runtimeSettings: request.runtimeSettings ?? {}, providerOperation: request.providerOperation,
          ...(inboxRoot ? { channelDir: inboxRoot } : {}), ...(membrane ? { membrane } : {}),
        }
        run = adapter.startTurn(turnInput)
        for (const event of ['native', 'providerEvent', 'providerSession', 'stderr', 'result', 'error', 'close', 'goalPauseFailed']) {
          run.on(event, (data) => send({ type: 'event', event, data: event === 'error' ? errorData(data) : event === 'stderr' ? String(data) : data }))
        }
        result = { started: true, cwd }
      } else if (message.method === 'kill') result = { killed: Boolean(run?.kill?.()) }
      else if (['respondRuntimeRequest', 'answerUserInput', 'controlThreadGoal'].includes(message.method)) {
        if (!run || typeof run[message.method] !== 'function') throw new Error('The remote turn cannot accept this control request.')
        result = await run[message.method](request)
      } else throw new Error('Unknown SSH bridge operation.')
      send({ type: 'response', id: message.id, result: result ?? null })
    } catch (error) { send({ type: 'response', id: message.id, error: errorData(error) }) }
  }

  const lines = readline.createInterface({ input, crlfDelay: Infinity })
  let overflow = false
  input.on('data', (chunk) => { if (Buffer.byteLength(chunk) > sshBridgeMaxLineBytes) { overflow = true; lines.close() } })
  lines.on('line', (line) => {
    if (Buffer.byteLength(line) > sshBridgeMaxLineBytes) { overflow = true; lines.close(); return }
    let message: JsonRecord
    try { message = JSON.parse(line) } catch { return }
    if (message?.protocol === sshBridgeProtocol) void handle(message)
  })
  await new Promise<void>((resolve) => lines.once('close', resolve))
  await cleanup()
  if (overflow) throw new Error('The SSH bridge request exceeds the supported size.')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void serveSshProviderBridge().catch((error) => {
    process.stderr.write(`SessionFlow SSH bridge: ${errorData(error).message}\n`)
    process.exitCode = 1
  })
}
