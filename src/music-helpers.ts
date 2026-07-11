/**
 * Minimal chord/scale helpers for the enforce layer — parses the host's
 * chord SYMBOLS ('F#m', 'Cmaj7', 'Bb7') into pitch-class sets and builds
 * scale pitch-class sets from key + mode. Kept plugin-local (the SDK ships
 * no theory tables; same discipline as the ensemble/arp plugins);
 * conservative: an unrecognized quality falls back to a plain root+fifth so
 * enforcement degrades gracefully rather than mangling exotic chords.
 */

const NOTE_TO_PC: Record<string, number> = {
  C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5,
  'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11,
};

/** quality suffix → intervals from the root (most common spellings). */
const QUALITY_INTERVALS: Record<string, number[]> = {
  '': [0, 4, 7],
  maj: [0, 4, 7],
  m: [0, 3, 7],
  min: [0, 3, 7],
  dim: [0, 3, 6],
  aug: [0, 4, 8],
  '7': [0, 4, 7, 10],
  maj7: [0, 4, 7, 11],
  m7: [0, 3, 7, 10],
  min7: [0, 3, 7, 10],
  m7b5: [0, 3, 6, 10],
  dim7: [0, 3, 6, 9],
  '9': [0, 4, 7, 10, 14],
  maj9: [0, 4, 7, 11, 14],
  m9: [0, 3, 7, 10, 14],
  min9: [0, 3, 7, 10, 14],
  '6': [0, 4, 7, 9],
  m6: [0, 3, 7, 9],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
  add9: [0, 4, 7, 14],
};

export interface ParsedChordSymbol {
  rootPc: number;
  pcs: Set<number>;
}

/** Parse 'F#m7' → root pc + chord pitch-class set. Null when unparseable. */
export function parseChordSymbol(symbol: string): ParsedChordSymbol | null {
  const m = /^([A-G](?:#|b)?)(.*)$/.exec(symbol.trim());
  if (!m) return null;
  const rootPc = NOTE_TO_PC[m[1]];
  if (rootPc === undefined) return null;
  const quality = m[2].trim();
  const intervals = QUALITY_INTERVALS[quality] ?? QUALITY_INTERVALS[quality.toLowerCase()] ?? [0, 7];
  return {
    rootPc,
    pcs: new Set(intervals.map((i) => (rootPc + i) % 12)),
  };
}

const SCALE_STEPS: Record<string, number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10],
  harmonic_minor: [0, 2, 3, 5, 7, 8, 11],
  melodic_minor: [0, 2, 3, 5, 7, 9, 11],
};

/** Scale pitch classes for key+mode; null for unknown keys/modes. */
export function scalePcsFor(key: string, mode: string): Set<number> | null {
  const tonic = NOTE_TO_PC[key.trim()];
  const steps = SCALE_STEPS[mode.trim().toLowerCase()];
  if (tonic === undefined || !steps) return null;
  return new Set(steps.map((s) => (tonic + s) % 12));
}
