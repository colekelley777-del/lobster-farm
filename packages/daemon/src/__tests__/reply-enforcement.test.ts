/**
 * Tests for reply-enforcement.ts (issue #39).
 *
 * Covers all acceptance-criteria checkboxes from the issue spec:
 *   - text + reply  → ok, no enforcement (Discord-bound + non-bound)
 *   - text + no-reply, bound → block + reminder
 *   - text + no-reply, NOT bound → ok pass-through
 *   - silent turn, bound → heartbeat posted
 *   - silent turn within cooldown → no second heartbeat
 *   - silent turn, NOT bound → no heartbeat, no error
 *   - subagent / sidechain → pass-through
 *   - JSONL flush race → retry loop tolerates a brief absence
 *   - Haiku timeout → graceful fail open
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DiscordBot } from "../discord.js";
import { encode_project_slug } from "../pool.js";
import type { BotPool, PoolBot } from "../pool.js";
import {
  HEARTBEAT_COOLDOWN_MS,
  HEARTBEAT_PREFIX,
  RELAY_DEDUP_MS,
  RELAY_SUFFIX,
  REPLY_REMINDER,
  _reset_cooldown_for_tests,
  evaluate_stop,
  is_discord_bound,
  parse_last_assistant_turn,
  read_last_assistant_turn,
  read_last_assistant_turn_extended,
  resolve_bound_channel,
} from "../reply-enforcement.js";
import type { TurnSummary } from "../reply-enforcement.js";

// ── Test helpers ──

function make_bot(overrides: Partial<PoolBot> & { id: number }): PoolBot {
  return {
    state: "free",
    channel_id: null,
    entity_id: null,
    archetype: null,
    channel_type: null,
    session_id: null,
    session_confirmed: true,
    tmux_session: `pool-${String(overrides.id)}`,
    last_active: null,
    assigned_at: null,
    state_dir: `/tmp/test-${String(overrides.id)}`,
    model: null,
    effort: null,
    last_avatar_archetype: null,
    last_avatar_set_at: null,
    ...overrides,
  };
}

/** Minimal pool stub exposing only the surface evaluate_stop touches. */
function make_pool(bots: PoolBot[]): BotPool {
  return {
    get_assigned_bots(): readonly PoolBot[] {
      return bots.filter((b) => b.state === "assigned");
    },
  } as unknown as BotPool;
}

interface SendCall {
  channel_id: string;
  content: string;
}

function make_discord(): { discord: DiscordBot; sends: SendCall[] } {
  const sends: SendCall[] = [];
  const discord = {
    async send(channel_id: string, content: string) {
      sends.push({ channel_id, content });
    },
  } as unknown as DiscordBot;
  return { discord, sends };
}

/** Build a JSONL "assistant" event with the given content blocks. */
function assistant_line(opts: {
  text?: string;
  tools?: string[];
  is_sidechain?: boolean;
}): string {
  const blocks: Array<Record<string, unknown>> = [];
  if (opts.text !== undefined) {
    blocks.push({ type: "text", text: opts.text });
  }
  for (const name of opts.tools ?? []) {
    blocks.push({ type: "tool_use", id: `t-${name}`, name, input: {} });
  }
  return JSON.stringify({
    type: "assistant",
    isSidechain: opts.is_sidechain === true,
    message: {
      role: "assistant",
      content: blocks,
    },
  });
}

function user_line(): string {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text: "hi" }] },
  });
}

beforeEach(() => {
  _reset_cooldown_for_tests();
});

// ── parse_last_assistant_turn ──

