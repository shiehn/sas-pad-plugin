/**
 * The deterministic pad grid — the heart of the rotation model.
 *
 * The user's mental model: over N bars, chords rotate across 1-4 patches
 * (bar 1 → patch A, bar 2 → patch B, …). This module owns ALL timing; the
 * LLM only picks pitches. Three levels:
 *
 *   base slots     — the rotation units (one per bar, or per half-bar in
 *                    'half' mode). `voice = baseSlotIndex % voiceCount` over
 *                    EVERY base slot including rests, so "bar N → patch N"
 *                    stays stable when a bar rests.
 *   voicing slots  — the harmony units the LLM voices (one per base slot ×
 *                    chord region; a mid-slot chord change splits the slot
 *                    so a stale chord is never held across a change).
 *   strikes        — the MIDI events (one per play segment × chord region),
 *                    each referencing its voicing slot's pitches.
 *
 * Pure and dependency-free: trivially testable, reusable by the prompt
 * builder and the enforcement layer alike.
 */

export type PadDurationMode = 'whole' | 'half' | 'rhythmic';
export type PadRestsMode = 'off' | 'sparse' | 'half-bar';
export type PadVoicingMode = 'full' | 'partial';

export const PAD_DURATION_MODES: readonly PadDurationMode[] = ['whole', 'half', 'rhythmic'];
export const PAD_RESTS_MODES: readonly PadRestsMode[] = ['off', 'sparse', 'half-bar'];
export const PAD_VOICING_MODES: readonly PadVoicingMode[] = ['full', 'partial'];

const BEATS_PER_BAR = 4;

/** One segment of a rhythmic pattern, normalized to a single 4-beat bar. */
export interface PadPatternSegment {
  startBeat: number;
  durationBeats: number;
  play: boolean;
}

export interface PadPattern {
  id: string;
  label: string;
  segments: PadPatternSegment[];
}

/**
 * The curated rhythmic pattern set. Patterns tile per BAR (the rhythmic
 * base slot), so with rotation each bar's pattern lands on one patch.
 */
export const PAD_PATTERNS: readonly PadPattern[] = [
  {
    id: 'front-half',
    label: 'play 1-2 · rest 3-4',
    segments: [
      { startBeat: 0, durationBeats: 2, play: true },
      { startBeat: 2, durationBeats: 2, play: false },
    ],
  },
  {
    id: 'back-half',
    label: 'rest 1-2 · play 3-4',
    segments: [
      { startBeat: 0, durationBeats: 2, play: false },
      { startBeat: 2, durationBeats: 2, play: true },
    ],
  },
  {
    id: 'pulsing-quarters',
    label: 'pulsing quarters',
    segments: [
      { startBeat: 0, durationBeats: 1, play: true },
      { startBeat: 1, durationBeats: 1, play: true },
      { startBeat: 2, durationBeats: 1, play: true },
      { startBeat: 3, durationBeats: 1, play: true },
    ],
  },
  {
    id: 'offbeat-stabs',
    label: 'offbeat stabs',
    segments: [
      { startBeat: 0, durationBeats: 0.5, play: false },
      { startBeat: 0.5, durationBeats: 0.5, play: true },
      { startBeat: 1, durationBeats: 0.5, play: false },
      { startBeat: 1.5, durationBeats: 0.5, play: true },
      { startBeat: 2, durationBeats: 0.5, play: false },
      { startBeat: 2.5, durationBeats: 0.5, play: true },
      { startBeat: 3, durationBeats: 0.5, play: false },
      { startBeat: 3.5, durationBeats: 0.5, play: true },
    ],
  },
  {
    id: 'long-short',
    label: 'long-short',
    segments: [
      { startBeat: 0, durationBeats: 3, play: true },
      { startBeat: 3, durationBeats: 1, play: true },
    ],
  },
];

export const DEFAULT_PATTERN_ID = 'front-half';

export function padPatternById(id: string): PadPattern {
  return PAD_PATTERNS.find((p) => p.id === id) ?? PAD_PATTERNS[0];
}

/** One harmony unit the LLM voices: a chord region within a base slot. */
export interface PadVoicingSlot {
  index: number;
  /** 0-based bar the slot starts in (display / prompt). */
  bar: number;
  startBeat: number;
  endBeat: number;
  /** The host's chord symbol sounding at slot start; null when chordless. */
  chordSymbol: string | null;
}

/** One MIDI event: its voicing slot's pitches at this start/duration. */
export interface PadStrike {
  startBeat: number;
  durationBeats: number;
  /** Which patch plays this strike (rotation: baseSlot % voiceCount). */
  voiceIndex: number;
  voicingSlotIndex: number;
  bar: number;
}

export interface PadSlotGrid {
  voicingSlots: PadVoicingSlot[];
  strikes: PadStrike[];
  voiceCount: number;
  bars: number;
}

export interface PadChordTiming {
  symbol: string;
  startQn: number;
  endQn: number;
}

