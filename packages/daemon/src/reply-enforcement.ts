/**
 * Stop-hook reply enforcement.
 *
 * On every Claude Code Stop hook fire, the daemon decides whether the agent's
 * last turn was correctly routed to its bound Discord channel:
 *
 *   produced_text  called_reply   action
 *   ─────────────  ────────────   ─────────────────────────────────────────
 *   true           true           pass through (normal)
 *   true           false          block: hook script exits 2 with reminder
 *   false          true           pass through (mid-turn streaming reply)
 *   false          false          heartbeat: daemon posts Haiku-summary itself
 *
 * Non-Discord-bound sessions (CLI agents, subagents, queue tasks) always pass
 * through. Heartbeats are debounced per-channel to avoid spam.
 *
 * See issue #39 for the full spec.
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { DiscordBot } from "./discord.js";
import { claude_session_jsonl_path } from "./pool.js";
import type { BotPool } from "./pool.js";
import * as sentry from "./sentry.js";

const exec = promisify(execFile);

// ── Tool name constants ──

/**
 * Discord output tool names that count as "the agent routed its message."
 * The MCP plugin namespace can drift over time — keep this list narrow but
 * forgiving (any tool whose name contains both "discord" and "reply"
 * qualifies, see `is_reply_tool_name`).
 */
const DISCORD_REPLY_TOOL_NAMES: readonly string[] = [
  "mcp__plugin_discord_discord__reply",
  "mcp__plugin_discord_discord__edit_message",
];

/** Loose match for any future Discord reply-shaped tool we haven't listed. */
function is_reply_tool_name(name: string): boolean {
  if (DISCORD_REPLY_TOOL_NAMES.includes(name)) return true;
  const lower = name.toLowerCase();
  return lower.includes("discord") && lower.includes("reply");
}

// ── Types ──

export interface TurnSummary {
  /** True if the last assistant turn produced a non-empty text content block. */
  produced_text: boolean;
  /** True if the last assistant turn called a Discord reply tool. */
  called_reply: boolean;
  /** True if the last assistant turn was a sidechain (subagent) message. */
  is_sidechain: boolean;
  /**
   * Comma-separated list of tool names invoked in the last assistant turn,
   * used by the heartbeat generator. May be empty when the turn was pure text.
   */
  tool_summary: string;
  /**
   * Full concatenated text from all non-empty text blocks in the last
   * assistant turn. Used by the auto-relay safety net to post the stranded
   * text to Discord when the agent forgot to call `reply`.
   */
  text_content: string;
  /** True if a transcript was found and parsed. False = no JSONL on disk yet. */
  found: boolean;
}

export type StopHookResponse = { ok: true } | { ok: true; block: true; reminder: string };

export interface EvaluateStopDeps {
  pool: BotPool | null;
  discord: DiscordBot | null;
  /** Override clock for tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Override transcript reader for tests. */
  read_turn?: (working_dir: string, session_id: string) => Promise<TurnSummary>;
  /** Override Haiku heartbeat generator for tests. */
  make_heartbeat?: (turn: TurnSummary) => Promise<string>;
  /**
   * Override Discord send for tests. When set, auto-relay uses this instead
   * of `deps.discord.send`. Signature matches `DiscordBot.send`.
   */
  send_relay?: (channel_id: string, content: string) => Promise<void>;
}

// ── Cooldown ──

/** Default per-channel heartbeat cooldown (ms). */
export const HEARTBEAT_COOLDOWN_MS = 60_000;

/**
 * Per-channel auto-relay dedup window (ms). If the safety net fired for a
 * channel within this window, skip posting again to avoid duplicate messages
 * when the block-and-remind loop fires repeatedly on the same content.
 */
export const RELAY_DEDUP_MS = 60_000;

interface CooldownEntry {
  channel_id: string;
  last_at: number;
}

/** Module-level cooldown map. Channels heartbeated within HEARTBEAT_COOLDOWN_MS
 * are skipped on subsequent silent turns. */
const heartbeat_cooldown = new Map<string, CooldownEntry>();

/** Per-channel dedup map for auto-relay. Keyed by channel_id. */
const relay_dedup = new Map<string, CooldownEntry>();

/** Reset cooldowns. Test-only. */
export function _reset_cooldown_for_tests(): void {
  heartbeat_cooldown.clear();
  relay_dedup.clear();
}

