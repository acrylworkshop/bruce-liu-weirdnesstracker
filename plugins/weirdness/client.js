/**
 * The tracker's browser side: the camera, the face reading, the capture and the charts.
 *
 * face-api (vendored in `assets/`, MIT) finds a face in the camera picture, reads its 68 landmarks and, on a capture,
 * computes the 128 number descriptor that identifies the person. The browser scores the live picture with the same
 * `score.js` the server records with, so the number on the readout is the number that gets saved.
 *
 * Every URL here is resolved against `base`, this page's own address with a trailing slash, so the same code works at
 * `/weirdness` on the app's own server and at `/app/weirdness` in the ACRYL frame.
 *
 * The page is a stage and a review. The stage (left) is the camera, the live number, the eight things driving it and the
 * capture settings; it stays short. The review (right) is a rail of people and one card about the selected person, with
 * two tabs (history, compare). Nothing that changes a person's data is repeated per row, which is what keeps ten people
 * readable.
 */
// The version the page gave this module rides along to the math beside it, so an edited score.js is not served from a cache.
const version = new URL(import.meta.url).searchParams.get('v') ?? ''
const { movingAverage, trend, weirdness } = await import(`./score.js${version === '' ? '' : `?v=${version}`}`)

const base = new URL(location.pathname.replace(/\/+$/, '') + '/', location.origin)
const api = (path) => new URL(path, base).href
const byId = (id) => document.getElementById(id)

const video = byId('video')
const photo = byId('photo')
const overlay = byId('overlay')
const placeholder = byId('placeholder')
const readout = byId('readout')
const liveScore = byId('live-score')
const liveVerdict = byId('live-verdict')
const noticeBox = byId('notice')
const statusLine = byId('status')
const flashBox = byId('flash')
const modelChip = byId('model-chip')
const modeChip = byId('mode-chip')
const modeLabel = byId('mode-label')
const startButton = byId('start')
const startLabel = byId('start-label')
const snapButton = byId('snap')
const peopleList = byId('people')
const peopleCount = byId('people-count')
const factorsBox = byId('factors')
const driversHint = byId('drivers-hint')
const renameInput = byId('rename')
const detailAvatar = byId('detail-avatar')
const detailMeta = byId('detail-meta')
const personMenu = byId('person-menu')
const mergeSelect = byId('merge')
const deleteButton = byId('delete')
const tabHistory = byId('tab-history')
const tabCompare = byId('tab-compare')
const panelHistory = byId('panel-history')
const panelCompare = byId('panel-compare')
const compareCount = byId('compare-count')
const statsBox = byId('stats')
const verdictLine = byId('verdict-line')
const verdictHeadline = byId('verdict-headline')
const verdictDetail = byId('verdict-detail')
const historyChart = byId('history-chart')
const compareChart = byId('compare-chart')
const compareTable = byId('compare-table')
const shotsBox = byId('shots')
const shotsHint = byId('shots-hint')
const settingsHint = byId('settings-hint')

const COLORS = ['#7c8cff', '#4dd4ac', '#ffd166', '#ff8fab', '#a78bfa', '#66c2ff']
const PROFILE_COLOR = COLORS[0]

/** What a number means in words: a score is easier to trust with a label beside it. */
const BANDS = [
  { upTo: 10, key: 'calm', label: 'suspiciously normal' },
  { upTo: 25, key: 'calm', label: 'almost normal' },
  { upTo: 45, key: 'odd', label: 'mildly weird' },
  { upTo: 65, key: 'weird', label: 'properly weird' },
  { upTo: Number.POSITIVE_INFINITY, key: 'weird', label: 'deeply weird' },
]

function bandOf(score) {
  for (const band of BANDS) if (score < band.upTo) return band
  return BANDS[BANDS.length - 1]
}

const view = {
  settings: { intervalSec: 5, matchThreshold: 0.6, sound: true },
  profiles: [],
  selected: null,
  compare: new Set(),
  tab: 'history',
  shotsFor: null,
  faceapi: null,
  options: null,
  stream: null,
  mode: null, // 'camera' | 'photo' | null
  running: false,
  capturing: false,
  lastCaptureAt: 0,
  lastFace: null,
  capturePhoto: false,
}

let timer = 0
let frameCallback = 0
let lastDetectAt = 0
let hadFace = false
let lastFaceSoundAt = 0

/**
 * Ask for the next look at the camera. In camera mode a video frame callback drives it, because a browser throttles
 * `setTimeout` in a tab that is not in front (a capture every 5 seconds became one a minute); the picture keeps coming, so
 * the frame callback keeps coming. A photo, or a browser without the callback, uses a timer.
 */
function scheduleTick(delay) {
  if (view.mode === 'camera' && typeof video.requestVideoFrameCallback === 'function') {
    if (frameCallback === 0) {
      frameCallback = video.requestVideoFrameCallback(() => {
        frameCallback = 0
        void tick()
      })
    }
    return
  }
  clearTimeout(timer)
  timer = setTimeout(() => void tick(), delay)
}

function stopTicking() {
  clearTimeout(timer)
  timer = 0
  if (frameCallback !== 0 && typeof video.cancelVideoFrameCallback === 'function') {
    video.cancelVideoFrameCallback(frameCallback)
  }
  frameCallback = 0
}

/* ---------- small DOM helpers: text always goes in as text, never as markup ---------- */

function element(tag, className, text) {
  const node = document.createElement(tag)
  if (className !== undefined) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

const SVG = 'http://www.w3.org/2000/svg'

function svgNode(tag, attributes) {
  const node = document.createElementNS(SVG, tag)
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value))
  return node
}

let statusHold = 0

function setStatus(message) {
  if (Date.now() < statusHold) return
  if (statusLine.textContent !== message) statusLine.textContent = message
}

/** A message that stays for a moment, instead of being replaced by the running commentary. */
function holdStatus(message, ms = 5000) {
  statusLine.textContent = message
  statusHold = Date.now() + ms
}

function notice(message) {
  noticeBox.textContent = message
}

let flashTimer = 0
function flash(message) {
  flashBox.textContent = message
  flashBox.hidden = false
  clearTimeout(flashTimer)
  flashTimer = setTimeout(() => {
    flashBox.hidden = true
  }, 7000)
}

const score1 = (value) => (Number.isFinite(value) ? value.toFixed(1) : '0.0')
const percent = (value) => `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%`
const signed = (value) => `${value > 0 ? '+' : ''}${score1(value)}`

