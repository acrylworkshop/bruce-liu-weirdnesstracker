/**
 * The tracker's browser side: the camera, the face reading, the capture and the charts.
 *
 * face-api (vendored in `assets/`, MIT) finds a face in the camera picture, reads its 68 landmarks and, on a capture,
 * computes the 128 number descriptor that identifies the person. The browser scores the live picture with the same
 * `score.js` the server records with, so the number on the badge is the number that gets saved.
 *
 * Every URL here is resolved against `base`, this page's own address with a trailing slash, so the same code works at
 * `/weirdness` on the app's own server and at `/app/weirdness` in the ACRYL frame.
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
const badge = byId('badge')
const liveScore = byId('live-score')
const noticeBox = byId('notice')
const statusLine = byId('status')
const flashBox = byId('flash')
const peopleList = byId('people')
const statsBox = byId('stats')
const historyChart = byId('history-chart')
const compareChart = byId('compare-chart')
const compareTable = byId('compare-table')
const shotsBox = byId('shots')
const factorsBox = byId('factors')
const historyTitle = byId('history-title')

const COLORS = ['#7c8cff', '#4dd4ac', '#ffd166', '#ff8fab', '#a78bfa', '#66c2ff']

const view = {
  settings: { intervalSec: 5, matchThreshold: 0.6 },
  profiles: [],
  selected: null,
  compare: new Set(),
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
  }, 6000)
}

const score1 = (value) => (Number.isFinite(value) ? value.toFixed(1) : '0.0')
const percent = (value) => `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%`

function when(at) {
  return new Date(at).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function describe(error) {
  const name = error && error.name ? error.name : ''
  if (name === 'NotAllowedError') return 'the camera was refused. Allow it in the browser bar, then press Start camera again.'
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return 'no camera was found on this machine.'
  if (name === 'NotReadableError') return 'the camera is busy in another app.'
  if (name === 'OverconstrainedError') return 'the camera cannot do the size asked for.'
  return (error && error.message) || String(error)
}

/* ---------- charts ---------- */

const SVG = 'http://www.w3.org/2000/svg'

function svgNode(tag, attributes) {
  const node = document.createElementNS(SVG, tag)
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value))
  return node
}