function in_cooldown(channel_id: string, now: number): boolean {
  const entry = heartbeat_cooldown.get(channel_id);
  if (!entry) return false;
  return now - entry.last_at < HEARTBEAT_COOLDOWN_MS;
}

function mark_cooldown(channel_id: string, now: number): void {
  heartbeat_cooldown.set(channel_id, { channel_id, last_at: now });
}

// ── Transcript parsing ──

/**
 * Locate and read the last assistant turn from a session's JSONL transcript.
 *
 * Mitigates the transcript-tail flush race: Claude Code writes the JSONL
 * asynchronously, so the Stop hook may fire before the last events have hit
 * disk. We retry with a short backoff up to ~250ms.
 *
 * Returns `found: false` when the transcript does not exist yet (e.g. brand
 * new session) — the caller treats this as "pass through, nothing to enforce".
 */
export async function read_last_assistant_turn(
  working_dir: string,
  session_id: string,
): Promise<TurnSummary> {
  const path = claude_session_jsonl_path(working_dir, session_id);

  // Brief retry loop to mitigate the JSONL flush race: Claude Code writes the
  // transcript asynchronously, so the Stop hook may fire before the last
  // events have hit disk. Retry with backoff, capped at ~250ms total. Settle
  // early once the file size stops growing — single syscall per attempt.
  const delays = [0, 50, 100, 100];
  let last_size = -1;
  let content = "";

  for (const delay of delays) {
    if (delay > 0) {
      await new Promise((r) => setTimeout(r, delay));
    }
    let next: string;
    try {
      next = await readFile(path, "utf-8");
    } catch {
      // File not yet on disk; retry within budget.
      continue;
    }
    if (next.length === last_size) {
      break;
    }
    last_size = next.length;
    content = next;
  }

  if (!content) {
    return {
      produced_text: false,
      called_reply: false,
      is_sidechain: false,
      tool_summary: "",
      text_content: "",
      found: false,
    };
  }

  return parse_last_assistant_turn(content);
}

interface JsonlEntry {
  type?: string;
  isSidechain?: boolean;
  message?: {
    role?: string;
    content?: Array<{
      type?: string;
      text?: string;
      name?: string;
    }>;
  };
}

/**
 * Pure transcript parser. Walks lines from the tail backward and returns the
 * summary of the most recent `type === "assistant"` entry.
 *
 * Exported for unit tests so we don't have to touch the filesystem.
 */
export function parse_last_assistant_turn(jsonl_content: string): TurnSummary {
  const lines = jsonl_content.split("\n");

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;

    let entry: JsonlEntry;
    try {
      entry = JSON.parse(line) as JsonlEntry;
    } catch {
      continue;
    }

    if (entry.type !== "assistant") continue;

    const content = entry.message?.content ?? [];
    let produced_text = false;
    let called_reply = false;
    const tool_names: string[] = [];
    const text_parts: string[] = [];

    for (const block of content) {
      if (block.type === "text" && typeof block.text === "string" && block.text.trim() !== "") {
        produced_text = true;
        text_parts.push(block.text);
      }
      if (block.type === "tool_use" && typeof block.name === "string") {
        tool_names.push(block.name);
        if (is_reply_tool_name(block.name)) {
          called_reply = true;
        }
      }
    }

    return {
      produced_text,
      called_reply,
      is_sidechain: entry.isSidechain === true,
      tool_summary: tool_names.join(", "),
      text_content: text_parts.join("\n\n"),
      found: true,
    };
  }

  return {
    produced_text: false,
    called_reply: false,
    is_sidechain: false,
    tool_summary: "",
    text_content: "",
    found: false,
  };
}

// ── Discord-bound check ──

/**
 * Resolve the Discord channel a session is bound to, if any.
 *
 * A session is "Discord-bound" iff there is an *assigned* pool bot whose
 * `session_id` matches and whose `channel_id` is set. Subagents (sidechain
 * sessions) and queue tasks are never directly bound — their session ids
 * never appear in the pool's assignment map.
 */
export function resolve_bound_channel(session_id: string, pool: BotPool | null): string | null {
  if (!pool) return null;
  for (const bot of pool.get_assigned_bots()) {
    if (bot.session_id === session_id && bot.channel_id) {
      return bot.channel_id;
    }
  }
  return null;
}

