/** Types for `score.js`, the math the browser and the server share. The implementation is beside this file. */

export interface WeirdnessFeatures {
  readonly eyeRatio: number
  readonly mouthRatio: number
  readonly smile: number
  readonly brow: number
  readonly roll: number
  readonly asymmetry: number
  readonly yaw: number
  readonly skew: number
}

export interface WeirdnessPart {
  readonly key: string
  readonly label: string
  readonly weight: number
  readonly value: number
  readonly share: number
}

export interface WeirdnessVerdict {
  readonly score: number
  readonly parts: readonly WeirdnessPart[]
  readonly top: readonly WeirdnessPart[]
}

export interface ScorePoint {
  readonly at: number
  readonly score: number
}

export interface Trend {
  readonly count: number
  readonly first: number
  readonly last: number
  readonly mean: number
  readonly median: number
  readonly min: number
  readonly max: number
  readonly slopePerDay: number
  readonly r2: number
  readonly change: number
  readonly spanDays: number
  readonly total: number
}

export const NEUTRAL: { readonly eyeRatio: number; readonly brow: number }
export const FEATURE_KEYS: readonly (keyof WeirdnessFeatures)[]
export function weirdness(features: WeirdnessFeatures): WeirdnessVerdict
export function trend(readings: readonly (ScorePoint | readonly [number, number])[]): Trend
export function movingAverage(readings: readonly ScorePoint[], window?: number): ScorePoint[]