/** A 0..100 line chart of one or more histories: the raw readings faint, the smoothed line bold, time along the bottom. */
function drawChart(container, series, height = 170) {
  container.replaceChildren()
  const points = series.flatMap((item) => item.points)
  if (points.length === 0) {
    container.append(element('p', 'empty', 'Nothing to chart yet.'))
    return
  }
  const width = Math.max(260, Math.round(container.clientWidth || 320))
  const pad = { left: 30, right: 6, top: 8, bottom: 18 }
  const plotWidth = width - pad.left - pad.right
  const plotHeight = height - pad.top - pad.bottom
  const from = Math.min(...points.map((point) => point.at))
  const to = Math.max(...points.map((point) => point.at))
  const span = Math.max(1, to - from)
  const x = (at) => pad.left + ((at - from) / span) * plotWidth
  const y = (score) => pad.top + (1 - Math.min(100, Math.max(0, score)) / 100) * plotHeight

  const root = svgNode('svg', {
    viewBox: `0 0 ${width} ${height}`,
    width,
    height,
    role: 'img',
    'aria-label': `Weirdness over time for ${series.map((item) => item.name).join(', ')}`,
  })
  for (const level of [0, 25, 50, 75, 100]) {
    root.append(
      svgNode('line', {
        x1: pad.left,
        x2: pad.left + plotWidth,
        y1: y(level),
        y2: y(level),
        stroke: 'currentColor',
        'stroke-opacity': level === 0 ? 0.35 : 0.12,
        'stroke-width': 1,
      }),
    )
    const label = svgNode('text', {
      x: pad.left - 6,
      y: y(level) + 3.5,
      'text-anchor': 'end',
      'font-size': 9,
      fill: 'currentColor',
      'fill-opacity': 0.55,
    })
    label.textContent = String(level)
    root.append(label)
  }
  for (const item of series) {
    if (item.points.length === 0) continue
    const path = item.points.map((point) => `${x(point.at).toFixed(1)},${y(point.score).toFixed(1)}`)
    root.append(
      svgNode('polyline', {
        points: path.join(' '),
        fill: 'none',
        stroke: item.color,
        'stroke-width': 1.25,
        'stroke-opacity': 0.35,
        'stroke-linejoin': 'round',
      }),
    )
    const smooth = movingAverage(item.points, 5)
    root.append(
      svgNode('polyline', {
        points: smooth.map((point) => `${x(point.at).toFixed(1)},${y(point.score).toFixed(1)}`).join(' '),
        fill: 'none',
        stroke: item.color,
        'stroke-width': 2.2,
        'stroke-linejoin': 'round',
        'stroke-linecap': 'round',
      }),
    )
    if (item.points.length === 1) {
      root.append(svgNode('circle', { cx: x(item.points[0].at), cy: y(item.points[0].score), r: 3, fill: item.color }))
    }
  }
  const firstLabel = svgNode('text', {
    x: pad.left,
    y: height - 3,
    'font-size': 9,
    fill: 'currentColor',
    'fill-opacity': 0.55,
  })
  firstLabel.textContent = when(from)
  const lastLabel = svgNode('text', {
    x: pad.left + plotWidth,
    y: height - 3,
    'text-anchor': 'end',
    'font-size': 9,
    fill: 'currentColor',
    'fill-opacity': 0.55,
  })
  lastLabel.textContent = when(to)
  root.append(firstLabel, lastLabel)
  container.append(root)

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

/* ---------- rendering ---------- */

function profileById(id) {
  return view.profiles.find((profile) => profile.id === id)
}

function latest(profile) {
  return profile.readings.length ? profile.readings[profile.readings.length - 1][0] : 0
}

function renderPeople() {
  const focused = document.activeElement
  if (focused && focused.classList && focused.classList.contains('name')) return
  peopleList.replaceChildren()
  if (view.profiles.length === 0) {
    peopleList.append(element('li', 'empty', 'No one yet. Start the camera and the first face becomes Person 1.'))
    return
  }
  for (const profile of view.profiles) {
    const stats = trend(profile.readings)
    const row = element('li', 'person' + (profile.id === view.selected ? ' active' : ''))
    row.dataset.id = profile.id

    const pick = element('label', 'pick')
    pick.title = 'Overlay this person in the comparison'
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.dataset.act = 'compare'
    box.checked = view.compare.has(profile.id)
    box.setAttribute('aria-label', `Compare ${profile.name}`)
    pick.append(box)

    const body = element('div')
    const name = document.createElement('input')
    name.className = 'name'
    name.value = profile.name
    name.dataset.act = 'name'
    name.maxLength = 40
    name.setAttribute('aria-label', 'Name of this person')
    const meta = element(
      'span',
      'meta',
      `${stats.count} capture${stats.count === 1 ? '' : 's'} · average ${score1(stats.mean)} · latest ${score1(stats.last)}`,
    )
    body.append(name, meta)

    const merge = document.createElement('select')
    merge.className = 'merge'
    merge.dataset.act = 'merge'
    merge.setAttribute('aria-label', `Merge ${profile.name} into another person`)
    merge.append(new Option('Merge into…', ''))
    for (const other of view.profiles) {
      if (other.id !== profile.id) merge.append(new Option(other.name, other.id))
    }

    const drop = element('button', 'drop', '×')
    drop.dataset.act = 'delete'
    drop.title = `Delete ${profile.name} and their readings`

    row.append(pick, body, merge, drop)
    peopleList.append(row)
  }
}

function renderStats() {
  statsBox.replaceChildren()
  const profile = profileById(view.selected)
  if (profile === undefined) {
    statsBox.append(element('div', 'empty', 'A person appears here once a face has been captured.'))
    historyTitle.textContent = 'History'
    historyChart.replaceChildren()
    return
  }
  historyTitle.textContent = `History · ${profile.name}`
  const stats = trend(profile.readings)
  const verdict =
    stats.count < 2
      ? 'one reading so far'
      : stats.slopePerDay > 0.2
        ? `getting weirder by ${score1(stats.slopePerDay)} points a day`
        : stats.slopePerDay < -0.2
          ? `calming down by ${score1(Math.abs(stats.slopePerDay))} points a day`
          : 'holding steady'
  const rows = [
    ['Latest', score1(stats.last)],
    ['Average', score1(stats.mean)],
    ['Peak', score1(stats.max)],
    ['Total points', score1(stats.total)],
    ['Captures', String(stats.count)],
    ['Change a day', `${stats.slopePerDay > 0 ? '+' : ''}${score1(stats.slopePerDay)}`],
    ['Since first', `${stats.change > 0 ? '+' : ''}${score1(stats.change)}`],
    ['Trend', `${verdict} (fit ${stats.r2.toFixed(2)})`],
    ['Covering', `${stats.spanDays.toFixed(1)} days`],
  ]
  for (const [label, value] of rows) {
    const cell = element('div')
    cell.append(element('dt', undefined, label), element('dd', undefined, value))
    statsBox.append(cell)
  }
  drawChart(historyChart, [
    { name: profile.name, color: COLORS[0], points: profile.readings.map(([at, score]) => ({ at, score })) },
  ])
}

function renderCompare() {
  for (const id of [...view.compare]) {
    if (profileById(id) === undefined) view.compare.delete(id)
  }
  const chosen = view.profiles.filter((profile) => view.compare.has(profile.id))
  const selected = profileById(view.selected)
  const shown = chosen.length > 0 ? chosen : selected === undefined ? [] : [selected]
  drawChart(
    compareChart,
    shown.map((profile, index) => ({
      name: profile.name,
      color: COLORS[index % COLORS.length],
      points: profile.readings.map(([at, score]) => ({ at, score })),
    })),
  )

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
  for (const label of ['Person', 'Average', 'Latest', 'A day', 'Since first']) {
    headRow.append(element('th', undefined, label))
  }
  head.append(headRow)
  const body = element('tbody')
  for (const { profile, stats } of rows) {
    const row = element('tr')
    const nameCell = element('td', undefined, profile.name)
    if (profile.id === view.selected) nameCell.style.color = 'var(--accent)'
    row.append(
      nameCell,
      element('td', undefined, score1(stats.mean)),
      element('td', undefined, score1(stats.last)),
      element('td', undefined, `${stats.slopePerDay > 0 ? '+' : ''}${score1(stats.slopePerDay)}`),
      element('td', undefined, `${stats.change > 0 ? '+' : ''}${score1(stats.change)}`),
    )
    body.append(row)
  }
  table.append(head, body)
  compareTable.append(table)
}

function renderFactors(parts) {
  factorsBox.replaceChildren()
  if (!parts) return
  for (const part of parts) {
    const card = element('div', 'factor')
    const bar = element('i')
    bar.style.width = percent(part.value)
    card.append(element('b', undefined, part.label), bar, element('em', undefined, percent(part.value)))
    factorsBox.append(card)
  }
}

async function renderShots() {
  const profile = profileById(view.selected)
  shotsBox.replaceChildren()
  if (profile === undefined) return
  let shots = []
  try {
    const response = await fetch(api(`api/profiles/${encodeURIComponent(profile.id)}/shots?limit=12`))
    if (response.ok) shots = (await response.json()).shots
  } catch {
    shots = []
  }
  if (shots.length === 0) {
    shotsBox.append(element('p', 'empty', 'No pictures yet (the newest 24 are kept, the rest age out).'))
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

function renderAll() {
  renderPeople()
  renderStats()
  renderCompare()
  renderShots()
}

function renderSettings() {
  const interval = byId('interval')
  interval.value = String(view.settings.intervalSec)
  if (interval.value !== String(view.settings.intervalSec)) interval.value = '5'
  const threshold = byId('threshold')
  threshold.value = String(view.settings.matchThreshold)
  byId('threshold-out').textContent = view.settings.matchThreshold.toFixed(2)
}

/* ---------- profiles ---------- */

function selectProfile(id) {
  view.selected = id
  renderAll()
}

async function rename(id, value) {
  const response = await fetch(api(`api/profiles/${encodeURIComponent(id)}/name`), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: value }),
  })
  const answer = await response.json().catch(() => ({}))
  if (!response.ok) {
    flash(answer.error || 'The name was refused.')
    return
  }
  const index = view.profiles.findIndex((profile) => profile.id === id)
  if (index >= 0) view.profiles[index] = answer.profile
  renderAll()
}

