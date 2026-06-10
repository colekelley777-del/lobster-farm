/**
 * Tests for BotPool.ensure_entity_channels_allowlisted — the drift-correction
 * pass that runs at assign-time to prune foreign entity channels from a pool
 * bot's access.json.
 *
 * Correct semantics (post-regression fix):
 *   1. The bot's ASSIGNED channel → allowlist with requireMention: false.
 *      Written by write_access_json; ensure_entity_channels_allowlisted is a
 *      no-op for it (it is already present).
 *   2. The entity's ALERTS channel → allowlist with requireMention: true.
 *      Written by write_access_json; ensure_entity_channels_allowlisted is a
 *      no-op for it (it is already present).
 *   3. ALL OTHER entity channels → must NOT be present. If any are present
 *      (due to prior over-granting), they are REMOVED at assign-time.
 *
 * Regression context: the original backfill added ALL entity channels with
 * requireMention: false, which caused every pool bot in an entity to respond
 * to every message in every entity channel (e.g. pool-2/Tristan responding in
 * #combatcall-general because the backfill had added it with
 * requireMention: false). See nightly incident ~00:09 UTC, 2026-06-09.
 *
 * See also: pool-access-control.test.ts for write_access_json tests.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EntityConfig, LobsterFarmConfig } from "@lobster-farm/shared";
import { LobsterFarmConfigSchema } from "@lobster-farm/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BotPool } from "../pool.js";
import type { EntityRegistry } from "../registry.js";

// ── Test helpers ──────────────────────────────────────────────────────────────

function make_config(user_id?: string): LobsterFarmConfig {
  return LobsterFarmConfigSchema.parse({
    user: { name: "Test" },
    discord: user_id ? { server_id: "111222333", user_id } : { server_id: "111222333" },
  });
}

function make_entity(id: string, channels: Array<{ type: string; id: string }>): EntityConfig {
  return {
    entity: {
      id,
      name: id,
      description: "",
      status: "active",
      blueprint: "software",
      pr_lifecycle: "v1",
      repos: [],
      accounts: { github: { user: "test" } },
      channels: {
        category_id: "cat-1",
        list: channels.map((c) => ({ type: c.type, id: c.id, purpose: "" })),
      },
      memory: { path: "/tmp", auto_extract: false },
      secrets: { vault: "1password", vault_name: `entity-${id}` },
    },
  } as unknown as EntityConfig;
}

function make_registry(entities: Record<string, EntityConfig>): EntityRegistry {
  return {
    get: (id: string) => entities[id],
    get_all: () => Object.values(entities),
    get_active: () => Object.values(entities),
    count: () => Object.keys(entities).length,
    load_all: async () => {},
  } as unknown as EntityRegistry;
}

/**
 * Exposes the private ensure_entity_channels_allowlisted for direct testing
 * and lets tests inject a registry without touching the real filesystem.
 */
class TestBotPool extends BotPool {
  set_registry(registry: EntityRegistry | null): void {
    (this as unknown as { registry: EntityRegistry | null }).registry = registry;
  }
}

// ── Helpers for seeding a minimal access.json ────────────────────────────────

/** Write a minimal access.json with the given groups already present. */
async function seed_access(
  dir: string,
  groups: Record<string, { requireMention: boolean; allowFrom: string[] }>,
): Promise<void> {
  const access = {
    dmPolicy: "allowlist",
    allowFrom: ["owner-1"],
    groups,
    pending: {},
    ackReaction: "👀",
    replyToMode: "first",
    textChunkLimit: 2000,
    chunkMode: "newline",
  };
  await writeFile(join(dir, "access.json"), JSON.stringify(access, null, 2), "utf-8");
}

// ── Unit tests: ensure_entity_channels_allowlisted ───────────────────────────