/** Convenience boolean. */
export function is_discord_bound(session_id: string, pool: BotPool | null): boolean {
  return resolve_bound_channel(session_id, pool) !== null;
}

// ── Heartbeat generation ──

/**
 * Ask Haiku for a one-line "what just happened" summary. Mirrors the shape of
 * `extract_session_learnings` in hooks.ts but bounded tighter — Stop hooks
 * have a 10s budget and Haiku takes 2–5s, so we cap at 6s and bail gracefully.
 */
export async function generate_heartbeat(turn: TurnSummary): Promise<string> {
  const tool_list = turn.tool_summary || "(no tools)";
  const prompt = [
    "You are summarizing what an autonomous coding agent just did in one short line.",
    "The agent finished a turn without sending any user-facing text.",
    "",
    `Tools invoked this turn: ${tool_list}`,
    "",
    "Write ONE sentence (max 15 words) describing what's happening, in present continuous tense.",
    'Examples: "Running tests on the new endpoint." / "Refactoring the pool resume logic." /',
    '"Investigating the failing CI check on PR #42."',
    "",
    "Reply with ONLY the sentence, no preamble, no quotes.",
  ].join("\n");

  const claude_bin = process.env.CLAUDE_BIN ?? "claude";
  const { stdout } = await exec(
    claude_bin,
    ["-p", "--model", "haiku", "--no-session-persistence", "--print", prompt],
    { timeout: 6_000 },
  );
  return stdout.trim();
}

// ── Orchestrator ──

/**
 * Heartbeat prefix — visually distinguishes daemon-authored heartbeats from
 * agent messages. Italic + bracket tag. Helen can refine.
 */
export const HEARTBEAT_PREFIX = "*[heartbeat]* ";

/** Reminder text shown to the agent on the blocked path (failure mode a). */
export const REPLY_REMINDER =
  "You produced assistant text but did not route it to Discord. Call the `reply` tool now with the user-facing portion of your last response. The user only sees what `reply` sends.";

/**
 * Suffix appended to auto-relayed messages so users know it was the daemon,
 * not the agent, that posted — and so we can track when the safety net fires.
 */
export const RELAY_SUFFIX = " 🤖 *auto-relayed*";

/**
 * Display names for each archetype role. Mirrors pool.ts
 * `resolve_agent_display_name` but kept local to avoid cross-module coupling.
 */
const ARCHETYPE_DISPLAY: Record<string, string> = {
  planner: "Percival",
  designer: "Galahad",
  builder: "Bedivere",
  reviewer: "Reviewer",
  operator: "Bors",
  commander: "Commander",
};

/**
 * Resolve the full assigned PoolBot for a session, if one exists. Returns null
 * when the session is unbound. Used by auto-relay to get both channel_id and
 * archetype (for attribution) in a single lookup.
 */
export function resolve_bound_bot(session_id: string, pool: BotPool | null) {
  if (!pool) return null;
  for (const bot of pool.get_assigned_bots()) {
    if (bot.session_id === session_id && bot.channel_id) {
      return bot;
    }
  }
  return null;
}

/**
 * Evaluate a Stop hook fire. Returns the response payload the HTTP handler
 * should send back to the hook script.
 *
 * Side effects:
 *   - On heartbeat path: posts a message to the bound Discord channel.
 *   - On any failure: logs + Sentry breadcrumb. NEVER throws — the hook
 *     budget is tight and a thrown error here would fail-closed against
 *     unrelated agent work.
 */
