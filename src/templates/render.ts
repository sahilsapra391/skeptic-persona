import { evaluateGate } from "./gate";
import { POST_TEXT_LIMIT, weightedLength } from "./length";
import type { Archetype, Beat, MediaRef, Payload } from "./types";

// The renderer. Pure and synchronous: payload + rotation state in, post out.
// Structural law (persona.md §3): [fact lines + attribution] then optionally
// ONE beat on its own line, never blended. The fact block must survive being
// screenshotted alone, so the beat is always separated by a blank line and is
// always the last thing in the post.

const BEAT_SEPARATOR = "\n\n";

export interface RotationState {
  /** Skeleton ids used by the most recent posts of this archetype, newest first. */
  readonly recentSkeletons: readonly string[];
  /** Beat ids used by the most recent posts of this archetype, newest first. */
  readonly recentBeats: readonly string[];
}

export const EMPTY_ROTATION: RotationState = { recentSkeletons: [], recentBeats: [] };

export interface RenderedPost {
  readonly ok: true;
  readonly text: string;
  readonly skeletonId: string;
  readonly beatId: string | null;
  readonly beatTier: string | null;
  readonly media: readonly MediaRef[];
}

export type RenderResult = RenderedPost | { readonly ok: false; readonly reason: string };

/** Deterministic 32-bit FNV-1a. Seeded on the item's dedup key so a
 *  re-render produces byte-identical text: what was approved is what posts. */
export function seedHash(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // Avalanche finalizer. FNV-1a's low bits track the last byte, so sequential
  // item ids would pick beats in a fixed cycle — a machine-detectable pattern,
  // which is precisely the spam signal rotation exists to avoid.
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** Interpolate `{slot}` markers. Fails CLOSED on a missing slot.
 *  Checks `undefined || ""` and NEVER falsiness: a parsed 0 is a real value. */
export function fillSlots(text: string, payload: Payload): string | null {
  const markers = text.match(/\{([a-zA-Z0-9_.]+)\}/g);
  if (!markers) return text;
  let out = text;
  for (const marker of markers) {
    const field = marker.slice(1, -1);
    const raw = field.includes(".")
      ? field.split(".").reduce<unknown>((acc, k) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[k] : undefined), payload)
      : payload[field];
    if (raw === undefined || raw === null || raw === "") return null;
    out = out.split(marker).join(String(raw));
  }
  return out;
}

/**
 * Pick a beat: eligible (gate passes, slots fill, not recently used), then
 * deterministic by seed. `signature` tier beats are excluded from normal
 * rotation and only surface when explicitly allowed.
 *
 * Rotation FAILS TO NO BEAT, never to a repeat — a post with only the fact is
 * always doctrine-valid, a repeated beat is a spam signal.
 */
export function pickBeat(
  archetype: Archetype,
  payload: Payload,
  rotation: RotationState,
  seed: number,
  opts: { allowSignature?: boolean } = {},
): { beat: Beat; text: string } | null {
  for (const guard of archetype.guards ?? []) {
    if (!guard.ok(payload)) return null;
  }

  const candidates: Array<{ beat: Beat; text: string }> = [];
  for (const beat of archetype.beats) {
    if (beat.tier === "signature" && !opts.allowSignature) continue;
    if (!evaluateGate(beat.when, payload)) continue;
    const text = fillSlots(beat.text, payload);
    if (text === null) continue; // slot missing -> ineligible, never blank
    candidates.push({ beat, text });
  }
  if (candidates.length === 0) return null;

  // Prefer escalation/signature tiers when they qualify: the absurd case is
  // the point of having them.
  const rank = (t: string): number => (t === "signature" ? 0 : t === "escalation" ? 1 : 2);
  const best = Math.min(...candidates.map((c) => rank(c.beat.tier)));
  const tiered = candidates.filter((c) => rank(c.beat.tier) === best);

  const fresh = tiered.filter((c) => !rotation.recentBeats.includes(c.beat.id));
  if (fresh.length === 0) return null; // exhausted -> no beat, never a repeat
  return fresh[seed % fresh.length] ?? null;
}