function when(at) {
  return new Date(at).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** "40 min", "1.5 hours", "3 days": how long a history covers, in the unit that reads best. */
function spanText(days) {
  const minutes = days * 1440
  if (!Number.isFinite(minutes) || minutes < 1) return 'under a minute'
  if (minutes < 90) return `${Math.round(minutes)} min`
  if (days < 2) return `${(minutes / 60).toFixed(1).replace(/\.0$/u, '')} hours`
  return `${days.toFixed(days < 10 ? 1 : 0).replace(/\.0$/u, '')} days`
}

/**
 * What the readings say, in words that stay true. A session of two hundred captures in half an hour has a huge
 * "points per day" slope and a line that fits nothing, so the rate is quoted per hour there and a flat, noisy series is
 * called what it is instead of inventing a direction.
 */
function describeTrend(stats) {
  if (stats.count === 0) return { headline: 'No readings yet', detail: 'Capture a face to start the history.', tone: 'flat' }
  if (stats.count === 1) return { headline: 'One reading so far', detail: 'Two or more readings show which way this is going.', tone: 'flat' }
  const span = spanText(stats.spanDays)
  const change = stats.change
  const slopePerHour = stats.slopePerDay / 24
  const noisy = stats.r2 < 0.12
  if (noisy || Math.abs(slopePerHour) < 0.05) {
    return {
      headline: Math.abs(change) < 2 ? 'Holding steady' : 'No clear direction',
      detail:
        Math.abs(change) < 2
          ? `${stats.count} readings over ${span}, all around the same level. Average ${score1(stats.mean)}.`
          : `${stats.count} readings over ${span}, moving up and down without a trend. Average ${score1(stats.mean)}.`,
      tone: 'flat',
    }
  }
  const rate =
    stats.spanDays >= 2
      ? `${score1(Math.abs(stats.slopePerDay))} points a day`
      : `${score1(Math.abs(slopePerHour))} points an hour`
  return {
    headline: change > 0 ? 'Getting weirder' : 'Calming down',
    detail: `About ${rate} over ${span}, from ${score1(stats.first)} to ${score1(stats.last)}.`,
    tone: change > 0 ? 'up' : 'down',
  }
}

function describe(error) {
  const name = error && error.name ? error.name : ''
  if (name === 'NotAllowedError') return 'the camera was refused. Allow it in the browser bar, then press Start camera again.'
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return 'no camera was found on this machine.'
  if (name === 'NotReadableError') return 'the camera is busy in another app.'
  if (name === 'OverconstrainedError') return 'the camera cannot do the size asked for.'
  return (error && error.message) || String(error)
}

/* ---------- sound: a few synthesized blips, no files, no libraries ---------- */

let audio = null

/**
 * The page's audio context, made on the first real click (browsers refuse sound before one) and resumed if the browser
 * suspended it. Null when this browser has no Web Audio at all: the tracker then simply stays quiet.
 */
function audioContext() {
  if (audio === null) {
    const Ctor = window.AudioContext || window.webkitAudioContext
    if (typeof Ctor !== 'function') return null
    try {
      audio = new Ctor()
    } catch {
      return null
    }
  }
  if (audio.state === 'suspended') audio.resume().catch(() => {})
  return audio
}

/** One short note: an oscillator with a click-free envelope, `delay` seconds from now. */
function beep(frequency, { to = 0, length = 0.1, type = 'triangle', gain = 0.05, delay = 0 } = {}) {
  if (view.settings.sound !== true) return
  const context = audioContext()
  if (context === null) return
  try {
    const start = context.currentTime + delay
    const oscillator = context.createOscillator()
    const envelope = context.createGain()
    oscillator.type = type
    oscillator.frequency.setValueAtTime(frequency, start)
    if (to > 0) oscillator.frequency.exponentialRampToValueAtTime(to, start + length)
    envelope.gain.setValueAtTime(0.0001, start)
    envelope.gain.exponentialRampToValueAtTime(gain, start + 0.012)
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + length)
    oscillator.connect(envelope).connect(context.destination)
    oscillator.start(start)
    oscillator.stop(start + length + 0.03)
  } catch {
    // Sound that cannot play is never a reason to lose a capture.
  }
}

/**
 * The tracker's voice: a capture is two notes whose pitch rises with the weirdness, a new face is a three note chime, a
 * new personal best is an upward fanfare, a face arriving gets a soft ping, and the camera opens and closes with a sweep.
 */
const sounds = {
  capture(score) {
    const root = 280 + Math.min(100, Math.max(0, score)) * 6
    beep(root, { length: 0.09, gain: 0.05 })
    beep(root * 1.5, { length: 0.11, gain: 0.045, delay: 0.075 })
  },
  newPerson() {
    beep(523, { length: 0.1, gain: 0.05 })
    beep(659, { length: 0.1, gain: 0.05, delay: 0.09 })
    beep(784, { length: 0.15, gain: 0.05, delay: 0.18 })
  },
  peak() {
    beep(784, { length: 0.09, gain: 0.055 })
    beep(988, { length: 0.09, gain: 0.05, delay: 0.08 })
    beep(1319, { length: 0.17, gain: 0.045, delay: 0.16 })
  },
  error() {
    beep(180, { length: 0.09, type: 'square', gain: 0.035 })
    beep(140, { length: 0.12, type: 'square', gain: 0.035, delay: 0.1 })
  },
  cameraOn() {
    beep(260, { to: 560, length: 0.22, type: 'sine', gain: 0.045 })
  },
  cameraOff() {
    beep(420, { to: 200, length: 0.2, type: 'sine', gain: 0.04 })
  },
  faceFound() {
    beep(1180, { length: 0.06, type: 'sine', gain: 0.02 })
  },
}

function renderSound() {
  const button = byId('sound')
  if (!button) return
  const on = view.settings.sound === true
  button.textContent = on ? 'Sound on' : 'Sound off'
  button.setAttribute('aria-pressed', on ? 'true' : 'false')
}

/* ---------- charts ---------- */

let chartSeq = 0

/**
 * A 0..100 line chart of one or more histories: the raw readings faint, the smoothed line bold over a soft fill, time
 * along the bottom, and a readout of the nearest reading under the pointer. The aria-label carries the same summary as
 * text, so the chart is not a picture with no content.
 */
