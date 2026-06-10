import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { access, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ArchetypeRole,
  ChannelMapping,
  ChannelType,
  EntityConfig,
  LobsterFarmConfig,
} from "@lobster-farm/shared";
import {
  entity_config_path,
  entity_context_dir,
  entity_daily_dir,
  entity_dir,
  entity_files_dir,
  entity_memory_path,
  write_yaml,
} from "@lobster-farm/shared";
import { lobsterfarm_dir } from "@lobster-farm/shared";
import {
  type AutocompleteInteraction,
  type CategoryChannel,
  type ChatInputCommandInteraction,
  Client,
  DiscordAPIError,
  ChannelType as DiscordChannelType,
  EmbedBuilder,
  GatewayIntentBits,
  type Guild,
  type Message,
  OverwriteType,
  PermissionFlagsBits,
  RESTJSONErrorCodes,
  type Role,
  SlashCommandBuilder,
  type TextChannel,
  type Webhook,
} from "discord.js";
import type { CommanderProcess } from "./commander-process.js";
import { PAT_TMUX_SESSION } from "./commander-process.js";
import { is_tmux_session_idle } from "./pool.js";
import type { BotPool, PoolBot } from "./pool.js";
import type { TaskQueue } from "./queue.js";
import type { EntityRegistry } from "./registry.js";
import type { RoutedMessage } from "./router.js";
import * as sentry from "./sentry.js";
import { read_session_context } from "./session-context.js";
import { fetch_subscription_usage } from "./usage-api.js";

/** Discord snowflake IDs are numeric strings, 17-20 digits. */
export function is_discord_snowflake(id: string): boolean {
  return /^\d{17,20}$/.test(id);
}

// ── Member-management errors (#308) ──
//
// Routes layer maps these to HTTP responses; carrying them as typed errors
// keeps the bot logic independent of HTTP concerns.

/** Thrown when a username search returns no matches in the guild. */
export class UserNotFoundError extends Error {
  constructor(public readonly username: string) {
    super(`No guild member found with username "${username}"`);
    this.name = "UserNotFoundError";
  }
}

/** A shortlist entry used when a username resolution is ambiguous. */
export interface UserCandidate {
  id: string;
  username: string;
  global_name: string | null;
}

/** Thrown when a username search returns more than one exact match. */
export class AmbiguousUserError extends Error {
  constructor(
    public readonly username: string,
    public readonly candidates: UserCandidate[],
  ) {
    super(
      `Multiple guild members matched "${username}" — disambiguate by user_id. ` +
        `Candidates: ${candidates.map((c) => `${c.username} (${c.id})`).join(", ")}`,
    );
    this.name = "AmbiguousUserError";
  }
}

/** Thrown when a requested entity does not exist in the registry. */
export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

/** Thrown when an entity has not yet been assigned a Discord role via lockdown. */
export class EntityRoleNotConfiguredError extends Error {
  constructor(public readonly entity_id: string) {
    super(`Entity "${entity_id}" has no role configured — run lockdown first.`);
    this.name = "EntityRoleNotConfiguredError";
  }
}

/**
 * Check whether a Discord bot username belongs to LobsterFarm.
 * Only LF bots should receive the Administrator-privileged "LobsterFarm Bot" role.
 *
 * Pool bots match by prefix (`lf-*`, `lobsterfarm*`, `lobster-farm*`). Infrastructure
 * bots (Pat, daemon, failsafe, merm) don't share a prefix with pool bots, so callers
 * pass an `infrastructure_bots` allowlist — matched by exact username (case-insensitive)
 * to avoid collisions with short names like "pat" accidentally matching "patrick" (#302).
 */
const LF_BOT_USERNAME_PREFIXES = ["lf-", "lobsterfarm", "lobster-farm"];
export function is_lf_bot(username: string, infrastructure_bots: string[] = []): boolean {
  const lower = username.toLowerCase();
  if (LF_BOT_USERNAME_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
    return true;
  }
  return infrastructure_bots.some((name) => name.toLowerCase() === lower);
}

// ── Formatting helpers ──

/** Format the duration between a start time and now as a human-readable string (e.g., "2h 14m"). */
export function format_duration(start: Date): string {
  const ms = Date.now() - start.getTime();
  if (ms < 0) return "0m";
  const total_minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(total_minutes / 60);
  const minutes = total_minutes % 60;
  if (hours > 0) return `${String(hours)}h ${String(minutes)}m`;
  return `${String(minutes)}m`;
}

/** Format seconds as a human-readable uptime string (e.g., "4h 22m"). */
export function format_uptime(seconds: number): string {
  if (seconds < 0) return "0m";
  const total_minutes = Math.floor(seconds / 60);
  const hours = Math.floor(total_minutes / 60);
  const minutes = total_minutes % 60;
  if (hours > 0) return `${String(hours)}h ${String(minutes)}m`;
  return `${String(minutes)}m`;
}

// ── Cross-entity dashboard types ──

/** A session entry for the cross-entity dashboard. Pre-resolved to strings
 * so the formatting function is pure and testable without Discord/pool deps. */
export interface DashboardSession {
  channel_name: string;
  agent_label: string;
  duration: string;
}

/** A single entity's section in the cross-entity dashboard. */
export interface DashboardEntity {
  id: string;
  sessions: DashboardSession[];
}

/** All data needed to render the cross-entity status dashboard. */
export interface DashboardData {
  uptime: string;
  pool_assigned: number;
  pool_total: number;
  entities: DashboardEntity[];
}

/** Render the cross-entity status dashboard as a Discord-safe string.
 * Pure function: all data pre-resolved, no side effects.
 * Truncates to stay within Discord's 2000-character message limit. */
export function format_cross_entity_dashboard(data: DashboardData): string {
  const DISCORD_MAX = 2000;
  const TRUNCATION_RESERVE = 60; // room for "... and N more entities"

  const lines: string[] = ["**LobsterFarm Status**", ""];

  lines.push(`**Daemon:** running (uptime: ${data.uptime})`);
  lines.push(
    `**Pool:** ${String(data.pool_assigned)}/${String(data.pool_total)} assigned, ${String(data.pool_total - data.pool_assigned)} free`,
  );
  lines.push("");

  let truncated_count = 0;
  for (let i = 0; i < data.entities.length; i++) {
    const entity = data.entities[i]!;
    const section_lines: string[] = [`--- ${entity.id} ---`];

    if (entity.sessions.length > 0) {
      section_lines.push("Sessions:");
      for (const s of entity.sessions) {
        section_lines.push(
          `  \u2022 ${s.channel_name} \u2014 ${s.agent_label} \u2014 ${s.duration}`,
        );
      }
    } else {
      section_lines.push("No active work.");
    }
    section_lines.push("");

    // Check if adding this section would exceed the limit
    const candidate = `${lines.join("\n")}\n${section_lines.join("\n")}`;
    if (candidate.length > DISCORD_MAX - TRUNCATION_RESERVE) {
      truncated_count = data.entities.length - i;
      break;
    }

    lines.push(...section_lines);
  }

  if (truncated_count > 0) {
    lines.push(`\u2026 and ${String(truncated_count)} more entities`);
  }

  return lines.join("\n").trim();
}

/** Format an ISO timestamp as a relative time string (e.g., "2h ago", "3d ago"). */
export function format_relative_time(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "just now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${String(minutes)}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)}h ago`;
  const days = Math.floor(hours / 24);
  return `${String(days)}d ago`;
}

// ── Channel index entry ──

interface ChannelEntry {
  entity_id: string;
  channel_type: ChannelType;
  /** Feature ID assigned to this work room (set by /open, cleared by /close). */
  assigned_feature?: string | null;
  /** Human-readable purpose from entity config (e.g., "aws", "io-site"). */
  purpose?: string;
  /**
   * Optional archetype override from the entity's channel config.
   * When present, incoming messages to this channel auto-assign a pool bot
   * running as this archetype instead of the default "planner".
   */
  assigned_archetype?: ArchetypeRole;
}

// ── Command target abstraction ──
// Unified interface that command handlers use to reply to the user.
// Both text messages and slash commands produce a CommandTarget.

export interface CommandTarget {
  /** Reply to the user. Handles ephemeral for slash commands. */
  reply: (content: string) => Promise<void>;
  /** The channel ID where the command was issued. */
  channel_id: string;
  /** React to the original message/interaction (no-op for slash commands). */
  react: (emoji: string) => Promise<void>;
  /** Display name of the command author. */
  author_name: string;
}

// ── Slash command definitions ──

export function build_slash_commands(): SlashCommandBuilder[] {
  return [
    new SlashCommandBuilder().setName("help").setDescription("Show available LobsterFarm commands"),

    new SlashCommandBuilder()
      .setName("status")
      .setDescription("Show session and entity status")
      .addStringOption((opt) =>
        opt
          .setName("scope")
          .setDescription("Scope")
          .addChoices({ name: "entity", value: "entity" }, { name: "all", value: "all" }),
      ) as SlashCommandBuilder,

    new SlashCommandBuilder()
      .setName("swap")
      .setDescription("Swap the active agent in this channel")
      .addStringOption((opt) =>
        opt
          .setName("agent")
          .setDescription("Agent to swap to")
          .setRequired(true)
          .addChoices(
            { name: "Gary (planner)", value: "planner" },
            { name: "Bob (builder)", value: "builder" },
            { name: "Pearl (designer)", value: "designer" },
            { name: "Ray (operator)", value: "operator" },
          ),
      ) as SlashCommandBuilder,

    new SlashCommandBuilder()
      .setName("scaffold")
      .setDescription("Scaffold Discord channels")
      .addStringOption((opt) =>
        opt.setName("name").setDescription("Entity ID or 'server'").setRequired(true),
      )
      .addStringOption((opt) =>
        opt.setName("blueprint").setDescription("Blueprint name (default: software)"),
      ) as SlashCommandBuilder,

    new SlashCommandBuilder()
      .setName("room")
      .setDescription("Create an on-demand work room with a pool bot")
      .addStringOption((opt) =>
        opt.setName("name").setDescription("Room name").setRequired(true),
      ) as SlashCommandBuilder,

    new SlashCommandBuilder()
      .setName("close")
      .setDescription("Archive and close the current work room")
      .addBooleanOption((opt) =>
        opt.setName("force").setDescription("Force close even if a feature is active"),
      ) as SlashCommandBuilder,

    new SlashCommandBuilder()
      .setName("resume")
      .setDescription("Restore an archived work room session")
      .addStringOption((opt) =>
        opt
          .setName("name")
          .setDescription("Archived room name")
          .setRequired(true)
          .setAutocomplete(true),
      ) as SlashCommandBuilder,

    new SlashCommandBuilder()
      .setName("compact")
      .setDescription("Trigger context compaction on the active session"),

    new SlashCommandBuilder()
      .setName("reset")
      .setDescription("Reset the current session and start fresh"),

    new SlashCommandBuilder()
      .setName("archives")
      .setDescription("List archived work room sessions for this entity"),
  ] as SlashCommandBuilder[];
}

// Commands whose responses should be ephemeral (only visible to the invoker).
export const EPHEMERAL_COMMAND_NAMES = ["help", "status", "archives"] as const;
const EPHEMERAL_COMMANDS = new Set<string>(EPHEMERAL_COMMAND_NAMES);

// Commands that perform external I/O and may exceed Discord's 3-second
// interaction response window. These get deferReply() before processing.
const DEFERRED_COMMANDS = new Set(["scaffold", "room", "resume", "close"]);

/** Minimal interface for the subset of ChatInputCommandInteraction used by extract_slash_args. */
export interface SlashInteractionLike {
  commandName: string;
  options: {
    getString(name: string): string | null;
    getBoolean(name: string): boolean | null;
  };
}

/**
 * Extract slash command options into the positional args array that
 * the shared handle_command dispatch expects. Each slash command
 * maps its named options to the legacy positional format.
 */
export function extract_slash_args(interaction: SlashInteractionLike): string[] {
  const name = interaction.commandName;

  switch (name) {
    case "status": {
      const scope = interaction.options.getString("scope");
      return scope ? [scope] : [];
    }
    case "swap": {
      const agent = interaction.options.getString("agent") ?? "";
      return [agent];
    }
    case "scaffold": {
      // /scaffold name:"my-entity" maps to args: ["entity", "my-entity"]
      const scaffold_name = interaction.options.getString("name") ?? "";
      if (scaffold_name === "server") return ["server"];
      const blueprint = interaction.options.getString("blueprint");
      const result = ["entity", scaffold_name];
      if (blueprint) result.push("--blueprint", blueprint);
      return result;
    }
    case "room": {
      const room_name = interaction.options.getString("name") ?? "";
      return [room_name];
    }
    case "close": {
      const force = interaction.options.getBoolean("force");
      return force ? ["--force"] : [];
    }
    case "resume": {
      const resume_name = interaction.options.getString("name") ?? "";
      return [resume_name];
    }
    default:
      return [];
  }
}

/** Create a CommandTarget from a Discord text message. */
function target_from_message(
  message: Message,
  send_fallback: (channel_id: string, content: string) => Promise<void>,
): CommandTarget {
  return {
    channel_id: message.channelId,
    author_name: message.author.displayName,
    async reply(content: string) {
      try {
        await message.reply(content);
      } catch {
        await send_fallback(message.channelId, content);
      }
    },
    async react(emoji: string) {
      try {
        await message.react(emoji);
      } catch {
        /* ignore */
      }
    },
  };
}

/** Create a CommandTarget from a slash command interaction. */
function target_from_interaction(
  interaction: ChatInputCommandInteraction,
  ephemeral: boolean,
  deferred = false,
): CommandTarget {
  let replied = false;
  return {
    channel_id: interaction.channelId,
    author_name: interaction.user.displayName,
    async reply(content: string) {
      try {
        if (deferred && !replied) {
          // editReply inherits the ephemeral flag from the earlier deferReply()
          // call — no need to pass ephemeral here.
          await interaction.editReply({ content });
        } else if (!replied) {
          await interaction.reply({ content, ephemeral });
        } else {
          await interaction.followUp({ content, ephemeral });
        }
        replied = true;
      } catch (err) {
        console.error(`[discord:slash] Reply failed: ${String(err)}`);
      }
    },
    async react(_emoji: string) {
      // Slash commands don't support reactions — no-op
    },
  };
}

// ── Discord Bot ──

// ── Avatar cache paths ──

const AVATAR_EXTENSIONS = [".jpg", ".png", ".webp"];

function avatars_dir(): string {
  return join(lobsterfarm_dir(), "avatars");
}

/**
 * Set a pool bot's Discord profile avatar using a raw REST call.
 * Reads the bot's token from its .env file, reads the avatar image from disk,
 * and PATCHes /users/@me. The token is only held in memory for the duration
 * of the fetch call — never stored, logged, or passed to other modules.
 *
 * @param state_dir - The pool bot's channel directory (contains .env with token)
 * @param agent_name - Lowercase agent name (e.g., "gary") used to find the avatar file
 */
