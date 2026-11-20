/**
 * The weirdness math: one implementation, used twice.
 *
 * The browser imports this file to show a live score while the camera runs, and the plugin's server imports it to compute
 * the number it records, so the two can never disagree. Everything here is plain arithmetic on numbers a captured face
 * yields, which is why it is a `.js` module with its types beside it in `score.d.ts` instead of a `.ts` one: a browser
 * cannot run TypeScript, and the app has no build step.
 *
 * A face yields 8 features, each a ratio of the face's own geometry (so a nearby face and a distant one score the same):
 *   eyeRatio  - eye height / eye width (about 0.27 for open, relaxed eyes)
 *   mouthRatio- inner mouth height / mouth width (near 0 with the mouth shut)
 *   smile     - mouth corner height above the lip centre, / mouth width (signed: positive is a grin)
 *   brow      - brow to eye distance / eye width
 *   roll      - head tilt in degrees, the line through the eyes against the horizon
 *   asymmetry - how far the face is from its own mirror image, / the distance between the eye centres
 *   yaw       - nose tip sideways from the eye centre, / the distance between the eye centres
 *   skew      - one mouth corner higher than the other, / mouth width
 *
 * Each feature becomes a 0..1 "part" (0 at the neutral value, 1 at or past an extreme), the weighted parts add up to a
 * 0..1 whole, and the score is that whole on a 0..100 scale, lifted a little by `^0.85` so an ordinary face reads as a
 * low number rather than zero. The weights add to 1. The thresholds are first-pass values from facial anthropometry;
 * the parts are shown on the page, so a person can see which one drives their score.
 */

const clamp01 = (value) => (value < 0 ? 0 : value > 1 ? 1 : value)
/** 0 at `low`, 1 at `high`, linear between, clamped outside: the shape every part uses. */
const between = (value, low, high) => clamp01((value - low) / (high - low))
const round1 = (value) => Math.round(value * 10) / 10

/** Where a relaxed face sits. A part is 0 here and grows with the distance from it. */
export const NEUTRAL = { eyeRatio: 0.27, brow: 1.15 }

/** Every feature a capture must carry, in the order the page shows them. */
export const FEATURE_KEYS = [
  'eyeRatio',
  'mouthRatio',
  'smile',
  'brow',
  'roll',
  'asymmetry',
  'yaw',
  'skew',
]

/** The label of a part, said the way the face is doing it (wide eyes, not just eyes). */
const labelsOf = (features) => ({
  eyes: features.eyeRatio > NEUTRAL.eyeRatio ? 'wide eyes' : 'eyes shut',
  mouth: 'open mouth',
  expression: features.smile > 0 ? 'big grin' : 'deep frown',
  brow: features.brow > NEUTRAL.brow ? 'raised brows' : 'lowered brows',
  tilt: 'head tilt',
  asymmetry: 'lopsided face',
  yaw: 'head turned',
  skew: 'crooked mouth',
})

/** Weight and shape of each part: the weight is its share of the whole, `shape` turns the feature into 0..1. */
const PARTS = [
  { key: 'eyes', weight: 0.13, shape: (f) => between(Math.abs(f.eyeRatio - NEUTRAL.eyeRatio), 0.02, 0.16) },
  { key: 'mouth', weight: 0.18, shape: (f) => between(f.mouthRatio, 0.06, 0.42) },
  { key: 'expression', weight: 0.12, shape: (f) => between(Math.abs(f.smile), 0.05, 0.3) },
  { key: 'brow', weight: 0.09, shape: (f) => between(Math.abs(f.brow - NEUTRAL.brow), 0.1, 0.75) },
  { key: 'tilt', weight: 0.13, shape: (f) => between(Math.abs(f.roll), 6, 35) },
  { key: 'asymmetry', weight: 0.17, shape: (f) => between(f.asymmetry, 0.02, 0.11) },
  { key: 'yaw', weight: 0.11, shape: (f) => between(Math.abs(f.yaw), 0.12, 0.5) },
  { key: 'skew', weight: 0.07, shape: (f) => between(f.skew, 0.02, 0.13) },
]

