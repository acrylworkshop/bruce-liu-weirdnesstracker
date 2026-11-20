/**
 * The weirdness tracker: the camera watches your face, scores how weird it looks, learns whose face it is and keeps a
 * history of every capture so you can chart and compare people. Its page is at `/weirdness`; it puts a summary of the
 * latest readings on the home page.
 *
 * The face work happens in the browser: the vendored face-api bundle detects a face in the camera picture, reads its 68
 * landmarks and computes a 128 number descriptor, and this plugin serves that bundle and its model weights unchanged from
 * `assets/`. The browser sends the landmark ratios, the descriptor and a small picture; the server computes the score
 * (the same `score.js` the browser showed live), matches the descriptor against the people it knows, and records the
 * reading in `weirdness.json` in the app's home. Nothing leaves the machine.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { Acryl } from '@acryldev/blends'
import { page } from './page.ts'
import { trend } from './score.js'
import {
  openStore,
  readDescriptor,
  readFeatures,
  readName,
  readSettings,
  readShot,
  type Profile,
  type Store,
} from './store.ts'
import type {} from '../home/index.ts'
import type {} from '@acryldev/instance'

export const name = 'weirdness'
export const inject = ['router', 'home', 'appInstance']

/** The files this plugin serves to its own page: the vendored face bundle, its model weights and the browser's own code. */
const here = fileURLToPath(new URL('.', import.meta.url))
const ASSETS: Record<string, string> = {
  'face-api.js': 'text/javascript; charset=utf-8',
  'LICENSE-face-api.txt': 'text/plain; charset=utf-8',
}
const MODEL_FILES = /^[a-z0-9][a-z0-9_.-]*\.(json|bin)$/
/** The client modules beside this file, served as they are: the browser runs them, so they are `.js`, not `.ts`. */
const CLIENT_FILES = ['client.js', 'score.js']

const escapeHtml = (text: string): string =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')

const recordOf = (input: unknown): Record<string, unknown> | null =>
  typeof input === 'object' && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : null

/** A profile as the page reads it: the readings as `[when, score]` pairs, which is all the charts need. */
function summary(profile: Profile) {
  return {
    id: profile.id,
    name: profile.name,
    createdAt: profile.createdAt,
    descriptors: profile.descriptors.length,
    readings: profile.readings.map((reading) => [reading.at, reading.score]),
  }
}

function widget(store: Store): string {
  const state = store.state()
  const profiles = [...state.profiles].sort(
    (a, b) => (b.readings.at(-1)?.at ?? 0) - (a.readings.at(-1)?.at ?? 0),
  )
  const captures = state.profiles.reduce((sum, profile) => sum + profile.readings.length, 0)
  const rows = profiles.slice(0, 3).map((profile) => {
    const stats = trend(profile.readings)
    const direction = stats.slopePerDay > 0.2 ? 'getting weirder' : stats.slopePerDay < -0.2 ? 'calming down' : 'holding steady'
    return `<li><b>${escapeHtml(profile.name)}</b><span>latest <output>${stats.last.toFixed(1)}</output> · average ${stats.mean.toFixed(1)} · ${escapeHtml(direction)}</span></li>`
  })
  const body =
    profiles.length === 0
      ? '<p>No faces yet. Open the tracker and let the camera look at you.</p>'
      : `<ul>${rows.join('')}</ul><p>${captures} capture${captures === 1 ? '' : 's'} of ${profiles.length} ${profiles.length === 1 ? 'person' : 'people'}, all kept on this machine.</p>`
  return `<div class="weirdness-summary">${body}<p><a id="weirdness-open" href="./weirdness">Open the weirdness tracker</a></p></div>
<script type="module">
  const link = document.getElementById('weirdness-open')
  if (link) link.setAttribute('href', location.pathname.replace(/\\/+$/, '') + '/weirdness')
</script>`
}