export interface BuildPadSlotGridOptions {
  bars: number;
  voiceCount: number;
  duration: PadDurationMode;
  patternId?: string;
  rests: PadRestsMode;
  chordTiming: ReadonlyArray<PadChordTiming>;
}

/** Chord symbol sounding at a beat (first region containing it wins). */
function chordSymbolAt(timing: ReadonlyArray<PadChordTiming>, beat: number): string | null {
  for (const t of timing) {
    if (t.startQn <= beat && beat < t.endQn) return t.symbol;
  }
  return null;
}

/** Chord-change boundaries strictly inside (start, end). */
function chordBoundariesWithin(
  timing: ReadonlyArray<PadChordTiming>,
  start: number,
  end: number
): number[] {
  const cuts = new Set<number>();
  for (const t of timing) {
    if (t.startQn > start && t.startQn < end) cuts.add(t.startQn);
    if (t.endQn > start && t.endQn < end) cuts.add(t.endQn);
  }
  return [...cuts].sort((a, b) => a - b);
}

export function buildPadSlotGrid(opts: BuildPadSlotGridOptions): PadSlotGrid {
  const bars = Math.max(1, Math.floor(opts.bars));
  const voiceCount = Math.max(1, Math.floor(opts.voiceCount));
  const pattern = padPatternById(opts.patternId ?? DEFAULT_PATTERN_ID);

  // Rests apply to whole/half only — in rhythmic mode the pattern owns rests.
  const rests: PadRestsMode = opts.duration === 'rhythmic' ? 'off' : opts.rests;

  // ── base slots (the rotation units) ─────────────────────────────────────
  const baseSlotBeats = opts.duration === 'half' ? BEATS_PER_BAR / 2 : BEATS_PER_BAR;
  const baseSlotCount = (bars * BEATS_PER_BAR) / baseSlotBeats;

  interface PlaySegment {
    startBeat: number;
    endBeat: number;
    voiceIndex: number;
    baseSlotIndex: number;
  }
  const playSegments: PlaySegment[] = [];

  for (let i = 0; i < baseSlotCount; i++) {
    const slotStart = i * baseSlotBeats;
    const voiceIndex = i % voiceCount;
    // 'sparse' = breath every 4 rotation units; the slot still consumes its
    // rotation position so "bar N → patch N" never re-aligns.
    if (rests === 'sparse' && i % 4 === 3) continue;

    if (opts.duration === 'rhythmic') {
      for (const seg of pattern.segments) {
        if (!seg.play) continue;
        playSegments.push({
          startBeat: slotStart + seg.startBeat,
          endBeat: slotStart + seg.startBeat + seg.durationBeats,
          voiceIndex,
          baseSlotIndex: i,
        });
      }
    } else {
      // 'half-bar' rests truncate each play slot to its first half.
      const playBeats = rests === 'half-bar' ? baseSlotBeats / 2 : baseSlotBeats;
      playSegments.push({
        startBeat: slotStart,
        endBeat: slotStart + playBeats,
        voiceIndex,
        baseSlotIndex: i,
      });
    }
  }

  // ── split at chord boundaries + coalesce voicing slots ─────────────────
  // One voicing slot per (base slot × chord region) so e.g. four pulsing
  // quarters over one chord share ONE voicing, but a mid-slot chord change
  // gets its own re-voiced region.
  const voicingSlots: PadVoicingSlot[] = [];
  const strikes: PadStrike[] = [];
  const slotIndexByKey = new Map<string, number>();

  for (const seg of playSegments) {
    const cuts = [
      seg.startBeat,
      ...chordBoundariesWithin(opts.chordTiming, seg.startBeat, seg.endBeat),
      seg.endBeat,
    ];
    for (let c = 0; c < cuts.length - 1; c++) {
      const start = cuts[c];
      const end = cuts[c + 1];
      if (end - start <= 0) continue;
      const symbol = chordSymbolAt(opts.chordTiming, start);
      const key = `${seg.baseSlotIndex}|${symbol ?? ''}`;

      let slotIndex = slotIndexByKey.get(key);
      if (slotIndex === undefined) {
        slotIndex = voicingSlots.length;
        slotIndexByKey.set(key, slotIndex);
        voicingSlots.push({
          index: slotIndex,
          bar: Math.floor(start / BEATS_PER_BAR),
          startBeat: start,
          endBeat: end,
          chordSymbol: symbol,
        });
      } else {
        // Extend the slot's display span to cover every strike it serves.
        const slot = voicingSlots[slotIndex];
        slot.startBeat = Math.min(slot.startBeat, start);
        slot.endBeat = Math.max(slot.endBeat, end);
      }

      strikes.push({
        startBeat: start,
        durationBeats: end - start,
        voiceIndex: seg.voiceIndex,
        voicingSlotIndex: slotIndex,
        bar: Math.floor(start / BEATS_PER_BAR),
      });
    }
  }

  return { voicingSlots, strikes, voiceCount, bars };
}