function drawChart(container, series, options = {}) {
  container.replaceChildren()
  const all = series.flatMap((item) => item.points)
  if (all.length === 0) {
    container.append(element('p', 'empty', options.empty ?? 'Nothing to chart yet.'))
    return
  }
  const width = Math.max(240, Math.round(container.clientWidth || 340))
  const height = options.height ?? 190
  const pad = { left: 32, right: 12, top: 12, bottom: 22 }
  const plotWidth = Math.max(40, width - pad.left - pad.right)
  const plotHeight = height - pad.top - pad.bottom
  const from = Math.min(...all.map((point) => point.at))
  const to = Math.max(...all.map((point) => point.at))
  const span = Math.max(1, to - from)
  const x = (at) => pad.left + ((at - from) / span) * plotWidth
  const y = (value) => pad.top + (1 - Math.min(100, Math.max(0, value)) / 100) * plotHeight
  const seq = (chartSeq += 1)
  const scores = all.map((point) => point.score)
  const summary =
    `${series.map((item) => item.name).join(' and ')}: ${all.length} readings from ${when(from)} to ${when(to)}, ` +
    `between ${score1(Math.min(...scores))} and ${score1(Math.max(...scores))} weirdness.`
  const root = svgNode('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': summary })
  const defs = svgNode('defs', {})

  for (const level of [0, 25, 50, 75, 100]) {
    root.append(
      svgNode('line', {
        x1: pad.left,
        x2: pad.left + plotWidth,
        y1: y(level),
        y2: y(level),
        stroke: 'currentColor',
        'stroke-opacity': level === 0 ? 0.32 : 0.1,
        'stroke-width': 1,
      }),
    )
    const label = svgNode('text', {
      x: pad.left - 7,
      y: y(level) + 3.5,
      'text-anchor': 'end',
      'font-size': 9,
      fill: 'currentColor',
      'fill-opacity': 0.5,
    })
    label.textContent = String(level)
    root.append(label)
  }

  series.forEach((item, index) => {
    if (item.points.length === 0) return
    const points = [...item.points].sort((a, b) => a.at - b.at)
    const smooth = movingAverage(points, 5)
    const gradientId = `weirdness-fill-${seq}-${index}`
    const gradient = svgNode('linearGradient', { id: gradientId, x1: 0, y1: 0, x2: 0, y2: 1 })
    gradient.append(
      svgNode('stop', { offset: '0%', 'stop-color': item.color, 'stop-opacity': 0.26 }),
      svgNode('stop', { offset: '100%', 'stop-color': item.color, 'stop-opacity': 0 }),
    )
    defs.append(gradient)
    const line = smooth.map((point, order) => `${order === 0 ? 'M' : 'L'}${x(point.at).toFixed(1)} ${y(point.score).toFixed(1)}`).join(' ')
    const area = `${line} L${x(smooth[smooth.length - 1].at).toFixed(1)} ${y(0).toFixed(1)} L${x(smooth[0].at).toFixed(1)} ${y(0).toFixed(1)} Z`
    if (series.length === 1) root.append(svgNode('path', { d: area, fill: `url(#${gradientId})`, stroke: 'none' }))
    root.append(
      svgNode('polyline', {
        points: points.map((point) => `${x(point.at).toFixed(1)},${y(point.score).toFixed(1)}`).join(' '),
        fill: 'none',
        stroke: item.color,
        'stroke-width': 1.1,
        'stroke-opacity': 0.28,
        'stroke-linejoin': 'round',
      }),
    )
    root.append(
      svgNode('path', {
        d: line,
        fill: 'none',
        stroke: item.color,
        'stroke-width': 2.1,
        'stroke-linejoin': 'round',
        'stroke-linecap': 'round',
      }),
    )
    const last = smooth[smooth.length - 1]
    root.append(
      svgNode('circle', { cx: x(last.at), cy: y(last.score), r: 4.5, fill: item.color, 'fill-opacity': 0.18 }),
      svgNode('circle', { cx: x(last.at), cy: y(last.score), r: 2.6, fill: item.color, stroke: 'currentColor', 'stroke-width': 1.2 }),
    )
  })

  const firstLabel = svgNode('text', { x: pad.left, y: height - 4, 'font-size': 9, fill: 'currentColor', 'fill-opacity': 0.5 })
  firstLabel.textContent = when(from)
  root.append(firstLabel)
  if (span > 60_000 && plotWidth > 230) {
    const middleLabel = svgNode('text', {
      x: pad.left + plotWidth / 2,
      y: height - 4,
      'text-anchor': 'middle',
      'font-size': 9,
      fill: 'currentColor',
      'fill-opacity': 0.4,
    })
    middleLabel.textContent = when(from + span / 2)
    root.append(middleLabel)
  }
  const lastLabel = svgNode('text', {
    x: pad.left + plotWidth,
    y: height - 4,
    'text-anchor': 'end',
    'font-size': 9,
    fill: 'currentColor',
    'fill-opacity': 0.5,
  })
  lastLabel.textContent = when(to)
  root.append(lastLabel, defs)

  const cursor = svgNode('line', {
    y1: pad.top,
    y2: pad.top + plotHeight,
    stroke: 'currentColor',
    'stroke-opacity': 0.3,
    'stroke-dasharray': '3 3',
    'stroke-width': 1,
  })
  cursor.style.opacity = '0'
  root.append(cursor)

  const tip = element('div', 'tip')
  const ordered = series
    .map((item) => ({ name: item.name, color: item.color, points: [...item.points].sort((a, b) => a.at - b.at) }))
    .filter((item) => item.points.length > 0)

  root.addEventListener('pointermove', (event) => {
    const rect = root.getBoundingClientRect()
    if (rect.width === 0) return
    const px = Math.min(pad.left + plotWidth, Math.max(pad.left, ((event.clientX - rect.left) / rect.width) * width))
    const at = from + ((px - pad.left) / plotWidth) * span
    const nearest = []
    for (const item of ordered) {
      let best = null
      for (const point of item.points) {
        if (best === null || Math.abs(point.at - at) < Math.abs(best.at - at)) best = point
      }
      if (best !== null) nearest.push({ ...item, point: best })
    }
    if (nearest.length === 0) return
    const spotlight = nearest.reduce((closest, item) => (item.point.at < closest.point.at ? item : closest), nearest[0])
    cursor.setAttribute('x1', x(spotlight.point.at))
    cursor.setAttribute('x2', x(spotlight.point.at))
    cursor.style.opacity = '1'
    tip.replaceChildren(element('span', 'tiptime', when(spotlight.point.at)))
    for (const item of nearest) {
      const line = element('div')
      if (series.length > 1) {
        const dot = element('i')
        dot.style.cssText = `display:inline-block;width:7px;height:7px;border-radius:2px;margin-right:5px;background:${item.color}`
        line.append(dot)
        line.append(document.createTextNode(`${item.name} `))
      }
      line.append(element('b', undefined, score1(item.point.score)))
      tip.append(line)
    }
    const topPoint = nearest.reduce((low, item) => (y(item.point.score) < y(low.point.score) ? item : low), nearest[0])
    tip.style.left = `${(x(spotlight.point.at) / width) * 100}%`
    tip.style.top = `${(y(topPoint.point.score) / height) * 100}%`
    tip.classList.add('on')
  })
  root.addEventListener('pointerleave', () => {
    cursor.style.opacity = '0'
    tip.classList.remove('on')
  })

  container.append(root, tip)
  if (series.length > 1) {
    const legend = element('div', 'legend')
    for (const item of series) {
      const chip = element('span')
      const dot = element('i')
      dot.style.background = item.color
      chip.append(dot, document.createTextNode(item.name))
      legend.append(chip)
    }
    container.append(legend)
  }
}

