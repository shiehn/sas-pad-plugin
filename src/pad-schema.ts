/**
 * The ONE tool the pad LLM call exposes: `submit_pads`. The schema is
 * deliberately tiny — per-slot PITCHES only. The deterministic grid
 * (pad-patterns.ts) owns all timing and rotation, and velocities are
 * mechanical, so the model's whole job is voicing choice + voice-leading.
 */

import type { PadVoicingSlot } from './pad-patterns';

export const SUBMIT_PADS_TOOL_NAME = 'submit_pads';

/** Gemini functionDeclarations-compatible parameters schema. */
export function buildSubmitPadsParameters(slots: readonly PadVoicingSlot[]): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      slots: {
        type: 'array',
        description:
          `Exactly ${slots.length} voicing slots, one per harmony slot listed in the ` +
          'system prompt, in slotIndex order. Every slot MUST be present.',
        items: {
          type: 'object',
          properties: {
            slotIndex: {
              type: 'integer',
              description: `0-based slot index (0..${slots.length - 1}).`,
            },
            pitches: {
              type: 'array',
              description:
                'The chord voicing for this slot as MIDI note numbers (0-127), ' +
                'low to high. All pitches sound simultaneously.',
              items: { type: 'integer' },
            },
          },
          required: ['slotIndex', 'pitches'],
        },
      },
    },
    required: ['slots'],
  };
}

export interface ParsedPads {
  /** Index-aligned with the grid's voicing slots; null = model omitted it. */
  slotPitches: Array<number[] | null>;
  warnings: string[];
}

/**
 * Defensive parse of the functionCall args. Rounds/clamps pitches, ignores
 * out-of-range slot indexes, collects warnings. Returns null only when
 * nothing usable came back.
 */
export function parsePadArgs(args: unknown, slotCount: number): ParsedPads | null {
  if (!args || typeof args !== 'object') return null;
  const slots = (args as { slots?: unknown }).slots;
  if (!Array.isArray(slots)) return null;

  const slotPitches: Array<number[] | null> = Array.from({ length: slotCount }, () => null);
  const warnings: string[] = [];
  let usable = 0;

  for (const entry of slots) {
    if (!entry || typeof entry !== 'object') {
      warnings.push('dropped a non-object slot entry');
      continue;
    }
    const { slotIndex, pitches } = entry as { slotIndex?: unknown; pitches?: unknown };
    const index = typeof slotIndex === 'number' ? Math.round(slotIndex) : NaN;
    if (!Number.isFinite(index) || index < 0 || index >= slotCount) {
      warnings.push(`dropped slot with out-of-range index ${String(slotIndex)}`);
      continue;
    }
    if (!Array.isArray(pitches)) {
      warnings.push(`slot ${index}: pitches was not an array`);
      continue;
    }
    const clean = pitches
      .filter((p): p is number => typeof p === 'number' && Number.isFinite(p))
      .map((p) => Math.max(0, Math.min(127, Math.round(p))));
    if (clean.length !== pitches.length) {
      warnings.push(`slot ${index}: dropped ${pitches.length - clean.length} non-numeric pitch(es)`);
    }
    slotPitches[index] = clean;
    usable += 1;
  }

  if (usable === 0) return null;
  return { slotPitches, warnings };
}