describe("BotPool.ensure_entity_channels_allowlisted", () => {
  let tmp_dir: string;

  beforeEach(async () => {
    tmp_dir = join(tmpdir(), `pool-entity-allowlist-test-${randomUUID()}`);
    await mkdir(tmp_dir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmp_dir, { recursive: true }).catch(() => {});
  });

  // ── Regression test (primary): no foreign channels added ──────────────────

  it("REGRESSION: does NOT add non-assigned entity channels with requireMention: false", async () => {
    // This is the exact scenario that caused the incident: pool-2 (Tristan) is
    // assigned to #combatcall-marketing. The backfill must NOT add #general or
    // #tos to pool-2's access.json, because that would make Tristan respond to
    // every message in those channels.
    const pool = new TestBotPool(make_config("owner-1"));
    pool.set_registry(
      make_registry({
        combatcall: make_entity("combatcall", [
          { type: "general", id: "general-chan" },
          { type: "alerts", id: "alerts-chan" },
          { type: "marketing", id: "marketing-chan" },
          { type: "tos", id: "tos-chan" },
        ]),
      }),
    );

    // pool-2 was just assigned to marketing. write_access_json wrote:
    //   marketing-chan (requireMention: false) + alerts-chan (requireMention: true).
    await seed_access(tmp_dir, {
      "marketing-chan": { requireMention: false, allowFrom: [] },
      "alerts-chan": { requireMention: true, allowFrom: [] },
    });

    // Simulate assign-time call with the assigned channel passed in.
    await pool.ensure_entity_channels_allowlisted(tmp_dir, "combatcall", "marketing-chan");

    const content = JSON.parse(await readFile(join(tmp_dir, "access.json"), "utf-8"));

    // The two permitted channels must be present and untouched.
    expect(content.groups["marketing-chan"]).toEqual({ requireMention: false, allowFrom: [] });
    expect(content.groups["alerts-chan"]).toEqual({ requireMention: true, allowFrom: [] });

    // Foreign entity channels must NOT be present.
    expect(content.groups["general-chan"]).toBeUndefined();
    expect(content.groups["tos-chan"]).toBeUndefined();
  });

  // ── Drift self-healing ─────────────────────────────────────────────────────

  it("removes foreign entity channels that were over-granted by a prior buggy backfill", async () => {
    // Simulate the live state of pool-2 before the hotfix: the old backfill had
    // added general-chan and tos-chan at requireMention: false.
    const pool = new TestBotPool(make_config("owner-1"));
    pool.set_registry(
      make_registry({
        combatcall: make_entity("combatcall", [
          { type: "general", id: "general-chan" },
          { type: "alerts", id: "alerts-chan" },
          { type: "marketing", id: "marketing-chan" },
          { type: "tos", id: "tos-chan" },
        ]),
      }),
    );

    // Stale state — over-granted by the old backfill.
    await seed_access(tmp_dir, {
      "marketing-chan": { requireMention: false, allowFrom: [] },
      "alerts-chan": { requireMention: true, allowFrom: [] },
      "general-chan": { requireMention: false, allowFrom: [] }, // ← over-granted
      "tos-chan": { requireMention: false, allowFrom: [] }, // ← over-granted
    });

    await pool.ensure_entity_channels_allowlisted(tmp_dir, "combatcall", "marketing-chan");

    const content = JSON.parse(await readFile(join(tmp_dir, "access.json"), "utf-8"));

    // Permitted channels untouched.
    expect(content.groups["marketing-chan"]).toEqual({ requireMention: false, allowFrom: [] });
    expect(content.groups["alerts-chan"]).toEqual({ requireMention: true, allowFrom: [] });

    // Foreign channels pruned.
    expect(content.groups["general-chan"]).toBeUndefined();
    expect(content.groups["tos-chan"]).toBeUndefined();
  });

  it("does not touch channels from other entities when pruning", async () => {
    // If a bot somehow has an entry from a different entity (cross-entity channel),
    // ensure_entity_channels_allowlisted must not remove it — it only operates on
    // channels that appear in THIS entity's config.
    const pool = new TestBotPool(make_config("owner-1"));
    pool.set_registry(
      make_registry({
        combatcall: make_entity("combatcall", [
          { type: "general", id: "general-chan" },
          { type: "alerts", id: "alerts-chan" },
          { type: "marketing", id: "marketing-chan" },
        ]),
      }),
    );

    await seed_access(tmp_dir, {
      "marketing-chan": { requireMention: false, allowFrom: [] },
      "alerts-chan": { requireMention: true, allowFrom: [] },
      "other-entity-chan": { requireMention: true, allowFrom: [] }, // different entity
    });

    await pool.ensure_entity_channels_allowlisted(tmp_dir, "combatcall", "marketing-chan");

    const content = JSON.parse(await readFile(join(tmp_dir, "access.json"), "utf-8"));

    // Cross-entity channel must be preserved — it's not in combatcall's config.
    expect(content.groups["other-entity-chan"]).toEqual({ requireMention: true, allowFrom: [] });
    // Foreign combatcall channel pruned.
    expect(content.groups["general-chan"]).toBeUndefined();
  });

  // ── No-op path ─────────────────────────────────────────────────────────────

  it("is a no-op when access.json already has only the permitted channels", async () => {
    const pool = new TestBotPool(make_config("owner-1"));
    pool.set_registry(
      make_registry({
        combatcall: make_entity("combatcall", [
          { type: "general", id: "general-chan" },
          { type: "alerts", id: "alerts-chan" },
        ]),
      }),
    );

    // Already clean — only the assigned channel and alerts present.
    await seed_access(tmp_dir, {
      "general-chan": { requireMention: false, allowFrom: [] },
      "alerts-chan": { requireMention: true, allowFrom: [] },
    });
    const before = await readFile(join(tmp_dir, "access.json"), "utf-8");

    await pool.ensure_entity_channels_allowlisted(tmp_dir, "combatcall", "general-chan");

    // File must be byte-identical — no write happened.
    expect(await readFile(join(tmp_dir, "access.json"), "utf-8")).toBe(before);
  });

  it("is idempotent — calling twice does not change the file a second time", async () => {
    const pool = new TestBotPool(make_config("owner-1"));
    pool.set_registry(
      make_registry({
        combatcall: make_entity("combatcall", [
          { type: "general", id: "general-chan" },
          { type: "tos", id: "tos-chan" },
        ]),
      }),
    );

    // Seed with a foreign channel that needs pruning.
    await seed_access(tmp_dir, {
      "general-chan": { requireMention: false, allowFrom: [] },
      "tos-chan": { requireMention: false, allowFrom: [] }, // foreign
    });

    await pool.ensure_entity_channels_allowlisted(tmp_dir, "combatcall", "general-chan");
    const after_first = await readFile(join(tmp_dir, "access.json"), "utf-8");

    // Second call — no foreign channels remain, must be a no-op.
    await pool.ensure_entity_channels_allowlisted(tmp_dir, "combatcall", "general-chan");
    const after_second = await readFile(join(tmp_dir, "access.json"), "utf-8");

    expect(after_second).toBe(after_first);
    const parsed = JSON.parse(after_second);
    expect(Object.keys(parsed.groups).sort()).toEqual(["general-chan"]);
  });

  it("does not alter dmPolicy or top-level allowFrom", async () => {
    const pool = new TestBotPool(make_config("owner-1"));
    pool.set_registry(
      make_registry({
        combatcall: make_entity("combatcall", [
          { type: "general", id: "general-chan" },
          { type: "tos", id: "tos-chan" },
        ]),
      }),
    );

    await seed_access(tmp_dir, {
      "general-chan": { requireMention: false, allowFrom: [] },
      "tos-chan": { requireMention: false, allowFrom: [] },
    });

    await pool.ensure_entity_channels_allowlisted(tmp_dir, "combatcall", "general-chan");

    const content = JSON.parse(await readFile(join(tmp_dir, "access.json"), "utf-8"));
    expect(content.dmPolicy).toBe("allowlist");
    expect(content.allowFrom).toEqual(["owner-1"]);
  });

  it("preserves optional fields (ackReaction, replyToMode, etc.)", async () => {
    const pool = new TestBotPool(make_config("owner-1"));
    pool.set_registry(
      make_registry({
        combatcall: make_entity("combatcall", [
          { type: "general", id: "general-chan" },
          { type: "tos", id: "tos-chan" },
        ]),
      }),
    );

    await seed_access(tmp_dir, {
      "general-chan": { requireMention: false, allowFrom: [] },
      "tos-chan": { requireMention: false, allowFrom: [] },
    });

    await pool.ensure_entity_channels_allowlisted(tmp_dir, "combatcall", "general-chan");

    const content = JSON.parse(await readFile(join(tmp_dir, "access.json"), "utf-8"));
    expect(content.ackReaction).toBe("👀");
    expect(content.replyToMode).toBe("first");
    expect(content.textChunkLimit).toBe(2000);
    expect(content.chunkMode).toBe("newline");
  });

  it("does not touch an existing alerts entry even if its shape would differ from defaults", async () => {
    // Alerts channel has requireMention: true (outbound-only policy from
    // write_access_json). Must survive the pruning pass unchanged.
    const pool = new TestBotPool(make_config("owner-1"));
    pool.set_registry(
      make_registry({
        combatcall: make_entity("combatcall", [
          { type: "general", id: "general-chan" },
          { type: "alerts", id: "alerts-chan" },
          { type: "tos", id: "tos-chan" },
        ]),
      }),
    );

    await seed_access(tmp_dir, {
      "general-chan": { requireMention: false, allowFrom: [] },
      "alerts-chan": { requireMention: true, allowFrom: [] },
      "tos-chan": { requireMention: false, allowFrom: [] }, // foreign — to be pruned
    });

    await pool.ensure_entity_channels_allowlisted(tmp_dir, "combatcall", "general-chan");

    const content = JSON.parse(await readFile(join(tmp_dir, "access.json"), "utf-8"));
    // Permitted entries preserved as-is.
    expect(content.groups["general-chan"]).toEqual({ requireMention: false, allowFrom: [] });
    expect(content.groups["alerts-chan"]).toEqual({ requireMention: true, allowFrom: [] });
    // Foreign channel pruned.
    expect(content.groups["tos-chan"]).toBeUndefined();
  });

  it("no-ops when the registry has no entry for the entity", async () => {
    const pool = new TestBotPool(make_config("owner-1"));
    pool.set_registry(make_registry({})); // empty registry

    await seed_access(tmp_dir, {
      "general-chan": { requireMention: false, allowFrom: [] },
    });
    const before = await readFile(join(tmp_dir, "access.json"), "utf-8");

    await pool.ensure_entity_channels_allowlisted(tmp_dir, "combatcall", "general-chan");

    expect(await readFile(join(tmp_dir, "access.json"), "utf-8")).toBe(before);
  });

  it("no-ops when registry is null", async () => {
    const pool = new TestBotPool(make_config("owner-1"));
    pool.set_registry(null);

    await seed_access(tmp_dir, {
      "general-chan": { requireMention: false, allowFrom: [] },
    });
    const before = await readFile(join(tmp_dir, "access.json"), "utf-8");

    await pool.ensure_entity_channels_allowlisted(tmp_dir, "combatcall", "general-chan");

    expect(await readFile(join(tmp_dir, "access.json"), "utf-8")).toBe(before);
  });

  it("no-ops when access.json does not exist (ENOENT is swallowed)", async () => {
    const pool = new TestBotPool(make_config("owner-1"));
    pool.set_registry(
      make_registry({
        combatcall: make_entity("combatcall", [{ type: "tos", id: "tos-chan" }]),
      }),
    );

    // No seed — file doesn't exist.
    await expect(
      pool.ensure_entity_channels_allowlisted(tmp_dir, "combatcall", "tos-chan"),
    ).resolves.toBeUndefined();
  });

  it("no-ops when entity has no channels in config", async () => {
    const pool = new TestBotPool(make_config("owner-1"));
    pool.set_registry(make_registry({ combatcall: make_entity("combatcall", []) }));

    await seed_access(tmp_dir, {
      "general-chan": { requireMention: false, allowFrom: [] },
    });
    const before = await readFile(join(tmp_dir, "access.json"), "utf-8");

    await pool.ensure_entity_channels_allowlisted(tmp_dir, "combatcall", "general-chan");

    expect(await readFile(join(tmp_dir, "access.json"), "utf-8")).toBe(before);
  });
});

