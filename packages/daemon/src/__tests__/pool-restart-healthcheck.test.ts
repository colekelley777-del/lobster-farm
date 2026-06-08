import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LobsterFarmConfigSchema } from "@lobster-farm/shared";
import type { EntityConfig, LobsterFarmConfig } from "@lobster-farm/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolBot } from "../pool.js";
import type { EntityRegistry } from "../registry.js";
import { BotPoolTestBase } from "./helpers/test-bot-pool-base.js";

// notify() makes a Discord webhook call — mock it so reconcile_assigned_health()
// can be asserted on without touching the network. Keep the rest of actions.js
// intact so pool.ts's other (transitive) imports still resolve. vi.hoisted lets
// the hoisted vi.mock() factory reference the spy.
const { notify_mock } = vi.hoisted(() => ({ notify_mock: vi.fn(async () => {}) }));
vi.mock("../actions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../actions.js")>();
  return { ...actual, notify: notify_mock };
});

let temp_dir: string;

function make_config(): LobsterFarmConfig {
  return LobsterFarmConfigSchema.parse({
    user: { name: "Test" },
    paths: { lobsterfarm_dir: temp_dir },
  });
}

function make_entity_config(entity_id: string, channel_ids: string[]): EntityConfig {
  return {
    entity: {
      id: entity_id,
      name: `Test ${entity_id}`,
      description: "",
      status: "active",
      repos: [],
      accounts: {},
      channels: {
        category_id: "",
        list: channel_ids.map((id) => ({ type: "general" as const, id })),
      },
      memory: { path: "/tmp/memory", auto_extract: true },
      secrets: { vault: "1password", vault_name: `entity-${entity_id}` },
    },
  };
}

function make_registry(entities: EntityConfig[]): EntityRegistry {
  const map = new Map<string, EntityConfig>();
  for (const e of entities) map.set(e.entity.id, e);
  return {
    get: (id: string) => map.get(id),
    get_all: () => [...map.values()],
    get_active: () => [...map.values()].filter((e) => e.entity.status === "active"),
    count: () => map.size,
  } as unknown as EntityRegistry;
}

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
    state_dir: `/tmp/test-pool-${String(overrides.id)}`,
    model: null,
    effort: null,
    last_avatar_archetype: null,
    last_avatar_set_at: null,
    ...overrides,
  };
}

/** Test pool that lets us drive tmux liveness per-session and inject bots. */
class TestBotPool extends BotPoolTestBase {
  /** Map of tmux session name → alive. Defaults to dead (post-crash). */
  private alive = new Map<string, boolean>();

  inject_bots(bots: PoolBot[]): void {
    (this as unknown as { bots: PoolBot[] }).bots = bots;
  }

  get_bots(): PoolBot[] {
    return (this as unknown as { bots: PoolBot[] }).bots;
  }

  set_tmux_alive(session: string, alive: boolean): void {
    this.alive.set(session, alive);
  }

  protected override is_tmux_alive(session_name: string): boolean {
    return this.alive.get(session_name) ?? false;
  }
}

