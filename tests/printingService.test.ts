import assert from "node:assert/strict";
import test from "node:test";
import type { PrintInstruction } from "../src/shared/types";
import { matchInstruction } from "../src/server/printingService";

const updatedAt = new Date(0).toISOString();
const instructions: PrintInstruction[] = [
  instruction("nexx", "NEXX", ["NEXX"]),
  instruction("scorpion", "SCORPION", ["SCORPION"]),
  instruction("hjc", "HJC", ["HJC"]),
  instruction("shoei", "SHOEI", ["SHOEI", "SHOIE"]),
  instruction("z3-seat-clips", "Z3 Seat Clips", ["Z3", "SEAT"]),
  instruction("z3-visor", "Z3 Visor", ["Z3", "VISOR"])
];

test("matches instruction type from SKU terms", () => {
  assert.equal(matchInstruction(instructions, "NEXX-XWST3")?.id, "nexx");
  assert.equal(matchInstruction(instructions, "HJC-ADAPTER-BLK")?.id, "hjc");
  assert.equal(matchInstruction(instructions, "SHOIE-ADAPTER")?.id, "shoei");
  assert.equal(matchInstruction(instructions, "Z3-SEAT-CLIPS-PAIR")?.id, "z3-seat-clips");
  assert.equal(matchInstruction(instructions, "JW-Z3-SEATBELT-001")?.id, "z3-seat-clips");
  assert.equal(matchInstruction(instructions, "Z3-VISOR-KIT")?.id, "z3-visor");
  assert.equal(matchInstruction(instructions, "JW-KAYAK-CLIP-001"), undefined);
  assert.equal(matchInstruction(instructions, "JW-Z3-GAUGE-001"), undefined);
});

function instruction(id: string, label: string, matchTerms: string[]): PrintInstruction {
  return {
    id,
    label,
    matchTerms,
    title: `${label} Instructions`,
    body: "",
    onHand: 0,
    lowAlert: 8,
    perPage: 4,
    updatedAt
  };
}
