import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-canvas-minimap-'))
after(() => fs.rmSync(tempRoot, { recursive: true, force: true }))
const modulePath = path.join(tempRoot, 'canvas-minimap.mjs')
fs.writeFileSync(modulePath, ts.transpileModule(fs.readFileSync('src/lib/canvas-minimap.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2023, verbatimModuleSyntax: true },
}).outputText)
const { canvasMinimapLayout, canvasMinimapPointToWorld } = await import(pathToFileURL(modulePath).href)

function near(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `Expected ${actual} to be near ${expected}`)
}

function inside(rect, size, padding = 0) {
  assert.ok(rect.x >= padding - 1e-9)
  assert.ok(rect.y >= padding - 1e-9)
  assert.ok(rect.x + rect.width <= size.width - padding + 1e-9)
  assert.ok(rect.y + rect.height <= size.height - padding + 1e-9)
}

test('overview keeps the real canvas aspect ratio and maps its visible area into the miniature', () => {
  const layout = canvasMinimapLayout({
    graphBounds: { x: 0, y: 0, width: 1000, height: 500 },
    viewport: { x: -100, y: -50, zoom: 2 },
    canvasSize: { width: 600, height: 400 },
    previewSize: { width: 220, height: 150 },
    padding: 10,
  })
  assert.deepEqual(layout.bounds, { x: 0, y: 0, width: 1000, height: 500 })
  assert.deepEqual(layout.viewport, { x: 10, y: 25, zoom: 0.2 })
  assert.deepEqual(layout.viewportRect, { x: 20, y: 30, width: 60, height: 40 })
})

test('panning beyond every Agent keeps the thumbnail content fitted and leaves viewport clipping to the caller', () => {
  const size = { width: 220, height: 150 }
  const layout = canvasMinimapLayout({
    graphBounds: { x: 0, y: 0, width: 300, height: 160 },
    viewport: { x: -2000, y: 300, zoom: 1 },
    canvasSize: { width: 400, height: 300 }, previewSize: size,
  })
  assert.deepEqual(layout.bounds, { x: 0, y: 0, width: 300, height: 160 })
  assert.ok(layout.viewportRect.x > size.width)
  assert.ok(layout.viewportRect.y < 0)
  near(layout.viewportRect.width, 400 * layout.viewport.zoom)
  near(layout.viewportRect.height, 300 * layout.viewport.zoom)
  const graphCorner = { x: layout.viewport.x, y: layout.viewport.y }
  assert.ok(graphCorner.x >= 8 - 1e-9)
  assert.ok(graphCorner.y >= 8 - 1e-9)
  assert.ok(graphCorner.y + 160 * layout.viewport.zoom <= size.height - 8 + 1e-9)
})

test('main canvas pan and zoom do not shrink or move a populated miniature', () => {
  const input = {
    graphBounds: { x: -400, y: 100, width: 1000, height: 500 },
    canvasSize: { width: 800, height: 600 }, previewSize: { width: 220, height: 150 },
  }
  const original = canvasMinimapLayout({ ...input, viewport: { x: 0, y: 0, zoom: 1 } })
  for (const viewport of [{ x: -2000, y: 300, zoom: 1 }, { x: 800, y: -1200, zoom: 0.25 }, { x: -400, y: 800, zoom: 4 }]) {
    const changed = canvasMinimapLayout({ ...input, viewport })
    assert.deepEqual(changed.viewport, original.viewport)
    assert.deepEqual(changed.bounds, original.bounds)
    assert.notDeepEqual(changed.viewportRect, original.viewportRect)
  }
})

test('clicking the miniature maps back to the same world coordinates at negative origins and arbitrary zoom', () => {
  const layout = canvasMinimapLayout({
    graphBounds: { x: -450, y: -600, width: 1900, height: 1300 },
    viewport: { x: 37, y: -94, zoom: 1.75 },
    canvasSize: { width: 950, height: 600 }, previewSize: { width: 240, height: 160 },
  })
  for (const world of [{ x: -450, y: -600 }, { x: 0, y: 0 }, { x: 1200, y: 650 }]) {
    const previewPoint = { x: world.x * layout.viewport.zoom + layout.viewport.x, y: world.y * layout.viewport.zoom + layout.viewport.y }
    const restored = canvasMinimapPointToWorld(previewPoint, layout)
    near(restored.x, world.x)
    near(restored.y, world.y)
  }
  const center = canvasMinimapPointToWorld({
    x: layout.viewportRect.x + layout.viewportRect.width / 2,
    y: layout.viewportRect.y + layout.viewportRect.height / 2,
  }, layout)
  near(center.x, (950 / 2 - 37) / 1.75)
  near(center.y, (600 / 2 + 94) / 1.75)
})

test('empty graphs use the visible canvas area and resize without stretching the miniature', () => {
  for (const graphBounds of [undefined, { x: 0, y: 0, width: 0, height: 0 }]) {
    for (const previewSize of [{ width: 220, height: 150 }, { width: 150, height: 220 }]) {
      const layout = canvasMinimapLayout({ graphBounds, viewport: { x: 80, y: -40, zoom: 0.5 }, canvasSize: { width: 800, height: 600 }, previewSize })
      assert.deepEqual(layout.bounds, { x: -160, y: 80, width: 1600, height: 1200 })
      inside(layout.viewportRect, previewSize, 8)
      near(layout.viewportRect.width / layout.viewportRect.height, 800 / 600)
    }
  }
})

test('invalid and initially unmeasured dimensions cannot introduce NaN or infinite transforms', () => {
  for (const viewport of [{ x: NaN, y: Infinity, zoom: 0 }, { x: Infinity, y: -Infinity, zoom: NaN }, { x: 1e308, y: -1e308, zoom: 1e-308 }]) {
    const layout = canvasMinimapLayout({
      graphBounds: { x: NaN, y: 0, width: Infinity, height: -1 }, viewport,
      canvasSize: { width: 0, height: NaN }, previewSize: { width: 0, height: -1 }, padding: Infinity,
    })
    for (const field of [layout.bounds, layout.viewport, layout.viewportRect]) {
      for (const value of Object.values(field)) assert.ok(Number.isFinite(value))
    }
    assert.ok(layout.viewport.zoom > 0)
    assert.ok(layout.viewportRect.width > 0)
    assert.ok(layout.viewportRect.height > 0)
  }
})

test('large padding remains bounded and layout calculations do not mutate graph or viewport inputs', () => {
  const graphBounds = Object.freeze({ x: -40, y: -30, width: 400, height: 250 })
  const viewport = Object.freeze({ x: 30, y: 20, zoom: 1 })
  const canvasSize = Object.freeze({ width: 500, height: 400 })
  const previewSize = Object.freeze({ width: 120, height: 80 })
  const layout = canvasMinimapLayout({ graphBounds, viewport, canvasSize, previewSize, padding: 1000 })
  inside({
    x: graphBounds.x * layout.viewport.zoom + layout.viewport.x,
    y: graphBounds.y * layout.viewport.zoom + layout.viewport.y,
    width: graphBounds.width * layout.viewport.zoom,
    height: graphBounds.height * layout.viewport.zoom,
  }, previewSize)
  assert.ok(layout.viewport.zoom > 0)
  assert.deepEqual(graphBounds, { x: -40, y: -30, width: 400, height: 250 })
  assert.deepEqual(viewport, { x: 30, y: 20, zoom: 1 })
})