describe("parse_last_assistant_turn", () => {
  it("flags produced_text when last assistant turn has non-empty text", () => {
    const jsonl = `${user_line()}\n${assistant_line({ text: "Hello there." })}\n`;
    const turn = parse_last_assistant_turn(jsonl);
    expect(turn.found).toBe(true);
    expect(turn.produced_text).toBe(true);
    expect(turn.called_reply).toBe(false);
  });

  it("ignores whitespace-only text blocks", () => {
    const jsonl = `${assistant_line({ text: "   \n\t" })}\n`;
    expect(parse_last_assistant_turn(jsonl).produced_text).toBe(false);
  });

  it("flags called_reply when the canonical Discord reply tool is invoked", () => {
    const jsonl = `${assistant_line({
      text: "ok",
      tools: ["mcp__plugin_discord_discord__reply"],
    })}\n`;
    const turn = parse_last_assistant_turn(jsonl);
    expect(turn.called_reply).toBe(true);
    expect(turn.produced_text).toBe(true);
  });

  it("loose-matches future discord-reply-shaped tool names", () => {
    const jsonl = `${assistant_line({ tools: ["discord_v2_reply"] })}\n`;
    expect(parse_last_assistant_turn(jsonl).called_reply).toBe(true);
  });

  it("does not flag non-reply tools as reply", () => {
    const jsonl = `${assistant_line({ tools: ["Bash", "Read", "Edit"] })}\n`;
    const turn = parse_last_assistant_turn(jsonl);
    expect(turn.called_reply).toBe(false);
    expect(turn.tool_summary).toBe("Bash, Read, Edit");
  });

  it("walks backward to the *last* assistant turn, ignoring earlier ones", () => {
    const jsonl = [
      assistant_line({ text: "old reply", tools: ["mcp__plugin_discord_discord__reply"] }),
      user_line(),
      assistant_line({ tools: ["Bash"] }), // last assistant turn = silent
      "",
    ].join("\n");
    const turn = parse_last_assistant_turn(jsonl);
    expect(turn.produced_text).toBe(false);
    expect(turn.called_reply).toBe(false);
    expect(turn.tool_summary).toBe("Bash");
  });

  it("propagates isSidechain marker", () => {
    const jsonl = `${assistant_line({ text: "subagent text", is_sidechain: true })}\n`;
    expect(parse_last_assistant_turn(jsonl).is_sidechain).toBe(true);
  });

  it("returns found=false on empty / no-assistant transcripts", () => {
    expect(parse_last_assistant_turn("").found).toBe(false);
    expect(parse_last_assistant_turn(`${user_line()}\n`).found).toBe(false);
  });

  it("skips malformed lines without throwing", () => {
    const jsonl = `not json\n${assistant_line({ text: "ok" })}\n`;
    expect(parse_last_assistant_turn(jsonl).found).toBe(true);
  });
});

// ── read_last_assistant_turn (filesystem + flush race) ──

describe("read_last_assistant_turn", () => {
  let original_home: string | undefined;
  let temp_home: string;
  let working_dir: string;
  let session_id: string;

  beforeEach(async () => {
    original_home = process.env.HOME;
    temp_home = await mkdtemp(join(tmpdir(), "lf-stop-hook-"));
    process.env.HOME = temp_home;

    working_dir = "/tmp/some-cwd";
    session_id = "11111111-1111-1111-1111-111111111111";

    const project_dir = join(temp_home, ".claude", "projects", encode_project_slug(working_dir));
    await mkdir(project_dir, { recursive: true });
  });

  afterEach(async () => {
    if (original_home !== undefined) {
      process.env.HOME = original_home;
    } else {
      delete process.env.HOME;
    }
    await rm(temp_home, { recursive: true, force: true });
  });

  it("returns found=false when the JSONL doesn't exist", async () => {
    const turn = await read_last_assistant_turn(working_dir, session_id);
    expect(turn.found).toBe(false);
  });

  it("reads the last assistant turn from disk", async () => {
    const path = join(
      temp_home,
      ".claude",
      "projects",
      encode_project_slug(working_dir),
      `${session_id}.jsonl`,
    );
    await writeFile(path, `${assistant_line({ text: "hello" })}\n`, "utf-8");
    const turn = await read_last_assistant_turn(working_dir, session_id);
    expect(turn.found).toBe(true);
    expect(turn.produced_text).toBe(true);
  });

  it("returns found=false on a zero-byte JSONL (empty-file edge case)", async () => {
    // Edge case: file exists but has zero bytes (a flush race window where
    // open() has created the file but no events have landed). The retry loop
    // settles when size stops growing, then the empty-content guard returns
    // found=false so the caller treats this as pass-through.
    const path = join(
      temp_home,
      ".claude",
      "projects",
      encode_project_slug(working_dir),
      `${session_id}.jsonl`,
    );
    await writeFile(path, "", "utf-8");
    const turn = await read_last_assistant_turn(working_dir, session_id);
    expect(turn.found).toBe(false);
    expect(turn.produced_text).toBe(false);
    expect(turn.called_reply).toBe(false);
  });

  it("tolerates a brief flush delay (race mitigation)", async () => {
    const path = join(
      temp_home,
      ".claude",
      "projects",
      encode_project_slug(working_dir),
      `${session_id}.jsonl`,
    );

    // Materialize the file ~25ms after the call begins.
    setTimeout(() => {
      void writeFile(path, `${assistant_line({ text: "late flush" })}\n`, "utf-8");
    }, 25);

    const turn = await read_last_assistant_turn(working_dir, session_id);
    expect(turn.found).toBe(true);
    expect(turn.produced_text).toBe(true);
  });
});

// ── Pool binding ──

