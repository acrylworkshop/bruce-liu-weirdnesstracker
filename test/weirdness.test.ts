import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { pinnedInstance, withPort } from '@acryldev/instance'
import { type App, createApp } from '../src/app.ts'
import { trend, weirdness } from '../plugins/weirdness/score.js'

/** Throwaway homes live inside the project (`.acrylblends/` is git ignored): a sandboxed agent may not write to the system temp folder. */
const scratch = join(fileURLToPath(new URL('..', import.meta.url)), '.acrylblends', 'test')
mkdirSync(scratch, { recursive: true })
const projectRoot = fileURLToPath(new URL('..', import.meta.url))

async function boot(home: string): Promise<App> {
  return createApp(withPort(pinnedInstance(home, { root: projectRoot }), 0), { listen: false })
}

async function withApp(run: (app: App) => Promise<void>) {
  const home = await mkdtemp(join(scratch, 'weirdness-test-'))
  const app = await boot(home)
  try {
    await run(app)
  } finally {
    await app.stop()
    await rm(home, { recursive: true, force: true })
  }
}

/** A relaxed face and a very odd one, as the browser would measure them. */
const NEUTRAL = {
  eyeRatio: 0.27,
  mouthRatio: 0.05,
  smile: 0.02,
  brow: 1.15,
  roll: 2,
  asymmetry: 0.02,
  yaw: 0.05,
  skew: 0.01,
}
const ODD = {
  eyeRatio: 0.45,
  mouthRatio: 0.5,
  smile: 0.3,
  brow: 1.8,
  roll: 30,
  asymmetry: 0.12,
  yaw: 0.5,
  skew: 0.14,
}

/** A face descriptor of 128 numbers; `seed` makes a different face, `drift` a slightly different picture of the same one. */
const face = (seed: number, drift = 0): number[] =>
  Array.from({ length: 128 }, (_, index) => Math.sin(index * (seed + 1) * 0.37) * 0.4 + drift)

const body = (features: unknown, descriptor: unknown, shot: unknown = null) =>
  JSON.stringify({ features, descriptor, shot })

async function capture(app: App, features: unknown, descriptor: unknown, shot: unknown = null) {
  return app.root.router.request('/weirdness/api/capture', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body(features, descriptor, shot),
  })
}

test('the weirdness math: a calm face is near zero, an odd one is high, and the trend measures the change', () => {
  const calm = weirdness(NEUTRAL)
  const odd = weirdness(ODD)
  assert.ok(calm.score < 5, `a neutral face should score low, got ${String(calm.score)}`)
  assert.ok(odd.score > 70, `an odd face should score high, got ${String(odd.score)}`)
  assert.equal(calm.parts.length, 8)
  assert.equal(odd.top.length, 3)
  assert.ok(odd.top[0].share >= odd.top[1].share, 'the top parts are the biggest first')
  assert.ok(odd.parts.every((part) => part.value >= 0 && part.value <= 1), 'every part is 0..1')

  const day = 86_400_000
  const start = Date.UTC(2024, 0, 1)
  const rising = [0, 1, 2, 3].map((index) => ({ at: start + index * day, score: 10 + index * 5 }))
  const stats = trend(rising)
  assert.equal(stats.count, 4)
  assert.equal(stats.first, 10)
  assert.equal(stats.last, 25)
  assert.equal(stats.change, 15)
  assert.equal(stats.slopePerDay, 5)
  assert.equal(stats.r2, 1)
  assert.equal(stats.spanDays, 3)
  assert.equal(stats.total, 70)
  assert.equal(trend([]).count, 0)
  assert.equal(trend([]).last, 0)
  const flat = trend([{ at: start, score: 20 }])
  assert.equal(flat.slopePerDay, 0)
  assert.equal(flat.count, 1)
  assert.equal(trend(rising.map((point) => [point.at, point.score] as const)).slopePerDay, 5)
})

