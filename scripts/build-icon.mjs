// Render resources/icon.svg to the PNG sizes Windows wants, and pack them into
// resources/icon.ico.
//
// Rendered through Electron rather than a native image library: Chromium is already
// a dependency and rasterises SVG exactly as the app itself would, so there is no
// second renderer to disagree with the first. ICO is written by hand because the
// format allows PNG payloads directly, which makes the packing a header, a
// directory, and the bytes.
//
// Run: node scripts/build-icon.mjs
import { _electron as electron } from 'playwright-core'
import * as fs from 'node:fs'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const SVG = path.join(APP_DIR, 'resources', 'icon.svg')
const OUT_ICO = path.join(APP_DIR, 'resources', 'icon.ico')
const OUT_PNG = path.join(APP_DIR, 'resources', 'icon.png')

// The sizes Explorer, the taskbar, alt-tab and the installer actually ask for.
const SIZES = [16, 24, 32, 48, 64, 128, 256]

// A data URI, not a blob: the app page's CSP allows `data:` images and not `blob:`,
// and rendering on the app's own page is the point — same renderer, same result.
const svgDataUri = `data:image/svg+xml;base64,${fs.readFileSync(SVG).toString('base64')}`
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
  args: [APP_DIR],
  cwd: APP_DIR,
  env,
  timeout: 60_000
})
const page = await app.firstWindow()

const pngs = new Map()
for (const size of SIZES) {
  // A fresh page per size so the SVG lays out at exactly that box, rather than
  // being scaled from one raster and picking up the artefacts of a resample.
  const shot = await page.evaluate(
    async ([dataUri, px]) => {
      const img = new Image()
      img.width = px
      img.height = px
      await new Promise((resolve, reject) => {
        img.onload = resolve
        img.onerror = () => reject(new Error('SVG failed to decode'))
        img.src = dataUri
      })
      const canvas = document.createElement('canvas')
      canvas.width = px
      canvas.height = px
      const ctx = canvas.getContext('2d')
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(img, 0, 0, px, px)
      return canvas.toDataURL('image/png').split(',')[1]
    },
    [svgDataUri, size]
  )
  pngs.set(size, Buffer.from(shot, 'base64'))
  console.log(`rendered ${size}×${size} (${pngs.get(size).length} bytes)`)
}

/**
 * A contact sheet, on both a dark and a light strip. An icon is only as good as
 * its 16px rendering on whatever the taskbar happens to be, and that is not
 * something to judge from the 256px artwork.
 */
const sheet = await page.evaluate(
  async ([sources]) => {
    const pad = 16
    const scale = 3 // drawn larger than life so small sizes can be inspected
    const width = sources.reduce((w, s) => w + s.size * scale + pad, pad)
    const rowHeight = 256 * scale * 0 + 128 + pad * 2
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = rowHeight * 2
    const ctx = canvas.getContext('2d')

    const strips = ['#1e1e1e', '#f2f2f2']
    for (let row = 0; row < 2; row++) {
      ctx.fillStyle = strips[row]
      ctx.fillRect(0, row * rowHeight, width, rowHeight)
      let x = pad
      for (const s of sources) {
        const img = new Image()
        await new Promise((resolve) => {
          img.onload = resolve
          img.src = `data:image/png;base64,${s.data}`
        })
        const drawn = s.size * scale
        ctx.drawImage(img, x, row * rowHeight + (rowHeight - drawn) / 2, drawn, drawn)
        x += drawn + pad
      }
    }
    return canvas.toDataURL('image/png').split(',')[1]
  },
  [
    [16, 24, 32, 48].map((size) => ({ size, data: pngs.get(size).toString('base64') }))
  ]
)
fs.writeFileSync(path.join(APP_DIR, '.shots', '80-icon-sizes.png'), Buffer.from(sheet, 'base64'))
console.log('wrote .shots/80-icon-sizes.png')

await app.close()

// The largest one on its own, for Linux packaging and anywhere a PNG is wanted.
fs.writeFileSync(OUT_PNG, pngs.get(256))

/**
 * ICO: a 6-byte header, then one 16-byte directory entry per image, then the
 * payloads. A width or height of 256 is stored as 0, which is the format's way of
 * saying "larger than a byte can hold".
 */
const entries = [...pngs.entries()]
const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0) // reserved
header.writeUInt16LE(1, 2) // 1 = icon
header.writeUInt16LE(entries.length, 4)

const directory = Buffer.alloc(16 * entries.length)
let offset = header.length + directory.length
entries.forEach(([size, png], i) => {
  const at = i * 16
  directory.writeUInt8(size >= 256 ? 0 : size, at)
  directory.writeUInt8(size >= 256 ? 0 : size, at + 1)
  directory.writeUInt8(0, at + 2) // palette entries, 0 for PNG
  directory.writeUInt8(0, at + 3) // reserved
  directory.writeUInt16LE(1, at + 4) // colour planes
  directory.writeUInt16LE(32, at + 6) // bits per pixel
  directory.writeUInt32LE(png.length, at + 8)
  directory.writeUInt32LE(offset, at + 12)
  offset += png.length
})

fs.writeFileSync(OUT_ICO, Buffer.concat([header, directory, ...entries.map(([, png]) => png)]))
console.log(`wrote ${path.relative(APP_DIR, OUT_ICO)} (${fs.statSync(OUT_ICO).size} bytes)`)
console.log(`wrote ${path.relative(APP_DIR, OUT_PNG)}`)