/** A person's history as a tiny line, the way the rail shows a shape without a chart. */
function sparkline(readings, band) {
  const points = readings.slice(-40).map(([at, score]) => ({ at, score }))
  const width = 46
  const height = 18
  const padding = 2
  const values = points.map((point) => point.score)
  let low = Math.min(...values)
  let high = Math.max(...values)
  // A flat history is a line through the middle, not a line on the floor.
  if (high - low < 1) {
    low -= 1
    high += 1
  }
  const span = Math.max(1, points[points.length - 1].at - points[0].at)
  const x = (at) => padding + ((at - points[0].at) / span) * (width - padding * 2)
  const y = (score) => height - padding - ((score - low) / (high - low)) * (height - padding * 2)
  const svg = svgNode('svg', { viewBox: `0 0 ${width} ${height}`, width, height, class: `spark band-${band}`, 'aria-hidden': 'true' })
  if (points.length === 1) {
    svg.append(svgNode('circle', { cx: width / 2, cy: y(points[0].score), r: 2, fill: 'currentColor' }))
    return svg
  }
  svg.append(
    svgNode('polyline', {
      points: points.map((point) => `${x(point.at).toFixed(1)},${y(point.score).toFixed(1)}`).join(' '),
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': 1.4,
      'stroke-linejoin': 'round',
      'stroke-linecap': 'round',
    }),
  )
  return svg
}

/* ---------- rendering ---------- */

function profileById(id) {
  return view.profiles.find((profile) => profile.id === id)
}

function latestAt(profile) {
  return profile.readings.length ? profile.readings[profile.readings.length - 1][0] : 0
}

function initial(name) {
  return (name || '?').trim().slice(0, 1).toUpperCase()
}

/** An avatar: the newest picture of that face, or the first letter when there is no picture yet. */
function avatarNode(profile) {
  const node = element('span', 'avatar')
  if (profile.avatar) node.style.backgroundImage = `url("${profile.avatar}")`
  else node.textContent = initial(profile.name)
  return node
}

function renderPeople() {
  peopleList.replaceChildren()
  peopleCount.textContent = String(view.profiles.length)
  if (view.profiles.length === 0) {
    peopleList.append(
      element('li', 'people-empty', 'No one yet. Start the camera and the first face becomes Person 1.'),
    )
    return
  }
  for (const profile of view.profiles) {
    const stats = trend(profile.readings)
    const band = bandOf(stats.count > 0 ? stats.last : 0)
    const selected = profile.id === view.selected
    const row = element('button', 'row')
    row.type = 'button'
    row.dataset.act = 'select'
    row.setAttribute('aria-pressed', selected ? 'true' : 'false')
    row.title = `Show ${profile.name}`
    row.append(avatarNode(profile))
    const who = element('span', 'who')
    who.append(
      element('span', 'pname', profile.name),
      element('span', 'pmeta', `${stats.count} capture${stats.count === 1 ? '' : 's'} · avg ${score1(stats.mean)}`),
    )
    row.append(who)
    if (profile.readings.length > 1) row.append(sparkline(profile.readings, band.key))
    row.append(element('span', `pscore band-${band.key}`, stats.count > 0 ? score1(stats.last) : '–'))

    const compare = document.createElement('input')
    compare.type = 'checkbox'
    compare.className = 'cmp'
    compare.dataset.act = 'compare'
    compare.checked = view.compare.has(profile.id)
    compare.setAttribute('aria-label', `Compare ${profile.name}`)
    compare.title = `Compare ${profile.name}`

    const item = element('li', `person${selected ? ' is-selected' : ''}`)
    item.dataset.id = profile.id
    item.append(row, compare)
    peopleList.append(item)
  }
}

function renderTabs() {
  const history = view.tab === 'history'
  const chosen = view.profiles.filter((profile) => view.compare.has(profile.id)).length
  compareCount.textContent = String(chosen)
  compareCount.hidden = chosen === 0
  tabHistory.setAttribute('aria-selected', history ? 'true' : 'false')
  tabCompare.setAttribute('aria-selected', history ? 'false' : 'true')
  tabHistory.tabIndex = history ? 0 : -1
  tabCompare.tabIndex = history ? -1 : 0
  panelHistory.hidden = !history
  panelCompare.hidden = history
}

function renderHeader(profile) {
  const disabled = profile === undefined
  renameInput.disabled = disabled
  renameInput.placeholder = disabled ? 'No one selected' : 'Name this person'
  if (document.activeElement !== renameInput) renameInput.value = profile ? profile.name : ''
  if (profile) {
    if (profile.avatar) {
      detailAvatar.style.backgroundImage = `url("${profile.avatar}")`
      detailAvatar.textContent = ''
    } else {
      detailAvatar.style.backgroundImage = ''
      detailAvatar.textContent = initial(profile.name)
    }
    detailMeta.textContent = profile.readings.length
      ? `${profile.readings.length} capture${profile.readings.length === 1 ? '' : 's'} · first seen ${when(profile.createdAt)}`
      : 'No readings yet.'
  } else {
    detailAvatar.style.backgroundImage = ''
    detailAvatar.textContent = '?'
    detailMeta.textContent = 'Capture a face to start the history.'
  }
  mergeSelect.replaceChildren(new Option(disabled ? 'Nothing to merge' : 'Merge into…', ''))
  for (const other of view.profiles) {
    if (other.id !== view.selected) mergeSelect.append(new Option(other.name, other.id))
  }
  mergeSelect.disabled = disabled || view.profiles.length < 2
  deleteButton.disabled = disabled
}

function renderHistory(profile) {
  statsBox.replaceChildren()
  if (profile === undefined) {
    statsBox.append(element('p', 'stats-empty', 'No one yet. Start the camera and the first face becomes Person 1.'))
    verdictLine.className = 'verdict-line'
    verdictHeadline.textContent = 'No readings yet'
    verdictDetail.textContent = 'A person appears here once a face has been captured.'
    const empty = element('p', 'empty', 'A line appears here after the first capture.')
    historyChart.replaceChildren(empty)
    return
  }
  const stats = trend(profile.readings)
  const tiles = [
    ['Latest', stats.count > 0 ? score1(stats.last) : '–'],
    ['Average', stats.count > 0 ? score1(stats.mean) : '–'],
    ['Peak', stats.count > 0 ? score1(stats.max) : '–'],
    ['Captures', String(stats.count)],
  ]
  for (const [label, value] of tiles) {
    const cell = element('div', 'stat')
    cell.append(element('dt', undefined, label), element('dd', undefined, value))
    statsBox.append(cell)
  }
  const verdict = describeTrend(stats)
  verdictLine.className = `verdict-line${verdict.tone === 'up' ? ' up' : verdict.tone === 'down' ? ' down' : ''}`
  verdictHeadline.textContent = verdict.headline
  verdictDetail.textContent = verdict.detail
  drawChart(
    historyChart,
    [
      {
        name: profile.name,
        color: PROFILE_COLOR,
        points: profile.readings.map(([at, score]) => ({ at, score })),
      },
    ],
    { height: 190, empty: 'A line appears here after the first capture.' },
  )
}