test('the page, the client modules and the vendored face bundle are served', () =>
  withApp(async (app) => {
    const page = await app.root.router.request('/weirdness')
    assert.equal(page.status, 200)
    assert.match(page.headers.get('content-type') ?? '', /text\/html/)
    const html = await page.text()
    assert.match(html, /<h1>Weirdness tracker<\/h1>/)
    assert.match(html, /client\.js\?v=[0-9a-f]{12}/, 'the page boots the client module under a version digest')

    const client = await app.root.router.request('/weirdness/client.js')
    assert.equal(client.status, 200)
    assert.match(client.headers.get('content-type') ?? '', /javascript/)
    assert.equal(client.headers.get('cache-control'), 'no-cache', 'an edited client module must not be served from a cache')
    assert.match(await client.text(), /weirdness/)

    const math = await app.root.router.request('/weirdness/score.js')
    assert.equal(math.status, 200)
    assert.match(await math.text(), /export function weirdness/)

    const bundle = await app.root.router.request('/weirdness/vendor/face-api.js')
    assert.equal(bundle.status, 200)
    assert.match(bundle.headers.get('content-type') ?? '', /javascript/)
    assert.equal(bundle.headers.get('cache-control'), 'public, max-age=86400', 'the vendored bundle may be cached')
    const bundleBytes = new Uint8Array(await bundle.arrayBuffer())
    assert.ok(bundleBytes.byteLength > 1_000_000, 'the face bundle is served whole')

    const manifest = await app.root.router.request('/weirdness/vendor/model/face_recognition_model-weights_manifest.json')
    assert.equal(manifest.status, 200)
    const weights = (await manifest.json()) as { paths: string[] }[]
    assert.deepEqual(weights[0].paths, ['face_recognition_model.bin'])

    const model = await app.root.router.request('/weirdness/vendor/model/face_recognition_model.bin')
    assert.equal(model.status, 200)
    await model.body?.cancel()

    for (const missing of [
      '/weirdness/vendor/model/../package.json',
      '/weirdness/vendor/model/nope.bin',
      '/weirdness/vendor/nope.js',
    ]) {
      const gone = await app.root.router.request(missing)
      assert.equal(gone.status, 404, missing)
      await gone.body?.cancel()
    }
  }))

test('a capture scores a face, starts a profile and records it; the same face comes back to the same person', () =>
  withApp(async (app) => {
    const state = await app.root.router.request('/weirdness/api/state')
    assert.deepEqual(await state.json(), {
      settings: { intervalSec: 5, matchThreshold: 0.6 },
      profiles: [],
    })

    const first = await capture(app, ODD, face(1), 'data:image/jpeg;base64,AAAA')
    assert.equal(first.status, 201)
    const answer = (await first.json()) as {
      profile: { id: string; name: string; readings: [number, number][] }
      reading: { score: number }
      created: boolean
      distance: number | null
    }
    assert.equal(answer.created, true)
    assert.equal(answer.profile.name, 'Person 1')
    assert.ok(answer.reading.score > 70)
    assert.equal(answer.distance, null)
    assert.equal(answer.profile.readings.length, 1)
    assert.match(new Date(answer.profile.readings[0][0]).toISOString(), /^\d{4}-/)

    const again = await capture(app, ODD, face(1, 0.001))
    const second = (await again.json()) as { profile: { id: string; readings: [number, number][] }; created: boolean; distance: number }
    assert.equal(second.created, false)
    assert.equal(second.profile.id, answer.profile.id, 'the same face stays one person')
    assert.ok(second.distance < 0.55)
    assert.equal(second.profile.readings.length, 2)

    const stranger = await capture(app, NEUTRAL, face(7))
    const other = (await stranger.json()) as { profile: { id: string; name: string }; created: boolean }
    assert.equal(other.created, true)
    assert.notEqual(other.profile.id, answer.profile.id)
    assert.equal(other.profile.name, 'Person 2')

    const after = (await (await app.root.router.request('/weirdness/api/state')).json()) as {
      profiles: { name: string; readings: unknown[] }[]
    }
    assert.equal(after.profiles.length, 2)
    assert.equal(after.profiles[0].readings.length, 1)
  }))