/**
 * The weirdness of one captured face: `score` (0..100, one decimal), every `part` with its 0..1 value and its share of
 * the score, and `top`, the three parts that pushed it hardest, biggest first.
 */
export function weirdness(features) {
  const labels = labelsOf(features)
  const parts = PARTS.map((part) => {
    const value = part.shape(features)
    return { key: part.key, label: labels[part.key], weight: part.weight, value, share: value * part.weight }
  })
  const whole = parts.reduce((sum, part) => sum + part.share, 0)
  const score = round1(100 * Math.pow(clamp01(whole), 0.85))
  const top = [...parts].sort((a, b) => b.share - a.share).slice(0, 3)
  return { score, parts, top }
}

/** Readings as the store keeps them: epoch milliseconds and the recorded score. */
const asPoints = (readings) =>
  readings
    .map((reading) => (Array.isArray(reading) ? { at: Number(reading[0]), score: Number(reading[1]) } : reading))
    .filter((point) => Number.isFinite(point.at) && Number.isFinite(point.score))
    .sort((a, b) => a.at - b.at)

/**
 * What a series of readings says about the change in weirdness over time.
 *
 * `slopePerDay` is the least-squares slope in points per day (`change` is the difference between the last and the first
 * reading, which a single wild capture moves but the slope does not), `r2` says how well that line fits (1 is a clean
 * trend, 0 is noise), and `spanDays` is how long the history covers. Empty history answers zeros, one reading a flat line.
 */
export function trend(readings) {
  const points = asPoints(readings)
  const count = points.length
  if (count === 0)
    return {
      count: 0,
      first: 0,
      last: 0,
      mean: 0,
      median: 0,
      min: 0,
      max: 0,
      slopePerDay: 0,
      r2: 0,
      change: 0,
      spanDays: 0,
      total: 0,
    }
  const scores = points.map((point) => point.score)
  const first = scores[0]
  const last = scores[count - 1]
  const total = scores.reduce((sum, score) => sum + score, 0)
  const mean = total / count
  const sorted = [...scores].sort((a, b) => a - b)
  const median = count % 2 === 1 ? sorted[(count - 1) / 2] : (sorted[count / 2 - 1] + sorted[count / 2]) / 2
  const day = 86400000
  const xs = points.map((point) => (point.at - points[0].at) / day)
  const spanDays = xs[count - 1]
  let slopePerDay = 0
  let r2 = 0
  if (count > 1 && spanDays > 0) {
    const xMean = xs.reduce((sum, x) => sum + x, 0) / count
    let covariance = 0
    let varianceX = 0
    let varianceY = 0
    for (let i = 0; i < count; i += 1) {
      const dx = xs[i] - xMean
      const dy = scores[i] - mean
      covariance += dx * dy
      varianceX += dx * dx
      varianceY += dy * dy
    }
    if (varianceX > 0) slopePerDay = covariance / varianceX
    if (varianceY > 0) {
      let residual = 0
      for (let i = 0; i < count; i += 1) {
        const predicted = mean + slopePerDay * (xs[i] - xMean)
        residual += (scores[i] - predicted) ** 2
      }
      r2 = clamp01(1 - residual / varianceY)
    }
  }
  return {
    count,
    first: round1(first),
    last: round1(last),
    mean: round1(mean),
    median: round1(median),
    min: round1(sorted[0]),
    max: round1(sorted[count - 1]),
    slopePerDay: round1(slopePerDay * 10) / 10,
    r2: Math.round(r2 * 100) / 100,
    change: round1(last - first),
    spanDays: Math.round(spanDays * 100) / 100,
    total: round1(total),
  }
}

/** The series smoothed over `window` readings, as the chart's bold line: every point is the mean of the window around it. */
export function movingAverage(readings, window = 5) {
  const points = asPoints(readings)
  const span = Math.max(1, Math.floor(window))
  if (span === 1) return points
  return points.map((point, index) => {
    const from = Math.max(0, index - Math.floor(span / 2))
    const to = Math.min(points.length, from + span)
    const slice = points.slice(from, to)
    const mean = slice.reduce((sum, item) => sum + item.score, 0) / slice.length
    return { at: point.at, score: Math.round(mean * 10) / 10 }
  })
}