// ── Integration-shaped test: assign-time pruning ─────────────────────────────
//
// Validates the exact live incident scenario from 2026-06-09: pool-2 (Tristan)
// was assigned to #combatcall-marketing but had #general and #tos in its
// access.json with requireMention: false due to the old over-granting backfill.
// After ensure_entity_channels_allowlisted runs at assign-time, only marketing
// and alerts should remain.

describe("pool-bot assign-time pruning (integration shape — combatcall incident)", () => {
  let tmp_dir: string;

  beforeEach(async () => {
    tmp_dir = join(tmpdir(), `pool-assign-prune-test-${randomUUID()}`);
    await mkdir(tmp_dir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmp_dir, { recursive: true }).catch(() => {});
  });

  it("prunes general + tos from pool-2/Tristan that were over-granted by the old backfill", async () => {
    // The exact state before Lancelot's hotfix on pool-2:
    //   pool-2 assigned to #combatcall-marketing (1511914313890402378)
    //   alerts-chan: 1511914315630776440  (requireMention: true — correct)
    //   general-chan: 1511914313890402344  (requireMention: false — WRONG, backfill bug)
    //   tos-chan: 1512238580443906201      (requireMention: false — WRONG, backfill bug)

    const pool = new TestBotPool(make_config("813566317948698675"));
    pool.set_registry(
      make_registry({
        combatcall: make_entity("combatcall", [
          { type: "general", id: "1511914313890402344" },
          { type: "alerts", id: "1511914315630776440" },
          { type: "marketing", id: "1511914313890402378" },
          { type: "tos", id: "1512238580443906201" },
        ]),
      }),
    );

    // Stale over-granted state (what pool-2 had before the hotfix).
    await seed_access(tmp_dir, {
      "1511914313890402378": { requireMention: false, allowFrom: [] }, // marketing (assigned) — correct
      "1511914315630776440": { requireMention: true, allowFrom: [] }, // alerts — correct
      "1511914313890402344": { requireMention: false, allowFrom: [] }, // general — WRONG
      "1512238580443906201": { requireMention: false, allowFrom: [] }, // tos — WRONG
    });

    // Simulate assign-time call: pool-2 is being assigned to #marketing.
    await pool.ensure_entity_channels_allowlisted(tmp_dir, "combatcall", "1511914313890402378");

    const content = JSON.parse(await readFile(join(tmp_dir, "access.json"), "utf-8"));

    // Permitted channels preserved.
    expect(content.groups["1511914313890402378"]).toEqual({ requireMention: false, allowFrom: [] });
    expect(content.groups["1511914315630776440"]).toEqual({ requireMention: true, allowFrom: [] });

    // Foreign channels removed — Tristan no longer hears #general or #tos.
    expect(content.groups["1511914313890402344"]).toBeUndefined();
    expect(content.groups["1512238580443906201"]).toBeUndefined();

    // Exactly two groups remain.
    expect(Object.keys(content.groups)).toHaveLength(2);
  });
});
