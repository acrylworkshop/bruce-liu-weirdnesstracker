/**
 * Where the weirdness tracker keeps its people: one JSON file in the app's home (`.acrylblends/weirdness.json`).
 *
 * A profile is one person: a name, the face descriptors that let the tracker recognise them again, and every reading
 * taken of that face (when, how weird, which parts drove it, and a small picture). A capture matches the face it was
 * given against the stored descriptors (the nearest one, by Euclidean distance, under the threshold in settings) and
 * records into that profile, or starts a new profile for a face it has not seen.
 *
 * The whole file is rewritten through a temporary file and a rename after every change, so a crash never leaves half a
 * file. Thumbnails are kept only for the latest readings (older ones drop their picture first, then the readings
 * themselves once the history is very long), so the file stays small however long the tracker runs.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FEATURE_KEYS, type WeirdnessFeatures, weirdness } from './score.js'

/** The descriptors one face is recognised by, and the pictures and readings one profile keeps. */
const MAX_DESCRIPTORS = 6
const MAX_SHOTS = 24
const MAX_READINGS = 5000

export interface Reading {
  readonly id: string
  /** Epoch milliseconds. */
  readonly at: number
  /** 0..100, the recorded weirdness. */
  readonly score: number
  /** Each part's 0..1 value, by the part's key. */
  readonly parts: Readonly<Record<string, number>>
  /** A small JPEG data URL of the face, or null once the picture has aged out. */
  shot: string | null
}

export interface Profile {
  readonly id: string
  name: string
  readonly createdAt: number
  /** The face's 128 number descriptors, newest last. */
  readonly descriptors: number[][]
  readonly readings: Reading[]
}

export interface Settings {
  /** Seconds between two automatic captures while a face is in view. */
  intervalSec: number
  /** Descriptor distance under which a face is the same person (0.4 is strict, 0.6 is loose). */
  matchThreshold: number
  /** Whether the page plays a sound for a capture, a new face and a new personal best. */
  sound: boolean
}

export interface State {
  readonly version: 1
  readonly settings: Settings
  readonly profiles: Profile[]
}

export interface CaptureInput {
  readonly features: WeirdnessFeatures
  /** The face's 128 number descriptor; a capture without one cannot be matched to a person. */
  readonly descriptor: readonly number[]
  readonly shot: string | null
}

export interface CaptureResult {
  readonly profile: Profile
  readonly reading: Reading
  readonly verdict: ReturnType<typeof weirdness>
  /** How far the face was from the profile's nearest stored descriptor; null for a profile just created. */
  readonly distance: number | null
  readonly created: boolean
}

export interface Store {
  state(): State
  settings(): Settings
  setSettings(patch: Partial<Settings>): Settings
  capture(input: CaptureInput): CaptureResult
  rename(id: string, name: string): Profile | undefined
  remove(id: string): boolean
  merge(from: string, into: string): Profile | undefined
  shots(id: string, limit: number): { at: number; score: number; shot: string }[]
}

/** The threshold face-api's own models are documented around: 0.6 reads two pictures of one face as the same person. */
const DEFAULT_SETTINGS: Settings = { intervalSec: 5, matchThreshold: 0.6, sound: true }
const MAX_SHOT_BYTES = 200_000
const MAX_NAME = 40

export const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

/** A settings patch, or null when a value is out of range: the interval 0..600 seconds (0 captures by hand only), the threshold 0.2..0.9, sound on or off. */
export function readSettings(input: unknown): Partial<Settings> | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null
  const patch: { intervalSec?: number; matchThreshold?: number; sound?: boolean } = {}
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (key === 'intervalSec') {
      if (!isFiniteNumber(value) || value < 0 || value > 600) return null
      patch.intervalSec = Math.round(value)
    } else if (key === 'matchThreshold') {
      if (!isFiniteNumber(value) || value < 0.2 || value > 0.9) return null
      patch.matchThreshold = Math.round(value * 100) / 100
    } else if (key === 'sound') {
      if (typeof value !== 'boolean') return null
      patch.sound = value
    } else {
      return null
    }
  }
  return patch
}