describe("resolve_bound_channel / is_discord_bound", () => {
  it("returns the channel_id when an assigned bot owns the session", () => {
    const pool = make_pool([
      make_bot({
        id: 1,
        state: "assigned",
        channel_id: "C123",
        entity_id: "lobster-farm",
        session_id: "S1",
      }),
    ]);
    expect(resolve_bound_channel("S1", pool)).toBe("C123");
    expect(is_discord_bound("S1", pool)).toBe(true);
  });

  it("returns null when no assigned bot owns the session", () => {
    const pool = make_pool([
      make_bot({
        id: 1,
        state: "assigned",
        channel_id: "C123",
        session_id: "S2",
      }),
    ]);
    expect(resolve_bound_channel("S1", pool)).toBeNull();
    expect(is_discord_bound("S1", pool)).toBe(false);
  });

  it("ignores non-assigned bots even with matching session_id", () => {
    const pool = make_pool([
      make_bot({ id: 1, state: "free", session_id: "S1", channel_id: "C-stale" }),
      make_bot({ id: 2, state: "parked", session_id: "S1", channel_id: "C-also-stale" }),
    ]);
    expect(is_discord_bound("S1", pool)).toBe(false);
  });

  it("returns null when pool is null", () => {
    expect(resolve_bound_channel("S1", null)).toBeNull();
    expect(is_discord_bound("S1", null)).toBe(false);
  });

  it("returns null for subagent session_ids (subagent sessions are never in the pool assignment map)", () => {
    // Subagents inherit the parent's working dir but get their own session_id
    // from Claude Code. They are never assigned a pool bot, so they never
    // appear in the assignment map — pool binding is the primary defense
    // against subagent Stop events triggering enforcement.
    const parent_session_id = "parent-S";
    const subagent_session_id = "subagent-S";
    const pool = make_pool([
      make_bot({
        id: 1,
        state: "assigned",
        channel_id: "C123",
        entity_id: "lobster-farm",
        session_id: parent_session_id,
      }),
    ]);
    expect(resolve_bound_channel(subagent_session_id, pool)).toBeNull();
    expect(is_discord_bound(subagent_session_id, pool)).toBe(false);
    // Sanity: the parent still resolves.
    expect(is_discord_bound(parent_session_id, pool)).toBe(true);
  });
});

// ── evaluate_stop orchestrator ──

