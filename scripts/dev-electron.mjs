import { spawn, execFile } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import * as fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { constants as osConstants } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const require = createRequire(import.meta.url)
const runFile = promisify(execFile)
const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))
const cacheFormatVersion = 1
const bundleName = 'SessionFlow.app'
const completionFile = 'prepared.json'

async function optionalFile(filePath) {
  try {
    return await fs.readFile(filePath)
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
}

async function exists(filePath) {
  try {
    await fs.lstat(filePath)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

function preparedPaths(cachePath) {
  const bundlePath = path.join(cachePath, bundleName)
  return { executablePath: path.join(bundlePath, 'Contents', 'MacOS', 'Electron'), bundlePath }
}

async function readPreparedCache(cachePath, fingerprint) {
  try {
    const completion = JSON.parse(await fs.readFile(path.join(cachePath, completionFile), 'utf8'))
    if (completion.formatVersion !== cacheFormatVersion || completion.fingerprint !== fingerprint) return undefined
    const prepared = preparedPaths(cachePath)
    const [bundleStat, executableStat, infoStat] = await Promise.all([
      fs.lstat(prepared.bundlePath),
      fs.stat(prepared.executablePath),
      fs.stat(path.join(prepared.bundlePath, 'Contents', 'Info.plist')),
    ])
    if (!bundleStat.isDirectory() || !executableStat.isFile() || !(executableStat.mode & 0o111) || !infoStat.isFile()) return undefined
    return prepared
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return undefined
    throw error
  }
}

async function setPlistString(plistPath, key, value) {
  try {
    await runFile('/usr/bin/plutil', ['-replace', key, '-string', value, plistPath])
  } catch (error) {
    throw new Error(`Cannot update ${key} in the development app: ${error.stderr?.trim() || error.message}`, { cause: error })
  }
}

async function assertIndependentBundle(bundlePath, sourceBundlePath) {
  const sourcePrefix = sourceBundlePath + path.sep
  async function inspect(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        const target = await fs.realpath(entryPath)
        if (target === sourceBundlePath || target.startsWith(sourcePrefix)) {
          throw new Error(`The copied development app contains a link back to the original Electron bundle: ${entryPath}`)
        }
      } else if (entry.isDirectory()) {
        await inspect(entryPath)
      }
    }
  }
  await inspect(bundlePath)
}

/** Prepare an independent development bundle without launching Electron. */
export async function prepareDevelopmentElectron() {
  const originalExecutablePath = require('electron')
  if (typeof originalExecutablePath !== 'string') throw new Error('The installed electron package did not provide an executable path.')
  if (process.platform !== 'darwin') return { executablePath: originalExecutablePath }

  const sourceBundlePath = await fs.realpath(path.resolve(originalExecutablePath, '../../..'))
  if (path.extname(sourceBundlePath) !== '.app' || path.basename(originalExecutablePath) !== 'Electron') {
    throw new Error(`Expected an Electron.app bundle with the original Electron executable, received: ${originalExecutablePath}`)
  }

  const sourceInfoPath = path.join(sourceBundlePath, 'Contents', 'Info.plist')
  const [sourceInfo, executableStat] = await Promise.all([fs.readFile(sourceInfoPath), fs.stat(originalExecutablePath)])
  const electronVersion = require('electron/package.json').version
  let iconPath = path.join(repositoryRoot, 'icon.icns')
  let icon = await optionalFile(iconPath)
  if (!icon) {
    iconPath = path.join(repositoryRoot, 'build', 'icon.icns')
    icon = await optionalFile(iconPath)
  }

  const hash = createHash('sha256')
  hash.update(JSON.stringify({
    formatVersion: cacheFormatVersion,
    electronVersion,
    sourceBundlePath,
    executable: {
      size: executableStat.size,
      mode: executableStat.mode,
      mtimeMs: executableStat.mtimeMs,
      ctimeMs: executableStat.ctimeMs,
    },
    iconPath: icon ? path.relative(repositoryRoot, iconPath) : null,
  }))
  hash.update(sourceInfo)
  hash.update(icon ?? Buffer.alloc(0))
  const fingerprint = hash.digest('hex')
  const cacheParent = path.join(repositoryRoot, '.cache', 'dev-electron')
  const cachePath = path.join(cacheParent, fingerprint)
  const cached = await readPreparedCache(cachePath, fingerprint)
  if (cached) return cached
  if (await exists(cachePath)) {
    throw new Error(`The development Electron cache is incomplete: ${cachePath}. It was left untouched; remove it only after any app using it has exited, then retry.`)
  }

  await fs.mkdir(cacheParent, { recursive: true })
  const temporaryPath = await fs.mkdtemp(path.join(cacheParent, `.prepare-${fingerprint.slice(0, 12)}-`))
  const temporaryBundlePath = path.join(temporaryPath, bundleName)
  try {
    await fs.cp(sourceBundlePath, temporaryBundlePath, {
      recursive: true,
      mode: fsConstants.COPYFILE_FICLONE,
      verbatimSymlinks: true,
      dereference: false,
      force: false,
      errorOnExist: true,
    })
    await assertIndependentBundle(temporaryBundlePath, sourceBundlePath)
    const plistPath = path.join(temporaryBundlePath, 'Contents', 'Info.plist')
    await setPlistString(plistPath, 'CFBundleName', 'SessionFlow')
    await setPlistString(plistPath, 'CFBundleDisplayName', 'SessionFlow')
    if (icon) {
      await fs.writeFile(path.join(temporaryBundlePath, 'Contents', 'Resources', 'SessionFlow.icns'), icon)
      await setPlistString(plistPath, 'CFBundleIconFile', 'SessionFlow.icns')
    }

    // Keep Electron's executable, bundle identifier, helpers, and runtime
    // entitlements intact. Only the modified outer bundle needs a new seal.
    try {
      await runFile('/usr/bin/codesign', [
        '--force', '--sign', '-', '--timestamp=none',
        '--preserve-metadata=entitlements,flags,runtime',
        temporaryBundlePath,
      ])
    } catch (error) {
      throw new Error(`Cannot sign the development Electron app: ${error.stderr?.trim() || error.message}`, { cause: error })
    }
    await fs.writeFile(path.join(temporaryPath, completionFile), JSON.stringify({ formatVersion: cacheFormatVersion, fingerprint }) + '\n')

    try {
      await fs.rename(temporaryPath, cachePath)
    } catch (error) {
      // Concurrent launches may have prepared the same immutable cache. Reuse
      // the winner, but never replace an already published (possibly live) app.
      const concurrentCache = await readPreparedCache(cachePath, fingerprint)
      if (concurrentCache) return concurrentCache
      throw error
    }
    return preparedPaths(cachePath)
  } catch (error) {
    throw new Error(`Failed to prepare SessionFlow's development Electron bundle: ${error.message}`, { cause: error })
  } finally {
    await fs.rm(temporaryPath, { recursive: true, force: true })
  }
}

async function main() {
  const args = process.argv.slice(2)
  const prepareOnly = args.length === 1 && args[0] === '--prepare'
  if (args.includes('--prepare') && !prepareOnly) throw new Error('Use --prepare by itself to prepare the app without launching it.')
  const prepared = await prepareDevelopmentElectron()
  if (prepareOnly) {
    process.stdout.write(JSON.stringify(prepared) + '\n')
    return
  }

  const environment = { ...process.env }
  delete environment.ELECTRON_RUN_AS_NODE
  const child = spawn(prepared.executablePath, args.length ? args : [repositoryRoot], {
    cwd: repositoryRoot,
    env: environment,
    stdio: 'inherit',
  })
  const forwardInterrupt = () => child.kill('SIGINT')
  const forwardTermination = () => child.kill('SIGTERM')
  process.on('SIGINT', forwardInterrupt)
  process.on('SIGTERM', forwardTermination)
  try {
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => resolve({ code, signal }))
    })
    process.exitCode = result.signal ? 128 + (osConstants.signals[result.signal] ?? 0) : (result.code ?? 1)
  } finally {
    process.off('SIGINT', forwardInterrupt)
    process.off('SIGTERM', forwardTermination)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`[dev-electron] ${error.message}\n`)
    process.exitCode = 1
  })
}
