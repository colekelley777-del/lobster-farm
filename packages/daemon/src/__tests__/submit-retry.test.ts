import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ──

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFileSync: vi.fn().mockImplementation(() => {
      throw new Error("not mocked");
    }),
    spawn: vi.fn(),
  };
});

import { execFileSync } from "node:child_process";
import { send_keys_with_submit_retry } from "../pool.js";

/**
 * Build an execFileSync mock that:
 *  - records every send-keys invocation (so we can count Enter re-sends)
 *  - returns a scripted sequence of capture-pane outputs (one per poll)
 *
 * Once the scripted outputs are exhausted, the last value repeats — this lets a
 * test simulate "input box stays stuck forever" with a single trailing value.
 */
function mock_pane(pane_outputs: string[], message: string) {
  const send_keys_calls: string[][] = [];
  let poll = 0;

  (execFileSync as Mock).mockImplementation((cmd: string, args: string[]) => {
    if (cmd === "tmux" && args[0] === "send-keys") {
      send_keys_calls.push(args);
      return "";
    }
    if (cmd === "tmux" && args[0] === "capture-pane") {
      const idx = Math.min(poll, pane_outputs.length - 1);
      poll++;
      return pane_outputs[idx] ?? `❯ ${message}`;
    }
    return "";
  });

  return {
    send_keys_calls,
    /** Number of times Enter (with or without text) was sent. */
    submit_count: () => send_keys_calls.length,
    /** Number of bare-Enter re-sends: ["send-keys", "-t", <session>, "Enter"].
     * The initial submit is ["send-keys", "-t", <session>, <message>, "Enter"]
     * (length 5), so a length-4 call is a retry. */
    retry_count: () => send_keys_calls.filter((a) => a.length === 4 && a[3] === "Enter").length,
  };
}

/**
 * Build an execFileSync mock where `send-keys` succeeds but every `capture-pane`
 * THROWS — simulating a dead/killed session whose pane can't be read. The
 * retry loop must treat this as indeterminate (never a confirmed submit).
 */
function mock_pane_capture_fails() {
  const send_keys_calls: string[][] = [];

  (execFileSync as Mock).mockImplementation((cmd: string, args: string[]) => {
    if (cmd === "tmux" && args[0] === "send-keys") {
      send_keys_calls.push(args);
      return "";
    }
    if (cmd === "tmux" && args[0] === "capture-pane") {
      throw new Error("can't find pane: session not found");
    }
    return "";
  });

  return {
    send_keys_calls,
    retry_count: () => send_keys_calls.filter((a) => a.length === 4 && a[3] === "Enter").length,
  };
}

// ── Tests ──

