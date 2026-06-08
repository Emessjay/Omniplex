import { describe, expect, it } from "vitest";
import {
  action,
  frame,
  frameToText,
  line,
  lineToText,
  text,
  textFrame,
} from "./helpers";
import { completeCommand, COMMANDS } from "./completion";

// NOTE: the scaffold's "submitCommand stub" tests were removed by `command-core`.
// `submitCommand` is no longer a client-side echo stub — it now delegates to the
// `runCommand` server action (which resolves the authed player and runs the real
// game pipeline), so it can't be exercised in a node unit test and the echo
// behavior it used to assert no longer exists. The render-frame builders and
// tab-completion below are unchanged and still covered.

describe("render-frame builders", () => {
  it("builds a plain text span without a style key when none given", () => {
    expect(text("hi")).toEqual({ kind: "text", text: "hi" });
    expect(text("hi", "muted")).toEqual({ kind: "text", text: "hi", style: "muted" });
  });

  it("builds an action span carrying its command and optional fields", () => {
    expect(action("warp Kepler", "warp 3 12 4")).toEqual({
      kind: "action",
      text: "warp Kepler",
      command: "warp 3 12 4",
    });
    expect(action("buy", "buy fuel", { style: "accent", title: "refuel" })).toEqual({
      kind: "action",
      text: "buy",
      command: "buy fuel",
      style: "accent",
      title: "refuel",
    });
  });

  it("normalizes a single span into a one-element line", () => {
    expect(line(text("solo"))).toEqual([{ kind: "text", text: "solo" }]);
  });

  it("flattens lines and frames to visible text, ignoring styling", () => {
    const l = line([text("> ", "muted"), action("go", "warp"), text(" now")]);
    expect(lineToText(l)).toBe("> go now");

    const f = frame([line(text("a")), line(text("b"))]);
    expect(frameToText(f)).toEqual(["a", "b"]);
  });

  it("textFrame produces one line per string", () => {
    const f = textFrame(["line one", "line two"], "heading");
    expect(f.lines).toHaveLength(2);
    expect(frameToText(f)).toEqual(["line one", "line two"]);
    expect(f.lines[0]?.[0]?.style).toBe("heading");
  });
});

describe("tab completion", () => {
  it("returns the full command list for empty input", () => {
    expect(completeCommand("")).toEqual([...COMMANDS]);
    expect(completeCommand("   ")).toEqual([...COMMANDS]);
  });

  it("filters by verb prefix and matches only the first token", () => {
    expect(completeCommand("w")).toEqual(["warp", "who"]);
    expect(completeCommand("inv")).toEqual(["inventory"]);
    expect(completeCommand("warp Kep")).toEqual(["warp"]);
    expect(completeCommand("zzz")).toEqual([]);
  });
});
