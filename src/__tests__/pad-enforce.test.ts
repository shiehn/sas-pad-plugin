/**
 * The polyphonic mechanical layer: register fold, chord/scale snap, dedupe,
 * priority caps, mud guard, deterministic fallback, strike materialization,
 * and the soft voice-leading analyzer.
 */

import {
  analyzePads,
  enforceVoicing,
  fallbackVoicingFromChord,
  materializeStrikes,
  orderChordPcsByPriority,
  PAD_REGISTER_HIGH,
  PAD_REGISTER_LOW,
  PAD_VELOCITY_STRIKE,
  PAD_VELOCITY_SUSTAIN,
} from '../pad-enforce';
import { parseChordSymbol, scalePcsFor } from '../music-helpers';
import { buildPadSlotGrid, type PadVoicingSlot } from '../pad-patterns';

const Am = parseChordSymbol('Am')!; // pcs {9, 0, 4}
const Cmaj7 = parseChordSymbol('Cmaj7')!; // pcs {0, 4, 7, 11}
const aMinorScale = scalePcsFor('A', 'minor')!;

describe('orderChordPcsByPriority', () => {
  it('orders root → 3rd → 7th → 5th', () => {
    expect(orderChordPcsByPriority(Cmaj7)).toEqual([0, 4, 11, 7]);
  });
});

describe('enforceVoicing', () => {
  it('folds out-of-register pitches into 48-76', () => {
    const { pitches } = enforceVoicing([33, 93], { chord: Am, voicing: 'full' });
    for (const p of pitches) {
      expect(p).toBeGreaterThanOrEqual(PAD_REGISTER_LOW);
      expect(p).toBeLessThanOrEqual(PAD_REGISTER_HIGH);
    }
  });

  it('snaps tones outside chord ∪ scale to the nearest chord tone', () => {
    // C#4 (61): not in Am, not in A minor scale → snaps to C4 (60).
    const { pitches, corrections } = enforceVoicing([61], {
      chord: Am,
      scalePcs: aMinorScale,
      voicing: 'full',
    });
    expect(pitches).toEqual([60]);
    expect(corrections.some((c) => c.includes('snapped'))).toBe(true);
  });

  it('keeps in-scale color tones that are not chord tones', () => {
    // B4 (71): not in Am but in the A minor scale → allowed color.
    const { pitches } = enforceVoicing([71], {
      chord: Am,
      scalePcs: aMinorScale,
      voicing: 'full',
    });
    expect(pitches).toEqual([71]);
  });

  it('dedupes exact repeated pitches but keeps octave doublings', () => {
    const { pitches } = enforceVoicing([60, 60, 72], { chord: Am, voicing: 'full' });
    expect(pitches).toEqual([60, 72]);
  });

  it('caps FULL voicings at 5 and PARTIAL at 3 by chord-tone priority', () => {
    const seven = [48, 52, 55, 59, 60, 64, 67]; // C E G B C E G over Cmaj7
    expect(enforceVoicing(seven, { chord: Cmaj7, voicing: 'full' }).pitches).toHaveLength(5);

    const partial = enforceVoicing(seven, { chord: Cmaj7, voicing: 'partial' }).pitches;
    expect(partial).toHaveLength(3);
    // Guide-tone priority: root, 3rd, 7th survive — the 5th (G) is trimmed.
    const pcs = new Set(partial.map((p) => p % 12));
    expect(pcs.has(7)).toBe(false);
  });

  it('mud guard drops the lower of a tight low-register pair', () => {
    const { pitches, corrections } = enforceVoicing([50, 52, 64], {
      chord: null,
      voicing: 'full',
    });
    expect(pitches).toEqual([52, 64]);
    expect(corrections.some((c) => c.includes('mud guard'))).toBe(true);
  });

  it('fills empty slots with a deterministic chord voicing (never silence)', () => {
    const { pitches, corrections } = enforceVoicing(null, { chord: Am, voicing: 'full' });
    expect(pitches.length).toBeGreaterThanOrEqual(3);
    expect(pitches.every((p) => Am.pcs.has(((p % 12) + 12) % 12))).toBe(true);
    expect(corrections.some((c) => c.includes('fallback'))).toBe(true);
  });
});

describe('fallbackVoicingFromChord', () => {
  it('builds a sorted root-first voicing inside the register', () => {
    const pitches = fallbackVoicingFromChord(Cmaj7, 'full');
    expect(pitches).toEqual([...pitches].sort((a, b) => a - b));
    expect(pitches[0] % 12).toBe(0); // root lowest
    for (const p of pitches) {
      expect(p).toBeGreaterThanOrEqual(PAD_REGISTER_LOW);
      expect(p).toBeLessThanOrEqual(PAD_REGISTER_HIGH);
    }
  });

  it('degrades to a neutral open fifth when no chord info exists', () => {
    expect(fallbackVoicingFromChord(null, 'full')).toEqual([57, 64]);
  });
});

describe('materializeStrikes', () => {
  const grid = buildPadSlotGrid({
    bars: 2,
    voiceCount: 2,
    duration: 'whole',
    rests: 'off',
    chordTiming: [{ symbol: 'Am', startQn: 0, endQn: 8 }],
  });

  it('routes each strike to its rotation voice with exact durations', () => {
    const perVoice = materializeStrikes(grid, [[57, 60], [59, 62]], 'whole');
    expect(perVoice).toHaveLength(2);
    expect(perVoice[0].map((n) => [n.pitch, n.startBeat, n.durationBeats])).toEqual([
      [57, 0, 4],
      [60, 0, 4],
    ]);
    expect(perVoice[1].map((n) => [n.pitch, n.startBeat, n.durationBeats])).toEqual([
      [59, 4, 4],
      [62, 4, 4],
    ]);
  });

  it('uses sustain velocity for whole/half and strike velocity for rhythmic', () => {
    const sustained = materializeStrikes(grid, [[57], [59]], 'whole');
    expect(sustained[0][0].velocity).toBe(PAD_VELOCITY_SUSTAIN);
    const rhythmic = materializeStrikes(grid, [[57], [59]], 'rhythmic');
    expect(rhythmic[0][0].velocity).toBe(PAD_VELOCITY_STRIKE);
  });
});

describe('analyzePads', () => {
  const slots = (symbols: Array<string | null>): PadVoicingSlot[] =>
    symbols.map((chordSymbol, index) => ({
      index,
      bar: index,
      startBeat: index * 4,
      endBeat: index * 4 + 4,
      chordSymbol,
    }));

  it('accepts smooth, compact voicings', () => {
    expect(analyzePads([[57, 60, 64], [57, 60, 65]], slots(['Am', 'F']))).toEqual([]);
  });

  it('flags voicings spanning more than two octaves', () => {
    const v = analyzePads([[48, 76]], slots(['Am']));
    expect(v.some((s) => s.includes('semitones'))).toBe(true);
  });

  it('flags whole-voicing jumps of more than 7 semitones', () => {
    const v = analyzePads([[55, 60, 64], [67, 72, 76]], slots(['Am', 'Am']));
    expect(v.some((s) => s.includes('jumps'))).toBe(true);
  });

  it('flags an unchanged voicing across a REAL chord change', () => {
    const v = analyzePads([[57, 60, 64], [57, 60, 64]], slots(['Am', 'F']));
    expect(v.some((s) => s.includes('chord changed'))).toBe(true);
  });

  it('does not flag repeats over the SAME chord', () => {
    expect(analyzePads([[57, 60, 64], [57, 60, 64]], slots(['Am', 'Am']))).toEqual([]);
  });
});