/** The features a capture sends, or null when one is missing or not a finite number. */
export function readFeatures(input: unknown): WeirdnessFeatures | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null
  const record = input as Record<string, unknown>
  const features: Record<string, number> = {}
  for (const key of FEATURE_KEYS) {
    const value = record[key]
    if (!isFiniteNumber(value) || Math.abs(value) > 1000) return null
    features[key] = value
  }
  return features as unknown as WeirdnessFeatures
}

/** A face descriptor: exactly 128 finite numbers of an ordinary size, or null. */
export function readDescriptor(input: unknown): number[] | null {
  if (!Array.isArray(input) || input.length !== 128) return null
  const descriptor: number[] = []
  for (const value of input) {
    if (!isFiniteNumber(value) || Math.abs(value) > 100) return null
    descriptor.push(Math.round(value * 1e6) / 1e6)
  }
  return descriptor
}

/** A face picture as a small JPEG data URL, or null; a picture that is not one is refused rather than stored. */
export function readShot(input: unknown): { shot: string | null } | null {
  if (input === null || input === undefined) return { shot: null }
  if (typeof input !== 'string') return null
  if (!input.startsWith('data:image/jpeg;base64,') || input.length > MAX_SHOT_BYTES) return null
  return { shot: input }
}

/** The name a profile is shown under, trimmed and short, or null when it is empty. */
export function readName(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const name = input.trim().replace(/\s+/gu, ' ').slice(0, MAX_NAME)
  return name === '' ? null : name
}

/** Euclidean distance between two face descriptors: 0 is the same picture, under 0.6 reads as the same person. */
export function distance(a: readonly number[], b: readonly number[]): number {
  let sum = 0
  for (let i = 0; i < 128; i += 1) sum += (a[i] - b[i]) ** 2
  return Math.sqrt(sum)
}

/** The profile whose nearest descriptor is closest to `descriptor`, when that is under `threshold`. */
function match(
  profiles: readonly Profile[],
  descriptor: readonly number[],
  threshold: number,
): { profile: Profile; distance: number } | null {
  let best: { profile: Profile; distance: number } | null = null
  for (const profile of profiles) {
    for (const stored of profile.descriptors) {
      const away = distance(descriptor, stored)
      if (best === null || away < best.distance) best = { profile, distance: away }
    }
  }
  return best !== null && best.distance <= threshold ? best : null
}

/** A stored file read back: anything malformed is dropped instead of breaking the tracker. */
function readState(file: string): State {
  const fresh: State = { version: 1, settings: { ...DEFAULT_SETTINGS }, profiles: [] }
  if (!existsSync(file)) return fresh
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fresh
  }
  if (typeof parsed !== 'object' || parsed === null) return fresh
  const record = parsed as Record<string, unknown>
  const settings = { ...DEFAULT_SETTINGS }
  if (typeof record.settings === 'object' && record.settings !== null) {
    const known = readSettings(record.settings)
    if (known !== null) Object.assign(settings, known)
  }
  const profiles: Profile[] = []
  for (const item of Array.isArray(record.profiles) ? record.profiles : []) {
    if (typeof item !== 'object' || item === null) continue
    const entry = item as Record<string, unknown>
    if (typeof entry.id !== 'string' || typeof entry.name !== 'string') continue
    const descriptors = (Array.isArray(entry.descriptors) ? entry.descriptors : [])
      .map(readDescriptor)
      .filter((descriptor): descriptor is number[] => descriptor !== null)
    const readings: Reading[] = []
    for (const raw of Array.isArray(entry.readings) ? entry.readings : []) {
      if (typeof raw !== 'object' || raw === null) continue
      const reading = raw as Record<string, unknown>
      if (typeof reading.id !== 'string' || !isFiniteNumber(reading.at) || !isFiniteNumber(reading.score)) continue
      const parts: Record<string, number> = {}
      if (typeof reading.parts === 'object' && reading.parts !== null) {
        for (const [key, value] of Object.entries(reading.parts as Record<string, unknown>)) {
          if (isFiniteNumber(value)) parts[key] = value
        }
      }
      const shot = readShot(reading.shot)
      readings.push({
        id: reading.id,
        at: reading.at,
        score: reading.score,
        parts,
        shot: shot === null ? null : shot.shot,
      })
    }
    readings.sort((a, b) => a.at - b.at)
    profiles.push({
      id: entry.id,
      name: readName(entry.name) ?? 'Unnamed',
      createdAt: isFiniteNumber(entry.createdAt) ? entry.createdAt : (readings[0]?.at ?? Date.now()),
      descriptors,
      readings,
    })
  }
  return { version: 1, settings, profiles }
}

