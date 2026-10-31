import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  checkpointRef,
  checkpointSessionRefRoot,
  emptyGitTree,
  gitCheckpointEnv,
  gitDiffMaxBuffer,
  parseDiffFilesFromPatch,
  safeCwd,
  totalsForDiffFiles,
} from './gitWorkspace.js'

export type GitCommandOptions = {
  signal?: AbortSignal
  env?: NodeJS.ProcessEnv
}

export type GitCommandRunner = (cwd: string, args: string[], options?: GitCommandOptions) => Promise<string>

export type TurnCheckpointInput = {
  cwd: string
  sessionId: string
  turnId: string
  turnCount: number
  stage: 'before' | 'after'
}

export type TurnCheckpoint = {
  ref: string
  commit: string
  cwd: string
  repoRoot: string
  turnCount: number
  stage: 'before' | 'after'
}

export type CompletedCheckpointInput = Omit<TurnCheckpointInput, 'stage' | 'turnCount'> & {
  fromCheckpointRef: string
  fromTurnCount: number
  toTurnCount: number
}

export type CheckpointDiffSummary = {
  sessionId: string
  turnId: string
  cwd: string
  repoRoot: string
  generatedAt: string
  range: {
    kind: 'checkpoint'
    fromCheckpointRef: string
    toCheckpointRef: string
    fromTurnCount: number
    toTurnCount: number
  }
  files: ReturnType<typeof parseDiffFilesFromPatch>
  totals: ReturnType<typeof totalsForDiffFiles>
  truncated: boolean
}

/** Git itself runs in a child process; the runtime event loop never waits synchronously. */
export const runGitCommand: GitCommandRunner = (cwd, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = execFile('git', args, {
      cwd,
      encoding: 'utf8',
      env: options.env ?? process.env,
      timeout: 30_000,
      maxBuffer: gitDiffMaxBuffer,
      signal: options.signal,
      windowsHide: true,
    }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout.trimEnd())
    })
    // commit-tree reads its message from stdin; send EOF just as the former
    // synchronous runner's ignored stdin did. No command is interactive.
    child.stdin?.end()
  })

/**
 * Owns filesystem/Git work only. Session state, leases and kernel commits stay
 * on the runtime thread. A cwd queue orders pruning and checkpoints so cleanup
 * cannot remove a newer turn's baseline while an older turn is finishing.
 */
export class GitCheckpointService {
  #run: GitCommandRunner
  #queues = new Map<string, Promise<unknown>>()
  #pending = new Set<Promise<unknown>>()

  constructor(run: GitCommandRunner = runGitCommand) {
    this.#run = run
  }

