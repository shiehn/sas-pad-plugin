/**
 * Prompt builder for the ONE schema-forced pad call. The grid owns all
 * timing, so the prompt's whole job is to make voice-leading effortless:
 * every voicing slot is listed with its bar span and chord symbol, and the
 * model is told to hold common tones and move stepwise.
 */

import type { PadVoicingMode, PadVoicingSlot } from './pad-patterns';
import {
  FULL_VOICING_MAX_NOTES,
  PAD_REGISTER_HIGH,
  PAD_REGISTER_LOW,
  PARTIAL_VOICING_MAX_NOTES,
} from './pad-enforce';

export function buildPadSystemPrompt(
  slots: readonly PadVoicingSlot[],
  voicing: PadVoicingMode
): string {
  const voicingRule =
    voicing === 'partial'
      ? `- PARTIAL voicing: 2-${PARTIAL_VOICING_MAX_NOTES} notes per slot — guide tones first (3rd and 7th), root only when it helps the line.`
      : `- FULL voicing: 4-${FULL_VOICING_MAX_NOTES} notes per slot — root, 3rd, 7th (or 5th), plus at most one color tone (9th, added tone) that stays inside the printed chord's scale.`;

  const slotLines = slots
    .map(
      (s) =>
        `  slot ${s.index}: bar ${s.bar + 1}, beats ${s.startBeat}-${s.endBeat}, chord ${s.chordSymbol ?? '(none — voice freely in key)'}`
    )
    .join('\n');

  return [
    'You are a pad voicing arranger. You voice a chord progression for a sustained pad instrument.',
    'The rhythm, durations, and patch rotation are already decided — you ONLY choose the pitches of each voicing.',
    '',
    'Rules:',
    `- Register: every pitch in MIDI ${PAD_REGISTER_LOW}-${PAD_REGISTER_HIGH} (C3-E5). Pads sit in the mid register — no bass notes, no lead lines.`,
    voicingRule,
    '- Voice-leading is the whole job: hold common tones between consecutive slots and move each voice by 2 semitones or less where possible. Never jump the whole voicing.',
    '- Use only chord tones plus in-key color tones. When the chord repeats across slots, vary the voicing subtly (inversion, drop a doubling) rather than copying it.',
    '',
    `Voice these ${slots.length} slots (submit ALL of them via submit_pads, in order):`,
    slotLines,
  ].join('\n');
}

export function buildPadRetrySuffix(violations: string[]): string {
  return [
    '',
    '',
    'Your previous submission had voice-leading problems:',
    ...violations.map((v) => `- ${v}`),
    'Submit the full set of slots again with these fixed. Keep everything else as close as possible.',
  ].join('\n');
}