describe("reconcile_assigned_health (issue #66)", () => {
  let pool: TestBotPool;

  beforeEach(async () => {
    temp_dir = await mkdtemp(join(tmpdir(), "pool-restart-hc-"));
    notify_mock.mockClear();

    pool = new TestBotPool(make_config());
    (pool as unknown as { registry: EntityRegistry }).registry = make_registry([
      make_entity_config("healthydogs", ["chan-foods"]),
    ]);

    // Stub spawn-path side effects so no real tmux/Discord work happens.
    for (const method of [
      "kill_tmux",
      "write_access_json",
      "set_bot_nickname",
      "set_bot_avatar",
      "persist",
      "resolve_github_token_ref",
    ] as const) {
      vi.spyOn(pool as unknown as Record<string, unknown>, method as never).mockImplementation(
        (() => undefined) as never,
      );
    }
    // restart_crashed_session pre-flights the JSONL — treat sessions as present.
    vi.spyOn(
      pool as unknown as Record<string, unknown>,
      "check_session_jsonl_exists_anywhere" as never,
    ).mockResolvedValue(true as never);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(temp_dir, { recursive: true, force: true });
  });

  it("(a) leaves an assigned bot with a live tmux session untouched", async () => {
    const start_tmux = vi
      .spyOn(pool as unknown as Record<string, unknown>, "start_tmux" as never)
      .mockResolvedValue(undefined as never);

    pool.inject_bots([
      make_bot({
        id: 3,
        state: "assigned",
        channel_id: "chan-foods",
        entity_id: "healthydogs",
        archetype: "planner",
        session_id: "sess-live",
      }),
    ]);
    pool.set_tmux_alive("pool-3", true);

    await pool.reconcile_assigned_health();

    // Healthy bot — no respawn, no alert, state unchanged.
    expect(start_tmux).not.toHaveBeenCalled();
    expect(notify_mock).not.toHaveBeenCalled();
    expect(pool.get_bots()[0]!.state).toBe("assigned");
  });

  it("(b) respawns an assigned bot whose tmux session is dead", async () => {
    const start_tmux = vi
      .spyOn(pool as unknown as Record<string, unknown>, "start_tmux" as never)
      .mockResolvedValue(undefined as never);

    pool.inject_bots([
      make_bot({
        id: 3,
        state: "assigned",
        channel_id: "chan-foods",
        entity_id: "healthydogs",
        archetype: "planner",
        session_id: "sess-abc",
      }),
    ]);
    pool.set_tmux_alive("pool-3", false); // half-spawned: assigned but dead

    await pool.reconcile_assigned_health();

    // Respawned via the existing restart path (resumes the confirmed session).
    expect(start_tmux).toHaveBeenCalledTimes(1);
    const bot = pool.get_bots()[0]!;
    expect(bot.state).toBe("assigned");
    expect(bot.channel_id).toBe("chan-foods");
    // The reused restart path posts its own "auto-restarted" success alert, but
    // the "could not be revived" failure alert must NOT fire.
    const revive_failed = notify_mock.mock.calls.some(
      (call) => typeof call[1] === "string" && call[1].includes("could not be revived"),
    );
    expect(revive_failed).toBe(false);
  });

  it("(c) emits an alert when the bot cannot be revived", async () => {
    // Make the respawn fail — restart_crashed_session frees the bot, then
    // reconcile_assigned_health alerts that the channel went dark.
    vi.spyOn(pool as unknown as Record<string, unknown>, "start_tmux" as never).mockRejectedValue(
      new Error("tmux spawn failed") as never,
    );

    pool.inject_bots([
      make_bot({
        id: 3,
        state: "assigned",
        channel_id: "chan-foods",
        entity_id: "healthydogs",
        archetype: "planner",
        session_id: "sess-abc",
      }),
    ]);
    pool.set_tmux_alive("pool-3", false);

    await pool.reconcile_assigned_health();

    // Bot freed by the restart-failure path...
    expect(pool.get_bots()[0]!.state).toBe("free");
    // ...and surfaced via #alerts so the channel doesn't go silently dark.
    expect(notify_mock).toHaveBeenCalledTimes(1);
    const [channel, message] = notify_mock.mock.calls[0]!;
    expect(channel).toBe("alerts");
    expect(message).toContain("Pool bot 3");
    expect(message).toContain("could not be revived");
  });

  it("ignores parked and free bots — only repairs assigned-but-dead", async () => {
    const start_tmux = vi
      .spyOn(pool as unknown as Record<string, unknown>, "start_tmux" as never)
      .mockResolvedValue(undefined as never);

    pool.inject_bots([
      make_bot({ id: 1, state: "free" }),
      make_bot({
        id: 2,
        state: "parked",
        channel_id: "chan-foods",
        entity_id: "healthydogs",
        archetype: "planner",
        session_id: "sess-parked",
      }),
    ]);
    pool.set_tmux_alive("pool-1", false);
    pool.set_tmux_alive("pool-2", false);

    await pool.reconcile_assigned_health();

    // Parked bots resume on next message; free bots have nothing to repair.
    expect(start_tmux).not.toHaveBeenCalled();
    expect(notify_mock).not.toHaveBeenCalled();
    expect(pool.get_bots().find((b) => b.id === 2)!.state).toBe("parked");
  });
});