async function renderShots(profile) {
  shotsBox.replaceChildren()
  if (profile === undefined) {
    shotsHint.textContent = 'The newest 24 are kept'
    return
  }
  const id = profile.id
  let shots = []
  try {
    const response = await fetch(api(`api/profiles/${encodeURIComponent(id)}/shots?limit=12`))
    if (response.ok) shots = (await response.json()).shots
  } catch {
    shots = []
  }
  if (view.selected !== id) return
  shotsHint.textContent = shots.length === 0 ? 'The newest 24 are kept' : `${shots.length} of ${profile.readings.length}`
  if (shots.length === 0) {
    shotsBox.append(element('p', 'empty', 'No pictures kept yet. The newest 24 are kept, the rest age out.'))
    return
  }
  for (const shot of shots) {
    const figure = element('figure')
    const image = document.createElement('img')
    image.src = shot.shot
    image.alt = `${profile.name} at weirdness ${score1(shot.score)}`
    image.loading = 'lazy'
    figure.append(image, element('figcaption', undefined, `${score1(shot.score)} · ${when(shot.at)}`))
    shotsBox.append(figure)
  }
}

function renderCompare() {
  const chosen = view.profiles.filter((profile) => view.compare.has(profile.id))
  if (chosen.length === 0) {
    drawChart(compareChart, [], {
      empty: 'Tick the box beside two or more people in the list, and their lines appear here.',
    })
  } else {
    drawChart(
      compareChart,
      chosen.map((profile, index) => ({
        name: profile.name,
        color: COLORS[index % COLORS.length],
        points: profile.readings.map(([at, score]) => ({ at, score })),
      })),
      { height: 190 },
    )
  }

  compareTable.replaceChildren()
  if (view.profiles.length === 0) {
    compareTable.append(element('p', 'empty', 'Compare people once there are two of them.'))
    return
  }
  const rows = view.profiles
    .map((profile) => ({ profile, stats: trend(profile.readings) }))
    .sort((a, b) => b.stats.mean - a.stats.mean)
  const table = element('table')
  const head = element('thead')
  const headRow = element('tr')
  for (const label of ['Person', 'Average', 'Latest', 'Change', 'Captures']) {
    headRow.append(element('th', undefined, label))
  }
  head.append(headRow)
  const body = element('tbody')
  for (const { profile, stats } of rows) {
    const row = element('tr')
    if (profile.id === view.selected) row.className = 'is-selected'
    if (view.compare.has(profile.id)) row.style.background = 'var(--accent-soft)'
    row.append(
      element('td', undefined, profile.name),
      element('td', undefined, stats.count > 0 ? score1(stats.mean) : '–'),
      element('td', undefined, stats.count > 0 ? score1(stats.last) : '–'),
      element('td', undefined, stats.count > 1 ? signed(stats.change) : '–'),
      element('td', undefined, String(stats.count)),
    )
    body.append(row)
  }
  table.append(head, body)
  compareTable.append(table)
}

function renderFactors(parts) {
  factorsBox.replaceChildren()
  if (!parts || parts.length === 0) {
    driversHint.textContent = 'Waiting for a face'
    factorsBox.append(element('li', 'factors-empty', 'The eight measurements behind the number show up once a face is in view.'))
    return
  }
  driversHint.textContent = 'How far each one goes'
  const sorted = [...parts].sort((a, b) => b.share - a.share)
  sorted.forEach((part, index) => {
    const item = element('li', `factor${index < 3 ? ' top' : ''}`)
    const bar = element('i')
    bar.style.width = percent(part.value)
    const track = element('span', 'fbar')
    track.append(bar)
    item.title = `${part.label}: ${percent(part.value)} of the way to the top, ${Math.round(part.weight * 100)}% of the score`
    item.append(
      element('span', 'flabel', part.label),
      element('span', 'fval', percent(part.value)),
      track,
    )
    factorsBox.append(item)
  })
}

function renderSettings() {
  const interval = byId('interval')
  interval.value = String(view.settings.intervalSec)
  if (interval.value !== String(view.settings.intervalSec)) interval.value = '5'
  const threshold = byId('threshold')
  threshold.value = String(view.settings.matchThreshold)
  byId('threshold-out').textContent = view.settings.matchThreshold.toFixed(2)
  settingsHint.textContent = `${view.settings.intervalSec > 0 ? `every ${view.settings.intervalSec}s` : 'only by hand'} · same person under ${view.settings.matchThreshold.toFixed(2)} · sound ${view.settings.sound ? 'on' : 'off'}`
  renderSound()
}

function renderAll() {
  const profile = profileById(view.selected)
  renderPeople()
  renderSettings()
  renderTabs()
  renderHeader(profile)
  renderHistory(profile)
  if (profile === undefined) {
    view.shotsFor = null
    shotsBox.replaceChildren()
    shotsHint.textContent = 'The newest 24 are kept'
  } else if (view.shotsFor !== profile.id) {
    view.shotsFor = profile.id
    void renderShots(profile)
  }
  if (view.tab === 'compare') renderCompare()
}

/* ---------- selecting and editing people ---------- */

function selectProfile(id) {
  view.selected = id
  renderAll()
}

function setTab(tab) {
  view.tab = tab
  renderTabs()
  if (tab === 'compare') renderCompare()
  else renderHistory(profileById(view.selected))
}

async function rename(id, value) {
  const response = await fetch(api(`api/profiles/${encodeURIComponent(id)}/name`), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: value }),
  })
  const answer = await response.json().catch(() => ({}))
  if (!response.ok) {
    flash(answer.error || 'That name was refused.')
    renderHeader(profileById(id))
    return
  }
  const index = view.profiles.findIndex((profile) => profile.id === id)
  if (index >= 0) view.profiles[index] = answer.profile
  renderAll()
}

async function removeProfile(id) {
  const profile = profileById(id)
  if (profile === undefined) return
  personMenu.open = false
  if (!confirm(`Delete ${profile.name} and all ${profile.readings.length} of their readings?`)) return
  const response = await fetch(api(`api/profiles/${encodeURIComponent(id)}`), { method: 'DELETE' })
  if (!response.ok) {
    flash('That person could not be deleted.')
    return
  }
  view.profiles = view.profiles.filter((item) => item.id !== id)
  view.compare.delete(id)
  if (view.selected === id) view.selected = view.profiles[0] ? view.profiles[0].id : null
  view.shotsFor = null
  renderAll()
}

async function mergeProfile(from, into) {
  const source = profileById(from)
  const target = profileById(into)
  personMenu.open = false
  if (source === undefined || target === undefined) return
  if (!confirm(`Merge ${source.name} into ${target.name}? The readings move over and ${source.name} goes away.`)) {
    renderHeader(source)
    return
  }
  const response = await fetch(api(`api/profiles/${encodeURIComponent(from)}/merge`), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ into }),
  })
  const answer = await response.json().catch(() => ({}))
  if (!response.ok) {
    flash(answer.error || 'Those two could not be merged.')
    return
  }
  view.profiles = view.profiles.filter((profile) => profile.id !== from)
  const index = view.profiles.findIndex((profile) => profile.id === into)
  if (index >= 0) view.profiles[index] = answer.profile
  view.compare.delete(from)
  if (view.selected === from) view.selected = into
  view.shotsFor = null
  renderAll()
}