describe("evaluate_stop — acceptance criteria", () => {
  const session_id = "abc";
  const working_dir = "/tmp/wd";

  function bound_pool(): BotPool {
    return make_pool([
      make_bot({
        id: 1,
        state: "assigned",
        channel_id: "C123",
        entity_id: "lobster-farm",
        session_id,
      }),
    ]);
  }

  function unbound_pool(): BotPool {
    return make_pool([
      make_bot({
        id: 1,
        state: "assigned",
        channel_id: "C123",
        entity_id: "lobster-farm",
        session_id: "different-session",
      }),
    ]);
  }

  function make_turn_reader(turn: Partial<TurnSummary>) {
    return async (): Promise<TurnSummary> => ({
      produced_text: false,
      called_reply: false,
      is_sidechain: false,
      tool_summary: "",
      text_content: "",
      found: true,
      ...turn,
    });
  }

  it("text + reply → ok pass-through (Discord-bound)", async () => {
    const { discord, sends } = make_discord();
    const result = await evaluate_stop(
      { session_id, working_dir },
      {
        pool: bound_pool(),
        discord,
        read_turn: make_turn_reader({ produced_text: true, called_reply: true }),
        make_heartbeat: async () => "should not run",
      },
    );
    expect(result).toEqual({ ok: true });
    expect(sends.length).toBe(0);
  });

  it("text + no-reply, Discord-bound → block + reminder", async () => {
    const { discord, sends } = make_discord();
    const result = await evaluate_stop(
      { session_id, working_dir },
      {
        pool: bound_pool(),
        discord,
        read_turn: make_turn_reader({ produced_text: true, called_reply: false }),
      },
    );
    expect(result).toEqual({ ok: true, block: true, reminder: REPLY_REMINDER });
    // Must NOT post a heartbeat on the blocked path.
    expect(sends.length).toBe(0);
  });

  it("text + no-reply, NOT Discord-bound → pass-through (no enforcement)", async () => {
    const { discord, sends } = make_discord();
    const result = await evaluate_stop(
      { session_id, working_dir },
      {
        pool: unbound_pool(),
        discord,
        read_turn: make_turn_reader({ produced_text: true, called_reply: false }),
      },
    );
    expect(result).toEqual({ ok: true });
    expect(sends.length).toBe(0);
  });

  it("silent turn (tool-only), Discord-bound → posts heartbeat to channel", async () => {
    const { discord, sends } = make_discord();
    const result = await evaluate_stop(
      { session_id, working_dir },
      {
        pool: bound_pool(),
        discord,
        read_turn: make_turn_reader({
          produced_text: false,
          called_reply: false,
          tool_summary: "Bash, Edit",
        }),
        make_heartbeat: async () => "Refactoring the pool resume logic.",
      },
    );
    expect(result).toEqual({ ok: true });
    expect(sends).toEqual([
      {
        channel_id: "C123",
        content: `${HEARTBEAT_PREFIX}Refactoring the pool resume logic.`,
      },
    ]);
  });

  it("silent turn within cooldown window → no second heartbeat", async () => {
    const { discord, sends } = make_discord();
    let now = 1_000_000;
    const deps = {
      pool: bound_pool(),
      discord,
      now: () => now,
      read_turn: make_turn_reader({
        produced_text: false,
        called_reply: false,
        tool_summary: "Bash",
      }),
      make_heartbeat: async () => "Working on something.",
    };

    await evaluate_stop({ session_id, working_dir }, deps);
    expect(sends.length).toBe(1);

    // Same channel, 30 seconds later — well inside the 60s cooldown.
    now += 30_000;
    expect(now - 1_000_000).toBeLessThan(HEARTBEAT_COOLDOWN_MS);
    await evaluate_stop({ session_id, working_dir }, deps);
    expect(sends.length).toBe(1);

    // After cooldown expires, a new heartbeat may post.
    now += HEARTBEAT_COOLDOWN_MS + 1;
    await evaluate_stop({ session_id, working_dir }, deps);
    expect(sends.length).toBe(2);
  });

  it("silent turn, NOT Discord-bound → no heartbeat, no error", async () => {
    const { discord, sends } = make_discord();
    let heartbeat_called = false;
    const result = await evaluate_stop(
      { session_id, working_dir },
      {
        pool: unbound_pool(),
        discord,
        read_turn: make_turn_reader({ produced_text: false, called_reply: false }),
        make_heartbeat: async () => {
          heartbeat_called = true;
          return "should not run";
        },
      },
    );
    expect(result).toEqual({ ok: true });
    expect(sends.length).toBe(0);
    expect(heartbeat_called).toBe(false);
  });

  it("subagent / sidechain transcript → pass-through even on text+no-reply", async () => {
    // Defense-in-depth: even if a sidechain session were somehow bound
    // (it shouldn't be, but the pool check is the only other line of defense),
    // the sidechain marker forces pass-through.
    const { discord, sends } = make_discord();
    const result = await evaluate_stop(
      { session_id, working_dir },
      {
        pool: bound_pool(),
        discord,
        read_turn: make_turn_reader({
          produced_text: true,
          called_reply: false,
          is_sidechain: true,
        }),
      },
    );
    expect(result).toEqual({ ok: true });
    expect(sends.length).toBe(0);
  });

  it("transcript not found → pass-through (no false-positive block)", async () => {
    const { discord, sends } = make_discord();
    const result = await evaluate_stop(
      { session_id, working_dir },
      {
        pool: bound_pool(),
        discord,
        read_turn: make_turn_reader({ found: false }),
      },
    );
    expect(result).toEqual({ ok: true });
    expect(sends.length).toBe(0);
  });

  it("transcript reader throws → fail open (no block)", async () => {
    const { discord, sends } = make_discord();
    const result = await evaluate_stop(
      { session_id, working_dir },
      {
        pool: bound_pool(),
        discord,
        read_turn: async () => {
          throw new Error("boom");
        },
      },
    );
    expect(result).toEqual({ ok: true });
    expect(sends.length).toBe(0);
  });

  it("Haiku heartbeat throws → swallow error, no send, no cooldown burn", async () => {
    const { discord, sends } = make_discord();
    let now = 0;
    const deps = {
      pool: bound_pool(),
      discord,
      now: () => now,
      read_turn: make_turn_reader({ produced_text: false, called_reply: false }),
      make_heartbeat: async () => {
        throw new Error("haiku timed out");
      },
    };
    const result = await evaluate_stop({ session_id, working_dir }, deps);
    expect(result).toEqual({ ok: true });
    expect(sends.length).toBe(0);

    // Cooldown was NOT marked because the send never landed — next call
    // (with a working heartbeat) should be free to post.
    const second = {
      ...deps,
      make_heartbeat: async () => "Now working.",
    };
    now += 1_000;
    await evaluate_stop({ session_id, working_dir }, second);
    expect(sends.length).toBe(1);
  });

  it("mid-turn streaming reply (no text + reply called) → pass-through, no heartbeat", async () => {
    const { discord, sends } = make_discord();
    const result = await evaluate_stop(
      { session_id, working_dir },
      {
        pool: bound_pool(),
        discord,
        read_turn: make_turn_reader({ produced_text: false, called_reply: true }),
        make_heartbeat: async () => "should not run",
      },
    );
    expect(result).toEqual({ ok: true });
    expect(sends.length).toBe(0);
  });

  it("silent turn with bound channel but null discord → pass-through, no Haiku call", async () => {
    // Defends the null-discord short-circuit: if a channel is bound but the
    // discord client somehow isn't wired (partial-startup edge case), we must
    // not burn a Haiku round-trip just to discard it.
    let heartbeat_called = false;
    const result = await evaluate_stop(
      { session_id, working_dir },
      {
        pool: bound_pool(),
        discord: null,
        read_turn: make_turn_reader({ produced_text: false, called_reply: false }),
        make_heartbeat: async () => {
          heartbeat_called = true;
          return "should not run";
        },
      },
    );
    expect(result).toEqual({ ok: true });
    expect(heartbeat_called).toBe(false);
  });

  it("null pool (daemon without Discord) → pass-through", async () => {
    const { discord, sends } = make_discord();
    const result = await evaluate_stop(
      { session_id, working_dir },
      {
        pool: null,
        discord,
        read_turn: make_turn_reader({ produced_text: true, called_reply: false }),
      },
    );
    expect(result).toEqual({ ok: true });
    expect(sends.length).toBe(0);
  });

  // ── Auto-relay tests ──

  it("auto-relay: stranded text → posts to channel with agent label + RELAY_SUFFIX", async () => {
    const relays: Array<{ channel_id: string; content: string }> = [];
    const result = await evaluate_stop(
      { session_id, working_dir },
      {
        pool: bound_pool(),
        discord: null,
        read_turn: make_turn_reader({
          produced_text: true,
          called_reply: false,
          text_content: "Here is the answer you asked for.",
        }),
        send_relay: async (cid, content) => {
          relays.push({ channel_id: cid, content });
        },
      },
    );
    // Still blocks + reminds so agent can retry cleanly.
    expect(result).toEqual({ ok: true, block: true, reminder: REPLY_REMINDER });
    expect(relays).toHaveLength(1);
    expect(relays[0].channel_id).toBe("C123");
    expect(relays[0].content).toContain("Here is the answer you asked for.");
    expect(relays[0].content).toContain(RELAY_SUFFIX);
    // bound_pool() has archetype null (make_bot default), so label falls back to "Agent"
    // Format is **Label:** text  (colon is inside the bold)
    expect(relays[0].content).toMatch(/^\*\*Agent:\*\* /);
  });

  it("auto-relay: empty text_content → no send, still block", async () => {
    const relays: Array<{ channel_id: string; content: string }> = [];
    const result = await evaluate_stop(
      { session_id, working_dir },
      {
        pool: bound_pool(),
        discord: null,
        read_turn: make_turn_reader({
          produced_text: true,
          called_reply: false,
          text_content: "   ",
        }),
        send_relay: async (cid, content) => {
          relays.push({ channel_id: cid, content });
        },
      },
    );
    expect(result).toEqual({ ok: true, block: true, reminder: REPLY_REMINDER });
    expect(relays).toHaveLength(0);
  });

  it("auto-relay: dedup — second stranded turn within window → no second relay", async () => {
    const relays: Array<{ channel_id: string; content: string }> = [];
    let now = 1_000_000;
    const deps = {
      pool: bound_pool(),
      discord: null,
      now: () => now,
      read_turn: make_turn_reader({
        produced_text: true,
        called_reply: false,
        text_content: "An answer.",
      }),
      send_relay: async (cid: string, content: string) => {
        relays.push({ channel_id: cid, content });
      },
    };

    await evaluate_stop({ session_id, working_dir }, deps);
    expect(relays).toHaveLength(1);

    // 30s later — within the 60s dedup window.
    now += 30_000;
    expect(now - 1_000_000).toBeLessThan(RELAY_DEDUP_MS);
    await evaluate_stop({ session_id, working_dir }, deps);
    expect(relays).toHaveLength(1); // no second relay

    // After dedup window expires, relay fires again.
    now += RELAY_DEDUP_MS + 1;
    await evaluate_stop({ session_id, working_dir }, deps);
    expect(relays).toHaveLength(2);
  });

  it("auto-relay: archetype planner → label is Percival", async () => {
    const pool_with_archetype = make_pool([
      make_bot({
        id: 1,
        state: "assigned",
        channel_id: "C123",
        entity_id: "lobster-farm",
        session_id,
        archetype: "planner",
      }),
    ]);
    const relays: Array<{ channel_id: string; content: string }> = [];
    await evaluate_stop(
      { session_id, working_dir },
      {
        pool: pool_with_archetype,
        discord: null,
        read_turn: make_turn_reader({
          produced_text: true,
          called_reply: false,
          text_content: "Plans are afoot.",
        }),
        send_relay: async (cid, content) => {
          relays.push({ channel_id: cid, content });
        },
      },
    );
    expect(relays).toHaveLength(1);
    expect(relays[0].content).toMatch(/^\*\*Percival:\*\* /);
  });

  it("auto-relay: send_relay throws → fail open (block still fires, no throw)", async () => {
    const result = await evaluate_stop(
      { session_id, working_dir },
      {
        pool: bound_pool(),
        discord: null,
        read_turn: make_turn_reader({
          produced_text: true,
          called_reply: false,
          text_content: "Some answer.",
        }),
        send_relay: async () => {
          throw new Error("discord send exploded");
        },
      },
    );
    // Fail open — block still fires.
    expect(result).toEqual({ ok: true, block: true, reminder: REPLY_REMINDER });
  });

  it("auto-relay: unbound session → no relay, no error", async () => {
    const relays: Array<{ channel_id: string; content: string }> = [];
    const result = await evaluate_stop(
      { session_id, working_dir },
      {
        pool: unbound_pool(),
        discord: null,
        read_turn: make_turn_reader({
          produced_text: true,
          called_reply: false,
          text_content: "Stranded but unbound.",
        }),
        send_relay: async (cid, content) => {
          relays.push({ channel_id: cid, content });
        },
      },
    );
    expect(result).toEqual({ ok: true });
    expect(relays).toHaveLength(0);
  });
});