export function apply(ctx: Context): void {
  const store = openStore(ctx.appInstance.home)
  /**
   * The digest of the browser modules this plugin serves. The page asks for `client.js?v=<digest>`, so a browser holding
   * an older copy (they are no-cache, but an earlier copy may still be in its cache) fetches the file on disk instead.
   */
  const version = (() => {
    const hash = createHash('sha1')
    for (const name of ['client.js', 'score.js']) hash.update(readFileSync(join(here, name)))
    return hash.digest('hex').slice(0, 12)
  })()
  /** Assets are read once and kept: the face bundle is 1.3 MB and the weights are 7 MB. */
  const cache = new Map<string, Uint8Array<ArrayBuffer>>()
  const bytesOf = (path: string): Uint8Array<ArrayBuffer> | null => {
    const cached = cache.get(path)
    if (cached !== undefined) return cached
    try {
      const data = readFileSync(path)
      const bytes = new Uint8Array(data.byteLength)
      bytes.set(data)
      cache.set(path, bytes)
      return bytes
    } catch {
      return null
    }
  }
  /**
   * A file of this plugin as a response, or null when it is missing: the caller answers 404 itself. The vendored face
   * bundle and weights never change, so the browser may keep them for a day; the plugin's own client modules change with
   * every edit, and a reload must fetch them again instead of running yesterday's code from the cache.
   */
  const file = (path: string, type: string, cacheable: boolean): Response | null => {
    const bytes = bytesOf(path)
    if (bytes === null) return null
    return new Response(bytes, {
      status: 200,
      headers: {
        'content-type': type,
        'cache-control': cacheable ? 'public, max-age=86400' : 'no-cache',
      },
    })
  }
  const app = new Acryl()
    .get('/', (c) => c.html(page(version)))
    .get('/client.js', (c) => file(join(here, 'client.js'), 'text/javascript; charset=utf-8', false) ?? c.json({ error: 'not found' }, 404))
    .get('/score.js', (c) => file(join(here, 'score.js'), 'text/javascript; charset=utf-8', false) ?? c.json({ error: 'not found' }, 404))
    .get('/vendor/:name', (c) => {
      const name = c.req.param('name')
      const type = ASSETS[name]
      if (type === undefined) return c.json({ error: 'not found' }, 404)
      return file(join(here, 'assets', name), type, true) ?? c.json({ error: 'not found' }, 404)
    })
    .get('/vendor/model/:name', (c) => {
      const name = c.req.param('name')
      if (!MODEL_FILES.test(name)) return c.json({ error: 'not found' }, 404)
      const type = name.endsWith('.json') ? 'application/json' : 'application/octet-stream'
      return file(join(here, 'assets', 'model', name), type, true) ?? c.json({ error: 'not found' }, 404)
    })
    .get('/api/state', (c) =>
      c.json({
        settings: store.settings(),
        profiles: [...store.state().profiles]
          .sort((a, b) => (b.readings.at(-1)?.at ?? 0) - (a.readings.at(-1)?.at ?? 0))
          .map(summary),
      }),
    )
    .get('/api/profiles/:id/shots', (c) => {
      const limit = Number(c.req.query('limit') ?? '12')
      const shots = store.shots(c.req.param('id'), Number.isFinite(limit) ? limit : 12)
      return c.json({ shots })
    })
    .post('/api/capture', async (c) => {
      const body = recordOf(await c.req.json().catch(() => null))
      if (body === null) return c.json({ error: 'a capture is a JSON object' }, 400)
      const features = readFeatures(body.features)
      const descriptor = readDescriptor(body.descriptor)
      const shot = readShot(body.shot)
      if (features === null || descriptor === null || shot === null)
        return c.json({ error: 'a capture needs the face features, its descriptor and a picture' }, 400)
      const result = store.capture({ features, descriptor, shot: shot.shot })
      return c.json(
        {
          profile: summary(result.profile),
          reading: { at: result.reading.at, score: result.reading.score, parts: result.reading.parts },
          verdict: result.verdict,
          distance: result.distance,
          created: result.created,
        },
        201,
      )
    })
    .post('/api/profiles/:id/name', async (c) => {
      const body = recordOf(await c.req.json().catch(() => null))
      const name = readName(body?.name)
      if (name === null) return c.json({ error: 'a name is 1 to 40 characters' }, 400)
      const profile = store.rename(c.req.param('id'), name)
      if (profile === undefined) return c.json({ error: 'no such person' }, 404)
      return c.json({ profile: summary(profile) })
    })
    .post('/api/profiles/:id/merge', async (c) => {
      const body = recordOf(await c.req.json().catch(() => null))
      const into = typeof body?.into === 'string' ? body.into : ''
      const target = store.merge(c.req.param('id'), into)
      if (target === undefined) return c.json({ error: 'merge one person into another' }, 404)
      return c.json({ profile: summary(target) })
    })
    .delete('/api/profiles/:id', (c) => {
      if (!store.remove(c.req.param('id'))) return c.json({ error: 'no such person' }, 404)
      return c.body(null, 204)
    })
    .post('/api/settings', async (c) => {
      const patch = readSettings(await c.req.json().catch(() => null))
      if (patch === null)
        return c.json({ error: 'settings are an interval of 1..600 seconds and a match threshold of 0.2..0.9' }, 400)
      return c.json({ settings: store.setSettings(patch) })
    })

  ctx.router.route('/weirdness', app)

  ctx.effect(() =>
    ctx.home.widget({
      id: 'weirdness',
      title: 'Weirdness',
      render: () => widget(store),
    }),
  )
}
