/**
 * Tests for the stuck-input watchdog in start_typing_loop (#316).
 *
 * Root cause: when Cole messages a bot mid-turn, the MCP channel plugin
 * delivers the text into the CLI input box but the Enter keystroke is
 * dropped inside the CLI.  The bot returns to the prompt with the text
 * sitting unsubmitted.  The daemon cannot patch the CLI, so it acts as a
 * safety net: if the typing loop detects the same non-empty input text
 * across ≥2 consecutive idle polls, it re-sends Enter.
 *
 * Also tests extract_prompt_input (the pane-parsing helper) and the
 * send_keys_with_submit_retry baseline-was-running hardening (issue #316).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LobsterFarmConfigSchema } from "@lobster-farm/shared";
import type { LobsterFarmConfig } from "@lobster-farm/shared";
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ──

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFileSync: vi.fn().mockReturnValue(""),
    spawn: vi.fn(),
  };
});

vi.mock("discord.js", async () => {
  const actual = await vi.importActual<typeof import("discord.js")>("discord.js");
  return {
    ...actual,
    Client: vi.fn().mockImplementation(() => ({
      on: vi.fn(),
      once: vi.fn(),
      login: vi.fn(),
      destroy: vi.fn(),
      user: null,
      channels: { fetch: vi.fn() },
      guilds: { fetch: vi.fn() },
      application: null,
    })),
  };
});

import { execFileSync } from "node:child_process";
import { DiscordBot, extract_prompt_input } from "../discord.js";
import type { BotPool, PoolBot } from "../pool.js";
import { EntityRegistry } from "../registry.js";

// ── Test helpers ──

let temp_dir: string;

function make_config(): LobsterFarmConfig {
  return LobsterFarmConfigSchema.parse({
    user: { name: "Test" },
    paths: { lobsterfarm_dir: temp_dir },
  });
}

function make_pool_bot(id = 0): PoolBot {
  return {
    id,
    state: "assigned",
    channel_id: "test-channel",
    entity_id: "test-entity",
    archetype: "planner",
    channel_type: "general",
    session_id: null,
    session_confirmed: true,
    tmux_session: `pool-${String(id)}`,
    last_active: new Date(),
    assigned_at: new Date(),
    state_dir: `/tmp/test-pool-${String(id)}`,
    model: null,
    effort: null,
    last_avatar_archetype: null,
    last_avatar_set_at: null,
  };
}

function make_mock_pool(opts?: { idle?: boolean; bot?: PoolBot | null }): BotPool {
  const bot = opts?.bot ?? make_pool_bot();
  return {
    get_assignment: vi.fn().mockReturnValue(opts?.bot === null ? null : bot),
    is_bot_idle: vi.fn().mockReturnValue(opts?.idle ?? false),
    has_stale_oauth: vi.fn().mockReturnValue(false),
    kill_stale_session: vi.fn(),
    release_with_history: vi.fn().mockResolvedValue(undefined),
    set_nickname_handler: vi.fn(),
    set_avatar_handler: vi.fn(),
    on: vi.fn().mockReturnThis(),
  } as unknown as BotPool;
}

class TestDiscordBot extends DiscordBot {
  finalize_calls: string[] = [];

  constructor(config: LobsterFarmConfig, registry: EntityRegistry) {
    super(config, registry);
    (this as unknown as Record<string, unknown>).finalize_status_embed = vi
      .fn()
      .mockImplementation((channel_id: string) => {
        this.finalize_calls.push(channel_id);
        return Promise.resolve();
      });
    (this as unknown as Record<string, unknown>).update_status_embed_from_tmux = vi
      .fn()
      .mockResolvedValue(undefined);
  }

  has_typing_loop(channel_id: string): boolean {
    return (this as unknown as { typing_loops: Map<string, NodeJS.Timeout> }).typing_loops.has(
      channel_id,
    );
  }
}

// ── Setup / teardown ──

beforeEach(async () => {
  temp_dir = await mkdtemp(join(tmpdir(), "lf-watchdog-test-"));
  vi.useFakeTimers({ shouldAdvanceTime: false });
  vi.clearAllMocks();
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(temp_dir, { recursive: true, force: true });
});

// ── extract_prompt_input unit tests ──

describe("extract_prompt_input", () => {
  it("returns null for null pane (unreadable)", () => {
    expect(extract_prompt_input(null)).toBeNull();
  });

  it("returns null when no prompt line is present", () => {
    expect(extract_prompt_input("some output\nmore output")).toBeNull();
  });

  it("returns null when prompt line is empty (nothing typed)", () => {
    expect(extract_prompt_input("output\n❯ ")).toBeNull();
  });

  it("returns the input text when the prompt line has content", () => {
    expect(extract_prompt_input("output\n❯ yes pull a real edge")).toBe("yes pull a real edge");
  });

  it("handles multi-line pane with text below the prompt", () => {
    const pane = "Thinking…\n\n❯ what should we build next\n";
    expect(extract_prompt_input(pane)).toBe("what should we build next");
  });

  it("returns null when 'esc to interrupt' is present (active turn — no input box)", () => {
    const pane = "✶ Working… (esc to interrupt)\n❯ some text";
    expect(extract_prompt_input(pane)).toBeNull();
  });

  it("handles long wrapped text — extracts from the prompt line only", () => {
    // Claude Code wraps long input across multiple lines; the prompt marker
    // is on one line and the overflow is on subsequent lines. extract_prompt_input
    // returns only the text on the ❯ line itself (the first chunk).
    const pane = "❯ first part of a very long message that wraps\ncontinuation text";
    expect(extract_prompt_input(pane)).toBe("first part of a very long message that wraps");
  });

  it("scans from the bottom — finds prompt on last relevant line", () => {
    const pane = "❯ old prompt line\nsome output\n❯ actual current input";
    expect(extract_prompt_input(pane)).toBe("actual current input");
  });
});

// ── Stuck-input watchdog integration tests ──

describe("start_typing_loop — stuck-input watchdog (#316)", () => {
  it("re-sends Enter when the same input text persists across two consecutive idle polls (mid-turn delivery)", () => {
    const config = make_config();
    const registry = new EntityRegistry(config);
    const bot = new TestDiscordBot(config, registry);
    const pool = make_mock_pool({ idle: true });
    bot.set_pool(pool);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // The pane shows a stuck input "yes pull a real edge" — idle, no "← discord"
    (execFileSync as Mock).mockReturnValue("❯ yes pull a real edge\n");

    bot.start_typing_loop("test-channel");

    // Skip past the 15s grace period
    vi.advanceTimersByTime(16000);

    // Poll 1 (post-grace): stuck text observed → stored as watchdog_prev_stuck_text
    // No Enter sent yet — need to see it again
    const call_count_after_first_poll = (execFileSync as Mock).mock.calls.filter(
      (c) => c[0] === "tmux" && c[1][0] === "send-keys",
    ).length;
    expect(call_count_after_first_poll).toBe(0);

    // Poll 2: same stuck text seen again → Enter re-sent
    vi.advanceTimersByTime(4000);

    const send_keys_calls = (execFileSync as Mock).mock.calls.filter(
      (c) => c[0] === "tmux" && c[1][0] === "send-keys",
    );
    expect(send_keys_calls.length).toBe(1);
    expect(send_keys_calls[0]?.[1]).toEqual(["send-keys", "-t", "pool-0", "Enter"]);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Stuck input detected"));
    warn.mockRestore();
  });

  it("does NOT re-send Enter when the text appears only once (single poll — too soon to act)", () => {
    const config = make_config();
    const registry = new EntityRegistry(config);
    const bot = new TestDiscordBot(config, registry);
    const pool = make_mock_pool({ idle: true });
    bot.set_pool(pool);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Text visible in poll 1, then disappears (bot processes it)
    let call_count = 0;
    (execFileSync as Mock).mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "tmux" && args[0] === "capture-pane") {
        call_count++;
        // First call returns stuck text, subsequent return cleared prompt
        return call_count === 1 ? "❯ do something\n" : "❯ ";
      }
      return "";
    });

    bot.start_typing_loop("test-channel");
    vi.advanceTimersByTime(16000); // grace period
    vi.advanceTimersByTime(4000); // poll 1: text seen, stored
    vi.advanceTimersByTime(4000); // poll 2: text gone → not stuck, no Enter

    const send_keys_calls = (execFileSync as Mock).mock.calls.filter(
      (c) => c[0] === "tmux" && c[1][0] === "send-keys",
    );
    expect(send_keys_calls.length).toBe(0);
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("Stuck input"));
    warn.mockRestore();
  });

  it("does NOT re-submit text that was already rescued (deduplication)", () => {
    const config = make_config();
    const registry = new EntityRegistry(config);
    const bot = new TestDiscordBot(config, registry);
    const pool = make_mock_pool({ idle: true });
    bot.set_pool(pool);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Stuck text persists indefinitely (Enter failed to clear it)
    (execFileSync as Mock).mockReturnValue("❯ stuck message\n");

    bot.start_typing_loop("test-channel");
    vi.advanceTimersByTime(16000);

    // Poll 1: text stored
    vi.advanceTimersByTime(4000);
    // Poll 2: same text — rescued, Enter sent once
    vi.advanceTimersByTime(4000);
    // Poll 3: text STILL the same — should NOT re-send (dedup)
    vi.advanceTimersByTime(4000);
    // Poll 4: same
    vi.advanceTimersByTime(4000);

    const send_keys_calls = (execFileSync as Mock).mock.calls.filter(
      (c) => c[0] === "tmux" && c[1][0] === "send-keys",
    );
    expect(send_keys_calls.length).toBe(1); // exactly one rescue
    warn.mockRestore();
  });

  it("does NOT fire the watchdog when 'esc to interrupt' is present (active turn — busy bot)", () => {
    const config = make_config();
    const registry = new EntityRegistry(config);
    const bot = new TestDiscordBot(config, registry);
    const pool = make_mock_pool({ idle: false }); // bot is NOT idle
    bot.set_pool(pool);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Pane shows active generation
    (execFileSync as Mock).mockReturnValue("✶ Thinking… (esc to interrupt)\n❯ queued message text");

    bot.start_typing_loop("test-channel");
    vi.advanceTimersByTime(16000);
    vi.advanceTimersByTime(4000);
    vi.advanceTimersByTime(4000);

    const send_keys_calls = (execFileSync as Mock).mock.calls.filter(
      (c) => c[0] === "tmux" && c[1][0] === "send-keys",
    );
    expect(send_keys_calls.length).toBe(0);
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("Stuck input"));
    warn.mockRestore();
  });

  it("does NOT fire watchdog when '← discord' is present (MCP delivery in flight)", () => {
    const config = make_config();
    const registry = new EntityRegistry(config);
    const bot = new TestDiscordBot(config, registry);
    const pool = make_mock_pool({ idle: true });
    bot.set_pool(pool);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Pane shows MCP delivery indicator alongside input text
    (execFileSync as Mock).mockReturnValue("← discord\n❯ message being delivered");

    bot.start_typing_loop("test-channel");
    vi.advanceTimersByTime(16000);
    vi.advanceTimersByTime(4000);
    vi.advanceTimersByTime(4000);

    const send_keys_calls = (execFileSync as Mock).mock.calls.filter(
      (c) => c[0] === "tmux" && c[1][0] === "send-keys",
    );
    expect(send_keys_calls.length).toBe(0);
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("Stuck input"));
    warn.mockRestore();
  });

  it("handles long wrapped input text — still rescues correctly", () => {
    const config = make_config();
    const registry = new EntityRegistry(config);
    const bot = new TestDiscordBot(config, registry);
    const pool = make_mock_pool({ idle: true });
    bot.set_pool(pool);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const long_text =
      "this is a very long message that wraps across multiple terminal lines and just keeps going";
    (execFileSync as Mock).mockReturnValue(`❯ ${long_text}\ncontinuation`);

    bot.start_typing_loop("test-channel");
    vi.advanceTimersByTime(16000);
    vi.advanceTimersByTime(4000); // poll 1: text stored
    vi.advanceTimersByTime(4000); // poll 2: same text — rescued

    const send_keys_calls = (execFileSync as Mock).mock.calls.filter(
      (c) => c[0] === "tmux" && c[1][0] === "send-keys",
    );
    expect(send_keys_calls.length).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Stuck input detected"));
    warn.mockRestore();
  });

  it("resets idle counter after rescue — requires full IDLE_THRESHOLD to finalize again", () => {
    // After the watchdog rescues a stuck message, consecutive_idle is reset to 0.
    // The typing loop should NOT finalize immediately — it needs another full
    // IDLE_THRESHOLD (3 consecutive idle polls) before declaring the bot idle.
    const config = make_config();
    const registry = new EntityRegistry(config);
    const bot = new TestDiscordBot(config, registry);
    const pool = make_mock_pool({ idle: true });
    bot.set_pool(pool);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // The 16s advance fires 4 ticks: ticks 1-3 are within grace (4s,8s,12s),
    // tick 4 at 16s is the first post-grace tick (poll 1 of idle checks).
    // Pane: stuck text for polls 1 and 2 (rescue fires on poll 2), then empty.
    let capture_poll = 0;
    (execFileSync as Mock).mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "tmux" && args[0] === "capture-pane") {
        capture_poll++;
        if (capture_poll <= 2) return "❯ fix the build\n";
        return "❯ "; // empty prompt after rescue
      }
      return "";
    });

    bot.start_typing_loop("test-channel");
    // Advance 16s: grace-period ticks at 4s,8s,12s + first post-grace tick at 16s
    // 16s tick = poll 1: stuck text stored in watchdog_prev; consecutive_idle=1
    vi.advanceTimersByTime(16000);

    // Poll 2 at 20s: same text → rescue, consecutive_idle reset to 0, return early
    vi.advanceTimersByTime(4000);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Stuck input detected"));

    // consecutive_idle is now 0. Need 3 more idle cycles to finalize.
    // Polls 3,4,5 all see empty prompt — no new stuck text — idle counter climbs.
    vi.advanceTimersByTime(4000); // poll 3: consecutive_idle = 1
    expect(bot.finalize_calls).toHaveLength(0);
    vi.advanceTimersByTime(4000); // poll 4: consecutive_idle = 2
    expect(bot.finalize_calls).toHaveLength(0);
    vi.advanceTimersByTime(4000); // poll 5: consecutive_idle = 3 → finalize
    expect(bot.finalize_calls).toHaveLength(1);

    warn.mockRestore();
  });
});

it("rescues again after active turn clears the dedupe (rescue → active → same text → rescued again)", () => {
  // Sequence:
  //   1. Text "hello" is stuck → rescued (watchdog_last_rescued_text = "hello")
  //   2. Bot becomes active (else-branch runs) → watchdog_last_rescued_text must reset to null
  //   3. Same text "hello" arrives stuck again → must be rescued a second time
  //
  // Without the fix (watchdog_last_rescued_text not cleared in the else-branch),
  // step 3 would be silently suppressed by the stale dedupe — the bug Lancelot flagged.
  const config = make_config();
  const registry = new EntityRegistry(config);
  const bot = new TestDiscordBot(config, registry);

  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

  // Phase control: start idle (stuck), then active, then idle (stuck same text) again.
  // idle_phase tracks which phase we're in:
  //   0 = stuck "hello" (rescue happens here)
  //   1 = active turn (clears dedupe)
  //   2 = stuck "hello" again (second rescue should fire)
  let idle_phase = 0;
  let capture_call = 0;

  const pool: BotPool = {
    get_assignment: vi.fn().mockImplementation(() => make_pool_bot()),
    is_bot_idle: vi.fn().mockImplementation(() => idle_phase !== 1),
    has_stale_oauth: vi.fn().mockReturnValue(false),
    kill_stale_session: vi.fn(),
    release_with_history: vi.fn().mockResolvedValue(undefined),
    set_nickname_handler: vi.fn(),
    set_avatar_handler: vi.fn(),
    on: vi.fn().mockReturnThis(),
  } as unknown as BotPool;

  (execFileSync as Mock).mockImplementation((cmd: string, args: string[]) => {
    if (cmd === "tmux" && args[0] === "capture-pane") {
      capture_call++;
      // Phase 0: polls 1+2 → stuck text (rescue fires on poll 2)
      // Phase 1: active turn — is_bot_idle returns false, pane not read by watchdog path
      // Phase 2: polls back in idle → stuck same text again
      if (idle_phase === 0 || idle_phase === 2) return "❯ hello\n";
      return "❯ "; // should not be reached during active phase
    }
    return "";
  });

  bot.set_pool(pool);
  bot.start_typing_loop("test-channel");

  // The 16s advance fires ticks at 4s,8s,12s,16s. The first three are within the
  // 15s grace period. The tick at 16s is the first post-grace idle poll (poll 1):
  // stuck text "hello" is stored in watchdog_prev_stuck_text but Enter is NOT sent yet
  // (rescue requires the same text across ≥2 consecutive polls).
  vi.advanceTimersByTime(16000);

  let send_calls = (execFileSync as Mock).mock.calls.filter(
    (c) => c[0] === "tmux" && c[1][0] === "send-keys",
  );
  expect(send_calls.length).toBe(0); // poll 1: text stored, no rescue yet

  // Poll 2: same text still stuck → first rescue fires, Enter re-sent
  vi.advanceTimersByTime(4000);
  send_calls = (execFileSync as Mock).mock.calls.filter(
    (c) => c[0] === "tmux" && c[1][0] === "send-keys",
  );
  expect(send_calls.length).toBe(1);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("Stuck input detected"));
  warn.mockClear();

  // Phase 1: bot becomes active (is_bot_idle returns false → else-branch fires).
  // Without the fix, watchdog_last_rescued_text would remain "hello", blocking a
  // future rescue of identical text. The fix clears it here.
  idle_phase = 1;
  vi.advanceTimersByTime(4000); // one active-turn tick — else-branch clears dedupe

  // Phase 2: bot goes idle again with the same stuck text "hello"
  idle_phase = 2;

  // Poll 1 of phase 2: text stored again in watchdog_prev_stuck_text
  vi.advanceTimersByTime(4000);
  send_calls = (execFileSync as Mock).mock.calls.filter(
    (c) => c[0] === "tmux" && c[1][0] === "send-keys",
  );
  expect(send_calls.length).toBe(1); // still just the first rescue

  // Poll 2 of phase 2: same text again → second rescue must fire
  // (would be suppressed without the fix because last_rescued_text still = "hello")
  vi.advanceTimersByTime(4000);
  send_calls = (execFileSync as Mock).mock.calls.filter(
    (c) => c[0] === "tmux" && c[1][0] === "send-keys",
  );
  expect(send_calls.length).toBe(2); // second rescue
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("Stuck input detected"));

  warn.mockRestore();
});

// ── Watchdog does not interfere with arrival at prompt (happy path) ──

describe("start_typing_loop — watchdog does not interfere with normal at-prompt delivery", () => {
  it("does not fire when bot is at prompt with no input text (normal idle state)", () => {
    const config = make_config();
    const registry = new EntityRegistry(config);
    const bot = new TestDiscordBot(config, registry);
    const pool = make_mock_pool({ idle: true });
    bot.set_pool(pool);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Empty prompt — bot is idle, nothing stuck
    (execFileSync as Mock).mockReturnValue("❯ ");

    bot.start_typing_loop("test-channel");
    vi.advanceTimersByTime(16000);
    vi.advanceTimersByTime(4000);
    vi.advanceTimersByTime(4000);
    vi.advanceTimersByTime(4000); // finalizes after IDLE_THRESHOLD

    const send_keys_calls = (execFileSync as Mock).mock.calls.filter(
      (c) => c[0] === "tmux" && c[1][0] === "send-keys",
    );
    expect(send_keys_calls.length).toBe(0);
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("Stuck input"));
    // Typing loop finalizes normally after IDLE_THRESHOLD idle cycles
    expect(bot.finalize_calls).toHaveLength(1);
    warn.mockRestore();
  });
});
