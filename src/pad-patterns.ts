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
 * METER (P8b multi-time-signature): the grid is parameterized on the scene
 * meter's QUARTER notes per bar (`quarterNotesPerBar`, default 4 = the
 * legacy 4/4 grid — omitted call sites are bit-identical to before). All
 * `startBeat`/`durationBeats` values are quarter notes, whatever the meter:
 *   - a base slot spans one bar (`quarterNotesPerBar` qn) or half a bar in
 *     'half' mode (`quarterNotesPerBar / 2` qn);
 *   - rhythmic patterns are authored on a 4-qn reference bar and scaled
 *     linearly to the meter's bar (segments are bar-FRACTION shapes: in 6/8
 *     "pulsing quarters" = four even pulses of 0.75 qn; in asymmetric meters
 *     the even subdivision may fall off the notated beat grid — accepted,
 *     deterministic, and documented rather than snapped);
 *   - 'half-bar' rests play the FRONT half of each slot (half the bar in
 *     whole mode, a quarter-bar in half mode) — in odd meters the midpoint
 *     can bisect a notated beat (7/8 → play 1.75 qn), which is fine for
 *     sustained pads;
 *   - rotation is INDEX-based (`baseSlotIndex % voiceCount`) and therefore
 *     meter-agnostic: bar 1 → patch A holds in every meter.
 * FRACTIONAL bars (7/8 → 3.5 qn) are safe: every derived quantity divides
 * only by powers of two, and curated meters' qn-per-bar values are dyadic
 * rationals (num·4/den, den ∈ {2,4,8,16}), so all products, offsets, and
 * bar-boundary quotients below are EXACT in floating point.
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

/** Quarter notes per bar of the default 4/4 meter (the legacy grid). */
const DEFAULT_QUARTER_NOTES_PER_BAR = 4;
/**
 * The AUTHORING bar span of rhythmic patterns: segments below are written
 * against a 4-qn reference bar and scaled by `quarterNotesPerBar / 4` at
 * grid-build time, so each pattern keeps its bar-fraction identity in every
 * meter (front-half = the bar's first half, etc.).
 */
const PATTERN_AUTHORING_BEATS = 4;

/**
 * One segment of a rhythmic pattern, normalized to the 4-qn AUTHORING bar
 * (`PATTERN_AUTHORING_BEATS`); scaled to the meter's bar when the grid is
 * built.
 */
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
  /**
   * QUARTER notes per bar of the scene meter (panel-core's
   * `panelQuarterNotesPerBar`): 4/4 → 4, 6/8 → 3, 7/8 → 3.5 (fractional is
   * fine — see the header's exactness note). Omitted/invalid → 4, the
   * legacy 4/4 grid, so existing call sites are unchanged.
   */
  quarterNotesPerBar?: number;
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
  const qnPerBar =
    opts.quarterNotesPerBar !== undefined &&
    Number.isFinite(opts.quarterNotesPerBar) &&
    opts.quarterNotesPerBar > 0
      ? opts.quarterNotesPerBar
      : DEFAULT_QUARTER_NOTES_PER_BAR;
  // Rhythmic segments are authored on a 4-qn bar; scale keeps their
  // bar-fraction shape in the meter's bar (division by 4 — exact).
  const patternScale = qnPerBar / PATTERN_AUTHORING_BEATS;

  // Rests apply to whole/half only — in rhythmic mode the pattern owns rests.
  const rests: PadRestsMode = opts.duration === 'rhythmic' ? 'off' : opts.rests;

  // ── base slots (the rotation units) ─────────────────────────────────────
  // 'half' slots span half the bar in every meter (7/8 → 1.75 qn). The slot
  // COUNT is derived structurally (2 per bar / 1 per bar), never by dividing
  // beat totals, so fractional bars cannot produce a fractional count.
  const baseSlotBeats = opts.duration === 'half' ? qnPerBar / 2 : qnPerBar;
  const baseSlotCount = bars * (opts.duration === 'half' ? 2 : 1);

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
          startBeat: slotStart + seg.startBeat * patternScale,
          endBeat: slotStart + (seg.startBeat + seg.durationBeats) * patternScale,
          voiceIndex,
          baseSlotIndex: i,
        });
      }
    } else {
      // 'half-bar' rests truncate each play slot to its first half (half the
      // bar in whole mode — a division by 2, exact for every curated meter).
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
          // Exact at bar boundaries: starts are dyadic-rational sums and the
          // boundary quotient start/qnPerBar is an exact integer (header note).
          bar: Math.floor(start / qnPerBar),
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
        bar: Math.floor(start / qnPerBar),
      });
    }
  }

  return { voicingSlots, strikes, voiceCount, bars };
}