// ── First-turn / cold-start recovery (the "first reply vanishes" bug) ──

describe("first-turn cold-start: JSONL not yet on disk when Stop hook fires", () => {
  const session_id = "first-turn-session";
  const working_dir = "/tmp/wd-first-turn";

  /**
   * Pool with a brand-new bot (session_confirmed === false) — simulates a
   * cold-start where the JSONL hasn't been observed on disk yet.
   */
  function new_session_pool(): BotPool {
    return make_pool([
      make_bot({
        id: 2,
        state: "assigned",
        channel_id: "C-first",
        entity_id: "lobster-farm",
        session_id,
        session_confirmed: false,
      }),
    ]);
  }

  /**
   * Pool with a confirmed bot — JSONL was previously seen. Used to verify
   * the extended-retry path is NOT taken for confirmed sessions.
   */
  function confirmed_pool(): BotPool {
    return make_pool([
      make_bot({
        id: 3,
        state: "assigned",
        channel_id: "C-confirmed",
        entity_id: "lobster-farm",
        session_id,
        session_confirmed: true,
      }),
    ]);
  }

  // ── Core regression test ──

  it("first turn, JSONL never appears → extended reader invoked, relay fires once", async () => {
    // read_turn (standard) → found: false
    // read_turn_extended   → found: true, stranded text
    // Expected: auto-relay posts exactly once, block+reminder returned.
    const relays: Array<{ channel_id: string; content: string }> = [];

    const result = await evaluate_stop(
      { session_id, working_dir },
      {
        pool: new_session_pool(),
        discord: null,
        read_turn: async () => ({
          produced_text: false,
          called_reply: false,
          is_sidechain: false,
          tool_summary: "",
          text_content: "",
          found: false,
        }),
        read_turn_extended: async () => ({
          produced_text: true,
          called_reply: false,
          is_sidechain: false,
          tool_summary: "",
          text_content: "Hello from the first turn!",
          found: true,
        }),
        send_relay: async (cid, content) => {
          relays.push({ channel_id: cid, content });
        },
      },
    );

    expect(result).toEqual({ ok: true, block: true, reminder: REPLY_REMINDER });
    expect(relays).toHaveLength(1);
    expect(relays[0].channel_id).toBe("C-first");
    expect(relays[0].content).toContain("Hello from the first turn!");
    expect(relays[0].content).toContain(RELAY_SUFFIX);
  });

  // ── JSONL flushes after extended delay — relay fires once, never twice ──

  it("first turn, JSONL appears during extended retry → relayed once, not duplicated", async () => {
    // Simulates: standard reader returns found:false, extended reader finds it.
    // dedup window must prevent a second relay if Stop fires again quickly.
    const relays: Array<{ channel_id: string; content: string }> = [];
    let now = 2_000_000;
    const deps = {
      pool: new_session_pool(),
      discord: null,
      now: () => now,
      read_turn: async (): Promise<TurnSummary> => ({
        produced_text: false,
        called_reply: false,
        is_sidechain: false,
        tool_summary: "",
        text_content: "",
        found: false,
      }),
      read_turn_extended: async (): Promise<TurnSummary> => ({
        produced_text: true,
        called_reply: false,
        is_sidechain: false,
        tool_summary: "",
        text_content: "Delayed first reply.",
        found: true,
      }),
      send_relay: async (cid: string, content: string) => {
        relays.push({ channel_id: cid, content });
      },
    };

    // First Stop hook fire — relay should post.
    await evaluate_stop({ session_id, working_dir }, deps);
    expect(relays).toHaveLength(1);

    // Second Stop fire within dedup window — must NOT post again.
    now += 10_000; // 10s later, well inside 60s dedup window
    expect(now - 2_000_000).toBeLessThan(RELAY_DEDUP_MS);
    await evaluate_stop({ session_id, working_dir }, deps);
    expect(relays).toHaveLength(1);
  });

  // ── Bot called reply → no auto-relay (no double-post) ──

  it("first turn, bot called reply → no auto-relay regardless of session_confirmed", async () => {
    // If the bot DID call reply, extended reader finds that — no relay should fire.
    const relays: Array<{ channel_id: string; content: string }> = [];

    const result = await evaluate_stop(
      { session_id, working_dir },
      {
        pool: new_session_pool(),
        discord: null,
        read_turn: async () => ({
          produced_text: false,
          called_reply: false,
          is_sidechain: false,
          tool_summary: "",
          text_content: "",
          found: false,
        }),
        read_turn_extended: async () => ({
          produced_text: true,
          called_reply: true, // bot did call reply
          is_sidechain: false,
          tool_summary: "mcp__plugin_discord_discord__reply",
          text_content: "Properly routed.",
          found: true,
        }),
        send_relay: async (cid, content) => {
          relays.push({ channel_id: cid, content });
        },
      },
    );

    // Normal pass-through: no block, no relay.
    expect(result).toEqual({ ok: true });
    expect(relays).toHaveLength(0);
  });

  // ── Confirmed session: extended reader NOT engaged ──

  it("confirmed session with found:false → extended reader NOT called, fail open", async () => {
    // For a confirmed session the standard found:false path should simply pass
    // through without invoking the expensive extended reader.
    let extended_called = false;

    const result = await evaluate_stop(
      { session_id, working_dir },
      {
        pool: confirmed_pool(),
        discord: null,
        read_turn: async () => ({
          produced_text: false,
          called_reply: false,
          is_sidechain: false,
          tool_summary: "",
          text_content: "",
          found: false,
        }),
        read_turn_extended: async () => {
          extended_called = true;
          return {
            produced_text: true,
            called_reply: false,
            is_sidechain: false,
            tool_summary: "",
            text_content: "Should not be seen.",
            found: true,
          };
        },
        send_relay: async () => {
          throw new Error("should not be called");
        },
      },
    );

    expect(result).toEqual({ ok: true });
    expect(extended_called).toBe(false);
  });

  // ── Extended reader also returns found:false → fail open, no crash ──

  it("first turn, extended reader also returns found:false → fail open, no relay", async () => {
    // Even when both readers give up, we must not throw or block the agent.
    const relays: Array<{ channel_id: string; content: string }> = [];

    const result = await evaluate_stop(
      { session_id, working_dir },
      {
        pool: new_session_pool(),
        discord: null,
        read_turn: async () => ({
          produced_text: false,
          called_reply: false,
          is_sidechain: false,
          tool_summary: "",
          text_content: "",
          found: false,
        }),
        read_turn_extended: async () => ({
          produced_text: false,
          called_reply: false,
          is_sidechain: false,
          tool_summary: "",
          text_content: "",
          found: false,
        }),
        send_relay: async (cid, content) => {
          relays.push({ channel_id: cid, content });
        },
      },
    );

    expect(result).toEqual({ ok: true });
    expect(relays).toHaveLength(0);
  });

  // ── Extended reader throws → fail open, no crash ──

  it("first turn, extended reader throws → fail open gracefully", async () => {
    const result = await evaluate_stop(
      { session_id, working_dir },
      {
        pool: new_session_pool(),
        discord: null,
        read_turn: async () => ({
          produced_text: false,
          called_reply: false,
          is_sidechain: false,
          tool_summary: "",
          text_content: "",
          found: false,
        }),
        read_turn_extended: async () => {
          throw new Error("extended read exploded");
        },
        send_relay: async () => {
          throw new Error("should not be called");
        },
      },
    );

    expect(result).toEqual({ ok: true });
  });

  // ── Non-Discord-bound new session → no-op ──

  it("first turn, unbound session → no extended reader call, no relay", async () => {
    // Even brand-new sessions that aren't Discord-bound should be ignored
    // entirely — the pool check is the first gate.
    let extended_called = false;
    const relays: Array<{ channel_id: string; content: string }> = [];

    const unbound = make_pool([
      make_bot({
        id: 4,
        state: "assigned",
        channel_id: "C-other",
        entity_id: "lobster-farm",
        session_id: "different-session",
        session_confirmed: false,
      }),
    ]);

    const result = await evaluate_stop(
      { session_id, working_dir },
      {
        pool: unbound,
        discord: null,
        read_turn: async () => ({
          produced_text: false,
          called_reply: false,
          is_sidechain: false,
          tool_summary: "",
          text_content: "",
          found: false,
        }),
        read_turn_extended: async () => {
          extended_called = true;
          return {
            produced_text: true,
            called_reply: false,
            is_sidechain: false,
            tool_summary: "",
            text_content: "Should not relay.",
            found: true,
          };
        },
        send_relay: async (cid, content) => {
          relays.push({ channel_id: cid, content });
        },
      },
    );

    expect(result).toEqual({ ok: true });
    expect(extended_called).toBe(false);
    expect(relays).toHaveLength(0);
  });

  // ── Dedup window: repeated silent new-session turns don't spam ──

  it("repeated first-turn stranded turns within dedup window → relay fires only once", async () => {
    const relays: Array<{ channel_id: string; content: string }> = [];
    let now = 3_000_000;

    const deps = {
      pool: new_session_pool(),
      discord: null,
      now: () => now,
      read_turn: async (): Promise<TurnSummary> => ({
        produced_text: false,
        called_reply: false,
        is_sidechain: false,
        tool_summary: "",
        text_content: "",
        found: false,
      }),
      read_turn_extended: async (): Promise<TurnSummary> => ({
        produced_text: true,
        called_reply: false,
        is_sidechain: false,
        tool_summary: "",
        text_content: "Stranded first turn.",
        found: true,
      }),
      send_relay: async (cid: string, content: string) => {
        relays.push({ channel_id: cid, content });
      },
    };

    // Turn 1 — relay fires.
    await evaluate_stop({ session_id, working_dir }, deps);
    expect(relays).toHaveLength(1);

    // Turn 2 within dedup window — no second relay.
    now += 5_000;
    await evaluate_stop({ session_id, working_dir }, deps);
    expect(relays).toHaveLength(1);

    // Turn 3 within dedup window — still no relay.
    now += 5_000;
    await evaluate_stop({ session_id, working_dir }, deps);
    expect(relays).toHaveLength(1);

    // After dedup window — relay may fire again.
    now += RELAY_DEDUP_MS + 1;
    await evaluate_stop({ session_id, working_dir }, deps);
    expect(relays).toHaveLength(2);
  });
});