/* ---------- the camera and the face ---------- */

function sourceSize(source) {
  return {
    width: source.naturalWidth || source.videoWidth || 0,
    height: source.naturalHeight || source.videoHeight || 0,
  }
}

function ready(source) {
  if (source === photo) return photo.complete && photo.naturalWidth > 0
  return video.readyState >= 2 && video.videoWidth > 0
}

/** The ratios `score.js` reads out of a 68 point face. */
function featuresOf(landmarks) {
  const points = landmarks.positions
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)
  const meanOf = (indices) => {
    let x = 0
    let y = 0
    for (const index of indices) {
      x += points[index].x
      y += points[index].y
    }
    return { x: x / indices.length, y: y / indices.length }
  }
  const eyeWidth = (distance(points[36], points[39]) + distance(points[42], points[45])) / 2 || 1
  const eyeHeight =
    (distance(points[37], points[41]) + distance(points[38], points[40]) + distance(points[43], points[47]) + distance(points[44], points[46])) / 4
  const eyeRatio = eyeHeight / eyeWidth
  const mouthWidth = distance(points[48], points[54]) || 1
  const mouthRatio = distance(points[62], points[66]) / mouthWidth
  const cornerY = (points[48].y + points[54].y) / 2
  const lipY = (points[51].y + points[57].y) / 2
  const smile = (lipY - cornerY) / mouthWidth
  const leftEye = meanOf([36, 37, 38, 39, 40, 41])
  const rightEye = meanOf([42, 43, 44, 45, 46, 47])
  const leftBrow = meanOf([17, 18, 19, 20, 21])
  const rightBrow = meanOf([22, 23, 24, 25, 26])
  const brow = (Math.hypot(leftBrow.x - leftEye.x, leftBrow.y - leftEye.y) + Math.hypot(rightBrow.x - rightEye.x, rightBrow.y - rightEye.y)) / 2 / eyeWidth
  const roll = (Math.atan2(points[45].y - points[36].y, points[45].x - points[36].x) * 180) / Math.PI
  const middle = { x: (leftEye.x + rightEye.x) / 2, y: (leftEye.y + rightEye.y) / 2 }
  const interocular = distance(points[36], points[45]) || 1
  const yaw = (points[30].x - middle.x) / interocular
  // Asymmetry and the crooked mouth are measured after the head's roll is taken out, so a tilted head is a tilt, not a lopsided face.
  const angle = (-roll * Math.PI) / 180
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const straight = (point) => ({
    x: middle.x + (point.x - middle.x) * cos - (point.y - middle.y) * sin,
    y: middle.y + (point.x - middle.x) * sin + (point.y - middle.y) * cos,
  })
  const pairs = [
    [36, 45],
    [37, 44],
    [38, 43],
    [39, 42],
    [40, 47],
    [41, 46],
    [17, 26],
    [18, 25],
    [19, 24],
    [20, 23],
    [21, 22],
    [48, 54],
    [49, 53],
    [50, 52],
    [58, 56],
    [59, 55],
    [31, 35],
    [32, 34],
  ]
  let asymmetry = 0
  for (const [left, right] of pairs) {
    const a = straight(points[left])
    const b = straight(points[right])
    asymmetry += Math.hypot(a.x - (2 * middle.x - b.x), a.y - b.y)
  }
  asymmetry = asymmetry / pairs.length / interocular
  const skew = Math.abs(straight(points[48]).y - straight(points[54]).y) / mouthWidth
  return { eyeRatio, mouthRatio, smile, brow, roll, asymmetry, yaw, skew }
}

/** A square picture of the face, small enough to keep hundreds of. */
function thumbnail(source, box) {
  const size = 112
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const context = canvas.getContext('2d')
  const { width: sourceWidth, height: sourceHeight } = sourceSize(source)
  const grownWidth = Math.min(sourceWidth, box.width * 1.6)
  const grownHeight = Math.min(sourceHeight, box.height * 1.6)
  const left = Math.min(Math.max(0, box.x + box.width / 2 - grownWidth / 2), Math.max(0, sourceWidth - grownWidth))
  const top = Math.min(Math.max(0, box.y + box.height / 2 - grownHeight / 2), Math.max(0, sourceHeight - grownHeight))
  const scale = Math.max(size / grownWidth, size / grownHeight)
  const drawWidth = grownWidth * scale
  const drawHeight = grownHeight * scale
  context.drawImage(
    source,
    left,
    top,
    grownWidth,
    grownHeight,
    (size - drawWidth) / 2,
    (size - drawHeight) / 2,
    drawWidth,
    drawHeight,
  )
  return canvas.toDataURL('image/jpeg', 0.7)
}

function drawOverlay(result, source, mirror) {
  const rect = overlay.getBoundingClientRect()
  const ratio = Math.min(2, window.devicePixelRatio || 1)
  const width = Math.max(1, Math.round(rect.width))
  const height = Math.max(1, Math.round(rect.height))
  if (overlay.width !== Math.round(width * ratio) || overlay.height !== Math.round(height * ratio)) {
    overlay.width = Math.round(width * ratio)
    overlay.height = Math.round(height * ratio)
  }
  const context = overlay.getContext('2d')
  context.setTransform(ratio, 0, 0, ratio, 0, 0)
  context.clearRect(0, 0, width, height)
  if (!result) return
  const { width: sourceWidth, height: sourceHeight } = sourceSize(source)
  if (sourceWidth === 0 || sourceHeight === 0) return
  const scale = Math.min(width / sourceWidth, height / sourceHeight)
  const offsetX = (width - sourceWidth * scale) / 2
  const offsetY = (height - sourceHeight * scale) / 2
  const at = (point) => [offsetX + point.x * scale, offsetY + point.y * scale]
  context.save()
  // The camera picture is shown mirrored, like a mirror; the overlay follows it there.
  if (mirror) {
    context.translate(width, 0)
    context.scale(-1, 1)
  }
  const box = result.detection.box
  const [boxX, boxY] = at({ x: box.x, y: box.y })
  context.strokeStyle = 'rgba(124,140,255,.95)'
  context.lineWidth = 2
  context.strokeRect(boxX, boxY, box.width * scale, box.height * scale)
  context.fillStyle = 'rgba(255,255,255,.85)'
  for (const point of result.landmarks.positions) {
    const [x, y] = at(point)
    context.beginPath()
    context.arc(x, y, 1.5, 0, Math.PI * 2)
    context.fill()
  }
  context.restore()
}