export async function set_bot_profile_avatar(state_dir: string, agent_name: string): Promise<void> {
  // Read bot token from .env file
  const env_content = await readFile(join(state_dir, ".env"), "utf-8");
  const token_match = env_content.match(/DISCORD_BOT_TOKEN=(.+)/);
  const token = token_match?.[1]?.trim();
  if (!token) {
    throw new Error(`No DISCORD_BOT_TOKEN in ${state_dir}/.env`);
  }

  // Find avatar file on disk
  const base_dir = avatars_dir();
  let avatar_path: string | null = null;
  for (const ext of AVATAR_EXTENSIONS) {
    const candidate = join(base_dir, `${agent_name}${ext}`);
    try {
      await access(candidate);
      avatar_path = candidate;
      break;
    } catch {}
  }

  if (!avatar_path) {
    throw new Error(`No avatar file found for "${agent_name}" in ${base_dir}`);
  }

  // Read file and encode as data URI for Discord API
  const avatar_buffer = await readFile(avatar_path);
  const ext = avatar_path.split(".").pop()!;
  const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
  const data_uri = `data:${mime};base64,${avatar_buffer.toString("base64")}`;

  // PATCH /users/@me with the bot's own token.
  // 10s timeout prevents a hung connection from bricking the assignment path.
  const controller = new AbortController();
  const timeout_id = setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await fetch("https://discord.com/api/v10/users/@me", {
      method: "PATCH",
      headers: {
        Authorization: `Bot ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ avatar: data_uri }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Discord API ${String(response.status)}: ${body}`);
    }
  } finally {
    clearTimeout(timeout_id);
  }
}

function avatar_cache_path(config: LobsterFarmConfig): string {
  return join(lobsterfarm_dir(config.paths), "state", "avatar-urls.json");
}

export class DiscordBot extends EventEmitter {
  private client: Client;
  private channel_map = new Map<string, ChannelEntry>();
  private entity_channels = new Map<string, Map<ChannelType, string>>();
  private connected = false;
  /** Cached avatar CDN URLs keyed by lowercase agent name. */
  private avatar_urls = new Map<string, string>();
  /** Active typing indicator intervals keyed by channel ID. */
  private typing_loops = new Map<string, NodeJS.Timeout>();
  /** Active status embeds keyed by channel ID. */
  private status_embeds = new Map<
    string,
    {
      message_id: string;
      start_time: number;
      last_status: string;
      last_detail: string | null;
      tool_count: number;
      agent_name: string;
    }
  >();
  /** Cached #command-center channel ID (resolved lazily from the GLOBAL category). */
  private command_center_channel_id: string | null = null;