// ── read_last_assistant_turn_extended (filesystem, extended retry) ──

describe("read_last_assistant_turn_extended", () => {
  let original_home: string | undefined;
  let temp_home: string;
  let working_dir: string;
  let session_id: string;

  beforeEach(async () => {
    original_home = process.env.HOME;
    temp_home = await mkdtemp(join(tmpdir(), "lf-stop-hook-ext-"));
    process.env.HOME = temp_home;

    working_dir = "/tmp/some-cwd-ext";
    session_id = "22222222-2222-2222-2222-222222222222";

    const project_dir = join(temp_home, ".claude", "projects", encode_project_slug(working_dir));
    await mkdir(project_dir, { recursive: true });
  });

  afterEach(async () => {
    if (original_home !== undefined) {
      process.env.HOME = original_home;
    } else {
      delete process.env.HOME;
    }
    await rm(temp_home, { recursive: true, force: true });
  });

  it("returns found=false when JSONL still does not exist after extended wait", async () => {
    const turn = await read_last_assistant_turn_extended(working_dir, session_id);
    // Both fast and slow phases exhausted — file never appeared.
    // This test is slow by design (~2.25s) — it validates the full budget.
    // Marked with a generous timeout via the test itself.
    expect(turn.found).toBe(false);
    expect(turn.produced_text).toBe(false);
  }, 10_000 /* allow up to 10s for the extended retry budget */);

  it("recovers JSONL that materialises during the extended window", async () => {
    const path = join(
      temp_home,
      ".claude",
      "projects",
      encode_project_slug(working_dir),
      `${session_id}.jsonl`,
    );

    // Write the file 600ms after the call begins — after the fast phase (~250ms)
    // but within the extended phase.
    setTimeout(() => {
      void writeFile(path, `${assistant_line({ text: "late first turn" })}\n`, "utf-8");
    }, 600);

    const turn = await read_last_assistant_turn_extended(working_dir, session_id);
    expect(turn.found).toBe(true);
    expect(turn.produced_text).toBe(true);
    expect(turn.text_content).toContain("late first turn");
  });
});
