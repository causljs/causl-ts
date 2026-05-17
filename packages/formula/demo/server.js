#!/usr/bin/env node
/**
 * Static dev server for the SPEC §11 spreadsheet demo.
 *
 * I run the demo against the built ESM in each package's `dist/` folder
 * and resolve `@causljs/*` bare specifiers via the import map in
 * `index.html`. That keeps the page identical to what users see when
 * they install the published packages — no bundler step in the middle.
 *
 * The server is intentionally trivial: a Node `http` listener that maps
 * URLs to files relative to the monorepo root, with the right MIME
 * types for `.js`, `.html`, `.map`. No deps, no watcher (the package
 * scripts in `package.json` arrange for `tsup --watch` to rebuild
 * `dist/` in the background; reload the page to pick up changes).
 */

import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { join, resolve, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

// `packages/formula/demo/server.js` → repo root is three levels up.
const __filename = fileURLToPath(import.meta.url)
const REPO_ROOT = resolve(__filename, '../../../..')

const PORT = Number(process.env.PORT ?? 4173)
const HOST = '127.0.0.1'

// Demo entry point. Visiting `/` redirects here.
const DEMO_PATH = '/packages/formula/demo/index.html'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
}

const server = createServer(async (req, res) => {
  try {
    if (!req.url) {
      res.writeHead(400)
      res.end('bad request')
      return
    }
    const url = new URL(req.url, `http://${HOST}:${PORT}`)
    let pathname = decodeURIComponent(url.pathname)
    if (pathname === '/' || pathname === '') {
      res.writeHead(302, { Location: DEMO_PATH })
      res.end()
      return
    }

    // Resolve against the monorepo root and refuse to escape it.
    const filePath = join(REPO_ROOT, pathname)
    if (!filePath.startsWith(REPO_ROOT)) {
      res.writeHead(403)
      res.end('forbidden')
      return
    }

    let stats
    try {
      stats = await stat(filePath)
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end(`Not found: ${pathname}\n\nDid you build the packages? Try \`pnpm demo:spreadsheet\` from the repo root.`)
      return
    }
    if (stats.isDirectory()) {
      res.writeHead(404)
      res.end('directory listings are disabled')
      return
    }

    const body = await readFile(filePath)
    const mime = MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
    res.writeHead(200, {
      'Content-Type': mime,
      'Cache-Control': 'no-store',
    })
    res.end(body)
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain' })
    res.end(`server error: ${e instanceof Error ? e.message : String(e)}`)
  }
})

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}${DEMO_PATH}`
  process.stdout.write(`causl demo server listening on ${url}\n`)
  process.stdout.write(`open the URL above to exercise the §11 spreadsheet.\n`)
})

// Clean shutdown on Ctrl+C so the port is released for the next run.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => process.exit(0))
  })
}