async function removeProfile(id) {
  const profile = profileById(id)
  if (profile === undefined) return
  if (!confirm(`Delete ${profile.name} and all ${profile.readings.length} of their readings?`)) return
  const response = await fetch(api(`api/profiles/${encodeURIComponent(id)}`), { method: 'DELETE' })
  if (!response.ok) {
    flash('That person could not be deleted.')
    return
  }
  view.profiles = view.profiles.filter((item) => item.id !== id)
  view.compare.delete(id)
  if (view.selected === id) view.selected = view.profiles[0] ? view.profiles[0].id : null
  renderAll()
}

async function mergeProfile(from, into) {
  const source = profileById(from)
  const target = profileById(into)
  if (source === undefined || target === undefined) return
  if (!confirm(`Merge ${source.name} into ${target.name}? The readings move over and ${source.name} goes away.`)) {
    renderPeople()
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

function handleDetection(result, source) {
  const mirror = view.mode === 'camera'
  drawOverlay(result, source, mirror)
  if (!result) {
    badge.hidden = true
    view.lastFace = null
    byId('snap').disabled = true
    renderFactors(null)
    setStatus(view.mode === 'photo' ? 'No face in that picture.' : 'No face in view. Face the camera, in good light.')
    return
  }
  const features = featuresOf(result.landmarks)
  const verdict = weirdness(features)
  badge.hidden = false
  liveScore.textContent = score1(verdict.score)
  renderFactors(verdict.top)
  view.lastFace = result
  byId('snap').disabled = false
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
        : 'Watching: captures only when you press the button.',
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
  setStatus('Reading the face...')
  try {
    const result = await view.faceapi.detectSingleFace(source, view.options).withFaceLandmarks().withFaceDescriptor()
    if (!result) {
      holdStatus('No face in view, so nothing was saved.')
      return
    }
    const features = featuresOf(result.landmarks)
    const descriptor = Array.from(result.descriptor)
    if (descriptor.length !== 128) {
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
      holdStatus(answer.error || 'The capture was refused.')
      return
    }
    applyCapture(answer)
  } catch (error) {
    holdStatus(`Capture failed: ${describe(error)}`)
  } finally {
    view.capturing = false
  }
}

function applyCapture(answer) {
  const index = view.profiles.findIndex((profile) => profile.id === answer.profile.id)
  if (index >= 0) view.profiles[index] = answer.profile
  else view.profiles.push(answer.profile)
  view.profiles.sort((a, b) => latest(b) - latest(a))
  view.selected = answer.profile.id
  renderAll()
  const name = answer.profile.name
  flash(
    answer.created
      ? `A new face: ${name}, weirdness ${score1(answer.reading.score)}. Rename them in the list.`
      : `${name} again, weirdness ${score1(answer.reading.score)} (face distance ${answer.distance}).`,
  )
  holdStatus(`Saved ${score1(answer.reading.score)} weirdness for ${name}.`)
}

async function startCamera() {
  if (view.stream !== null) {
    stopCamera()
    return
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    notice('This page cannot reach a camera: browsers give one only over https or on localhost.')
    return
  }
  byId('start').disabled = true
  photo.hidden = true
  video.hidden = false
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
    notice('Camera on. Make a face.')
    byId('start').textContent = 'Stop camera'
    lastDetectAt = 0
    scheduleTick(0)
  } catch (error) {
    notice(`Camera: ${describe(error)}`)
  } finally {
    byId('start').disabled = false
  }
}

function stopCamera() {
  if (view.stream !== null) {
    for (const track of view.stream.getTracks()) track.stop()
    view.stream = null
  }
  video.srcObject = null
  view.lastFace = null
  if (view.mode === 'camera') view.mode = null
  if (view.mode !== 'photo') view.running = false
  stopTicking()
  badge.hidden = true
  drawOverlay(null, video, false)
  renderFactors(null)
  notice('Camera off')
  byId('start').textContent = 'Start camera'
  byId('snap').disabled = true
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
  view.mode = 'photo'
  view.running = true
  view.capturePhoto = true
  notice('Reading the picture...')
  byId('start').textContent = 'Start camera'
  byId('snap').disabled = false
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
  renderSettings()
  renderAll()
}

async function loadModels() {
  notice('Loading the face models (8 MB, kept on this machine)...')
  const faceapi = await import('./vendor/face-api.js')
  const models = new URL('vendor/model', base).href
  await faceapi.nets.tinyFaceDetector.loadFromUri(models)
  await faceapi.nets.faceLandmark68Net.loadFromUri(models)
  await faceapi.nets.faceRecognitionNet.loadFromUri(models)
  view.faceapi = faceapi
  view.options = new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.4 })
  notice('Face models ready. Press Start camera, or pick a photo.')
  setStatus('Point the camera at a face to begin.')
}