  constructor(
    private config: LobsterFarmConfig,
    private registry: EntityRegistry,
  ) {
    super();
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        // Privileged intent — requires "Server Members Intent" enabled in
        // Discord Developer Portal (Bot → Privileged Gateway Intents).
        // Needed for guild.members.fetch() in lockdown().
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });
  }

  /** Connect to Discord. */
  async connect(token: string): Promise<void> {
    this.build_channel_map();

    const ready = new Promise<void>((resolve) => {
      this.client.once("ready", () => {
        const tag = this.client.user?.tag ?? "unknown";
        console.log(`[discord] Connected as ${tag}`);
        this.connected = true;

        // Register guild-specific slash commands (instant, no propagation delay)
        void this.register_slash_commands();

        // Eagerly resolve #command-center channel ID so handle_message()
        // can detect user messages there and show typing + status embeds.
        void this.find_command_center_channel().then((id) => {
          if (id) {
            console.log(`[discord] Command center channel resolved: ${id}`);
          }
        });

        this.emit("connected");
        resolve();
      });
    });

    this.client.on("messageCreate", (message: Message) => {
      void this.handle_message(message);
    });

    this.client.on("interactionCreate", (interaction) => {
      if (interaction.isAutocomplete()) {
        void this.handle_autocomplete(interaction as AutocompleteInteraction);
        return;
      }
      if (interaction.isChatInputCommand()) {
        void this.handle_slash_command(interaction as ChatInputCommandInteraction);
      }
    });

    await this.client.login(token);
    await ready;

    sentry.addBreadcrumb({
      category: "daemon.lifecycle",
      message: "Discord connected",
      data: { tag: this.client.user?.tag },
    });
  }

  /** Register slash commands on the guild for instant availability. */
  private async register_slash_commands(): Promise<void> {
    const guild = await this.get_guild();
    if (!guild) {
      console.log("[discord] No guild available — slash commands not registered");
      return;
    }

    try {
      const commands = build_slash_commands();
      await guild.commands.set(commands);
      console.log(`[discord] Registered ${String(commands.length)} slash commands on guild`);
    } catch (err) {
      console.error(`[discord] Failed to register slash commands: ${String(err)}`);
      sentry.captureException(err, {
        tags: { component: "discord", operation: "register_slash_commands" },
        contexts: {
          debug: { hint: "Most likely missing applications.commands OAuth2 scope" },
        },
      });
    }
  }

  /** Disconnect from Discord. */
  async disconnect(): Promise<void> {
    if (this.connected) {
      console.log("[discord] Disconnecting...");
      await this.stop_all_typing_loops();
      sentry.addBreadcrumb({
        category: "daemon.lifecycle",
        message: "Discord disconnecting",
      });
      this.client.destroy();
      this.connected = false;
    }
  }

  /** Check if connected. */
  is_connected(): boolean {
    return this.connected;
  }

  /** Find the #system-status channel by name under the GLOBAL category. */
  async find_system_status_channel(): Promise<string | null> {
    const guild = await this.get_guild();
    if (!guild) return null;

    const category = guild.channels.cache.find(
      (c) => c.name === "GLOBAL" && c.type === DiscordChannelType.GuildCategory,
    );
    if (!category) return null;

    const channel = guild.channels.cache.find(
      (c) => c.name === "system-status" && c.parentId === category.id,
    );
    return channel?.id ?? null;
  }

  /** Find the #command-center channel by name under the GLOBAL category. Caches the result. */
  async find_command_center_channel(): Promise<string | null> {
    if (this.command_center_channel_id) return this.command_center_channel_id;

    const guild = await this.get_guild();
    if (!guild) return null;

    const category = guild.channels.cache.find(
      (c) => c.name === "GLOBAL" && c.type === DiscordChannelType.GuildCategory,
    );
    if (!category) return null;

    const channel = guild.channels.cache.find(
      (c) => c.name === "command-center" && c.parentId === category.id,
    );
    if (channel) {
      this.command_center_channel_id = channel.id;
    }
    return this.command_center_channel_id;
  }

  /**
   * Defensive guard: returns true (and logs) when `channel_id` is empty,
   * whitespace-only, undefined, or null. Caller should early-return on `true`.
   * Emits a Sentry breadcrumb (not an exception event) so we get caller
   * attribution without paging — a real bug upstream of the call should be
   * fixed at the source, this is only the net.
   */
  private is_empty_channel_id(
    method_name: string,
    channel_id: string | undefined | null,
    content?: string,
  ): boolean {
    if (channel_id?.trim()) return false;
    const err = new Error(`${method_name}() called with empty channel_id`);
    console.warn(`[discord] ${err.message}`, err.stack);
    sentry.addBreadcrumb({
      category: "discord",
      level: "warning",
      message: err.message,
      data: { content_preview: content?.slice(0, 80) },
    });
    return true;
  }

  /** Send a plain message to a channel (from the bot itself). */
  async send(channel_id: string, content: string): Promise<void> {
    if (this.is_empty_channel_id("send", channel_id, content)) return;
    if (!this.connected) {
      console.log(`[discord:offline] Would send to ${channel_id}: ${content}`);
      return;
    }

    try {
      const channel = await this.client.channels.fetch(channel_id);
      if (channel?.isTextBased()) {
        await (channel as TextChannel).send(content);
      }
    } catch (err) {
      console.error(`[discord] Failed to send to ${channel_id}: ${String(err)}`);
      sentry.captureException(err, {
        tags: { module: "discord", action: "send" },
      });
    }
  }

  /**
   * Start a status monitoring loop for a channel. Polls the assigned pool bot's
   * tmux session every 4 seconds to update the status embed and detect idle/stale states.
   * Auto-stops when the bot returns to idle, the bot is released, or stale OAuth is detected.
   */
  start_typing_loop(channel_id: string): void {
    // Don't stack loops for the same channel
    if (this.typing_loops.has(channel_id)) return;
    if (!this._pool) return;

    // Track consecutive idle checks to avoid premature finalization.
    // The MCP plugin needs time to deliver the message — checking idle
    // on the very first tick may fire before the bot starts processing.
    let consecutive_idle = 0;
    const IDLE_THRESHOLD = 3; // require 3 consecutive idle checks (~12s) before finalizing

    // Grace period: skip idle checks entirely for the first 15 seconds.
    // MCP message delivery (channel push or bridge) takes several seconds —
    // the bot sits at its previous prompt during delivery, looking "idle"
    // when it's actually about to start processing. (#280)
    const started_at = Date.now();
    const GRACE_PERIOD_MS = 15_000;

    const interval = setInterval(() => {
      if (!this._pool) {
        this.stop_typing_loop(channel_id);
        void this.finalize_status_embed(channel_id);
        return;
      }

      const bot = this._pool.get_assignment(channel_id);
      if (!bot) {
        this.stop_typing_loop(channel_id);
        void this.finalize_status_embed(channel_id);
        return;
      }

      // Detect stale OAuth mid-session. The initial check in handle_message()
      // can miss this due to a race: the CLI hasn't tried the token yet when
      // the daemon first checks. By checking here every tick, we catch it
      // within 4 seconds and recycle the bot.
      if (this._pool.has_stale_oauth(bot.id)) {
        console.warn(
          `[discord] Stale OAuth detected for pool-${String(bot.id)} during status loop — recycling`,
        );
        this.stop_typing_loop(channel_id);
        void this.finalize_status_embed(channel_id);
        this._pool.kill_stale_session(bot.id);
        void this._pool.release_with_history(bot.id).then(() => {
          void this.send(
            channel_id,
            "Session expired — send your message again and a fresh bot will pick it up.",
          );
        });
        return;
      }

      // During the grace period, skip idle checks — the message is still
      // being delivered via MCP and the bot will appear idle at its old prompt.
      if (Date.now() - started_at < GRACE_PERIOD_MS) {
        // Still update the status embed so the user sees activity
        void this.update_status_embed_from_tmux(channel_id, bot.tmux_session);
        return;
      }

      if (this._pool.is_bot_idle(bot)) {
        // Before declaring idle, check if there's a pending MCP delivery.
        // The tmux pane shows "← discord" when the channel plugin is pushing
        // a message — if that indicator is present near the end of the pane
        // alongside a prompt, the bot is about to receive work.
        try {
          const pane = execFileSync(
            "tmux",
            ["capture-pane", "-t", bot.tmux_session, "-p", "-S", "-5"],
            { encoding: "utf-8", timeout: 2000 },
          );
          if (pane.includes("← discord")) {
            consecutive_idle = 0;
            void this.update_status_embed_from_tmux(channel_id, bot.tmux_session);
            return;
          }
        } catch {
          // tmux read failure — fall through to normal idle logic
        }

        consecutive_idle++;
        if (consecutive_idle >= IDLE_THRESHOLD) {
          this.stop_typing_loop(channel_id);
          void this.finalize_status_embed(channel_id);
          return;
        }
      } else {
        consecutive_idle = 0;
      }

      // Parse tmux output and update the status embed if activity changed
      void this.update_status_embed_from_tmux(channel_id, bot.tmux_session);
    }, 4000);

    this.typing_loops.set(channel_id, interval);
  }

  /** Stop the typing indicator loop for a channel. */
  stop_typing_loop(channel_id: string): void {
    const interval = this.typing_loops.get(channel_id);
    if (interval) {
      clearInterval(interval);
      this.typing_loops.delete(channel_id);
    }
  }

  /** Stop all typing loops (e.g. on disconnect). */
  async stop_all_typing_loops(): Promise<void> {
    const finalizations: Promise<void>[] = [];
    for (const [channel_id, interval] of this.typing_loops) {
      clearInterval(interval);
      this.typing_loops.delete(channel_id);
      finalizations.push(this.finalize_status_embed(channel_id));
    }
    await Promise.allSettled(finalizations);
  }

  /**
   * Start a status monitoring loop for the Commander (Pat) in #command-center.
   * Uses Pat's fixed tmux session ("pat") for idle detection and activity parsing,
   * independent of the bot pool.
   */
  start_commander_typing_loop(channel_id: string): void {
    // Don't stack loops for the same channel
    if (this.typing_loops.has(channel_id)) return;

    const TMUX_SESSION = PAT_TMUX_SESSION;

    // Track consecutive idle checks to avoid premature finalization.
    // Pat's channel plugin needs time to deliver the message — if we
    // check idle on the very first tick, the bot may not have started yet.
    let consecutive_idle = 0;
    const IDLE_THRESHOLD = 2; // require 2 consecutive idle checks before finalizing

    const interval = setInterval(() => {
      if (is_tmux_session_idle(TMUX_SESSION)) {
        consecutive_idle++;
        if (consecutive_idle >= IDLE_THRESHOLD) {
          this.stop_typing_loop(channel_id);
          void this.finalize_status_embed(channel_id);
          return;
        }
      } else {
        consecutive_idle = 0;
      }

      // Parse tmux output and update the status embed if activity changed
      void this.update_status_embed_from_tmux(channel_id, TMUX_SESSION);
    }, 4000);

    this.typing_loops.set(channel_id, interval);
  }

  // ── Status embeds ──

  /**
   * Parse Claude Code tmux output to extract current activity, tool count, and detail.
   * Reads ⏺ markers for tool calls, ✻ for thinking status, and the status bar
   * for background subagents.
   */
  private parse_tmux_activity(tmux_output: string): {
    status: string;
    detail: string | null;
    tool_count: number;
  } {
    const lines = tmux_output.split("\n");

    // Count tool use lines (⏺ markers)
    const tool_lines = lines.filter((l) => l.includes("⏺"));
    const tool_count = tool_lines.length;

    // Check status bar for background subagents
    const last_line = lines[lines.length - 1] ?? "";
    const agent_match = last_line.match(/(\d+) local agent/);
    const has_background_agents = !!agent_match;

    // Check for ✻ thinking indicators (Churned = processing, Baked = waiting)
    let thinking_status: string | null = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = (lines[i] ?? "").trim();
      if (line.startsWith("✻")) {
        if (line.includes("local agent")) {
          thinking_status = "subagent_running";
        } else if (line.includes("Churned") || line.includes("Baked")) {
          thinking_status = "thinking";
        }
        break;
      }
    }

    // If parent is at prompt with background agents, show subagent status
    if (has_background_agents || thinking_status === "subagent_running") {
      let subagent_name: string | null = null;
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = (lines[i] ?? "").trim();
        if (!line.includes("⏺")) continue;
        // Match "⏺ bob(description)" — direct agent name calls (lowercase = subagent name)
        const direct_match = line.match(/⏺\s+([a-z]\w*)\(/);
        if (direct_match?.[1]) {
          subagent_name = direct_match[1];
          break;
        }
        // Match "⏺ Agent(name)" — explicit Agent tool calls
        const agent_match2 = line.match(/⏺\s+Agent\(/);
        if (agent_match2) {
          subagent_name = "subagent";
          break;
        }
      }

      const count_str = agent_match
        ? `${agent_match[1]} subagent${agent_match[1] === "1" ? "" : "s"}`
        : "Subagent";
      return {
        status: `${count_str} running`,
        detail: subagent_name ? `→ ${subagent_name}` : null,
        tool_count,
      };
    }

    // Find the last ⏺ line for current status + extract detail
    let status = "Thinking...";
    let detail: string | null = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = (lines[i] ?? "").trim();
      if (!line.includes("⏺")) continue;

      // Extract parenthesized argument for detail (file path, command, etc.)
      const paren_match = line.match(/⏺\s+\w+\((.+?)(?:\)|$)/);
      const raw_detail = paren_match?.[1];

      if (line.includes("Read")) {
        status = "Reading files";
        detail = this.extract_path_detail(raw_detail);
      } else if (line.includes("Edit") || line.includes("Wrote to")) {
        status = "Editing code";
        detail = this.extract_path_detail(raw_detail);
      } else if (line.includes("Write")) {
        status = "Writing files";
        detail = this.extract_path_detail(raw_detail);
      } else if (line.includes("Bash")) {
        status = "Running commands";
        detail = this.extract_command_detail(raw_detail);
      } else if (line.includes("Agent")) {
        status = "Spawning subagent";
      } else if (line.includes("Grep")) {
        status = "Searching codebase";
        detail = this.extract_grep_detail(raw_detail);
      } else if (line.includes("Glob")) {
        status = "Searching codebase";
      } else if (line.includes("WebSearch") || line.includes("WebFetch")) {
        status = "Searching the web";
      } else if (line.includes("Skill")) {
        status = "Loading skill";
      } else if (line.includes("ToolSearch")) {
        status = "Loading tools";
      } else if (line.includes("discord") && line.includes("reply")) {
        status = "Composing reply";
      } else if (line.includes("MCP")) {
        status = "Using tools";
      } else {
        status = "Working...";
      }
      break;
    }

    return { status, detail, tool_count };
  }

  /** Extract a short file path from a Read/Edit/Write argument. */
  private extract_path_detail(raw: string | undefined): string | null {
    if (!raw) return null;
    const cleaned = raw.replace(/['"]/g, "").trim();
    const parts = cleaned.split("/").filter(Boolean);
    if (parts.length <= 3) return `\`${cleaned}\``;
    return `\`…/${parts.slice(-3).join("/")}\``;
  }

  /** Extract a short command from a Bash argument. */
  private extract_command_detail(raw: string | undefined): string | null {
    if (!raw) return null;
    const cleaned = raw.replace(/['"]/g, "").trim();
    if (cleaned.length > 50) return `\`${cleaned.slice(0, 47)}…\``;
    return `\`${cleaned}\``;
  }

  /** Extract search pattern from a Grep argument. */
  private extract_grep_detail(raw: string | undefined): string | null {
    if (!raw) return null;
    const cleaned = raw.replace(/['"]/g, "").trim();
    if (cleaned.length > 40) return `\`${cleaned.slice(0, 37)}…\``;
    return `\`${cleaned}\``;
  }

  /** Format elapsed seconds as a human-readable duration. */
  private format_duration(seconds: number): string {
    if (seconds < 60) return `${String(seconds)}s`;
    return `${String(Math.floor(seconds / 60))}m ${String(seconds % 60)}s`;
  }

  /**
   * Build a working-state embed for the given tracking entry.
   */
  private build_working_embed(entry: {
    agent_name: string;
    last_status: string;
    last_detail: string | null;
    tool_count: number;
    start_time: number;
  }): EmbedBuilder {
    const elapsed = Math.round((Date.now() - entry.start_time) / 1000);
    const parts = [`**${entry.agent_name}** — Working`];
    parts.push(`Status: ${entry.last_status}`);
    if (entry.last_detail) {
      parts.push(entry.last_detail);
    }
    if (entry.tool_count > 0) {
      parts.push(
        `${String(entry.tool_count)} tool ${entry.tool_count === 1 ? "use" : "uses"} · ${this.format_duration(elapsed)}`,
      );
    } else {
      parts.push(this.format_duration(elapsed));
    }
    return new EmbedBuilder().setColor(0xf59e0b).setDescription(parts.join("\n"));
  }

  /**
   * Send a status embed to a channel showing the agent is working.
   * Stores the message ID so we can edit it when the agent finishes.
   */
  async send_status_embed(channel_id: string, archetype: ArchetypeRole | "system"): Promise<void> {
    if (this.is_empty_channel_id("send_status_embed", channel_id)) return;
    if (!this.connected) return;

    // Don't stack embeds — finalize any existing one first
    if (this.status_embeds.has(channel_id)) {
      await this.finalize_status_embed(channel_id);
    }

    const identity = this.resolve_agent_identity(archetype);
    const now = Date.now();

    const entry = {
      message_id: "",
      start_time: now,
      last_status: "Starting...",
      last_detail: null as string | null,
      tool_count: 0,
      agent_name: identity.name,
    };

    // Claim the slot BEFORE the async send to prevent concurrent calls from
    // both posting embeds for the same channel (the second caller will see
    // the entry and finalize it instead of creating a duplicate).
    this.status_embeds.set(channel_id, entry);

    const embed = this.build_working_embed(entry);

    try {
      const channel = await this.client.channels.fetch(channel_id);
      if (!channel?.isTextBased()) {
        this.status_embeds.delete(channel_id);
        return;
      }

      const msg = await (channel as TextChannel).send({ embeds: [embed] });
      entry.message_id = msg.id; // update in-place; map already has the ref
    } catch (err) {
      this.status_embeds.delete(channel_id); // clean up on failure
      console.error(`[discord] Failed to send status embed: ${String(err)}`);
    }
  }

  /**
   * Parse tmux output from a session and update the status embed if activity changed.
   * Called from the typing loop every tick. Accepts a tmux session name directly
   * so it works for both pool bots and the commander (Pat).
   */
  private async update_status_embed_from_tmux(
    channel_id: string,
    tmux_session: string,
  ): Promise<void> {
    const entry = this.status_embeds.get(channel_id);
    if (!entry?.message_id) return; // not yet sent or already finalized

    try {
      const output = execFileSync("tmux", ["capture-pane", "-t", tmux_session, "-p"], {
        encoding: "utf-8",
        timeout: 2000,
      });

      const { status, detail, tool_count } = this.parse_tmux_activity(output);

      // Only edit if something actually changed
      if (
        status === entry.last_status &&
        detail === entry.last_detail &&
        tool_count === entry.tool_count
      ) {
        return;
      }

      entry.last_status = status;
      entry.last_detail = detail;
      entry.tool_count = Math.max(entry.tool_count, tool_count);

      const embed = this.build_working_embed(entry);

      const channel = await this.client.channels.fetch(channel_id);
      if (!channel?.isTextBased()) return;

      const msg = await (channel as TextChannel).messages.fetch(entry.message_id);
      await msg.edit({ embeds: [embed] });
    } catch {
      // Best-effort — tmux read or Discord edit failure is non-fatal
    }
  }

  /**
   * Edit the status embed to show the agent is done. Removes tracking state.
   */
  async finalize_status_embed(channel_id: string): Promise<void> {
    const entry = this.status_embeds.get(channel_id);
    if (!entry) return;
    this.status_embeds.delete(channel_id);
    if (!entry.message_id) return; // embed was claimed but never sent — nothing to edit

    const elapsed = Math.round((Date.now() - entry.start_time) / 1000);
    const duration = this.format_duration(elapsed);

    const parts = [`**${entry.agent_name}** — Done`];
    if (entry.tool_count > 0) {
      parts.push(`${String(entry.tool_count)} tool uses · ${duration}`);
    } else {
      parts.push(duration);
    }

    const embed = new EmbedBuilder().setColor(0x10b981).setDescription(parts.join("\n"));

    try {
      const channel = await this.client.channels.fetch(channel_id);
      if (!channel?.isTextBased()) return;

      const msg = await (channel as TextChannel).messages.fetch(entry.message_id);
      await msg.edit({ embeds: [embed] });
    } catch (err) {
      // Message might have been deleted — that's fine
      console.error(`[discord] Failed to finalize status embed: ${String(err)}`);
    }
  }

  /**
   * Send a message as a specific agent (with custom name + avatar via webhook).
   * Falls back to regular send if webhook creation fails.
   */
  async send_as_agent(
    channel_id: string,
    content: string,
    archetype: ArchetypeRole | "system",
  ): Promise<void> {
    if (this.is_empty_channel_id("send_as_agent", channel_id, content)) return;
    if (!this.connected) {
      console.log(`[discord:offline] [${archetype}] ${content}`);
      return;
    }

    const identity = this.resolve_agent_identity(archetype);

    try {
      const webhook = await this.get_or_create_webhook(channel_id);
      if (webhook) {
        await webhook.send({
          content,
          username: identity.name,
          avatarURL: identity.avatar_url,
        });
        return;
      }
    } catch (err) {
      console.log(`[discord] Webhook send failed, falling back to bot: ${String(err)}`);
    }

    // Fallback: send as bot with agent prefix
    await this.send(channel_id, `**[${identity.name}]** ${content}`);
  }

  /** Send a message to an entity's channel by type, as a specific agent. */
  async send_to_entity(
    entity_id: string,
    channel_type: ChannelType,
    content: string,
    archetype?: ArchetypeRole | "system",
  ): Promise<void> {
    const entity_map = this.entity_channels.get(entity_id);
    if (!entity_map) {
      console.log(`[discord] No channel mapping for entity ${entity_id}`);
      return;
    }

    const channel_id = entity_map.get(channel_type);
    if (!channel_id) {
      console.log(`[discord] No ${channel_type} channel for entity ${entity_id}`);
      return;
    }

    if (archetype) {
      await this.send_as_agent(channel_id, content, archetype);
    } else {
      await this.send(channel_id, content);
    }
  }

  // ── Alert router helpers ──
  // These methods support the tiered alert system (alert-router.ts).
  // They expose lower-level Discord primitives that the router composes.

  /** Resolve the channel ID for a given entity and channel type. Returns null if not found. */
  get_entity_channel_id(entity_id: string, channel_type: ChannelType): string | null {
    const entity_map = this.entity_channels.get(entity_id);
    if (!entity_map) return null;
    return entity_map.get(channel_type) ?? null;
  }

  /** Send a Discord embed to a channel. Returns the message ID, or null on failure. */
  async send_embed(channel_id: string, embed: EmbedBuilder): Promise<string | null> {
    if (this.is_empty_channel_id("send_embed", channel_id)) return null;
    if (!this.connected) {
      console.log(`[discord:offline] Would send embed to ${channel_id}`);
      return null;
    }

    try {
      const channel = await this.client.channels.fetch(channel_id);
      if (channel?.isTextBased()) {
        const msg = await (channel as TextChannel).send({ embeds: [embed] });
        return msg.id;
      }
      return null;
    } catch (err) {
      console.error(`[discord] Failed to send embed to ${channel_id}: ${String(err)}`);
      sentry.captureException(err, {
        tags: { module: "discord", action: "send_embed" },
      });
      return null;
    }
  }

  /** Create a thread from an existing message. Returns the thread ID, or null on failure. */
  async create_thread_from_message(
    channel_id: string,
    message_id: string,
    name: string,
  ): Promise<string | null> {
    if (!this.connected) {
      console.log(`[discord:offline] Would create thread "${name}" from message ${message_id}`);
      return null;
    }

    try {
      const channel = await this.client.channels.fetch(channel_id);
      if (!channel?.isTextBased()) return null;

      const message = await (channel as TextChannel).messages.fetch(message_id);
      const thread = await message.startThread({
        name: name.slice(0, 100), // Discord thread name max 100 chars
        autoArchiveDuration: 1440, // 24 hours
      });
      console.log(`[discord] Created thread "${name}" (${thread.id}) from message ${message_id}`);
      return thread.id;
    } catch (err) {
      console.error(`[discord] Failed to create thread from message ${message_id}: ${String(err)}`);
      sentry.captureException(err, {
        tags: { module: "discord", action: "create_thread_from_message" },
      });
      return null;
    }
  }

  /** Post a text message to a thread. */
  async send_to_thread(thread_id: string, content: string): Promise<void> {
    if (this.is_empty_channel_id("send_to_thread", thread_id, content)) return;
    if (!this.connected) {
      console.log(`[discord:offline] Would send to thread ${thread_id}: ${content}`);
      return;
    }

    try {
      const thread = await this.client.channels.fetch(thread_id);
      if (thread?.isThread()) {
        // Unarchive if archived so we can post
        if (thread.archived) {
          await thread.setArchived(false);
        }
        await thread.send(content);
      }
    } catch (err) {
      console.error(`[discord] Failed to send to thread ${thread_id}: ${String(err)}`);
      sentry.captureException(err, {
        tags: { module: "discord", action: "send_to_thread" },
      });
    }
  }

  /** Edit an existing message's embed. Returns true on success. */
  async edit_message_embed(
    channel_id: string,
    message_id: string,
    embed: EmbedBuilder,
  ): Promise<boolean> {
    if (!this.connected) {
      console.log(`[discord:offline] Would edit embed on message ${message_id}`);
      return false;
    }

    try {
      const channel = await this.client.channels.fetch(channel_id);
      if (!channel?.isTextBased()) return false;

      const message = await (channel as TextChannel).messages.fetch(message_id);
      await message.edit({ embeds: [embed] });
      return true;
    } catch (err) {
      console.error(
        `[discord] Failed to edit message ${message_id} in ${channel_id}: ${String(err)}`,
      );
      sentry.captureException(err, {
        tags: { module: "discord", action: "edit_message_embed" },
      });
      return false;
    }
  }

  /**
   * Find a thread in a channel by exact name match. Searches active (non-archived)
   * threads first. Returns the thread ID, or null if not found.
   */
  async find_thread_by_name(channel_id: string, name: string): Promise<string | null> {
    if (!this.connected) return null;

    try {
      const channel = await this.client.channels.fetch(channel_id);
      if (!channel?.isTextBased()) return null;

      // Search active threads in the channel
      const text_channel = channel as TextChannel;
      const active = await text_channel.threads.fetchActive();
      const match = active.threads.find((t) => t.name === name);
      if (match) return match.id;

      // Also check recently archived threads (covers daemon restart case)
      const archived = await text_channel.threads.fetchArchived({ limit: 50 });
      const archived_match = archived.threads.find((t) => t.name === name);
      if (archived_match) return archived_match.id;

      return null;
    } catch (err) {
      console.error(`[discord] Failed to find thread "${name}" in ${channel_id}: ${String(err)}`);
      return null;
    }
  }

  // ── Channel management ──

  /** Create a text channel under a category. Returns the channel ID, or null on failure. */
  async create_channel(category_id: string, name: string, reason?: string): Promise<string | null> {
    const guild = await this.get_guild();
    if (!guild) return null;
    try {
      const channel = await guild.channels.create({
        name,
        type: DiscordChannelType.GuildText,
        parent: category_id,
        reason: reason ?? "LobsterFarm dynamic channel",
      });
      console.log(`[discord] Created #${name} (${channel.id})`);
      return channel.id;
    } catch (err) {
      console.error(`[discord] Failed to create channel "${name}": ${String(err)}`);
      sentry.captureException(err, {
        tags: { module: "discord", action: "create_channel" },
      });
      return null;
    }
  }

  /** Delete a channel by ID. Returns true on success, false on failure. No-op (returns true) if disconnected or DM channel. */
  async delete_channel(channel_id: string): Promise<boolean> {
    if (!this.connected) return true;
    try {
      const channel = await this.client.channels.fetch(channel_id);
      if (!channel || channel.isDMBased()) return true;
      await channel.delete("LobsterFarm work room cleanup");
      console.log(`[discord] Deleted channel ${channel_id}`);
      return true;
    } catch (err) {
      console.error(`[discord] Failed to delete channel ${channel_id}: ${String(err)}`);
      sentry.captureException(err, {
        tags: { module: "discord", action: "delete_channel" },
      });
      return false;
    }
  }

  // ── Agent identity ──

  resolve_agent_identity(archetype: ArchetypeRole | "system"): {
    name: string;
    avatar_url: string | undefined;
  } {
    if (archetype === "system") {
      const system_url = this.avatar_urls.get("lobsterfarm");
      return { name: "LobsterFarm", avatar_url: system_url };
    }

    const agents = this.config.agents;

    // Build name lookup defensively: if a new archetype was added to the
    // enum but the config agent entry is missing (e.g., shared dist not
    // yet rebuilt), fall back to the archetype string rather than throwing.
    // This prevents a single unmapped archetype from killing message handling
    // across the entire daemon.
    const names: Record<string, string> = {
      planner: agents.planner?.name ?? "Planner",
      designer: agents.designer?.name ?? "Designer",
      builder: agents.builder?.name ?? "Builder",
      operator: agents.operator?.name ?? "Operator",
      commander: agents.commander?.name ?? "Commander",
      marketer: agents.marketer?.name ?? "Tristan",
      reviewer: "Reviewer",
    };

    const name = names[archetype] ?? archetype;
    const avatar_url = this.avatar_urls.get(name.toLowerCase());
    return { name, avatar_url };
  }

  // ── Avatar management ──

  /** Load avatar URL cache from disk. Returns the parsed map (also populates this.avatar_urls). */
  async load_avatar_cache(): Promise<Map<string, string>> {
    try {
      const raw = await readFile(avatar_cache_path(this.config), "utf-8");
      const data: unknown = JSON.parse(raw);
      if (data && typeof data === "object" && !Array.isArray(data)) {
        for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
          if (typeof value === "string") {
            this.avatar_urls.set(key, value);
          }
        }
      }
    } catch {
      // File doesn't exist or is invalid — start with empty cache
    }
    return new Map(this.avatar_urls);
  }

  /** Save current avatar URL cache to disk. */
  async save_avatar_cache(): Promise<void> {
    const path = avatar_cache_path(this.config);
    await mkdir(join(path, ".."), { recursive: true });
    const obj: Record<string, string> = {};
    for (const [key, value] of this.avatar_urls) {
      obj[key] = value;
    }
    await writeFile(path, JSON.stringify(obj, null, 2), "utf-8");
  }

  /**
   * Upload agent avatars to Discord and cache the CDN URLs.
   *
   * For each configured agent, checks if an avatar file exists at
   * ~/.lobsterfarm/avatars/{name}.{jpg,png,webp}. If the URL is already
   * cached, skips the upload. Otherwise uploads to a system channel
   * and extracts the CDN URL from the resulting attachment.
   *
   * Must be called after Discord is connected.
   */
  async upload_avatars(): Promise<void> {
    // Load any existing cache from disk
    await this.load_avatar_cache();

    // Collect all agent names from config
    const agents = this.config.agents;
    const agent_names = [
      agents.planner.name.toLowerCase(),
      agents.designer.name.toLowerCase(),
      agents.builder.name.toLowerCase(),
      agents.operator.name.toLowerCase(),
      agents.commander.name.toLowerCase(),
      agents.marketer.name.toLowerCase(),
    ];

    // Discover avatar files on disk
    let dir_entries: string[] = [];
    try {
      dir_entries = await readdir(avatars_dir());
    } catch {
      console.log("[discord:avatars] No avatars directory found — skipping avatar upload");
      return;
    }

    // Build a map of agent name → file path for files that exist on disk
    const avatar_files = new Map<string, string>();
    for (const filename of dir_entries) {
      const dot = filename.lastIndexOf(".");
      if (dot === -1) continue;
      const ext = filename.slice(dot).toLowerCase();
      if (!AVATAR_EXTENSIONS.includes(ext)) continue;
      const name = filename.slice(0, dot).toLowerCase();
      avatar_files.set(name, join(avatars_dir(), filename));
    }

    // Find a channel to upload to (system-status preferred, any entity channel as fallback)
    const upload_channel_id = this.find_upload_channel();
    if (!upload_channel_id) {
      console.log("[discord:avatars] No channel available for avatar upload — skipping");
      return;
    }

    let uploaded = 0;
    let cached = 0;

    for (const name of agent_names) {
      // Already cached — skip
      if (this.avatar_urls.has(name)) {
        cached++;
        continue;
      }

      const file_path = avatar_files.get(name);
      if (!file_path) continue;

      try {
        const url = await this.upload_avatar_file(upload_channel_id, name, file_path);
        if (url) {
          this.avatar_urls.set(name, url);
          uploaded++;
        }
      } catch (err) {
        console.error(`[discord:avatars] Failed to upload avatar for ${name}: ${String(err)}`);
      }
    }

    // Also upload any non-agent avatar files (e.g., "lobsterfarm" for system identity)
    for (const [name, file_path] of avatar_files) {
      if (agent_names.includes(name)) continue; // already handled
      if (this.avatar_urls.has(name)) {
        cached++;
        continue;
      }

      try {
        const url = await this.upload_avatar_file(upload_channel_id, name, file_path);
        if (url) {
          this.avatar_urls.set(name, url);
          uploaded++;
        }
      } catch (err) {
        console.error(`[discord:avatars] Failed to upload avatar for ${name}: ${String(err)}`);
      }
    }

    // Save cache to disk if anything changed
    if (uploaded > 0) {
      await this.save_avatar_cache();
    }

    console.log(
      `[discord:avatars] ${String(uploaded)} uploaded, ${String(cached)} cached, ${String(this.avatar_urls.size)} total`,
    );
  }

  /** Upload a single avatar file to Discord and return the CDN URL. */
  private async upload_avatar_file(
    channel_id: string,
    name: string,
    file_path: string,
  ): Promise<string | null> {
    const channel = await this.client.channels.fetch(channel_id);
    if (!channel?.isTextBased()) return null;

    const text_channel = channel as TextChannel;
    const message = await text_channel.send({
      content: `Avatar: ${name}`,
      files: [
        { attachment: file_path, name: `${name}${file_path.slice(file_path.lastIndexOf("."))}` },
      ],
    });

    const attachment = message.attachments.first();
    if (!attachment?.url) {
      console.log(`[discord:avatars] Upload succeeded but no attachment URL for ${name}`);
      return null;
    }

    // Delete the upload message — we only needed the CDN URL
    try {
      await message.delete();
    } catch {
      // Not critical — message stays in the channel but that's fine
    }

    return attachment.url;
  }

  /** Find a channel suitable for avatar uploads. Prefers system-status. */
  private find_upload_channel(): string | null {
    // Try to find system-status channel from global config
    // (it's not in entity_channels — check by iterating channels)
    for (const [channel_id] of this.channel_map) {
      return channel_id; // any mapped channel will work
    }

    // Fallback: try any entity's first channel
    for (const [, entity_map] of this.entity_channels) {
      for (const [, channel_id] of entity_map) {
        return channel_id;
      }
    }

    return null;
  }

  /** Get the current avatar URL for an agent name (for testing/inspection). */
  get_avatar_url(name: string): string | undefined {
    return this.avatar_urls.get(name.toLowerCase());
  }

  // ── Webhook management ──

  private webhook_cache = new Map<string, { webhook: Webhook; cached_at: number }>();

  private static WEBHOOK_TTL_MS = 60 * 60 * 1000;

  invalidate_webhook(channel_id: string): void {
    this.webhook_cache.delete(channel_id);
  }

  private async get_or_create_webhook(channel_id: string): Promise<Webhook | null> {
    // Check cache with TTL
    const cached = this.webhook_cache.get(channel_id);
    if (cached && Date.now() - cached.cached_at < DiscordBot.WEBHOOK_TTL_MS) {
      return cached.webhook;
    }
    if (cached) {
      this.webhook_cache.delete(channel_id);
    }

    try {
      const channel = await this.client.channels.fetch(channel_id);
      if (!channel?.isTextBased()) return null;

      const text_channel = channel as TextChannel;

      // Look for existing LobsterFarm webhook
      const webhooks = await text_channel.fetchWebhooks();
      let webhook = webhooks.find((w) => w.name === "LobsterFarm Agent");

      if (!webhook) {
        // Create one
        webhook = await text_channel.createWebhook({
          name: "LobsterFarm Agent",
          reason: "LobsterFarm agent identity support",
        });
        console.log(`[discord] Created webhook for channel ${channel_id}`);
      }

      this.webhook_cache.set(channel_id, { webhook, cached_at: Date.now() });
      return webhook;
    } catch (err) {
      console.log(`[discord] Failed to get/create webhook for ${channel_id}: ${String(err)}`);
      return null;
    }
  }

  // ── Server & Entity Scaffolding ──

  /** Get the guild (Discord server) from config. */
  protected async get_guild(): Promise<Guild | null> {
    const server_id = this.config.discord?.server_id;
    if (!server_id) {
      console.log("[discord] No server_id in config — cannot scaffold");
      return null;
    }
    try {
      return await this.client.guilds.fetch(server_id);
    } catch (err) {
      console.error(`[discord] Failed to fetch guild ${server_id}: ${String(err)}`);
      sentry.captureException(err, {
        tags: { module: "discord", action: "fetch_guild" },
      });
      return null;
    }
  }

  /**
   * Scaffold the global Discord structure on first connect.
   * Creates the GLOBAL category with #command-center and #system-status.
   * Returns the channel IDs created.
   */
  async scaffold_server(): Promise<{ command_center?: string; system_status?: string }> {
    const guild = await this.get_guild();
    if (!guild) return {};

    const result: { command_center?: string; system_status?: string } = {};

    try {
      // Find or create GLOBAL category
      let category = guild.channels.cache.find(
        (c) => c.name === "GLOBAL" && c.type === DiscordChannelType.GuildCategory,
      ) as CategoryChannel | undefined;

      if (!category) {
        category = await guild.channels.create({
          name: "GLOBAL",
          type: DiscordChannelType.GuildCategory,
          reason: "LobsterFarm global channels",
        });
        console.log("[discord] Created GLOBAL category");
      }

      // Create channels under GLOBAL
      const global_channels = [
        { name: "command-center", key: "command_center" as const },
        { name: "system-status", key: "system_status" as const },
      ];

      for (const ch of global_channels) {
        let channel = guild.channels.cache.find(
          (c) => c.name === ch.name && c.parentId === category!.id,
        );

        if (!channel) {
          channel = await guild.channels.create({
            name: ch.name,
            type: DiscordChannelType.GuildText,
            parent: category.id,
            reason: "LobsterFarm global channel",
          });
          console.log(`[discord] Created #${ch.name}`);
        }

        result[ch.key] = channel.id;
      }
    } catch (err) {
      console.error(`[discord] Server scaffold failed: ${String(err)}`);
      sentry.captureException(err, {
        tags: { module: "discord", action: "scaffold_server" },
      });
    }

    return result;
  }

  /**
   * Populate the guild's role cache from the API. Call once before using
   * find_or_create_bot_role / find_or_create_entity_role, which operate
   * on cache only. Newly created roles are automatically added to cache
   * by discord.js, so a single fetch at the start of a batch is sufficient.
   */
  async ensure_roles_cached(guild: Guild): Promise<void> {
    await guild.roles.fetch();
  }

  /**
   * Find or create the "LobsterFarm Bot" role with Administrator permissions.
   * Used by scaffold_entity and lockdown to ensure bots have a shared role.
   * Caller must call ensure_roles_cached(guild) first.
   */
  async find_or_create_bot_role(guild: Guild): Promise<Role> {
    const existing = guild.roles.cache.find((r) => r.name === "LobsterFarm Bot");
    if (existing) return existing;

    const role = await guild.roles.create({
      name: "LobsterFarm Bot",
      permissions: [PermissionFlagsBits.Administrator],
      reason: "LobsterFarm bot role — grants bots access to all channels",
    });
    console.log(`[discord] Created "LobsterFarm Bot" role (${role.id})`);
    return role;
  }

  /**
   * Find or create the entity-specific Discord role.
   * The role itself has no special permissions — it's used as a tag
   * for category permission overrides.
   * Caller must call ensure_roles_cached(guild) first.
   */
  async find_or_create_entity_role(guild: Guild, entity_id: string): Promise<Role> {
    const existing = guild.roles.cache.find((r) => r.name === entity_id);
    if (existing) return existing;

    const role = await guild.roles.create({
      name: entity_id,
      reason: `LobsterFarm entity role for ${entity_id}`,
    });
    console.log(`[discord] Created entity role "${entity_id}" (${role.id})`);
    return role;
  }

  /**
   * Set permission overrides on a category so only the entity role and
   * bot role can view channels within it. @everyone is denied ViewChannel.
   */
  async set_entity_category_permissions(
    category: CategoryChannel,
    entity_role: Role,
    bot_role: Role,
  ): Promise<void> {
    const guild = category.guild;

    await category.permissionOverwrites.set([
      {
        id: guild.roles.everyone.id,
        type: OverwriteType.Role,
        deny: [PermissionFlagsBits.ViewChannel],
      },
      {
        id: entity_role.id,
        type: OverwriteType.Role,
        allow: [PermissionFlagsBits.ViewChannel],
      },
      {
        id: bot_role.id,
        type: OverwriteType.Role,
        allow: [PermissionFlagsBits.ViewChannel],
      },
    ]);

    console.log(
      `[discord] Set permission overrides on category "${category.name}" ` +
        `(entity: ${entity_role.name}, bot: ${bot_role.name})`,
    );
  }

  // ── Entity membership management (#308) ──

  /**
   * Resolve a Discord username to a user ID by searching the guild.
   *
   * Uses Discord's prefix-match member search, then filters down to an exact
   * case-insensitive match on `username` first, falling back to `global_name`.
   * A username match wins over a global_name match if both exist — usernames
   * are globally unique, global_names are not.
   *
   * @throws UserNotFoundError when no member matches
   * @throws AmbiguousUserError when more than one member matches
   */
  async resolve_user_id(username: string): Promise<string> {
    const guild = await this.get_guild();
    if (!guild) {
      throw new Error("Cannot resolve user — Discord not connected or server_id missing");
    }

    const query = username.trim();
    if (!query) {
      throw new UserNotFoundError(username);
    }

    // Discord's search is prefix-match — fetch a handful and filter exactly.
    const results = await guild.members.search({ query, limit: 10 });
    const target = query.toLowerCase();

    const by_username: UserCandidate[] = [];
    const by_global_name: UserCandidate[] = [];

    for (const [, member] of results) {
      const uname = member.user.username.toLowerCase();
      const gname = member.user.globalName?.toLowerCase() ?? null;
      const candidate: UserCandidate = {
        id: member.user.id,
        username: member.user.username,
        global_name: member.user.globalName ?? null,
      };
      if (uname === target) by_username.push(candidate);
      else if (gname === target) by_global_name.push(candidate);
    }

    // Prefer username matches — they're globally unique on Discord.
    const matches = by_username.length > 0 ? by_username : by_global_name;

    if (matches.length === 0) throw new UserNotFoundError(username);
    if (matches.length > 1) throw new AmbiguousUserError(username, matches);
    return matches[0]!.id;
  }

  /**
   * Assign the entity role to a guild member.
   * The role must already exist in the entity config (populated by lockdown).
   * Returns the role_id that was assigned, so callers can include it in audit
   * logs / API responses without re-reading the entity config.
   */
  async assign_entity_role(entity_id: string, user_id: string): Promise<string> {
    const { guild, role_id } = await this.get_entity_role_context(entity_id);
    const member = await guild.members.fetch(user_id);
    await member.roles.add(role_id, `LobsterFarm entity membership — ${entity_id}`);
    return role_id;
  }

  /** Remove the entity role from a guild member. Idempotent. */
  async remove_entity_role(entity_id: string, user_id: string): Promise<void> {
    const { guild, role_id } = await this.get_entity_role_context(entity_id);
    const member = await guild.members.fetch(user_id);
    await member.roles.remove(role_id, `LobsterFarm entity membership removed — ${entity_id}`);
  }

  /**
   * Shared preamble for assign/remove — verifies the guild is reachable and
   * the entity has a role_id configured. Throws if either check fails.
   */
  private async get_entity_role_context(
    entity_id: string,
  ): Promise<{ guild: Guild; role_id: string }> {
    const guild = await this.get_guild();
    if (!guild) {
      throw new Error("Cannot manage entity membership — Discord not connected");
    }
    const entity = this.registry.get(entity_id);
    if (!entity) {
      throw new NotFoundError(`Entity "${entity_id}" not found`);
    }
    const role_id = entity.entity.channels.role_id;
    if (!role_id) {
      throw new EntityRoleNotConfiguredError(entity_id);
    }
    return { guild, role_id };
  }

  /**
   * Scaffold Discord channels for a new entity.
   * Creates a category, standard channels (general, alerts), an entity role,
   * and sets permission overrides so only the entity role + bot role can view.
   * Work rooms are created on demand via /room.
   * Returns the channel mappings to store in entity config.
   */
  async scaffold_entity(
    entity_id: string,
    entity_name: string,
  ): Promise<{
    category_id: string;
    role_id: string;
    channels: Array<{ type: string; id: string; purpose: string }>;
  }> {
    const guild = await this.get_guild();
    if (!guild) return { category_id: "", role_id: "", channels: [] };

    const channels: Array<{ type: string; id: string; purpose: string }> = [];
    let category_id = "";
    let role_id = "";

    // Create roles before any channels — if role creation fails (e.g., bot lacks
    // Manage Roles permission), we fail fast before leaving an empty, unprotected category.
    let bot_role: Role;
    let entity_role: Role;
    try {
      await this.ensure_roles_cached(guild);
      bot_role = await this.find_or_create_bot_role(guild);
      entity_role = await this.find_or_create_entity_role(guild, entity_id);
      role_id = entity_role.id;
    } catch (err) {
      console.error(
        `[discord] Role creation failed for ${entity_id} — aborting scaffold: ${String(err)}`,
      );
      sentry.captureException(err, {
        tags: { module: "discord", action: "scaffold_entity_roles", entity: entity_id },
      });
      return { category_id, role_id, channels };
    }

    // Track whether permissions were successfully set. If the category is created
    // but permissions fail, we must clean up to avoid leaving an unprotected category
    // visible to @everyone.
    let permissions_set = false;

    try {
      // Create entity category
      const category_name = entity_name;
      let category = guild.channels.cache.find(
        (c) => c.name === category_name && c.type === DiscordChannelType.GuildCategory,
      ) as CategoryChannel | undefined;

      if (!category) {
        category = await guild.channels.create({
          name: category_name,
          type: DiscordChannelType.GuildCategory,
          reason: `LobsterFarm entity: ${entity_id}`,
        });
        console.log(`[discord] Created category "${category_name}"`);
      }
      category_id = category.id;

      // Set category permissions — this is a fatal step. If it fails after the
      // category exists, the entity would be scaffolded but unprotected.
      await this.set_entity_category_permissions(category, entity_role, bot_role);
      permissions_set = true;

      // Standard entity channels — work rooms are created on demand via /room
      const entity_channels = [
        { name: "general", type: "general", purpose: "Entity-level discussion" },
        { name: "alerts", type: "alerts", purpose: "Approvals, blockers, questions" },
      ];

      for (const ch of entity_channels) {
        let channel = guild.channels.cache.find(
          (c) => c.name === ch.name && c.parentId === category!.id,
        );

        if (!channel) {
          channel = await guild.channels.create({
            name: ch.name,
            type: DiscordChannelType.GuildText,
            parent: category.id,
            reason: `LobsterFarm entity: ${entity_id}`,
          });
          console.log(`[discord] Created #${ch.name} in ${category_name}`);
        }

        channels.push({ type: ch.type, id: channel.id, purpose: ch.purpose });
      }

      // Rebuild channel map to include new channels
      this.build_channel_map();
    } catch (err) {
      console.error(`[discord] Entity scaffold failed for ${entity_id}: ${String(err)}`);
      sentry.captureException(err, {
        tags: { module: "discord", action: "scaffold_entity", entity: entity_id },
      });

      // If the category was created but permissions weren't set, delete it
      // to avoid leaving an unprotected category visible to @everyone.
      if (category_id && !permissions_set) {
        try {
          const cat = guild.channels.cache.get(category_id);
          if (cat) {
            await cat.delete("LobsterFarm scaffold cleanup — permission setup failed");
            console.log(`[discord] Deleted unprotected category ${category_id} for ${entity_id}`);
          }
        } catch (cleanup_err) {
          console.error(
            `[discord] Failed to clean up unprotected category ${category_id}: ${String(cleanup_err)}`,
          );
        }
        category_id = "";
      }
    }

    return { category_id, role_id, channels };
  }

  /**
   * Process a single entity during lockdown.
   *
   * Fetches the Discord category FIRST — if it's missing (Unknown Channel /
   * 10003), returns `skipped_missing_category` without creating the entity
   * role. Previously the role was created first and then orphaned on the
   * guild when the category fetch threw (see #303).
   *
   * Caller must have called `ensure_roles_cached(guild)` and
   * `find_or_create_bot_role(guild)` beforehand.
   */
  async process_entity_lockdown(
    guild: Guild,
    entity_config: EntityConfig,
    bot_role: Role,
  ): Promise<{
    status: "processed" | "skipped_no_category_id" | "skipped_missing_category" | "failed";
  }> {
    const entity_id = entity_config.entity.id;
    const category_id = entity_config.entity.channels.category_id;

    if (!category_id || !is_discord_snowflake(category_id)) {
      console.log(`[lockdown] Skipping entity "${entity_id}" — no valid category_id`);
      return { status: "skipped_no_category_id" };
    }

    // Fetch the category FIRST. If Discord returns 10003 (Unknown Channel)
    // the category was deleted out from under us — skip this entity without
    // creating a role, so we don't leave an orphan role on the guild.
    let category: CategoryChannel | null;
    try {
      category = (await guild.channels.fetch(category_id)) as CategoryChannel | null;
    } catch (err) {
      if (err instanceof DiscordAPIError && err.code === RESTJSONErrorCodes.UnknownChannel) {
        console.warn(
          `[lockdown] Skipped entity "${entity_id}" — category ${category_id} not found (stale config?). No role created. Update config or re-scaffold the entity.`,
        );
        return { status: "skipped_missing_category" };
      }
      console.error(
        `[lockdown] Failed to fetch category for entity "${entity_id}": ${String(err)}`,
      );
      sentry.captureException(err, {
        tags: { module: "discord", action: "lockdown_fetch_category", entity: entity_id },
      });
      return { status: "failed" };
    }

    if (!category || category.type !== DiscordChannelType.GuildCategory) {
      console.warn(
        `[lockdown] Skipped entity "${entity_id}" — category ${category_id} not a guild category. No role created.`,
      );
      return { status: "skipped_missing_category" };
    }

    try {
      // Only create the entity role after we've confirmed the category exists.
      // Cache was populated by ensure_roles_cached() at the start of lockdown;
      // newly created roles are auto-added to cache.
      const entity_role = await this.find_or_create_entity_role(guild, entity_id);

      await this.set_entity_category_permissions(category, entity_role, bot_role);

      // lockPermissions() syncs the channel to inherit from the category, wiping any
      // channel-level overrides. Safe for our setup — all LF channels should inherit.
      for (const [, child] of category.children.cache) {
        try {
          await child.lockPermissions();
        } catch (err) {
          console.warn(`[lockdown] Failed to sync permissions for #${child.name}: ${String(err)}`);
        }
      }

      // Store role_id in entity config if not already set
      if (entity_config.entity.channels.role_id !== entity_role.id) {
        entity_config.entity.channels.role_id = entity_role.id;
        await this.persist_entity_config(entity_config);
        console.log(`[lockdown] Stored role_id for entity "${entity_id}"`);
      }

      console.log(`[lockdown] Processed entity "${entity_id}"`);
      return { status: "processed" };
    } catch (err) {
      console.error(`[lockdown] Failed to process entity "${entity_id}": ${String(err)}`);
      sentry.captureException(err, {
        tags: { module: "discord", action: "lockdown", entity: entity_id },
      });
      return { status: "failed" };
    }
  }

  /**
   * Surface entities that were skipped during lockdown because their Discord
   * category was missing. Posts to #system-status — a global channel, so the
   * notification lands even when the affected entity's own #alerts channel
   * is also gone (usually the case when the category is deleted).
   */
  private async notify_missing_categories(entity_ids: string[]): Promise<void> {
    try {
      const channel_id = await this.find_system_status_channel();
      if (!channel_id) {
        console.warn(
          `[lockdown] Cannot surface stale-category skips — #system-status not found. Entities needing attention: ${entity_ids.join(", ")}`,
        );
        return;
      }
      const list = entity_ids.map((id) => `\`${id}\``).join(", ");
      const body = `⚠️ Lockdown skipped ${String(entity_ids.length)} entity(ies) — their configured \`category_id\` points to a category that no longer exists on the Discord server: ${list}.\nNo role was created for these entities. Update the entity config or re-scaffold to restore them.`;
      await this.send(channel_id, body);
    } catch (err) {
      console.error(`[lockdown] Failed to surface stale-category skips: ${String(err)}`);
      sentry.captureException(err, {
        tags: { module: "discord", action: "lockdown_notify_missing_categories" },
      });
    }
  }

  /**
   * One-time lockdown migration.
   *
   * Idempotent — safe to run multiple times. For each entity:
   * 1. Creates/finds the "LobsterFarm Bot" role, assigns to all bot members
   * 2. Creates/finds entity roles, sets category permission overrides
   * 3. Stores role_id in entity config
   * 4. Locks down the GLOBAL category (Jax + bots only)
   * 5. Locks down the failsafe channel if it exists
   * 6. Reloads entity configs
   */
  async lockdown(): Promise<{
    bot_role_id: string;
    entities_processed: number;
    entities_failed: number;
    /** Entity IDs whose Discord category was missing (10003 Unknown Channel). */
    entities_skipped_missing_category: string[];
    global_locked: boolean;
    failsafe_locked: boolean;
    bots_assigned: number;
  }> {
    const guild = await this.get_guild();
    if (!guild) {
      throw new Error("Cannot fetch guild — Discord not connected or server_id missing");
    }

    const user_id = this.config.discord?.user_id;
    if (!user_id) {
      throw new Error("discord.user_id not set in config — required for global channel lockdown");
    }
    if (!is_discord_snowflake(user_id)) {
      throw new Error(
        `discord.user_id "${user_id}" is not a valid Discord snowflake — expected a 17-20 digit numeric string`,
      );
    }

    // 1. Create/find the bot role — populate cache once for the entire lockdown
    await this.ensure_roles_cached(guild);
    const bot_role = await this.find_or_create_bot_role(guild);

    // 2. Assign bot role to LobsterFarm bot members only (not all bots in the server).
    // The "LobsterFarm Bot" role carries Administrator — only our bots should have it.
    // Infrastructure bots (Pat, daemon, failsafe, merm) don't share a prefix with pool
    // bots, so the config-driven allowlist covers them explicitly (#302).
    const infrastructure_bots = this.config.discord?.infrastructure_bots ?? [];
    const members = await guild.members.fetch();
    let bots_assigned = 0;
    for (const [, member] of members) {
      if (
        member.user.bot &&
        is_lf_bot(member.user.username, infrastructure_bots) &&
        !member.roles.cache.has(bot_role.id)
      ) {
        try {
          await member.roles.add(bot_role, "LobsterFarm lockdown — assigning bot role");
          bots_assigned++;
          console.log(`[lockdown] Assigned bot role to ${member.user.tag}`);
        } catch (err) {
          // The daemon bot's own application role may be higher, causing this
          // to fail for the bot itself. Log and continue.
          console.warn(
            `[lockdown] Failed to assign bot role to ${member.user.tag}: ${String(err)}`,
          );
        }
      }
    }
    console.log(`[lockdown] Bot role assigned to ${String(bots_assigned)} new bots`);

    // 3. Process each entity — fetch category, create role, set overrides, store role_id
    let entities_processed = 0;
    let entities_failed = 0;
    const entities_skipped_missing_category: string[] = [];
    for (const entity_config of this.registry.get_all()) {
      const result = await this.process_entity_lockdown(guild, entity_config, bot_role);
      switch (result.status) {
        case "processed":
          entities_processed++;
          break;
        case "skipped_missing_category":
          entities_skipped_missing_category.push(entity_config.entity.id);
          entities_failed++;
          break;
        case "skipped_no_category_id":
          // Intentional no-op: entity has no category configured yet (e.g. not scaffolded).
          break;
        case "failed":
          entities_failed++;
          break;
      }
    }

    // Surface stale-category skips so they don't silently rot — post to #system-status
    // (which isn't entity-scoped) so Jax sees a single global notification even when
    // the affected entity's own #alerts channel is also gone.
    if (entities_skipped_missing_category.length > 0) {
      await this.notify_missing_categories(entities_skipped_missing_category);
    }

    // 4. Lock down GLOBAL category — Jax + bots only
    // Fetch fresh channel list to match the API-fetched approach used for entity categories
    let global_locked = false;
    try {
      await guild.channels.fetch();
      const global_category = guild.channels.cache.find(
        (c) => c.name === "GLOBAL" && c.type === DiscordChannelType.GuildCategory,
      ) as CategoryChannel | undefined;

      if (global_category) {
        await global_category.permissionOverwrites.set([
          {
            id: guild.roles.everyone.id,
            type: OverwriteType.Role,
            deny: [PermissionFlagsBits.ViewChannel],
          },
          {
            id: user_id,
            type: OverwriteType.Member,
            allow: [PermissionFlagsBits.ViewChannel],
          },
          {
            id: bot_role.id,
            type: OverwriteType.Role,
            allow: [PermissionFlagsBits.ViewChannel],
          },
        ]);

        // lockPermissions() syncs the channel to inherit from the category, wiping any
        // channel-level overrides. Safe for our setup — all LF channels should inherit.
        for (const [, child] of global_category.children.cache) {
          try {
            await child.lockPermissions();
          } catch (err) {
            console.warn(`[lockdown] Failed to sync GLOBAL child #${child.name}: ${String(err)}`);
          }
        }

        global_locked = true;
        console.log("[lockdown] GLOBAL category locked down");
      } else {
        console.log("[lockdown] GLOBAL category not found — skipping");
      }
    } catch (err) {
      console.error(`[lockdown] Failed to lock GLOBAL category: ${String(err)}`);
      sentry.captureException(err, {
        tags: { module: "discord", action: "lockdown_global" },
      });
    }

    // 5. Lock down failsafe channel (may exist outside a category)
    let failsafe_locked = false;
    try {
      const failsafe = guild.channels.cache.find(
        (c) => c.name === "failsafe" && c.type === DiscordChannelType.GuildText,
      ) as TextChannel | undefined;

      if (failsafe) {
        await failsafe.permissionOverwrites.set([
          {
            id: guild.roles.everyone.id,
            type: OverwriteType.Role,
            deny: [PermissionFlagsBits.ViewChannel],
          },
          {
            id: user_id,
            type: OverwriteType.Member,
            allow: [PermissionFlagsBits.ViewChannel],
          },
          {
            id: bot_role.id,
            type: OverwriteType.Role,
            allow: [PermissionFlagsBits.ViewChannel],
          },
        ]);

        failsafe_locked = true;
        console.log("[lockdown] Failsafe channel locked down");
      } else {
        console.log("[lockdown] Failsafe channel not found — skipping");
      }
    } catch (err) {
      console.error(`[lockdown] Failed to lock failsafe channel: ${String(err)}`);
      sentry.captureException(err, {
        tags: { module: "discord", action: "lockdown_failsafe" },
      });
    }

    // 6. Reload entity configs and rebuild channel map
    await this.registry.load_all();
    this.build_channel_map();

    console.log(
      `[lockdown] Complete: ${String(entities_processed)} entities processed, ` +
        `${String(entities_failed)} failed ` +
        `(${String(entities_skipped_missing_category.length)} skipped: missing category), ` +
        `${String(bots_assigned)} bots, global=${String(global_locked)}, ` +
        `failsafe=${String(failsafe_locked)}`,
    );

    return {
      bot_role_id: bot_role.id,
      entities_processed,
      entities_failed,
      entities_skipped_missing_category,
      global_locked,
      failsafe_locked,
      bots_assigned,
    };
  }

  /** Rebuild the channel → entity/type index from entity configs. */
  build_channel_map(): void {
    this.channel_map.clear();
    this.entity_channels.clear();

    for (const entity_config of this.registry.get_all()) {
      const entity_id = entity_config.entity.id;
      const entity_map = new Map<ChannelType, string>();

      for (const channel of entity_config.entity.channels.list) {
        if (!is_discord_snowflake(channel.id)) {
          console.log(
            `[discord] Skipping invalid channel ID "${channel.id}" ` +
              `in entity "${entity_id}" — not a Discord snowflake`,
          );
          continue;
        }

        this.channel_map.set(channel.id, {
          entity_id,
          channel_type: channel.type,
          assigned_archetype: channel.assigned_archetype,
        });

        // For send_to_entity, store the first channel of each type
        if (!entity_map.has(channel.type)) {
          entity_map.set(channel.type, channel.id);
        }
      }

      this.entity_channels.set(entity_id, entity_map);
    }

    console.log(
      `[discord] Channel map built: ${String(this.channel_map.size)} channels across ${String(this.entity_channels.size)} entities`,
    );
  }

  private _pool: BotPool | null = null;
  private _commander: CommanderProcess | null = null;

  set_managers(_queue: TaskQueue): void {
    // Queue wiring deferred — will be used for slash-command task submission
    console.debug("[discord] set_managers called — queue wiring not yet implemented");
  }

  /**
   * Wire the CommanderProcess so handle_message can keep Pat's access.json
   * in sync when the owner posts in a daemon-watched channel that isn't a
   * pool work room. See `ensure_channel_allowlisted` for the additive
   * allowlist semantics. Issue #318.
   */
  set_commander(commander: CommanderProcess): void {
    this._commander = commander;
  }

  set_pool(pool: BotPool): void {
    this._pool = pool;

    // Register nickname handler so pool can set bot nicknames through the
    // daemon's Discord client — no pool bot tokens needed at runtime.
    pool.set_nickname_handler(async (user_id: string, display_name: string) => {
      const guild = await this.get_guild();
      if (!guild) return;
      const member = await guild.members.fetch(user_id);
      await member.setNickname(display_name);
    });

    // Register avatar handler so pool can set bot profile pictures.
    // Uses a raw REST call with the bot's own token — the daemon bot
    // cannot change another bot's profile avatar via the gateway.
    pool.set_avatar_handler(async (state_dir: string, agent_name: string) => {
      await set_bot_profile_avatar(state_dir, agent_name);
    });

    // When a waiting-for-human bot is evicted, notify the channel
    pool.on(
      "bot:parked_with_context",
      (info: { bot_id: number; channel_id: string | null; entity_id: string | null }) => {
        if (info.channel_id) {
          void this.send(
            info.channel_id,
            "This session was parked to free up a bot slot. " +
              "Your conversation is saved — it will resume when you send a new message.",
          );
        }
      },
    );
  }

  // ── Internal message handling ──

  private async handle_message(message: Message): Promise<void> {
    // Ignore bot messages
    if (message.author.bot) return;

    // Look up channel in entity map
    const entry = this.channel_map.get(message.channelId);

    // Commander (Pat) handles #command-center via its own Discord bot.
    // The daemon's bot sees user messages there too — start typing + status
    // embeds so the user gets visual feedback while Pat processes.
    // Lazily resolve the channel ID if it hasn't been cached yet (covers the
    // narrow window between bot ready and the async find_command_center_channel).
    const cc_id = this.command_center_channel_id ?? (await this.find_command_center_channel());
    if (!entry && cc_id === message.channelId) {
      this.start_commander_typing_loop(message.channelId);
      void this.send_status_embed(message.channelId, "commander");
      return;
    }

    // Owner-authored message in a non-pool, non-command-center channel that
    // the daemon's bot can see. Ensure Pat's allowlist contains this channel
    // so a follow-up @-mention of Pat is delivered by the plugin's gate
    // instead of dropped. Idempotent: skips on channels already allowlisted.
    // Issue #318.
    if (!entry && this._commander) {
      const owner_id = this.config.discord?.user_id;
      if (owner_id && message.author.id === owner_id) {
        try {
          await this._commander.ensure_channel_allowlisted(message.channelId);
        } catch (err) {
          // Don't let an allowlist write failure derail message handling for
          // the rest of the daemon. Log + Sentry; the next owner message in
          // the same channel will retry.
          console.error(
            `[discord] Failed to allowlist channel for Pat: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          sentry.captureException(err, {
            tags: { module: "discord", action: "ensure_channel_allowlisted" },
          });
        }
      }
    }

    // Unmapped channels: ignore everything.
    if (!entry) return;

    // Ignore legacy !lf text commands — all commands are now slash commands.
    if (message.content.trim().startsWith("!lf")) return;

    // Intercept !reset — release current bot, next real message triggers fresh assignment
    if (message.content.trim().toLowerCase() === "!reset") {
      if (this._pool) {
        // Clear session history so the next assignment starts fresh
        this._pool.clear_session_history(entry.entity_id, message.channelId);
        await this._pool.release(message.channelId);
        const target = target_from_message(message, (ch, c) => this.send(ch, c));
        await target.reply(
          "Session reset. Send a message to start fresh.\n-# Tip: use `/reset` instead of `!reset`",
        );
      }
      return;
    }

    // Non-command messages: auto-assign a pool bot if none is active on this channel
    if (this._pool) {
      let assignment = this._pool.get_assignment(message.channelId);

      // If a bot is assigned but its tmux session is dead, release it (preserving
      // session_id for resume) and fall through to the auto-assign branch below.
      // This is the lazy-resume path: the first message after a tmux death triggers
      // reassignment with session resume, so the user never sees a gap.
      if (assignment && !this._pool.is_session_alive(assignment.id)) {
        console.log(
          `[discord] Dead tmux detected for pool-${String(assignment.id)} on message — releasing with history`,
        );
        await this._pool.release_with_history(assignment.id);
        assignment = undefined;
      }

      // If the tmux session is alive but the CLI has a stale OAuth token
      // ("Not logged in"), kill it and release with history. The re-assign
      // flow below will spawn a fresh CLI process with a valid token and
      // --resume the session so conversation context is preserved.
      if (assignment && this._pool.has_stale_oauth(assignment.id)) {
        console.warn(
          `[discord] Stale OAuth detected for pool-${String(assignment.id)} on message — killing and releasing with history`,
        );
        this._pool.kill_stale_session(assignment.id);
        await this._pool.release_with_history(assignment.id);
        assignment = undefined;
      }

      if (!assignment) {
        // Use the channel's configured archetype override if present, otherwise
        // default to planner. This lets work_room channels (e.g., #marketing)
        // spawn a specific archetype (e.g., marketer) without a /swap.
        const archetype: ArchetypeRole = entry.assigned_archetype ?? "planner";

        // Show the user we're working on it
        try {
          await message.react("⏳");
        } catch {
          /* ignore */
        }

        // Pass the user's message as a pending_message so the SessionStart
        // hook can inject it as additionalContext when the Claude CLI
        // starts (issue #290). No tmux send-keys bridging required.
        const result = await this._pool.assign(
          message.channelId,
          entry.entity_id,
          archetype,
          undefined, // resume_session_id — pool handles auto-resume from parked bots + session_history
          entry.channel_type,
          undefined, // working_dir — use entity default
          {
            user: message.author.displayName,
            channel_id: message.channelId,
            message_id: message.id,
            content: message.content,
            ts: new Date(message.createdTimestamp).toISOString(),
          },
        );
        if (result) {
          try {
            await message.reactions.cache.get("⏳")?.users.remove(this.client.user!.id);
            await message.react("👀");
          } catch {
            /* ignore */
          }
          // Start typing indicator loop + status embed while bot processes
          this.start_typing_loop(message.channelId);
          void this.send_status_embed(message.channelId, archetype);
        } else {
          try {
            await message.reactions.cache.get("⏳")?.users.remove(this.client.user!.id);
          } catch {
            /* ignore */
          }
          try {
            await message.reply(
              "All bots are busy right now. Your message will be picked up when a slot opens.",
            );
          } catch {
            await this.send(
              message.channelId,
              "All bots are busy right now. Your message will be picked up when a slot opens.",
            );
          }
        }
      } else {
        // Bot is assigned and tmux is alive — touch for LRU tracking
        this._pool.touch(message.channelId);
        // Start typing indicator loop + status embed while bot processes the new message
        this.start_typing_loop(message.channelId);
        void this.send_status_embed(message.channelId, assignment.archetype ?? "planner");
      }
    }
  }

  private async handle_command(
    name: string,
    args: string[],
    routed: RoutedMessage,
    target: CommandTarget,
  ): Promise<void> {
    switch (name) {
      case "help":
        await target.reply(
          "**LobsterFarm Commands:**\n" +
            "• `/swap <agent>` — swap active agent in this channel\n" +
            "• `/compact` — trigger context compaction on the active session\n" +
            "• `/room <name>` — create an on-demand work room with a pool bot\n" +
            "• `/close` — archive and delete the current work room\n" +
            "• `/resume <name>` — restore an archived work room session\n" +
            "• `/archives` — list archived work room sessions\n" +
            "• `/status` — session/entity status for this channel\n" +
            "• `/scaffold <name>` — create Discord channels\n" +
            "• `/reset` — reset the current session\n" +
            "• `/help` — this message",
        );
        break;

      case "status":
        await this.handle_status_command(routed, target);
        break;

      case "scaffold":
        await this.handle_scaffold_command(args, routed, target);
        break;

      case "swap":
        await this.handle_swap_command(args, target);
        break;

      case "compact":
        await this.handle_compact_command(target);
        break;

      case "room":
        await this.handle_room_command(args, routed, target);
        break;

      case "close":
        await this.handle_close_command(args, routed, target);
        break;

      case "resume":
        await this.handle_resume_command(args, routed, target);
        break;

      case "reset":
        await this.handle_reset_command(routed, target);
        break;

      case "archives":
        await this.handle_archives_command(routed, target);
        break;

      default:
        await target.reply(`Unknown command: \`${name}\`. Try \`/help\`.`);
    }
  }

  private async handle_status_command(routed: RoutedMessage, target: CommandTarget): Promise<void> {
    const pool = this._pool;
    const entity_id = routed.entity_id;
    const is_entity_channel = entity_id !== "_global";

    // Build pool summary (used in all contexts)
    const pool_summary = pool ? this.format_pool_summary(pool) : null;

    // Global channel (e.g., #command-center) — show cross-entity dashboard
    if (!is_entity_channel) {
      const response = this.format_cross_entity_status(pool);
      await target.reply(response);
      return;
    }

    // Entity-level channels without session-specific info (e.g., #alerts, #work-log)
    const assignment = pool?.get_assignment(target.channel_id);
    if (!assignment && routed.channel_type !== "general" && routed.channel_type !== "work_room") {
      const lines = [`**${entity_id}**`];
      if (pool_summary) lines.push("", pool_summary);
      await target.reply(lines.join("\n"));
      return;
    }

    // Entity channel with no bot assigned
    if (!assignment) {
      const lines = ["No active session in this channel."];
      lines.push("", `**${entity_id}**`);
      if (pool_summary) lines.push("", pool_summary);
      await target.reply(lines.join("\n"));
      return;
    }

    // Full session status — bot is assigned to this channel.
    const lines = await this.format_session_status(assignment, routed);
    if (pool_summary) lines.push("", pool_summary);
    await target.reply(lines.join("\n"));
  }

  /** Format the full session status block for a channel with an assigned bot.
   * Fetches context and subscription usage on demand from live data sources. */
  private async format_session_status(bot: PoolBot, _routed: RoutedMessage): Promise<string[]> {
    const identity = bot.archetype ? this.resolve_agent_identity(bot.archetype) : null;
    const agent_label = identity ? `${identity.name} (${bot.archetype})` : "unknown";

    const lines = ["**Session Status**", `Agent: ${agent_label}`];

    if (bot.session_id) {
      lines.push(`Session: \`${bot.session_id.slice(0, 8)}\``);
    }

    // Uptime from assigned_at, falling back to last_active
    const start_time = bot.assigned_at ?? bot.last_active;
    if (start_time) {
      lines.push(`Uptime: ${format_duration(start_time)}`);
    }

    lines.push(`Bot: pool-${String(bot.id)} (lf-${String(bot.id)})`);

    if (bot.model) {
      lines.push(`Model: ${bot.model}`);
    }
    if (bot.effort) {
      lines.push(`Effort: ${bot.effort}`);
    }

    // Fetch context and subscription usage on demand.
    // Both calls are best-effort: try/catch prevents either from blocking the response.
    const [context_usage, subscription_usage] = await Promise.all([
      bot.session_id ? read_session_context(bot.session_id) : Promise.resolve(null),
      fetch_subscription_usage(),
    ]);

    if (context_usage) {
      let context_line = `Context: ${context_usage.summary}`;
      if (context_usage.compactions > 0) {
        const label = context_usage.compactions === 1 ? "compaction" : "compactions";
        context_line += ` \u00b7 ${String(context_usage.compactions)} ${label}`;
      }
      lines.push(context_line);
    }
    if (subscription_usage) {
      lines.push(`Usage: ${subscription_usage.summary}`);
    }

    return lines;
  }

  /** Format pool capacity summary. */
  private format_pool_summary(pool: BotPool): string {
    const status = pool.get_status();
    return `Pool: ${String(status.assigned)}/${String(status.total)} assigned, ${String(status.free)} free`;
  }

  /** Build the cross-entity status dashboard shown in #command-center.
   * Gathers data from registry and pool, then delegates to the pure
   * format_cross_entity_dashboard() function for rendering. */
  format_cross_entity_status(pool: BotPool | null): string {
    const entities = this.registry.get_active();
    const status = pool?.get_status();
    const assigned_bots = pool?.get_assigned_bots() ?? [];

    // Group assigned bots by entity
    const bots_by_entity = new Map<string, (typeof assigned_bots)[number][]>();
    for (const bot of assigned_bots) {
      if (!bot.entity_id) continue;
      const list = bots_by_entity.get(bot.entity_id) ?? [];
      list.push(bot);
      bots_by_entity.set(bot.entity_id, list);
    }

    // Build dashboard data with all names/labels pre-resolved
    const dashboard_entities: DashboardEntity[] = entities.map((entity_config) => {
      const eid = entity_config.entity.id;
      const entity_bots = bots_by_entity.get(eid) ?? [];
      return {
        id: eid,
        sessions: entity_bots.map((bot) => {
          const identity = bot.archetype ? this.resolve_agent_identity(bot.archetype) : null;
          return {
            channel_name: this.resolve_channel_display_name(bot.channel_id),
            agent_label: identity ? `${identity.name} (${bot.archetype})` : "unknown",
            duration: bot.assigned_at ? format_duration(bot.assigned_at) : "?",
          };
        }),
      };
    });

    return format_cross_entity_dashboard({
      uptime: format_uptime(process.uptime()),
      pool_assigned: status?.assigned ?? 0,
      pool_total: status?.total ?? 0,
      entities: dashboard_entities,
    });
  }

  /** Resolve a channel ID to a display name.
   * Uses the Discord.js channel cache when available, falls back to the
   * channel_type from the channel map, and finally to the raw ID. */
  private resolve_channel_display_name(channel_id: string | null): string {
    if (!channel_id) return "unknown";

    // Try Discord.js cache first (has actual channel names)
    const discord_channel = this.client.channels.cache.get(channel_id);
    if (discord_channel && "name" in discord_channel && typeof discord_channel.name === "string") {
      return `#${discord_channel.name}`;
    }

    // Fall back to channel type from our mapping
    const entry = this.channel_map.get(channel_id);
    if (entry) {
      return `#${entry.channel_type.replace(/_/g, "-")}`;
    }

    return `#${channel_id}`;
  }

  private async handle_scaffold_command(
    args: string[],
    _routed: RoutedMessage,
    target: CommandTarget,
  ): Promise<void> {
    const sub = args[0];

    if (sub === "entity") {
      // Usage: /scaffold name:<id>
      const entity_id = args[1];
      if (!entity_id || !/^[a-z0-9-]+$/.test(entity_id)) {
        await target.reply(
          "Usage: `/scaffold <id>`\nID must be lowercase alphanumeric with hyphens.",
        );
        return;
      }

      // Check if entity already exists
      if (this.registry.get(entity_id)) {
        await target.reply(`Entity **${entity_id}** already exists.`);
        return;
      }

      // Parse remaining args for name, optional --repo, and optional --blueprint
      const remaining = args.slice(2);
      let repo_url = "";
      let blueprint = "software";
      const name_parts: string[] = [];
      for (let i = 0; i < remaining.length; i++) {
        if (remaining[i] === "--repo" && remaining[i + 1]) {
          repo_url = remaining[i + 1]!;
          i++;
        } else if (remaining[i] === "--blueprint" && remaining[i + 1]) {
          blueprint = remaining[i + 1]!;
          i++;
        } else {
          name_parts.push(remaining[i]!);
        }
      }
      const entity_name = name_parts.join(" ") || entity_id;

      await target.reply(`Setting up entity **${entity_id}** ("${entity_name}")...`);

      // 1. Create Discord channels and entity role
      const { category_id, role_id, channels } = await this.scaffold_entity(entity_id, entity_name);

      // 2. Create directory structure
      const paths = this.config.paths;
      const dirs = [
        entity_dir(paths, entity_id),
        entity_daily_dir(paths, entity_id),
        entity_context_dir(paths, entity_id),
        entity_files_dir(paths, entity_id),
      ];
      for (const dir of dirs) {
        await mkdir(dir, { recursive: true });
      }

      // 3. Create entity config
      const entity_config = {
        entity: {
          id: entity_id,
          name: entity_name,
          description: "",
          status: "active",
          blueprint,
          repos: [
            {
              name: entity_id,
              url: repo_url || `git@github.com:org/${entity_id}.git`,
              path: `~/.lobsterfarm/entities/${entity_id}/repos/${entity_id}`,
              structure: "monorepo",
            },
          ],
          accounts: {},
          channels: {
            category_id,
            role_id: role_id || undefined,
            list: channels,
          },
          memory: {
            path: entity_dir(paths, entity_id),
            auto_extract: true,
          },
          secrets: {
            vault: "1password",
            vault_name: `entity-${entity_id}`,
          },
        },
      };

      const config_path = entity_config_path(paths, entity_id);
      await write_yaml(config_path, entity_config);

      // 4. Create MEMORY.md and context files
      const mem_path = entity_memory_path(paths, entity_id);
      await writeFile(
        mem_path,
        `# ${entity_name} — Memory\n\n_Curated project knowledge. Updated by agents, reviewed periodically._\n`,
        "utf-8",
      );

      const ctx_dir = entity_context_dir(paths, entity_id);
      await writeFile(
        join(ctx_dir, "decisions.md"),
        `# ${entity_name} — Decision Log\n\n_Append-only. Record significant decisions with rationale._\n`,
        "utf-8",
      );
      await writeFile(
        join(ctx_dir, "gotchas.md"),
        `# ${entity_name} — Known Gotchas\n\n_Issues, workarounds, and things to watch out for._\n`,
        "utf-8",
      );

      // 5. Reload entity into registry and rebuild channel map so the new
      //    entity's channels are routable immediately (the build_channel_map
      //    call inside scaffold_entity runs before the registry has the entity).
      await this.registry.load_all();
      this.build_channel_map();

      // 6. Report
      const channel_lines = channels.map((c) => `  • #${c.purpose} → ${c.type}`);
      await target.reply(
        `Entity **${entity_id}** fully scaffolded:\n• Config: \`${config_path}\`\n• Memory: \`${mem_path}\`\n• Discord: ${String(channels.length)} channels\n${channel_lines.join("\n")}\n\nReady to use. Try \`/room "your-first-room"\``,
      );
    } else if (sub === "server") {
      await target.reply("Scaffolding global Discord structure...");
      const result = await this.scaffold_server();
      const created = Object.entries(result).filter(([_, v]) => v).length;
      await target.reply(`Global scaffold complete. ${String(created)} channels configured.`);
    } else {
      await target.reply(
        "Usage:\n• `/scaffold server` — create GLOBAL channels\n• `/scaffold <id>` — create entity channels",
      );
    }
  }

  private async handle_swap_command(args: string[], target: CommandTarget): Promise<void> {
    if (!this._pool) {
      await target.reply("Bot pool not available.");
      return;
    }

    // Usage: /swap agent:<archetype>
    const archetype_name = args[0]?.toLowerCase();
    const archetype_map: Record<string, ArchetypeRole> = {
      gary: "planner",
      planner: "planner",
      bob: "builder",
      builder: "builder",
      pearl: "designer",
      designer: "designer",
      ray: "operator",
      operator: "operator",
    };

    const archetype = archetype_map[archetype_name ?? ""];
    if (!archetype) {
      await target.reply("Usage: `/swap <agent>` — planner, builder, designer, or operator");
      return;
    }

    const channel_id = target.channel_id;
    const entry = this.channel_map.get(channel_id);
    if (!entry) {
      await target.reply("This channel isn't mapped to an entity.");
      return;
    }

    // Release current bot, assign new one
    await this._pool.release(channel_id);
    const result = await this._pool.assign(channel_id, entry.entity_id, archetype);

    if (result) {
      const agent_display =
        this.config.agents[archetype === "reviewer" ? "planner" : archetype]?.name ?? archetype;
      await target.reply(`Swapping to ${agent_display}...`);
    } else {
      await target.reply("No pool bots available for swap.");
    }
  }

  private async handle_compact_command(target: CommandTarget): Promise<void> {
    if (!this._pool) {
      await target.reply("Bot pool not available.");
      return;
    }

    const assignment = this._pool.get_assignment(target.channel_id);
    if (!assignment) {
      await target.reply("No active session in this channel.");
      return;
    }

    try {
      execFileSync("tmux", ["send-keys", "-t", assignment.tmux_session, "/compact", "Enter"], {
        stdio: "ignore",
        timeout: 5000,
      });
      await target.reply("✅ Compact triggered.");
    } catch {
      await target.reply("Failed to send compact — session may be unresponsive.");
    }
  }

  // ── Dynamic room commands ──

  /**
   * /room name:<name>
   * Creates an on-demand work room under the entity's category,
   * assigns a pool bot, and optionally bridges initial context.
   */
  private async handle_room_command(
    args: string[],
    routed: RoutedMessage,
    target: CommandTarget,
  ): Promise<void> {
    if (!this._pool) {
      await target.reply("Bot pool not available.");
      return;
    }

    const entity_config = this.registry.get(routed.entity_id);
    if (!entity_config) {
      await target.reply("This channel isn't mapped to an entity.");
      return;
    }

    const category_id = entity_config.entity.channels.category_id;
    if (!category_id) {
      await target.reply("Entity has no Discord category configured.");
      return;
    }

    // Parse name and optional context
    const raw_name = args[0];
    if (!raw_name) {
      // Generate a default name with timestamp
      args.unshift(`room-${String(Date.now())}`);
    }
    const name = sanitize_channel_name(args[0]!);
    const context = args.slice(1).join(" ");

    // Check for name collision with active channels
    if (this.find_channel_by_name(entity_config.entity.channels, name)) {
      await target.reply(`A room named **${name}** already exists.`);
      return;
    }

    // Create Discord channel
    const channel_id = await this.create_channel(
      category_id,
      name,
      `On-demand work room for ${routed.entity_id}`,
    );
    if (!channel_id) {
      await target.reply("Failed to create Discord channel.");
      return;
    }

    // Add to entity config
    entity_config.entity.channels.list.push({
      type: "work_room",
      id: channel_id,
      purpose: name,
      dynamic: true,
    });

    // Persist and rebuild
    await this.persist_entity_config(entity_config);
    this.build_channel_map();

    // Assign a pool bot (planner by default). If the /room command carried
    // initial context, inject it via the SessionStart hook (issue #290).
    const pending_message = context
      ? {
          user: target.author_name,
          channel_id,
          message_id: "",
          content: context,
          ts: new Date().toISOString(),
        }
      : undefined;
    const assignment = await this._pool.assign(
      channel_id,
      routed.entity_id,
      "planner",
      undefined,
      "work_room",
      undefined,
      pending_message,
    );

    // Post confirmation in both source channel and new room
    await target.reply(`Room **#${name}** created. Session started.`);
    if (assignment) {
      await this.send(channel_id, "Room created. Session started.");
    }
  }

  /**
   * /close
   * Archives the current work room's session and deletes the channel.
   * Only works in work_room channels.
   */
  private async handle_close_command(
    _args: string[],
    routed: RoutedMessage,
    target: CommandTarget,
  ): Promise<void> {
    // Verify this is a work_room channel
    if (routed.channel_type !== "work_room") {
      await target.reply("Can't close this channel. `/close` only works in work rooms.");
      return;
    }

    const entity_config = this.registry.get(routed.entity_id);
    if (!entity_config) {
      await target.reply("Entity not found.");
      return;
    }

    const channel_id = target.channel_id;
    const channel_entry = entity_config.entity.channels.list.find(
      (c: ChannelMapping) => c.id === channel_id,
    );
    if (!channel_entry) {
      await target.reply("Channel not found in entity config.");
      return;
    }

    // Determine the room name from the purpose field or the channel name
    const room_name = channel_entry.purpose ?? `room-${channel_id}`;

    // Archive the session
    const now = new Date().toISOString();
    const archive_entry: RoomArchive = {
      name: room_name,
      channel_id,
      session_id: null,
      entity_id: routed.entity_id,
      archetype: "planner",
      archived_at: now,
      closed_at: now,
    };

    // Get session info from pool bot if assigned
    if (this._pool) {
      const assignment = this._pool.get_assignment(channel_id);
      if (assignment) {
        archive_entry.session_id = assignment.session_id ?? null;
        archive_entry.archetype = assignment.archetype ?? "planner";
      }
    }

    // Write archive atomically
    await write_room_archive(routed.entity_id, archive_entry, this.config.paths);

    // Release the pool bot
    if (this._pool) {
      await this._pool.release(channel_id);
    }

    // Find the entity's general channel for the farewell message.
    // The work room channel is deleted below, so the farewell goes to #general instead.
    const general_channel = entity_config.entity.channels.list.find(
      (c: ChannelMapping) => c.type === "general",
    );

    // Delete Discord channel
    await this.delete_channel(channel_id);

    // Remove from entity config
    entity_config.entity.channels.list = entity_config.entity.channels.list.filter(
      (c: ChannelMapping) => c.id !== channel_id,
    );

    // Persist and rebuild
    await this.persist_entity_config(entity_config);
    this.build_channel_map();

    // Send farewell to general (skip if general has a placeholder ID)
    if (general_channel && is_discord_snowflake(general_channel.id)) {
      await this.send(
        general_channel.id,
        `Session archived as \`${room_name}\`. Use \`/resume ${room_name}\` to restore.`,
      );
    }

    // Acknowledge the interaction. For slash commands, the interaction token
    // remains valid even after the channel is deleted.
    await target.reply(`Session archived. Use \`/resume ${room_name}\` to restore.`);
  }

  /**
   * /resume name:<name>
   * Restores an archived work room session. Creates a new channel,
   * assigns a pool bot with the archived session_id for resume.
   */
  private async handle_resume_command(
    args: string[],
    routed: RoutedMessage,
    target: CommandTarget,
  ): Promise<void> {
    if (!this._pool) {
      await target.reply("Bot pool not available.");
      return;
    }

    const entity_config = this.registry.get(routed.entity_id);
    if (!entity_config) {
      await target.reply("Entity not found.");
      return;
    }

    const category_id = entity_config.entity.channels.category_id;
    if (!category_id) {
      await target.reply("Entity has no Discord category configured.");
      return;
    }

    const search_name = args[0];
    if (!search_name) {
      await target.reply("Usage: `/resume <name>`");
      return;
    }

    // Look up archives
    const archives = await load_room_archives(routed.entity_id, this.config.paths);
    const matches = archives.filter((a) => a.name === search_name);

    if (matches.length === 0) {
      const available = [...new Set(archives.map((a) => a.name))];
      if (available.length === 0) {
        await target.reply("No archived sessions found for this entity.");
      } else {
        await target.reply(
          `No archived session found with name **${search_name}**.\nAvailable: ${available.map((n) => `\`${n}\``).join(", ")}`,
        );
      }
      return;
    }

    if (matches.length > 1) {
      // Multiple matches — list them with timestamps for disambiguation
      const lines = matches.map(
        (a, i) => `${String(i + 1)}. \`${a.name}\` — closed ${a.closed_at}`,
      );
      await target.reply(
        `Multiple archived sessions named **${search_name}**:\n${lines.join("\n")}\n\nMost recent will be used. To specify, re-close to create distinct names.`,
      );
      // Use the most recent match
    }

    // Use the most recent match (last in sorted order)
    const archive = matches[matches.length - 1]!;

    // Check for name collision with active channels
    if (this.find_channel_by_name(entity_config.entity.channels, search_name)) {
      await target.reply(`A room named **${search_name}** already exists.`);
      return;
    }

    // Create new Discord channel
    const channel_id = await this.create_channel(
      category_id,
      search_name,
      `Resumed work room for ${routed.entity_id}`,
    );
    if (!channel_id) {
      await target.reply("Failed to create Discord channel.");
      return;
    }

    // Add to entity config
    entity_config.entity.channels.list.push({
      type: "work_room",
      id: channel_id,
      purpose: search_name,
      dynamic: true,
    });

    // Persist and rebuild
    await this.persist_entity_config(entity_config);
    this.build_channel_map();

    // Assign pool bot with resumed session_id
    const resume_session_id = archive.session_id ?? undefined;
    const assignment = await this._pool.assign(
      channel_id,
      routed.entity_id,
      (archive.archetype || "planner") as ArchetypeRole,
      resume_session_id,
      "work_room",
    );

    // Consume the archive file now that the room is live again.
    // Failure to delete is non-fatal — log and move on.
    await delete_room_archive(routed.entity_id, archive, this.config.paths);

    if (assignment) {
      await this.send(channel_id, `Session \`${search_name}\` resumed.`);
      await target.reply(`Session **${search_name}** resumed in <#${channel_id}>.`);
    } else {
      await target.reply(
        `Room created but no pool bots available. Send a message in <#${channel_id}> to auto-assign.`,
      );
    }
  }

  // ── Helpers ──

  /** Persist an entity's config back to YAML. */
  private async persist_entity_config(
    entity_config: { entity: { id: string } } & Record<string, unknown>,
  ): Promise<void> {
    const config_path = entity_config_path(this.config.paths, entity_config.entity.id);
    await write_yaml(config_path, entity_config);
    console.log(`[discord] Persisted entity config for ${entity_config.entity.id}`);
  }

  /** Find a channel in an entity's channel list by its purpose/name field. */
  private find_channel_by_name(
    channels: { list: ChannelMapping[] },
    name: string,
  ): ChannelMapping | undefined {
    return channels.list.find((c: ChannelMapping) => c.type === "work_room" && c.purpose === name);
  }

  // ── Slash command handling ──

  /** Handle an incoming slash command interaction. */
  private async handle_slash_command(interaction: ChatInputCommandInteraction): Promise<void> {
    const command_name = interaction.commandName;
    const ephemeral = EPHEMERAL_COMMANDS.has(command_name);
    const deferred = DEFERRED_COMMANDS.has(command_name);

    // Long-running commands must defer within 3 seconds to avoid
    // Discord's "This application did not respond" error.
    if (deferred) {
      try {
        await interaction.deferReply({ ephemeral });
      } catch (err) {
        console.error(`[discord:slash] deferReply failed for /${command_name}: ${String(err)}`);
        return; // Can't respond — Discord already timed out or errored
      }
    }

    const target = target_from_interaction(interaction, ephemeral, deferred);

    // Build entity context from channel map
    const entry = this.channel_map.get(interaction.channelId);
    const routed: RoutedMessage = {
      entity_id: entry?.entity_id ?? "_global",
      channel_type: entry?.channel_type ?? "general",
      content: "",
      author: interaction.user.tag,
      channel_id: interaction.channelId,
    };

    // Extract args from interaction options, mapping to the same
    // positional format that the text command handlers expect
    const args = extract_slash_args(interaction);

    try {
      await this.handle_command(command_name, args, routed, target);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await target.reply(`Error: ${msg}`);
    }
  }

  /** Handle autocomplete interactions (e.g., /resume name suggestions). */
  private async handle_autocomplete(interaction: AutocompleteInteraction): Promise<void> {
    if (interaction.commandName !== "resume") return;

    const focused = interaction.options.getFocused();
    const entry = this.channel_map.get(interaction.channelId);
    if (!entry) {
      await interaction.respond([]);
      return;
    }

    try {
      const archives = await load_room_archives(entry.entity_id, this.config.paths);
      // Deduplicate by name, keep most recent
      const name_map = new Map<string, RoomArchive>();
      for (const a of archives) {
        name_map.set(a.name, a);
      }

      const choices = [...name_map.values()]
        .filter((a) => a.name.toLowerCase().includes(focused.toLowerCase()))
        .slice(0, 25) // Discord limit
        .map((a) => ({ name: a.name, value: a.name }));

      await interaction.respond(choices);
    } catch {
      await interaction.respond([]);
    }
  }

  /** Handle /archives — list all archived work room sessions for the entity. */
  private async handle_archives_command(
    routed: RoutedMessage,
    target: CommandTarget,
  ): Promise<void> {
    if (routed.entity_id === "_global") {
      await target.reply(
        "Run `/archives` in an entity channel to see that entity's archived sessions.",
      );
      return;
    }

    const archives = await load_room_archives(routed.entity_id, this.config.paths);
    if (archives.length === 0) {
      await target.reply("No archived sessions for this entity.");
      return;
    }

    // Deduplicate by name, keeping the most recent
    const by_name = new Map<string, RoomArchive>();
    for (const a of archives) {
      const existing = by_name.get(a.name);
      const a_ts = a.closed_at || a.archived_at || "";
      const ex_ts = existing ? existing.closed_at || existing.archived_at || "" : "";
      if (!existing || a_ts > ex_ts) by_name.set(a.name, a);
    }

    // Sort most recent first
    const sorted = [...by_name.values()].sort((a, b) =>
      (b.closed_at || b.archived_at || "").localeCompare(a.closed_at || a.archived_at || ""),
    );

    const MAX_ENTRIES = 25;
    const lines = ["**Archived Sessions**", ""];
    for (const a of sorted.slice(0, MAX_ENTRIES)) {
      const timestamp = a.closed_at || a.archived_at;
      const ago = format_relative_time(timestamp);
      const role = a.archetype ?? "unknown";
      lines.push(`- **${a.name}** -- ${role} -- closed ${ago}`);
    }
    if (sorted.length > MAX_ENTRIES) {
      lines.push(`\n… and ${sorted.length - MAX_ENTRIES} more`);
    }
    lines.push("", "-# Use `/resume <name>` to restore.");

    await target.reply(lines.join("\n"));
  }

  /** Handle /reset — release current bot, next message triggers fresh assignment. */
  private async handle_reset_command(_routed: RoutedMessage, target: CommandTarget): Promise<void> {
    if (!this._pool) {
      await target.reply("Bot pool not available.");
      return;
    }

    const entry = this.channel_map.get(target.channel_id);
    if (!entry) {
      await target.reply("This channel isn't mapped to an entity.");
      return;
    }

    this._pool.clear_session_history(entry.entity_id, target.channel_id);
    await this._pool.release(target.channel_id);
    await target.reply("Session reset. Send a message to start fresh.");
  }
}

// ── Channel name sanitization ──

/** Sanitize a string for use as a Discord channel name.
 * Lowercase, hyphens only, no spaces, max 100 chars. */
export function sanitize_channel_name(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-") // Replace non-alphanumeric with hyphens
    .replace(/-+/g, "-") // Collapse multiple hyphens
    .replace(/^-|-$/g, "") // Trim leading/trailing hyphens
    .slice(0, 100); // Discord channel name limit
}

// ── Room archive types and I/O ──

export interface RoomArchive {
  name: string;
  channel_id: string;
  session_id: string | null;
  entity_id: string;
  archetype: string;
  /** When the room was archived (same as closed_at for backward compat with older archives). */
  archived_at: string;
  closed_at: string;
}

/** Write a room archive entry atomically. */
export async function write_room_archive(
  entity_id: string,
  archive: RoomArchive,
  paths?: Record<string, string>,
): Promise<void> {
  const archives_dir = join(entity_dir(paths, entity_id), "archives");
  await mkdir(archives_dir, { recursive: true });

  const timestamp = archive.closed_at.replace(/[:.]/g, "-");
  const filename = `${archive.name}-${timestamp}.json`;
  const filepath = join(archives_dir, filename);
  const tmp_path = `${filepath}.tmp`;

  await writeFile(tmp_path, JSON.stringify(archive, null, 2), "utf-8");
  await rename(tmp_path, filepath);

  console.log(`[discord] Archived room ${archive.name} to ${filepath}`);
}

/** Delete a specific archive file. Returns true if deleted, false on error. */
export async function delete_room_archive(
  entity_id: string,
  archive: RoomArchive,
  paths?: Record<string, string>,
): Promise<boolean> {
  const archives_dir = join(entity_dir(paths, entity_id), "archives");
  const timestamp = archive.closed_at.replace(/[:.]/g, "-");
  const filename = `${archive.name}-${timestamp}.json`;
  const filepath = join(archives_dir, filename);
  try {
    await unlink(filepath);
    console.log(`[discord] Deleted consumed archive: ${filepath}`);
    return true;
  } catch (err) {
    console.warn(`[discord] Failed to delete archive ${filepath}: ${err}`);
    return false;
  }
}

/** Load all room archives for an entity, sorted by closed_at ascending. */
export async function load_room_archives(
  entity_id: string,
  paths?: Record<string, string>,
): Promise<RoomArchive[]> {
  const archives_dir = join(entity_dir(paths, entity_id), "archives");
  let entries: string[];
  try {
    entries = await readdir(archives_dir);
  } catch {
    return []; // No archives directory
  }

  const archives: RoomArchive[] = [];
  for (const filename of entries) {
    if (!filename.endsWith(".json")) continue;
    try {
      const raw = await readFile(join(archives_dir, filename), "utf-8");
      const data = JSON.parse(raw) as RoomArchive;
      archives.push(data);
    } catch {
      console.log(`[discord] Skipping invalid archive file: ${filename}`);
    }
  }

  // Sort by closed_at ascending (oldest first)
  archives.sort((a, b) => a.closed_at.localeCompare(b.closed_at));
  return archives;
}

// ── Token resolution ──

/** Resolve the Discord bot token. Resolution order:
 * 1. DISCORD_BOT_TOKEN env var (preferred — set via env.sh or op run)
 * 2. ~/.lobsterfarm/.env file (written by setup wizard)
 *
 * If a 1Password reference is configured but the token isn't in the
 * environment, logs guidance on using `op run` to inject it safely.
 */
export async function resolve_bot_token(config: LobsterFarmConfig): Promise<string | null> {
  // 1. Environment variable
  const env_token = process.env.DISCORD_BOT_TOKEN;
  if (env_token) {
    console.log("[discord] Using bot token from DISCORD_BOT_TOKEN env var");
    return env_token;
  }

  // 2. .env file in lobsterfarm dir
  try {
    const { lobsterfarm_dir } = await import("@lobster-farm/shared");
    const { readFile } = await import("node:fs/promises");
    const env_path = `${lobsterfarm_dir(config.paths)}/.env`;
    const env_content = await readFile(env_path, "utf-8");
    const match = env_content.match(/^DISCORD_BOT_TOKEN=(.+)$/m);
    if (match?.[1]) {
      console.log("[discord] Using bot token from .env file");
      return match[1].trim();
    }
  } catch {
    // .env file doesn't exist — continue
  }

  // 3. 1Password: `op read` is not used here because it exposes the token
  // to stdout (which gets logged in session JSONL files). Instead, the token
  // must be injected via env.sh (sourced before daemon startup) using:
  //   op run --env-file ~/.lobsterfarm/.env.op -- <daemon start command>
  // This keeps the secret in the process environment without stdout exposure.
  const op_ref = config.discord?.bot_token_ref;
  if (op_ref) {
    console.log(
      `[discord] 1Password reference configured (${op_ref}) but DISCORD_BOT_TOKEN is not set. Ensure env.sh or the daemon launcher uses 'op run --env-file .env.op' to inject the token.`,
    );
  }

  return null;
}