/**
 * The tracker's file as a small store. Read once here, changed in memory by the routes, written whole after each
 * change through a temporary file and a rename.
 */
export function openStore(home: string): Store {
  const file = join(home, 'weirdness.json')
  const state = readState(file)
  const save = (): void => {
    mkdirSync(home, { recursive: true })
    const temporary = `${file}.${String(process.pid)}.tmp`
    writeFileSync(temporary, `${JSON.stringify(state, null, 1)}\n`)
    renameSync(temporary, file)
  }
  const find = (id: string): Profile | undefined => state.profiles.find((profile) => profile.id === id)

  return {
    state: () => state,
    settings: () => state.settings,

    setSettings(patch) {
      Object.assign(state.settings, patch)
      save()
      return state.settings
    },

    capture(input) {
      const verdict = weirdness(input.features)
      const matched = match(state.profiles, input.descriptor, state.settings.matchThreshold)
      const at = Date.now()
      const reading: Reading = {
        id: randomUUID(),
        at,
        score: verdict.score,
        parts: Object.fromEntries(verdict.parts.map((part) => [part.key, Math.round(part.value * 100) / 100])),
        shot: input.shot,
      }
      const profile: Profile =
        matched?.profile ??
        ({
          id: randomUUID(),
          name: `Person ${String(state.profiles.length + 1)}`,
          createdAt: at,
          descriptors: [],
          readings: [],
        } satisfies Profile)
      if (matched === null) state.profiles.push(profile)
      profile.descriptors.push([...input.descriptor])
      if (profile.descriptors.length > MAX_DESCRIPTORS) profile.descriptors.splice(0, profile.descriptors.length - MAX_DESCRIPTORS)
      profile.readings.push(reading)
      // The pictures age out before the readings do: the file stays small, and the chart keeps its whole history.
      const withShot = profile.readings.filter((item) => item.shot !== null)
      for (const item of withShot.slice(0, Math.max(0, withShot.length - MAX_SHOTS))) item.shot = null
      if (profile.readings.length > MAX_READINGS)
        profile.readings.splice(0, profile.readings.length - MAX_READINGS)
      save()
      return {
        profile,
        reading,
        verdict,
        distance: matched === null ? null : Math.round(matched.distance * 1000) / 1000,
        created: matched === null,
      }
    },

    rename(id, name) {
      const profile = find(id)
      if (profile === undefined) return undefined
      profile.name = name
      save()
      return profile
    },

    remove(id) {
      const index = state.profiles.findIndex((profile) => profile.id === id)
      if (index === -1) return false
      state.profiles.splice(index, 1)
      save()
      return true
    },

    merge(from, into) {
      const source = find(from)
      const target = find(into)
      if (source === undefined || target === undefined || source === target) return undefined
      for (const descriptor of source.descriptors) {
        target.descriptors.push(descriptor)
      }
      if (target.descriptors.length > MAX_DESCRIPTORS)
        target.descriptors.splice(0, target.descriptors.length - MAX_DESCRIPTORS)
      target.readings.push(...source.readings)
      target.readings.sort((a, b) => a.at - b.at)
      const withShot = target.readings.filter((item) => item.shot !== null)
      for (const item of withShot.slice(0, Math.max(0, withShot.length - MAX_SHOTS))) item.shot = null
      state.profiles.splice(state.profiles.indexOf(source), 1)
      save()
      return target
    },

    shots(id, limit) {
      const profile = find(id)
      if (profile === undefined) return []
      return profile.readings
        .filter((reading): reading is Reading & { shot: string } => reading.shot !== null)
        .slice(-Math.max(1, Math.min(60, limit)))
        .reverse()
        .map((reading) => ({ at: reading.at, score: reading.score, shot: reading.shot }))
    },
  }
}
