import http from 'node:http'
import { randomUUID } from 'node:crypto'

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => {
      body += chunk
      if (body.length > 1024 * 1024) {
        reject(new Error('Request body is too large'))
        request.destroy()
      }
    })
    request.on('end', () => {
      if (body.trim().length === 0) {
        resolve({})
        return
      }

      try {
        resolve(JSON.parse(body))
      } catch (error) {
        reject(error)
      }
    })
    request.on('error', reject)
  })
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(payload))
}

function bearerToken(request) {
  const header = request.headers.authorization
  if (typeof header !== 'string') {
    return undefined
  }

  const match = /^Bearer\s+(.+)$/i.exec(header)
  return match?.[1]
}

export class MembraneBridge {
  #server: http.Server | undefined
  #tokens = new Map()
  #handler
  #url: string | undefined
  #starting: Promise<string> | undefined
  #cancelStart: (() => void) | undefined
  #generation = 0

  constructor({ handler }) {
    this.#handler = handler
  }

  start(): Promise<string> {
    if (this.#starting) return this.#starting
    if (this.#url) {
      return Promise.resolve(this.#url)
    }

    const generation = this.#generation
    const server = http.createServer((request, response) => {
      void this.#handleRequest(request, response)
    })
    let resolve!: (url: string) => void
    let reject!: (error: Error) => void
    const starting = new Promise<string>((yes, no) => { resolve = yes; reject = no })
    let settled = false
    const release = () => {
      if (this.#starting !== starting) return
      this.#starting = undefined
      this.#cancelStart = undefined
    }
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      if (this.#server === server) this.#server = undefined
      release()
      reject(error)
    }
    const onError = (error: Error) => {
      server.off('listening', onListening)
      fail(error)
    }
    const onListening = () => {
      server.off('error', onError)
      // A close/revive may have replaced this generation while listen was
      // pending. Close the captured server, never the newer live binding.
      if (generation !== this.#generation || this.#server !== server) {
        server.close()
        fail(new Error('Orrery membrane bridge was closed while starting.'))
        return
      }
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        fail(new Error('Failed to bind Orrery membrane bridge'))
        return
      }
      settled = true
      this.#url = `http://127.0.0.1:${address.port}`
      release()
      resolve(this.#url)
    }
    this.#server = server
    this.#starting = starting
    this.#cancelStart = () => fail(new Error('Orrery membrane bridge was closed while starting.'))
    server.once('error', onError)
    server.once('listening', onListening)
    // Own the rejection cleanup even if a caller races startup against an
    // independent shutdown signal and no longer awaits this promise.
    void starting.then(release, release)
    try { server.listen(0, '127.0.0.1') }
    catch (error) { onError(error instanceof Error ? error : new Error(String(error))) }
    return starting
  }

  createRunToken(sourceSessionId) {
    const token = randomUUID()
    this.#tokens.set(token, sourceSessionId)
    return token
  }

  revokeRunToken(token) {
    this.#tokens.delete(token)
  }

  close() {
    this.#tokens.clear()
    this.#generation += 1
    const server = this.#server
    const cancelStart = this.#cancelStart
    this.#server = undefined
    this.#url = undefined
    this.#starting = undefined
    this.#cancelStart = undefined
    cancelStart?.()
    // A not-yet-listening server is closed by onListening when its old
    // generation eventually binds; calling close early can miss that bind.
    if (server?.listening) server.close()
  }

  async #handleRequest(request, response) {
    if (request.method !== 'POST') {
      sendJson(response, 405, { error: 'Method not allowed' })
      return
    }

    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const match = /^\/membrane\/([a-z_]+)$/.exec(url.pathname)
    if (!match) {
      sendJson(response, 404, { error: 'Unknown membrane route' })
      return
    }

    const token = bearerToken(request)
    const source = token ? this.#tokens.get(token) : undefined
    if (!token || !source) {
      sendJson(response, 401, { error: 'Invalid membrane token' })
      return
    }

    try {
      const input = await readJsonBody(request)
      const result = await this.#handler({
        tool: match[1],
        source,
        input,
      })
      sendJson(response, 200, result)
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}