  private enqueue<T>(cwd: string, work: (cwd: string) => Promise<T>): Promise<T> {
    const resolved = safeCwd(cwd)
    const previous = this.#queues.get(resolved)
    const operation = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(() => work(resolved))
    this.#queues.set(resolved, operation)
    this.#pending.add(operation)
    const clean = () => {
      this.#pending.delete(operation)
      if (this.#queues.get(resolved) === operation) this.#queues.delete(resolved)
    }
    void operation.then(clean, clean)
    return operation
  }

  async idle(): Promise<void> {
    while (this.#pending.size) await Promise.allSettled([...this.#pending])
  }

  /** Wait for already queued work for this workspace, including ref pruning. */
  async settled(cwd: string): Promise<void> {
    await this.#queues.get(safeCwd(cwd))?.catch(() => undefined)
  }

  baseline(cwd: string, signal?: AbortSignal): Promise<{ head?: string; statusDigest?: string }> {
    return this.enqueue(cwd, async (resolved) => {
      signal?.throwIfAborted()
      const baseline: { head?: string; statusDigest?: string } = {}
      try {
        baseline.head = await this.#run(resolved, ['rev-parse', 'HEAD'], { signal })
        const status = await this.#run(resolved, ['status', '--porcelain=v1'], { signal })
        baseline.statusDigest = createHash('sha256').update(status).digest('hex')
      } catch {
        signal?.throwIfAborted()
        // Non-Git projects retain workspace exclusion without a Git baseline.
      }
      return baseline
    })
  }

  capture(input: TurnCheckpointInput, signal?: AbortSignal): Promise<TurnCheckpoint> {
    return this.enqueue(input.cwd, (cwd) => this.captureNow({ ...input, cwd }, signal))
  }

  private async captureNow(input: TurnCheckpointInput, signal?: AbortSignal): Promise<TurnCheckpoint> {
    signal?.throwIfAborted()
    const stat = await fs.stat(input.cwd)
    if (!stat.isDirectory()) throw new Error(`Project cwd is not a folder: ${input.cwd}`)
    await this.#run(input.cwd, ['rev-parse', '--is-inside-work-tree'], { signal })
    const repoRoot = await this.#run(input.cwd, ['rev-parse', '--show-toplevel'], { signal })
    const ref = checkpointRef(input)
    const tempIndex = path.join(os.tmpdir(), `orrery-checkpoint-${process.pid}-${randomUUID()}.index`)
    const env = gitCheckpointEnv(tempIndex)
    try {
      let head: string | undefined
      try { head = await this.#run(input.cwd, ['rev-parse', '--verify', 'HEAD^{commit}'], { env, signal }) }
      catch { signal?.throwIfAborted() }
      const indexTree = head ? await this.#run(input.cwd, ['write-tree'], { signal }) : emptyGitTree
      await this.#run(input.cwd, ['read-tree', indexTree], { env, signal })
      await this.#run(input.cwd, ['add', '-A', '--', '.'], { env, signal })
      const tree = await this.#run(input.cwd, ['write-tree'], { env, signal })
      const commit = await this.#run(input.cwd, ['commit-tree', tree, ...(head ? ['-p', head] : [])], { env, signal })
      await this.#run(input.cwd, ['update-ref', ref, commit], { signal })
      return { ref, commit, cwd: input.cwd, repoRoot, turnCount: input.turnCount, stage: input.stage }
    } finally {
      await Promise.all([tempIndex, `${tempIndex}.lock`].map((file) => fs.rm(file, { force: true }).catch(() => undefined)))
    }
  }

  complete(input: CompletedCheckpointInput): Promise<CheckpointDiffSummary> {
    return this.enqueue(input.cwd, async (cwd) => {
      const after = await this.captureNow({ ...input, cwd, turnCount: input.toTurnCount, stage: 'after' })
      const patch = await this.#run(cwd, ['diff', '--patch', '--no-color', '--no-ext-diff', '--no-textconv', '--relative', input.fromCheckpointRef, after.ref, '--', '.'])
      const files = parseDiffFilesFromPatch(patch)
      return {
        sessionId: input.sessionId,
        turnId: input.turnId,
        cwd,
        repoRoot: after.repoRoot,
        generatedAt: new Date().toISOString(),
        range: { kind: 'checkpoint', fromCheckpointRef: input.fromCheckpointRef, toCheckpointRef: after.ref, fromTurnCount: input.fromTurnCount, toTurnCount: input.toTurnCount },
        files,
        totals: totalsForDiffFiles(files),
        truncated: patch.length > 2 * 1024 * 1024,
      }
    })
  }

  prune(cwd: string, sessionId: string, keepRefs: string[]): Promise<void> {
    return this.enqueue(cwd, async (resolved) => {
      const refs = (await this.#run(resolved, ['for-each-ref', '--format=%(refname)', checkpointSessionRefRoot(sessionId)])).split('\n').filter(Boolean)
      const keep = new Set(keepRefs)
      for (const ref of refs) if (!keep.has(ref)) await this.#run(resolved, ['update-ref', '-d', ref])
    }).catch(() => undefined) // Retention cleanup is best-effort; diff facts remain authoritative.
  }
}