/**
 * Resolve an archetype's attribution against the payload.
 *
 * A plain string is the common case. A map means the archetype serves more
 * than one primary source (CONGRESS_PTR covers both chambers), and the
 * payload names which. The map is closed: the payload picks a key, it can
 * never supply the citation text, so a malformed payload cannot invent a
 * source. Absent or unrecognised key -> null -> the caller refuses to render.
 */
export function resolveAttribution(archetype: Archetype, payload: Payload): string | null {
  const a = archetype.attribution;
  if (typeof a === "string") return a;
  const key = payload[a.field];
  if (typeof key !== "string") return null;
  return Object.prototype.hasOwnProperty.call(a.map, key) ? (a.map[key] ?? null) : null;
}

export function renderPost(
  archetype: Archetype,
  payload: Payload,
  opts: { seed: string; rotation?: RotationState; allowSignature?: boolean },
): RenderResult {
  const rotation = opts.rotation ?? EMPTY_ROTATION;
  const seed = seedHash(opts.seed);

  const buildable = archetype.skeletons
    .map((s) => ({ skeleton: s, out: s.build(payload) }))
    .filter((x): x is { skeleton: (typeof archetype.skeletons)[number]; out: NonNullable<ReturnType<(typeof archetype.skeletons)[number]["build"]>> } => x.out !== null);
  // Attribution before anything else: an archetype serving two chambers must
  // never inherit the other one's source. Unresolvable means no post, not a
  // guessed citation — every post carries its OWN source (non-negotiable #2).
  const attribution = resolveAttribution(archetype, payload);
  if (attribution === null) return { ok: false, reason: "no_attribution" };

  if (buildable.length === 0) return { ok: false, reason: "no_eligible_skeleton" };

  const freshSkeletons = buildable.filter((b) => !rotation.recentSkeletons.includes(b.skeleton.id));
  const pool = freshSkeletons.length > 0 ? freshSkeletons : buildable; // skeletons may repeat if exhausted; beats may not

  const picked = pickBeat(archetype, payload, rotation, seed, { allowSignature: opts.allowSignature });

  // Try skeletons in seed order and take the first whose fact block fits: a
  // verbose variant must not sink an otherwise publishable filing.
  let chosen: (typeof pool)[number] | null = null;
  let factBlock = "";
  for (let i = 0; i < pool.length; i++) {
    const candidate = pool[(seed + i) % pool.length]!;
    const lines = [...candidate.out.lines];
    // BLENDING GUARD: a blank line inside the fact block would create a
    // second beat-position line and misplace attribution.
    if (lines.some((l) => l.includes("\n\n"))) continue;
    // Attribution attaches to the HEAD line — the claim — not to whatever
    // item title happens to be last (persona.md §6).
    lines[0] = `${lines[0]}, ${attribution}`;
    const block = lines.join("\n");
    if (weightedLength(block) <= POST_TEXT_LIMIT) {
      chosen = candidate;
      factBlock = block;
      break;
    }
  }
  if (!chosen) return { ok: false, reason: "over_budget" };

  let text = factBlock;
  if (picked) {
    const withBeat = `${factBlock}${BEAT_SEPARATOR}${picked.text}`;
    // The fact block is never sacrificed for a beat: if the post would
    // exceed the limit, the beat is what gets dropped.
    if (weightedLength(withBeat) <= POST_TEXT_LIMIT) text = withBeat;
  }

  return {
    ok: true,
    text,
    skeletonId: chosen.skeleton.id,
    beatId: text === factBlock ? null : (picked?.beat.id ?? null),
    beatTier: text === factBlock ? null : (picked?.beat.tier ?? null),
    media: chosen.out.media ?? [],
  };
}
