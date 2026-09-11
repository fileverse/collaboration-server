import { describe, it, expect } from "vitest";
import {
  normalizeWireFormats,
  resolveWireFormat,
  supportsXChaCha,
} from "../../services/wire-format";

const E: ["ecies"] = ["ecies"];
const EX: ["ecies", "xchacha"] = ["ecies", "xchacha"];

describe("normalizeWireFormats", () => {
  it("defaults to ecies for absent, empty or junk input", () => {
    expect(normalizeWireFormats(undefined)).toEqual(["ecies"]);
    expect(normalizeWireFormats([])).toEqual(["ecies"]);
    expect(normalizeWireFormats("xchacha")).toEqual(["ecies"]);
    expect(normalizeWireFormats(["aes", 3])).toEqual(["ecies"]);
  });
  it("keeps known values and drops unknown ones", () => {
    expect(normalizeWireFormats(["xchacha", "nope", "ecies"])).toEqual(["xchacha", "ecies"]);
  });
  it("dedupes a hostile input instead of storing it verbatim", () => {
    expect(normalizeWireFormats(Array(10_000).fill("ecies"))).toEqual(["ecies"]);
  });
  it("supportsXChaCha reads the list", () => {
    expect(supportsXChaCha(E)).toBe(false);
    expect(supportsXChaCha(EX)).toBe(true);
  });
});

describe("resolveWireFormat", () => {
  it("locked: announces xchacha and refuses a joiner without it", () => {
    expect(resolveWireFormat({ locked: true, target: "ecies", roomFormats: [], joiningFormats: E }))
      .toEqual({ announce: "xchacha", lock: false, refuse: true });
    expect(resolveWireFormat({ locked: true, target: "xchacha", roomFormats: [E], joiningFormats: EX }))
      .toEqual({ announce: "xchacha", lock: false, refuse: false });
    expect(resolveWireFormat({ locked: true, target: "xchacha", roomFormats: [], joiningFormats: E }))
      .toEqual({ announce: "xchacha", lock: false, refuse: true });
  });
  it("target off: always ecies, never locks or refuses", () => {
    expect(resolveWireFormat({ locked: false, target: "ecies", roomFormats: [EX], joiningFormats: EX }))
      .toEqual({ announce: "ecies", lock: false, refuse: false });
    expect(resolveWireFormat({ locked: false, target: "ecies", roomFormats: [], joiningFormats: E }))
      .toEqual({ announce: "ecies", lock: false, refuse: false });
  });
  it("target on, empty room, capable joiner: locks", () => {
    expect(resolveWireFormat({ locked: false, target: "xchacha", roomFormats: [], joiningFormats: EX }))
      .toEqual({ announce: "xchacha", lock: true, refuse: false });
  });
  it("target on, capable room, capable joiner: locks", () => {
    expect(resolveWireFormat({ locked: false, target: "xchacha", roomFormats: [EX, EX], joiningFormats: EX }))
      .toEqual({ announce: "xchacha", lock: true, refuse: false });
  });
  it("target on, one old socket in the room: ecies, no lock", () => {
    expect(resolveWireFormat({ locked: false, target: "xchacha", roomFormats: [EX, E], joiningFormats: EX }))
      .toEqual({ announce: "ecies", lock: false, refuse: false });
  });
  it("target on, old joiner: ecies, no lock, no refusal", () => {
    expect(resolveWireFormat({ locked: false, target: "xchacha", roomFormats: [EX], joiningFormats: E }))
      .toEqual({ announce: "ecies", lock: false, refuse: false });
  });
});