peopleList.addEventListener('click', (event) => {
  const target = event.target
  if (!(target instanceof Element)) return
  const row = target.closest('.person')
  if (!row) return
  if (target.closest('input, select, button')) return
  selectProfile(row.dataset.id)
})

peopleList.addEventListener('change', (event) => {
  const target = event.target
  if (!(target instanceof Element)) return
  const row = target.closest('.person')
  if (!row) return
  const id = row.dataset.id
  if (target.dataset.act === 'compare') {
    if (target.checked) view.compare.add(id)
    else view.compare.delete(id)
    renderCompare()
  } else if (target.dataset.act === 'name') {
    void rename(id, target.value)
  } else if (target.dataset.act === 'merge') {
    if (target.value !== '') void mergeProfile(id, target.value)
  }
})

peopleList.addEventListener('click', (event) => {
  const target = event.target
  if (!(target instanceof Element)) return
  const drop = target.closest('button[data-act=delete]')
  if (!drop) return
  const row = drop.closest('.person')
  if (row) void removeProfile(row.dataset.id)
})

byId('start').addEventListener('click', () => {
  void startCamera()
})
byId('snap').addEventListener('click', () => {
  void captureNow()
})
byId('file').addEventListener('change', (event) => {
  const file = event.target.files && event.target.files[0]
  if (file) void usePhoto(file)
})
byId('interval').addEventListener('change', (event) => {
  void saveSettings({ intervalSec: Number(event.target.value) })
})
byId('threshold').addEventListener('input', (event) => {
  byId('threshold-out').textContent = Number(event.target.value).toFixed(2)
})
byId('threshold').addEventListener('change', (event) => {
  void saveSettings({ matchThreshold: Number(event.target.value) })
})

let resizeTimer = 0
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer)
  resizeTimer = setTimeout(() => {
    renderStats()
    renderCompare()
  }, 150)
})

try {
  await loadState()
} catch (error) {
  setStatus(`The tracker could not read its readings: ${describe(error)}`)
}
try {
  await loadModels()
} catch (error) {
  notice(`The face models could not be loaded: ${describe(error)}`)
  setStatus('Reload the page to try the face models again.')
}
