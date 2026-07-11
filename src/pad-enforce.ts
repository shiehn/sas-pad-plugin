/**
 * The polyphonic mechanical layer — everything the LLM is NOT trusted with.
 *
 * Pads are block chords, so the ensemble-core `enforceVoice` (monophonic by
 * contract) is unusable here; this module reuses only its two pure pitch
 * helpers. Pipeline per voicing slot: fallback voicing when the model left
 * the slot empty (a pad with silent holes is a bug, not a style) → register
 * fold → snap non-chord/non-scale tones to the nearest chord tone → dedupe →
 * cap polyphony by chord-tone priority (root → 3rd → 7th → 5th → colors) →
 * low-interval mud guard. Velocities are mechanical: pads are dynamically
 * flat, so nothing pitch-related rides on them.
 */

import { foldPitchToRegister, nearestPitchWithPc } from '@signalsandsorcery/plugin-sdk';
import type { PadDurationMode, PadSlotGrid, PadVoicingMode } from './pad-patterns';
import { parseChordSymbol, type ParsedChordSymbol } from './music-helpers';

export const PAD_REGISTER_LOW = 48; // C3
export const PAD_REGISTER_HIGH = 76; // E5
export const PAD_VELOCITY_SUSTAIN = 72;
export const PAD_VELOCITY_STRIKE = 84;

export const FULL_VOICING_MAX_NOTES = 5;
export const PARTIAL_VOICING_MAX_NOTES = 3;

/** Below this pitch, intervals tighter than MUD_MIN_INTERVAL turn to mud. */
const MUD_CEILING = 55;
const MUD_MIN_INTERVAL = 3;

export interface PadNote {
  pitch: number;
  startBeat: number;
  durationBeats: number;
  velocity: number;
}

export interface EnforceVoicingOptions {
  chord: ParsedChordSymbol | null;
  scalePcs?: Set<number>;
  voicing: PadVoicingMode;
}

export interface EnforceVoicingResult {
  pitches: number[];
  corrections: string[];
}

const pcOf = (pitch: number): number => ((pitch % 12) + 12) % 12;

/**
 * Chord pitch classes ordered by voicing priority: root, then 3rd, 7th,
 * 5th (incl. altered), then whatever colors remain.
 */
export function orderChordPcsByPriority(chord: ParsedChordSymbol): number[] {
  const { rootPc, pcs } = chord;
  const ordered: number[] = [];
  const pushIf = (interval: number): void => {
    const pc = (rootPc + interval) % 12;
    if (pcs.has(pc) && !ordered.includes(pc)) ordered.push(pc);
  };
  pushIf(0);
  pushIf(4); // major 3rd
  pushIf(3); // minor 3rd
  pushIf(10); // minor 7th
  pushIf(11); // major 7th
  pushIf(7); // perfect 5th
  pushIf(6); // diminished 5th
  pushIf(8); // augmented 5th
  for (const pc of pcs) if (!ordered.includes(pc)) ordered.push(pc);
  return ordered;
}

/**
 * Deterministic voicing straight from the chord table — used when the model
 * omitted or emptied a slot. Root as the lowest note, remaining priority
 * tones stacked upward, capped by the voicing mode.
 */
export function fallbackVoicingFromChord(
  chord: ParsedChordSymbol | null,
  voicing: PadVoicingMode
): number[] {
  // No chord info at all (chordless scene): a neutral open fifth on A — the
  // least-wrong sound in any key. Only reachable when the scene has no
  // contract chords, which generation refuses anyway.
  if (!chord) return [57, 64];
  const cap = voicing === 'partial' ? PARTIAL_VOICING_MAX_NOTES : Math.min(4, FULL_VOICING_MAX_NOTES);
  const orderedPcs = orderChordPcsByPriority(chord).slice(0, cap);
  const pitches: number[] = [];
  let floor = MUD_CEILING; // start the root above the mud zone
  for (const pc of orderedPcs) {
    const placed = nearestPitchWithPc(floor + 2, pc, floor, PAD_REGISTER_HIGH);
    pitches.push(placed);
    floor = placed + 1;
  }
  return pitches.sort((a, b) => a - b);
}