function showLive(score) {
  const band = bandOf(score)
  readout.dataset.band = band.key
  readout.hidden = false
  liveScore.textContent = score1(score)
  liveVerdict.textContent = band.label
}

function hideLive() {
  readout.hidden = true
  readout.dataset.band = 'calm'
}

function handleDetection(result, source) {
  const mirror = view.mode === 'camera'
  drawOverlay(result, source, mirror)
  if (!result) {
    hideLive()
    view.lastFace = null
    hadFace = false
    snapButton.disabled = true
    renderFactors(null)
    setStatus(view.mode === 'photo' ? 'No face in that picture.' : 'No face in view. Face the camera, in good light.')
    return
  }
  if (!hadFace) {
    hadFace = true
    // A soft ping when a face arrives, at most once every ten seconds: flickering detection is not a chime.
    const now = Date.now()
    if (now - lastFaceSoundAt > 10_000) {
      lastFaceSoundAt = now
      sounds.faceFound()
    }
  }
  const features = featuresOf(result.landmarks)
  const verdict = weirdness(features)
  showLive(verdict.score)
  renderFactors(verdict.parts)
  view.lastFace = result
  snapButton.disabled = false
  const { width } = result.detection.box
  const { width: sourceWidth } = sourceSize(source)
  const share = sourceWidth > 0 ? width / sourceWidth : 0
  if (share < 0.16) {
    setStatus('Come closer: the face is too small to read well.')
  } else if (view.mode === 'photo') {
    setStatus('Face read from the picture. It is saved as a capture.')
  } else {
    setStatus(
      view.settings.intervalSec > 0
        ? `Watching: a capture every ${view.settings.intervalSec}s while a face is in view.`
        : 'Watching: captures only when you press the button or C.',
    )
  }
  const due = view.mode === 'camera' && view.settings.intervalSec > 0 && Date.now() - view.lastCaptureAt >= view.settings.intervalSec * 1000
  if (view.mode === 'photo' && view.capturePhoto) {
    view.capturePhoto = false
    void captureNow()
  } else if (due && share >= 0.16) {
    void captureNow()
  }
}

async function tick() {
  if (!view.running) return
  if (view.capturing) {
    scheduleTick(200)
    return
  }
  if (view.faceapi === null) {
    scheduleTick(300)
    return
  }
  const source = view.mode === 'photo' ? photo : video
  if (!ready(source)) {
    scheduleTick(250)
    return
  }
  // Every video frame asks for the next look; only every so often is there a detection, which is the expensive part.
  const now = performance.now()
  if (view.mode === 'camera' && now - lastDetectAt < 120) {
    scheduleTick(120)
    return
  }
  lastDetectAt = now
  let result = null
  try {
    result = await view.faceapi.detectSingleFace(source, view.options).withFaceLandmarks()
  } catch (error) {
    holdStatus(`Face reading stopped: ${describe(error)}`)
    view.running = false
    return
  }
  try {
    handleDetection(result, source)
  } catch (error) {
    holdStatus(`Face reading error: ${describe(error)}`)
  }
  scheduleTick(view.mode === 'photo' ? 1000 : 150)
}

async function captureNow() {
  if (view.capturing || view.faceapi === null) return
  const source = view.mode === 'photo' ? photo : video
  if (!ready(source)) return
  view.capturing = true
  view.lastCaptureAt = Date.now()
  setStatus('Reading the face…')
  try {
    const result = await view.faceapi.detectSingleFace(source, view.options).withFaceLandmarks().withFaceDescriptor()
    if (!result) {
      sounds.error()
      holdStatus('No face in view, so nothing was saved.')
      return
    }
    const features = featuresOf(result.landmarks)
    const descriptor = Array.from(result.descriptor)
    if (descriptor.length !== 128) {
      sounds.error()
      holdStatus('The face signature could not be read this time.')
      return
    }
    const response = await fetch(api('api/capture'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ features, descriptor, shot: thumbnail(source, result.detection.box) }),
    })
    const answer = await response.json().catch(() => ({}))
    if (!response.ok) {
      sounds.error()
      holdStatus(answer.error || 'The capture was refused.')
      return
    }
    applyCapture(answer)
  } catch (error) {
    sounds.error()
    holdStatus(`Capture failed: ${describe(error)}`)
  } finally {
    view.capturing = false
  }
}

function applyCapture(answer) {
  const previous = view.profiles.find((profile) => profile.id === answer.profile.id)
  const previousBest = previous === undefined ? 0 : previous.readings.reduce((best, [, score]) => Math.max(best, score), 0)
  const index = view.profiles.findIndex((profile) => profile.id === answer.profile.id)
  if (index >= 0) view.profiles[index] = answer.profile
  else view.profiles.push(answer.profile)
  view.profiles.sort((a, b) => latestAt(b) - latestAt(a))
  view.selected = answer.profile.id
  view.tab = 'history'
  view.shotsFor = null
  renderAll()
  const name = answer.profile.name
  // The sound says what the capture meant: a new face, a personal best, or just another reading of the same face.
  if (answer.created) sounds.newPerson()
  else if (answer.reading.score > previousBest + 0.05) sounds.peak()
  else sounds.capture(answer.reading.score)
  readout.animate?.(
    [
      { transform: 'scale(1)' },
      { transform: 'scale(1.06)' },
      { transform: 'scale(1)' },
    ],
    { duration: 260, easing: 'ease-out' },
  )
  flash(
    answer.created
      ? `A new face: ${name}, weirdness ${score1(answer.reading.score)}. Rename them on the right.`
      : `${name} again, weirdness ${score1(answer.reading.score)} (face distance ${answer.distance}).`,
  )
  holdStatus(`Saved ${score1(answer.reading.score)} weirdness for ${name}.`)
}

function startCamera() {
  if (view.stream !== null) {
    stopCamera()
    return
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    notice('This page cannot reach a camera: browsers give one only over https or on localhost.')
    return
  }
  startButton.disabled = true
  startLabel.textContent = 'Opening the camera…'
  photo.hidden = true
  video.hidden = false
  void (async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 960 }, facingMode: 'user' },
        audio: false,
      })
      view.stream = stream
      video.srcObject = stream
      await video.play()
      view.mode = 'camera'
      view.running = true
      view.lastCaptureAt = Date.now()
      placeholder.hidden = true
      startLabel.textContent = 'Stop camera'
      modeLabel.textContent = 'Recording'
      modeChip.hidden = false
      hadFace = false
      lastDetectAt = 0
      sounds.cameraOn()
      scheduleTick(0)
    } catch (error) {
      placeholder.hidden = false
      startLabel.textContent = 'Start camera'
      notice(`Camera: ${describe(error)}`)
      sounds.error()
    } finally {
      startButton.disabled = false
    }
  })()
}