test('a capture without a usable face, picture or features is refused', () =>
  withApp(async (app) => {
    const noFeatures = await capture(app, { eyeRatio: 0.3 }, face(1))
    assert.equal(noFeatures.status, 400)
    const noDescriptor = await capture(app, ODD, [1, 2, 3])
    assert.equal(noDescriptor.status, 400)
    const badShot = await capture(app, ODD, face(1), 'data:text/html;base64,AAAA')
    assert.equal(badShot.status, 400)
    const notJson = await app.root.router.request('/weirdness/api/capture', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'nope',
    })
    assert.equal(notJson.status, 400)
    const state = (await (await app.root.router.request('/weirdness/api/state')).json()) as { profiles: unknown[] }
    assert.deepEqual(state.profiles, [])
  }))

test('people can be renamed, merged and deleted, and the settings stick', () =>
  withApp(async (app) => {
    const one = (await (await capture(app, ODD, face(1))).json()) as { profile: { id: string } }
    const two = (await (await capture(app, NEUTRAL, face(7))).json()) as { profile: { id: string } }

    const rename = await app.root.router.request(`/weirdness/api/profiles/${one.profile.id}/name`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Robin' }),
    })
    assert.equal(rename.status, 200)
    assert.equal(((await rename.json()) as { profile: { name: string } }).profile.name, 'Robin')

    const emptyName = await app.root.router.request(`/weirdness/api/profiles/${one.profile.id}/name`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '  ' }),
    })
    assert.equal(emptyName.status, 400)

    const settings = await app.root.router.request('/weirdness/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ intervalSec: 15, matchThreshold: 0.4 }),
    })
    assert.equal(settings.status, 200)
    assert.deepEqual(((await settings.json()) as { settings: unknown }).settings, {
      intervalSec: 15,
      matchThreshold: 0.4,
    })
    const badSetting = await app.root.router.request('/weirdness/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ matchThreshold: 3 }),
    })
    assert.equal(badSetting.status, 400)

    const merge = await app.root.router.request(`/weirdness/api/profiles/${two.profile.id}/merge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ into: one.profile.id }),
    })
    assert.equal(merge.status, 200)
    const merged = (await merge.json()) as { profile: { readings: unknown[]; name: string } }
    assert.equal(merged.profile.name, 'Robin')
    assert.equal(merged.profile.readings.length, 2)

    const remove = await app.root.router.request(`/weirdness/api/profiles/${one.profile.id}`, { method: 'DELETE' })
    assert.equal(remove.status, 204)
    const state = (await (await app.root.router.request('/weirdness/api/state')).json()) as { profiles: unknown[] }
    assert.deepEqual(state.profiles, [])
  }))

test('the home page shows the tracker widget with the latest readings', () =>
  withApp(async (app) => {
    const before = await (await app.root.router.request('/', { headers: { accept: 'text/html' } })).text()
    assert.match(before, /data-widget="weirdness"/)
    assert.match(before, /No faces yet/)

    await capture(app, ODD, face(1))

    const after = await (await app.root.router.request('/', { headers: { accept: 'text/html' } })).text()
    assert.match(after, /data-widget="weirdness"/)
    assert.match(after, /Person 1/)
    assert.match(after, /1 capture of 1 person/)
    assert.match(after, /Open the weirdness tracker/)
  }))

test('the readings and the people survive a restart', async () => {
  const home = await mkdtemp(join(scratch, 'weirdness-restart-'))
  try {
    const first = await boot(home)
    let id = ''
    try {
      const answer = (await (await capture(first, ODD, face(1))).json()) as { profile: { id: string } }
      id = answer.profile.id
      await first.root.router.request(`/weirdness/api/profiles/${id}/name`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Robin' }),
      })
      await first.root.router.request('/weirdness/api/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ intervalSec: 30 }),
      })
    } finally {
      await first.stop()
    }
    const second = await boot(home)
    try {
      const state = (await (await second.root.router.request('/weirdness/api/state')).json()) as {
        settings: { intervalSec: number }
        profiles: { id: string; name: string; readings: unknown[] }[]
      }
      assert.equal(state.settings.intervalSec, 30)
      assert.equal(state.profiles.length, 1)
      assert.equal(state.profiles[0].id, id)
      assert.equal(state.profiles[0].name, 'Robin')
      assert.equal(state.profiles[0].readings.length, 1)
    } finally {
      await second.stop()
    }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
