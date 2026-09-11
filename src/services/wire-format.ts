// Per-document wire-format negotiation.
// Pure: the auth and disconnect handlers feed it what they read and act on the result.

export type WireFormat = "ecies" | "xchacha";

const KNOWN: readonly WireFormat[] = ["ecies", "xchacha"];

// Dedupe so a hostile wireFormats array is never stored verbatim on socket.data: the
// Redis adapter serialises socket.data on every cross-instance fetchSockets.
export const normalizeWireFormats = (value: unknown): WireFormat[] => {
  if (!Array.isArray(value)) return ["ecies"];
  const kept = [...new Set(value.filter((v): v is WireFormat => KNOWN.includes(v as WireFormat)))];
  return kept.length ? kept : ["ecies"];
};

export const supportsXChaCha = (formats: WireFormat[]): boolean => formats.includes("xchacha");

export interface WireResolution {
  announce: WireFormat;
  lock: boolean;
  refuse: boolean;
}

export function resolveWireFormat(input: {
  locked: boolean;
  target: WireFormat;
  roomFormats: WireFormat[][];
  joiningFormats: WireFormat[];
}): WireResolution {
  const joinerOk = supportsXChaCha(input.joiningFormats);
  if (input.locked) {
    return { announce: "xchacha", lock: false, refuse: !joinerOk };
  }
  if (input.target !== "xchacha") {
    return { announce: "ecies", lock: false, refuse: false };
  }
  const allOk = joinerOk && input.roomFormats.every(supportsXChaCha);
  return allOk
    ? { announce: "xchacha", lock: true, refuse: false }
    : { announce: "ecies", lock: false, refuse: false };
}