function stopCamera() {
  const hadCamera = view.stream !== null
  if (view.stream !== null) {
    for (const track of view.stream.getTracks()) track.stop()
    view.stream = null
  }
  video.srcObject = null
  view.lastFace = null
  hadFace = false
  if (view.mode === 'camera') view.mode = null
  if (view.mode !== 'photo') view.running = false
  stopTicking()
  hideLive()
  modeChip.hidden = true
  placeholder.hidden = false
  drawOverlay(null, video, false)
  renderFactors(null)
  notice('Camera off. Start the camera, or pick a photo, to read a face.')
  startLabel.textContent = 'Start camera'
  snapButton.disabled = true
  if (hadCamera) sounds.cameraOff()
}

async function usePhoto(file) {
  stopCamera()
  view.lastFace = null
  const url = URL.createObjectURL(file)
  photo.src = url
  try {
    await photo.decode()
  } catch (error) {
    notice(`That file could not be opened: ${describe(error)}`)
    return
  }
  video.hidden = true
  photo.hidden = false
  placeholder.hidden = true
  view.mode = 'photo'
  view.running = true
  view.capturePhoto = true
  modeLabel.textContent = 'Reading a photo'
  modeChip.hidden = false
  snapButton.disabled = false
  lastDetectAt = 0
  scheduleTick(0)
  // The blob URL is not needed once the picture has been decoded into the element.
  setTimeout(() => URL.revokeObjectURL(url), 10000)
}

/* ---------- settings ---------- */

async function saveSettings(patch) {
  Object.assign(view.settings, patch)
  renderSettings()
  const response = await fetch(api('api/settings'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  })
  if (!response.ok) {
    flash('That setting was refused.')
    return
  }
  const answer = await response.json()
  view.settings = answer.settings
  renderSettings()
  if (view.mode === 'camera' && view.running) {
    setStatus(
      view.settings.intervalSec > 0
        ? `Watching: a capture every ${view.settings.intervalSec}s while a face is in view.`
        : 'Watching: captures only when you press the button or C.',
    )
  }
}

/* ---------- boot ---------- */

async function loadState() {
  const response = await fetch(api('api/state'))
  if (!response.ok) {
    setStatus('The tracker could not read its own state.')
    return
  }
  const data = await response.json()
  view.settings = data.settings
  view.profiles = data.profiles
  view.selected = view.profiles.length ? view.profiles[0].id : null
  renderAll()
}

async function loadModels() {
  modelChip.textContent = 'Loading face models…'
  modelChip.hidden = false
  setStatus('Loading the face models (8 MB, kept on this machine)…')
  try {
    const faceapi = await import('./vendor/face-api.js')
    const models = new URL('vendor/model', base).href
    await faceapi.nets.tinyFaceDetector.loadFromUri(models)
    await faceapi.nets.faceLandmark68Net.loadFromUri(models)
    await faceapi.nets.faceRecognitionNet.loadFromUri(models)
    view.faceapi = faceapi
    view.options = new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.4 })
    modelChip.hidden = true
    startButton.disabled = false
    startLabel.textContent = 'Start camera'
    setStatus('Point the camera at a face to begin.')
  } catch (error) {
    modelChip.textContent = 'Face models failed'
    startLabel.textContent = 'Camera unavailable'
    setStatus(`The face models could not be loaded: ${describe(error)}. Reload the page to try again.`)
  }
}

/* ---------- the things a person does ---------- */

peopleList.addEventListener('click', (event) => {
  const target = event.target
  if (!(target instanceof Element)) return
  const row = target.closest('.person')
  if (!row) return
  if (target.closest('input')) return
  selectProfile(row.dataset.id)
})

peopleList.addEventListener('change', (event) => {
  const target = event.target
  if (!(target instanceof Element)) return
  if (target.dataset.act !== 'compare') return
  const row = target.closest('.person')
  if (!row) return
  const id = row.dataset.id
  if (target.checked) view.compare.add(id)
  else view.compare.delete(id)
  renderTabs()
  if (view.tab === 'compare') renderCompare()
})

byId('start').addEventListener('click', () => {
  startCamera()
})
byId('snap').addEventListener('click', () => {
  void captureNow()
})
byId('file').addEventListener('change', (event) => {
  const file = event.target.files && event.target.files[0]
  if (file) void usePhoto(file)
})
byId('sound').addEventListener('click', () => {
  // This click is the gesture a browser needs before it will make a sound.
  audioContext()
  const on = view.settings.sound !== true
  void saveSettings({ sound: on })
  if (on) sounds.capture(30)
})
document.addEventListener(
  'pointerdown',
  () => {
    audioContext()
  },
  { once: true },
)
byId('interval').addEventListener('change', (event) => {
  void saveSettings({ intervalSec: Number(event.target.value) })
})
byId('threshold').addEventListener('input', (event) => {
  byId('threshold-out').textContent = Number(event.target.value).toFixed(2)
})
byId('threshold').addEventListener('change', (event) => {
  void saveSettings({ matchThreshold: Number(event.target.value) })
})

renameInput.addEventListener('change', () => {
  if (view.selected === null) return
  const name = renameInput.value.trim()
  if (name === '' || profileById(view.selected)?.name === name) {
    renderHeader(profileById(view.selected))
    return
  }
  void rename(view.selected, name)
})
renameInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') renameInput.blur()
})

mergeSelect.addEventListener('change', () => {
  const into = mergeSelect.value
  if (view.selected === null || into === '') return
  void mergeProfile(view.selected, into)
})
deleteButton.addEventListener('click', () => {
  if (view.selected !== null) void removeProfile(view.selected)
})

tabHistory.addEventListener('click', () => {
  setTab('history')
})
tabCompare.addEventListener('click', () => {
  setTab('compare')
})
for (const tab of [tabHistory, tabCompare]) {
  tab.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') return
    event.preventDefault()
    const next = tab === tabHistory ? tabCompare : tabHistory
    setTab(next === tabCompare ? 'compare' : 'history')
    next.focus()
  })
}
byId('compare-hint').addEventListener('click', () => {
  setTab('compare')
  tabCompare.focus()
})
document.addEventListener('click', (event) => {
  const target = event.target
  if (!(target instanceof Element)) return
  if (personMenu.open && !personMenu.contains(target)) personMenu.open = false
})

document.addEventListener('keydown', (event) => {
  if (event.key !== 'c' && event.key !== 'C') return
  if (event.metaKey || event.ctrlKey || event.altKey) return
  const target = event.target
  if (target instanceof Element && target.closest('input, select, textarea, [contenteditable]')) return
  if (snapButton.disabled || view.capturing) return
  event.preventDefault()
  void captureNow()
})

let resizeTimer = 0
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer)
  resizeTimer = setTimeout(() => {
    renderHistory(profileById(view.selected))
    if (view.tab === 'compare') renderCompare()
  }, 150)
})

renderFactors(null)
try {
  await loadState()
} catch (error) {
  setStatus(`The tracker could not read its readings: ${describe(error)}`)
}
await loadModels()