export function enforceVoicing(
  rawPitches: number[] | null,
  opts: EnforceVoicingOptions
): EnforceVoicingResult {
  const corrections: string[] = [];
  const { chord, scalePcs, voicing } = opts;

  let pitches = rawPitches?.slice() ?? [];
  if (pitches.length === 0) {
    pitches = fallbackVoicingFromChord(chord, voicing);
    corrections.push('empty slot — used deterministic fallback voicing');
  }

  // Register fold.
  pitches = pitches.map((p) => {
    const folded = foldPitchToRegister(p, PAD_REGISTER_LOW, PAD_REGISTER_HIGH);
    if (folded !== p) corrections.push(`folded ${p} → ${folded}`);
    return folded;
  });

  // Snap tones outside chord ∪ scale to the nearest chord tone. In-scale
  // non-chord tones are allowed color.
  if (chord) {
    pitches = pitches.map((p) => {
      const pc = pcOf(p);
      if (chord.pcs.has(pc) || scalePcs?.has(pc)) return p;
      let bestPc = chord.rootPc;
      let bestDist = 12;
      for (const cpc of chord.pcs) {
        const d = Math.min((pc - cpc + 12) % 12, (cpc - pc + 12) % 12);
        if (d < bestDist) {
          bestDist = d;
          bestPc = cpc;
        }
      }
      const snapped = nearestPitchWithPc(p, bestPc, PAD_REGISTER_LOW, PAD_REGISTER_HIGH);
      corrections.push(`snapped ${p} → ${snapped}`);
      return snapped;
    });
  }

  // Dedupe exact pitches (octave doublings survive) and sort.
  const before = pitches.length;
  pitches = [...new Set(pitches)].sort((a, b) => a - b);
  if (pitches.length !== before) corrections.push('deduped repeated pitches');

  // Cap polyphony by chord-tone priority.
  const cap = voicing === 'partial' ? PARTIAL_VOICING_MAX_NOTES : FULL_VOICING_MAX_NOTES;
  if (pitches.length > cap) {
    if (chord) {
      const priority = orderChordPcsByPriority(chord);
      const rank = (p: number): number => {
        const r = priority.indexOf(pcOf(p));
        return r === -1 ? priority.length : r;
      };
      pitches = pitches
        .slice()
        .sort((a, b) => rank(a) - rank(b) || a - b)
        .slice(0, cap)
        .sort((a, b) => a - b);
    } else {
      pitches = pitches.slice(0, cap);
    }
    corrections.push(`trimmed to ${cap} notes (${voicing} voicing)`);
  }

  // Mud guard: in the low register, drop the lower of any tight pair.
  const guarded: number[] = [];
  for (const p of pitches) {
    const prev = guarded[guarded.length - 1];
    if (prev !== undefined && prev < MUD_CEILING && p - prev < MUD_MIN_INTERVAL) {
      guarded[guarded.length - 1] = p;
      corrections.push(`mud guard dropped ${prev} (too close to ${p} below C3+)`);
    } else {
      guarded.push(p);
    }
  }

  return { pitches: guarded, corrections };
}

/**
 * Expand enforced voicings through the grid's strikes into per-voice note
 * arrays. Durations are exactly the strike span — Surge pad presets carry
 * their own release envelopes, and MIDI tails double-attack across rotation
 * handoffs.
 */
export function materializeStrikes(
  grid: PadSlotGrid,
  voicings: ReadonlyArray<readonly number[]>,
  durationMode: PadDurationMode
): PadNote[][] {
  const velocity = durationMode === 'rhythmic' ? PAD_VELOCITY_STRIKE : PAD_VELOCITY_SUSTAIN;
  const perVoice: PadNote[][] = Array.from({ length: grid.voiceCount }, () => []);
  for (const strike of grid.strikes) {
    const pitches = voicings[strike.voicingSlotIndex] ?? [];
    for (const pitch of pitches) {
      perVoice[strike.voiceIndex].push({
        pitch,
        startBeat: strike.startBeat,
        durationBeats: strike.durationBeats,
        velocity,
      });
    }
  }
  return perVoice;
}

/**
 * Soft cross-slot rules — reported, not repaired. What the guided retry is
 * for: voice-leading is the one job the LLM has here.
 */
export function analyzePads(
  voicings: ReadonlyArray<readonly number[]>,
  slots: PadSlotGrid['voicingSlots']
): string[] {
  const violations: string[] = [];
  const mean = (ps: readonly number[]): number =>
    ps.length === 0 ? 0 : ps.reduce((a, b) => a + b, 0) / ps.length;

  for (let i = 0; i < slots.length; i++) {
    const pitches = voicings[i] ?? [];
    if (pitches.length === 0) continue;
    const spread = pitches[pitches.length - 1] - pitches[0];
    if (spread > 24) {
      violations.push(`slot ${i}: voicing spans ${spread} semitones (keep it within two octaves)`);
    }
  }

  for (let i = 1; i < slots.length; i++) {
    const prev = voicings[i - 1] ?? [];
    const curr = voicings[i] ?? [];
    if (prev.length === 0 || curr.length === 0) continue;
    const jump = Math.abs(mean(curr) - mean(prev));
    if (jump > 7) {
      violations.push(
        `slots ${i - 1}→${i}: the voicing center jumps ${Math.round(jump)} semitones — hold common tones and move voices stepwise`
      );
    }
    const chordChanged = slots[i - 1].chordSymbol !== slots[i].chordSymbol;
    const identical =
      prev.length === curr.length && prev.every((p, idx) => p === curr[idx]);
    if (chordChanged && identical && slots[i].chordSymbol !== null) {
      const prevChord = slots[i - 1].chordSymbol ? parseChordSymbol(slots[i - 1].chordSymbol as string) : null;
      const currChord = slots[i].chordSymbol ? parseChordSymbol(slots[i].chordSymbol as string) : null;
      // Only a violation when the chords genuinely differ in pitch content.
      const samePcs =
        prevChord && currChord &&
        prevChord.pcs.size === currChord.pcs.size &&
        [...prevChord.pcs].every((pc) => currChord.pcs.has(pc));
      if (!samePcs) {
        violations.push(
          `slots ${i - 1}→${i}: chord changed (${slots[i - 1].chordSymbol} → ${slots[i].chordSymbol}) but the voicing did not`
        );
      }
    }
  }

  return violations;
}