describe("send_keys_with_submit_retry", () => {
  const MSG = "hold until I delete the repo";

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("confirms immediately when the turn starts (esc to interrupt)", async () => {
    // Pane shows the active-generation indicator on the first poll.
    const m = mock_pane(["✶ Thinking… (esc to interrupt)"], MSG);

    const p = send_keys_with_submit_retry("pool-4", MSG, { poll_ms: 50, confirm_ms: 400 });
    await vi.advanceTimersByTimeAsync(500);
    expect(await p).toBe(true);

    // One send (text + Enter), no retries.
    expect(m.retry_count()).toBe(0);
  });

  it("confirms when the input box clears (text no longer present)", async () => {
    // Pane no longer echoes the typed text → submit landed.
    const m = mock_pane(["❯ "], MSG);

    const p = send_keys_with_submit_retry("pool-4", MSG, { poll_ms: 50, confirm_ms: 400 });
    await vi.advanceTimersByTimeAsync(500);
    expect(await p).toBe(true);
    expect(m.retry_count()).toBe(0);
  });

  it("re-sends Enter when text sits unsubmitted, then succeeds", async () => {
    // First confirm window: text still in the box. After the retry Enter, the
    // turn starts → confirmed.
    //
    // With confirm_ms=150 and poll_ms=100 two polls happen per window (at
    // 100ms and 200ms). A baseline pane read happens BEFORE the initial
    // send, so the sequence is: [baseline, poll-1, poll-2, retry-poll-1].
    const m = mock_pane(
      [
        `❯ ${MSG}`, // baseline (pre-send) — baseline_was_running=false
        `❯ ${MSG}`, // poll 1 (100ms) — still unsubmitted
        `❯ ${MSG}`, // poll 2 (200ms) — still unsubmitted (window expires → retry)
        "✶ Working… (esc to interrupt)", // retry poll 1 — turn started
      ],
      MSG,
    );

    const p = send_keys_with_submit_retry("pool-4", MSG, {
      poll_ms: 100,
      confirm_ms: 150,
      max_retries: 3,
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(await p).toBe(true);

    // Exactly one bare-Enter retry was needed.
    expect(m.retry_count()).toBe(1);
  });

  it("logs a warning when a retry was needed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Same layout as above: baseline + 2 window-0 polls (both stuck) + retry poll
    const m = mock_pane([`❯ ${MSG}`, `❯ ${MSG}`, `❯ ${MSG}`, "esc to interrupt"], MSG);

    const p = send_keys_with_submit_retry("pool-4", MSG, {
      poll_ms: 100,
      confirm_ms: 150,
      max_retries: 3,
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(await p).toBe(true);

    expect(m.retry_count()).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("re-sending Enter"));
    warn.mockRestore();
  });

  it("gives up after bounded retries when text never submits", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Input box stays stuck forever (single trailing value repeats).
    const m = mock_pane([`❯ ${MSG}`], MSG);

    const p = send_keys_with_submit_retry("pool-4", MSG, {
      poll_ms: 100,
      confirm_ms: 150,
      max_retries: 2,
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(await p).toBe(false);

    // Bounded: exactly max_retries bare-Enter re-sends, no infinite loop.
    expect(m.retry_count()).toBe(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Submit never confirmed"));
    warn.mockRestore();
  });

  it("does not warn on the happy path", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mock_pane(["esc to interrupt"], MSG);

    const p = send_keys_with_submit_retry("pool-4", MSG, { poll_ms: 50, confirm_ms: 400 });
    await vi.advanceTimersByTimeAsync(500);
    expect(await p).toBe(true);

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("does not false-positive confirm when the pane read fails — retries then gives up", async () => {
    // Capture-pane throws on every poll (dead/killed session). A failed read is
    // indeterminate, NOT "input box empty → submitted": the loop must keep
    // retrying and then give up rather than reporting a phantom success (#65).
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const m = mock_pane_capture_fails();

    const p = send_keys_with_submit_retry("pool-4", MSG, {
      poll_ms: 100,
      confirm_ms: 150,
      max_retries: 2,
    });
    await vi.advanceTimersByTimeAsync(3000);

    // Must NOT report a false-positive confirmation.
    expect(await p).toBe(false);
    // Bounded: exactly max_retries bare-Enter re-sends, no infinite loop.
    expect(m.retry_count()).toBe(2);
    // The pane-unreadable failure is surfaced, and the give-up is logged.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Pane read failed"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not confirm submit"));
    warn.mockRestore();
  });

  // ── Baseline false-positive hardening (issue #316) ──

  it("does NOT false-positive when 'esc to interrupt' was ALREADY in the pane before send (prior turn)", async () => {
    // Scenario: a prior turn's "esc to interrupt" is still showing when
    // send_keys_with_submit_retry is called.  The first pane read (for the
    // baseline) sees the indicator.  Post-send pane ALSO shows it — but our
    // message text is still in the box, unsubmitted.
    //
    // Old code: returned true immediately (false positive — the prior turn's
    // indicator counted as confirmation).
    // New code: baseline_was_running = true → "esc to interrupt" alone is not
    // enough; we also require the message text to have cleared.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let call_count = 0;
    (execFileSync as Mock).mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "tmux" && args[0] === "send-keys") return "";
      if (cmd === "tmux" && args[0] === "capture-pane") {
        call_count++;
        // Baseline (call 0 — before send): prior turn running
        if (call_count === 1) return "✶ Thinking… (esc to interrupt)\n❯ ";
        // Post-send polls: prior turn STILL running, our text now in box
        if (call_count <= 3) return `✶ Still going… (esc to interrupt)\n❯ ${MSG}`;
        // Eventually our turn starts (text cleared, new "esc to interrupt")
        return "✶ New turn (esc to interrupt)";
      }
      return "";
    });

    const p = send_keys_with_submit_retry("pool-4", MSG, {
      poll_ms: 100,
      confirm_ms: 150,
      max_retries: 3,
    });
    await vi.advanceTimersByTimeAsync(3000);
    // Should eventually confirm once the text clears (new turn), not on the first poll
    expect(await p).toBe(true);
    warn.mockRestore();
  });

  it("confirms immediately when 'esc to interrupt' appears freshly (baseline was NOT running)", async () => {
    // Baseline: bot was at prompt (no "esc to interrupt"). Post-send: turn
    // started — "esc to interrupt" is fresh confirmation (not a pre-existing one).
    let call_count = 0;
    (execFileSync as Mock).mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "tmux" && args[0] === "send-keys") return "";
      if (cmd === "tmux" && args[0] === "capture-pane") {
        call_count++;
        if (call_count === 1) return "❯ "; // baseline: at prompt, no prior turn
        return "✶ Thinking… (esc to interrupt)";
      }
      return "";
    });

    const p = send_keys_with_submit_retry("pool-4", MSG, { poll_ms: 50, confirm_ms: 400 });
    await vi.advanceTimersByTimeAsync(500);
    expect(await p).toBe(true);
  });
});
