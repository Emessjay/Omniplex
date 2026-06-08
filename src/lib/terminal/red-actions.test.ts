import { describe, expect, it } from "vitest";
import { action, actionStyle } from "./helpers";
import type { ActionSpan } from "./types";

/**
 * The "red = unperformable" action convention (P9b): an `ActionSpan` can carry
 * an optional `disabled` flag, and the renderer colors a disabled action with
 * the `danger` (red) intent instead of the usual `link` (blue) — color-only, so
 * theme parity holds. The token stays clickable either way. `actionStyle` is the
 * pure color-choice the `<Terminal>` renderer uses, tested here without React.
 */
describe("action() disabled flag", () => {
  it("omits `disabled` by default (back-compatible)", () => {
    expect(action("mine iron", "mine iron")).toEqual({
      kind: "action",
      text: "mine iron",
      command: "mine iron",
    });
    // Falsey disabled is not serialized, so existing snapshots/call sites hold.
    expect(action("mine iron", "mine iron", { disabled: false }).disabled).toBeUndefined();
  });

  it("sets `disabled: true` when requested, preserving style/title", () => {
    expect(
      action("buy shields", "buy ablative_shields", {
        style: "link",
        title: "out of stock",
        disabled: true,
      }),
    ).toEqual({
      kind: "action",
      text: "buy shields",
      command: "buy ablative_shields",
      style: "link",
      title: "out of stock",
      disabled: true,
    });
  });
});

describe("actionStyle (renderer color choice)", () => {
  it("maps a disabled action to the danger (red) intent, overriding style", () => {
    const span: ActionSpan = {
      kind: "action",
      text: "warp",
      command: "warp 0 0 1",
      style: "link",
      disabled: true,
    };
    expect(actionStyle(span)).toBe("danger");
  });

  it("keeps a performable action at its declared style", () => {
    expect(actionStyle({ kind: "action", text: "x", command: "x", style: "accent" })).toBe(
      "accent",
    );
  });

  it("defaults a styleless performable action to link (blue)", () => {
    expect(actionStyle({ kind: "action", text: "x", command: "x" })).toBe("link");
  });
});