export async function evaluate_stop(
  args: { session_id: string; working_dir: string },
  deps: EvaluateStopDeps,
): Promise<StopHookResponse> {
  const { session_id, working_dir } = args;
  const now_fn = deps.now ?? Date.now;
  const read_turn = deps.read_turn ?? read_last_assistant_turn;
  const make_heartbeat = deps.make_heartbeat ?? generate_heartbeat;

  // Step 1: Discord-bound check is cheap — do it first to short-circuit
  // pass-through cases (subagents, CLI agents, queue tasks).
  const bound_bot = resolve_bound_bot(session_id, deps.pool);
  if (!bound_bot) {
    return { ok: true };
  }
  const channel_id = bound_bot.channel_id!;
  const archetype = bound_bot.archetype;

  // Step 2: parse the last assistant turn from the JSONL tail.
  let turn: TurnSummary;
  try {
    turn = await read_turn(working_dir, session_id);
  } catch (err) {
    // Parsing failed — fail open. Don't block the agent on a transcript bug.
    console.warn(
      `[reply-enforce] transcript read failed for ${session_id.slice(0, 8)}: ${String(err)}`,
    );
    sentry.addBreadcrumb({
      category: "reply-enforce",
      level: "warning",
      message: "transcript read failed",
      data: { session_id: session_id.slice(0, 8), err: String(err) },
    });
    return { ok: true };
  }

  // Belt-and-suspenders: if the transcript flagged this as a sidechain, treat
  // as not bound. (The pool check above should already exclude subagents,
  // since their session ids aren't in the assignment map.)
  if (turn.is_sidechain) {
    return { ok: true };
  }

  if (!turn.found) {
    // No transcript on disk yet (or empty). Pass through — there is nothing
    // to enforce against.
    return { ok: true };
  }

  // Step 3: decide.
  if (turn.produced_text && !turn.called_reply) {
    // Failure mode (a): stranded text. Belt-and-suspenders:
    //   1. Auto-relay the text to Discord so the user sees it regardless.
    //   2. Also block with a reminder so the agent retries properly.
    //
    // The relay fires even when blocking alone has failed to recover the agent
    // (as seen in tonight's pool-0 incident — 3 consecutive silent turns).
    const now = now_fn();
    const in_relay_dedup = (relay_dedup.get(channel_id)?.last_at ?? 0) + RELAY_DEDUP_MS > now;

    if (!in_relay_dedup && turn.text_content.trim()) {
      const send_fn =
        deps.send_relay ??
        ((cid: string, content: string) =>
          deps.discord ? deps.discord.send(cid, content) : Promise.resolve());

      const agent_label =
        archetype && ARCHETYPE_DISPLAY[archetype] ? ARCHETYPE_DISPLAY[archetype] : "Agent";

      const relay_content = `**${agent_label}:** ${turn.text_content.trim()}${RELAY_SUFFIX}`;

      try {
        await send_fn(channel_id, relay_content);
        relay_dedup.set(channel_id, { channel_id, last_at: now });
        console.log(
          `[reply-enforce] auto-relayed stranded text for ${session_id.slice(0, 8)} → ${channel_id} (${agent_label})`,
        );
      } catch (err) {
        // Relay send failed — log and continue. The block+reminder still fires
        // so the agent has a chance to retry on its own.
        console.warn(
          `[reply-enforce] auto-relay send failed for ${session_id.slice(0, 8)}: ${String(err)}`,
        );
        sentry.addBreadcrumb({
          category: "reply-enforce",
          level: "warning",
          message: "auto-relay send failed",
          data: { session_id: session_id.slice(0, 8), channel_id, err: String(err) },
        });
      }
    }

    return { ok: true, block: true, reminder: REPLY_REMINDER };
  }

  if (!turn.produced_text && !turn.called_reply) {
    // Failure mode (b): heartbeat. Cooldown to prevent spam.
    const now = now_fn();
    if (in_cooldown(channel_id, now)) {
      return { ok: true };
    }

    // Null-discord guard sits BEFORE the Haiku call so we don't burn an API
    // round-trip in the (theoretical) case where a channel is bound but the
    // discord client isn't wired (e.g., daemon during a partial-startup window).
    if (!deps.discord) {
      return { ok: true };
    }

    try {
      const summary = await make_heartbeat(turn);
      const trimmed = summary.trim();
      if (trimmed) {
        await deps.discord.send(channel_id, `${HEARTBEAT_PREFIX}${trimmed}`);
        mark_cooldown(channel_id, now);
      }
    } catch (err) {
      // Haiku timeout / Discord send error — log, don't block.
      console.warn(
        `[reply-enforce] heartbeat skipped for ${session_id.slice(0, 8)}: ${String(err)}`,
      );
      sentry.addBreadcrumb({
        category: "reply-enforce",
        level: "warning",
        message: "heartbeat skipped",
        data: { session_id: session_id.slice(0, 8), err: String(err) },
      });
    }

    return { ok: true };
  }

  // produced_text + called_reply → normal pass-through.
  // !produced_text + called_reply → mid-turn streaming reply, also pass-through.
  return { ok: true };
}
