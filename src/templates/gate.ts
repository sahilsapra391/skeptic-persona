import type { Gate, Payload } from "./types";

// Gate evaluator. One absence choke point before every leaf operator: a
// missing field can never satisfy ANY op, including the negative ones (a
// naive `neq` on a missing field returns true and publishes a claim about
// data we never parsed). Numeric ops never coerce.

function lookup(payload: Payload, field: string): unknown {
  // Dotted paths for nested parsed structures (e.g. "issuer.ticker").
  if (!field.includes(".")) return payload[field];
  let cur: unknown = payload;
  for (const part of field.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Present and meaningful. NOTE: 0 and false ARE present — only null/undefined/"" are not. */
function present(v: unknown): boolean {
  return v !== undefined && v !== null && v !== "";
}

export function evaluateGate(gate: Gate, payload: Payload): boolean {
  switch (gate.op) {
    case "all":
      return gate.of.every((g) => evaluateGate(g, payload));
    case "any":
      return gate.of.some((g) => evaluateGate(g, payload));
    default:
      break;
  }

  const value = lookup(payload, gate.field);
  // THE CHOKE POINT: absence satisfies nothing.
  if (!present(value)) return false;

  switch (gate.op) {
    case "has":
      // Empty arrays are absence for gating purposes.
      return Array.isArray(value) ? value.length > 0 : true;
    case "eq":
      return value === gate.value;
    case "neq":
      return value !== gate.value;
    case "gte":
    case "lte":
    case "gt":
    case "lt": {
      if (typeof value !== "number" || !Number.isFinite(value)) return false; // no coercion
      if (gate.op === "gte") return value >= gate.value;
      if (gate.op === "lte") return value <= gate.value;
      if (gate.op === "gt") return value > gate.value;
      return value < gate.value;
    }
    case "includes":
      return Array.isArray(value) && value.includes(gate.value);
    case "gtField": {
      const other = lookup(payload, gate.other);
      if (!present(other)) return false;
      if (typeof value !== "number" || typeof other !== "number") return false;
      if (!Number.isFinite(value) || !Number.isFinite(other)) return false;
      return value > other;
    }
    default:
      return false;
  }
}

/** Every field name a gate reads — used by the doctrine tests and the audit. */
export function gateFields(gate: Gate): string[] {
  if (gate.op === "all" || gate.op === "any") return gate.of.flatMap(gateFields);
  if (gate.op === "gtField") return [gate.field, gate.other];
  return [gate.field];
}
