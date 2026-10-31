import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import test from 'node:test'
import ts from 'typescript'

// Compile this isolated, dependency-free bridge without rebuilding the runtime
// while another acceptance process may be reading its existing build outputs.
const source = fs.readFileSync(new URL('../../electron/runtime/membraneBridge.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ES2022 },
}).outputText
const { MembraneBridge } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)

function deferred() {
  let resolve
  const promise = new Promise((yes) => { resolve = yes })
  return { promise, resolve }
}

function request(url, token) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${url}/membrane/report`, {
      method: 'POST', agent: false,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    }, (response) => {
      let text = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => { text += chunk })
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(text) }))
    })
    req.on('error', reject)
    req.setTimeout(2000, () => req.destroy(new Error('Membrane request timed out')))
    req.end('{}')
  })
}

function portClosed(url) {
  const parsed = new URL(url)
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: parsed.hostname, port: Number(parsed.port) })
    socket.on('connect', () => { socket.destroy(); resolve(false) })
    socket.on('error', (error) => {
      if (error.code === 'ECONNREFUSED') resolve(true)
      else reject(error)
    })
    socket.setTimeout(1000, () => { socket.destroy(); reject(new Error('Port closure probe timed out')) })
  })
}

async function expectPortClosed(url) {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    if (await portClosed(url)) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail(`Membrane listener is still accepting TCP connections: ${url}`)
}

function delayFirstListen(t) {
  const original = http.Server.prototype.listen
  const bound = deferred()
  let first = true
  http.Server.prototype.listen = function (...args) {
    if (!first) return Reflect.apply(original, this, args)
    first = false
    this.prependOnceListener('listening', () => {
      const address = this.address()
      bound.resolve(`http://127.0.0.1:${address.port}`)
    })
    setTimeout(() => Reflect.apply(original, this, args), 40)
    return this
  }
  t.after(() => { http.Server.prototype.listen = original })
  return bound.promise
}

test('concurrent membrane starts share one listener and one URL', async (t) => {
  const original = http.Server.prototype.listen
  let listeners = 0
  http.Server.prototype.listen = function (...args) {
    listeners += 1
    return Reflect.apply(original, this, args)
  }
  t.after(() => { http.Server.prototype.listen = original })
  const bridge = new MembraneBridge({ handler: async (input) => ({ source: input.source, tool: input.tool }) })
  t.after(() => bridge.close())
  const starting = bridge.start()
  assert.equal(bridge.start(), starting)
  const urls = await Promise.all([starting, bridge.start(), bridge.start()])
  assert.equal(new Set(urls).size, 1)
  assert.equal(listeners, 1)
  const token = bridge.createRunToken('fixture-session')
  assert.deepEqual(await request(urls[0], token), { status: 200, body: { source: 'fixture-session', tool: 'report' } })
  assert.equal(await bridge.start(), urls[0])
  assert.equal(listeners, 1)
  bridge.close()
  await expectPortClosed(urls[0])
})

test('closing a pending start rejects it and closes its eventual real TCP listener', async (t) => {
  const bound = delayFirstListen(t)
  const bridge = new MembraneBridge({ handler: async () => ({ ok: true }) })
  t.after(() => bridge.close())
  const starting = bridge.start()
  const rejected = assert.rejects(starting, /closed while starting/)
  bridge.close()
  await rejected
  const oldUrl = await bound
  await expectPortClosed(oldUrl)
})

test('a revived bridge survives the old generation finishing its delayed listen', async (t) => {
  const bound = delayFirstListen(t)
  const bridge = new MembraneBridge({ handler: async () => ({ ok: true }) })
  t.after(() => bridge.close())
  const oldToken = bridge.createRunToken('old-session')
  const oldStart = bridge.start()
  const rejected = assert.rejects(oldStart, /closed while starting/)
  bridge.close()
  const freshUrl = await bridge.start()
  const token = bridge.createRunToken('new-session')
  assert.deepEqual(await request(freshUrl, token), { status: 200, body: { ok: true } })
  const oldUrl = await bound
  await rejected
  assert.notEqual(freshUrl, oldUrl)
  await expectPortClosed(oldUrl)
  assert.deepEqual(await request(freshUrl, token), { status: 200, body: { ok: true } })
  assert.equal((await request(freshUrl, oldToken)).status, 401, 'old generation tokens stay revoked')
  assert.equal(await bridge.start(), freshUrl)
  bridge.close()
  await expectPortClosed(freshUrl)
})

test('a failed bind clears only its own startup and allows a fresh real listener', async (t) => {
  const original = http.Server.prototype.listen
  let fail = true
  http.Server.prototype.listen = function (...args) {
    if (!fail) return Reflect.apply(original, this, args)
    fail = false
    queueMicrotask(() => this.emit('error', new Error('Fixture bind failure')))
    return this
  }
  t.after(() => { http.Server.prototype.listen = original })
  const bridge = new MembraneBridge({ handler: async () => ({ ok: true }) })
  t.after(() => bridge.close())
  await assert.rejects(bridge.start(), /Fixture bind failure/)
  const url = await bridge.start()
  assert.equal((await request(url)).status, 401)
  bridge.close()
  await expectPortClosed(url)
})
