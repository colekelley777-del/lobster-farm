import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { EntityConfig, LobsterFarmConfig } from "@lobster-farm/shared";
import { EntityConfigSchema, LobsterFarmConfigSchema } from "@lobster-farm/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { build_model_flags } from "../models.js";
import { ClaudeSessionManager } from "../session.js";

function make_config(overrides?: Partial<LobsterFarmConfig>): LobsterFarmConfig {
  return LobsterFarmConfigSchema.parse({
    user: { name: "Test" },
    ...overrides,
  });
}

/** Poll until predicate is true (avoids race conditions on slow CI). */
async function wait_for(
  predicate: () => boolean,
  timeout_ms = 5000,
  interval_ms = 25,
): Promise<void> {
  const deadline = Date.now() + timeout_ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("wait_for timed out");
    await new Promise((r) => setTimeout(r, interval_ms));
  }
}

describe("build_model_flags", () => {
  it("maps opus/high to correct flags", () => {
    const flags = build_model_flags({ model: "opus", think: "high" });
    expect(flags).toContain("--model");
    expect(flags).toContain("claude-opus-4-8");
    expect(flags).toContain("--effort");
    expect(flags).toContain("high");
  });

  it("maps sonnet/standard to correct flags", () => {
    const flags = build_model_flags({ model: "sonnet", think: "standard" });
    expect(flags).toContain("claude-sonnet-4-6");
    expect(flags).toContain("medium");
  });

  it("maps haiku/none to model only", () => {
    const flags = build_model_flags({ model: "haiku", think: "none" });
    expect(flags).toContain("claude-haiku-4-5-20251001");
    expect(flags).toContain("--effort");
    expect(flags).toContain("low");
  });

  it("maps opus/xhigh to correct flags", () => {
    const flags = build_model_flags({ model: "opus", think: "xhigh" });
    expect(flags).toContain("--model");
    expect(flags).toContain("claude-opus-4-8");
    expect(flags).toContain("--effort");
    expect(flags).toContain("xhigh");
  });

  it("maps opus/max to correct flags", () => {
    const flags = build_model_flags({ model: "opus", think: "max" });
    expect(flags).toContain("--model");
    expect(flags).toContain("claude-opus-4-8");
    expect(flags).toContain("--effort");
    expect(flags).toContain("max");
  });
});

describe("ClaudeSessionManager", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = join(tmpdir(), `lf-session-test-${Date.now()}`);
    await mkdir(tmp, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  describe("build_command", () => {
    it("builds correct CLI arguments for autonomous mode", async () => {
      const config = make_config();
      const mgr = new ClaudeSessionManager(config);

      const { args } = await mgr.build_command({
        entity_id: "alpha",
        feature_id: "alpha-42",
        archetype: "builder",
        dna: ["coding-dna"],
        model: { model: "opus", think: "high" },
        worktree_path: "/repos/alpha",
        prompt: "Build feature #42",
        interactive: false,
      });

      expect(args).toContain("-p");
      expect(args).toContain("--output-format");
      expect(args).toContain("stream-json");
      expect(args).toContain("--agent");
      expect(args).toContain("bob"); // default builder name
      expect(args).toContain("--model");
      expect(args).toContain("claude-opus-4-8");
      expect(args).toContain("--permission-mode");
      expect(args).toContain("bypassPermissions");
      expect(args).toContain("--session-id");
      expect(args).toContain("--append-system-prompt");
      expect(args).toContain("--add-dir");
      // Prompt is piped via stdin, not in args
      expect(args).not.toContain("Build feature #42");
    });

    it("uses custom agent names from config", async () => {
      const config = make_config({
        agents: {
          planner: { name: "Planny" },
          designer: { name: "Desi" },
          builder: { name: "Buildo" },
          operator: { name: "Opsy" },
        },
      });
      const mgr = new ClaudeSessionManager(config);

      const { args: planner_args } = await mgr.build_command({
        entity_id: "alpha",
        feature_id: "alpha-1",
        archetype: "planner",
        dna: ["planning-dna"],
        model: { model: "opus", think: "high" },
        worktree_path: "/repos/alpha",
        prompt: "Plan feature #1",
        interactive: false,
      });

      const agent_idx = planner_args.indexOf("--agent");
      expect(planner_args[agent_idx + 1]).toBe("planny");

      const { args: builder_args } = await mgr.build_command({
        entity_id: "alpha",
        feature_id: "alpha-2",
        archetype: "builder",
        dna: ["coding-dna"],
        model: { model: "opus", think: "high" },
        worktree_path: "/repos/alpha",
        prompt: "Build feature #2",
        interactive: false,
      });

      const builder_agent_idx = builder_args.indexOf("--agent");
      expect(builder_args[builder_agent_idx + 1]).toBe("buildo");
    });

    it("always uses 'reviewer' name for reviewer archetype", async () => {
      const config = make_config();
      const mgr = new ClaudeSessionManager(config);

      const { args } = await mgr.build_command({
        entity_id: "alpha",
        feature_id: "alpha-1",
        archetype: "reviewer",
        dna: ["review-dna"],
        model: { model: "sonnet", think: "standard" },
        worktree_path: "/repos/alpha",
        prompt: "Review PR #1",
        interactive: false,
      });

      const agent_idx = args.indexOf("--agent");
      expect(args[agent_idx + 1]).toBe("reviewer");
    });
  });

  describe("spawn with mock binary", () => {
    it("spawns a process and tracks it", async () => {
      // Create a mock "claude" script that just echoes and exits
      const mock_claude = join(tmp, "mock-claude");
      await writeFile(
        mock_claude,
        '#!/bin/bash\necho \'{"type":"result","content":"done"}\'\nexit 0\n',
        "utf-8",
      );
      await chmod(mock_claude, 0o755);

      const config = make_config();
      const mgr = new ClaudeSessionManager(config);

      // Override the claude binary via env
      process.env.CLAUDE_BIN = mock_claude;

      const completed = new Promise<void>((resolve) => {
        mgr.on("session:completed", () => resolve());
      });

      const session = await mgr.spawn({
        entity_id: "alpha",
        feature_id: "alpha-42",
        archetype: "builder",
        dna: ["coding-dna"],
        model: { model: "opus", think: "high" },
        worktree_path: tmp,
        prompt: "test prompt",
        interactive: false,
      });

      expect(session.session_id).toBeTruthy();
      expect(session.entity_id).toBe("alpha");
      expect(session.pid).toBeGreaterThan(0);

      // Wait for completion
      await completed;

      // After completion, session should be cleaned up
      expect(mgr.get_active()).toHaveLength(0);

      delete process.env.CLAUDE_BIN;
    });

    it("rejects interactive mode", async () => {
      const config = make_config();
      const mgr = new ClaudeSessionManager(config);

      await expect(
        mgr.spawn({
          entity_id: "alpha",
          feature_id: "alpha-42",
          archetype: "builder",
          dna: [],
          model: { model: "opus", think: "high" },
          worktree_path: tmp,
          prompt: "test",
          interactive: true,
        }),
      ).rejects.toThrow("Interactive sessions are not yet implemented");
    });

    it("emits session:failed on non-zero exit", async () => {
      const mock_claude = join(tmp, "mock-claude-fail");
      await writeFile(mock_claude, "#!/bin/bash\nexit 1\n", "utf-8");
      await chmod(mock_claude, 0o755);

      const config = make_config();
      const mgr = new ClaudeSessionManager(config);
      process.env.CLAUDE_BIN = mock_claude;

      const failed = new Promise<string>((resolve) => {
        mgr.on("session:failed", (_id: string, error: string) => resolve(error));
      });

      await mgr.spawn({
        entity_id: "alpha",
        feature_id: "alpha-42",
        archetype: "builder",
        dna: [],
        model: { model: "opus", think: "high" },
        worktree_path: tmp,
        prompt: "test",
        interactive: false,
      });

      const error = await failed;
      expect(error).toContain("exited with code 1");
      expect(mgr.get_active()).toHaveLength(0);

      delete process.env.CLAUDE_BIN;
    });
  });

  describe("session queries", () => {
    it("get_by_entity and get_by_feature work", async () => {
      const mock_claude = join(tmp, "mock-claude-slow");
      // This script sleeps so the session stays active
      await writeFile(mock_claude, "#!/bin/bash\nsleep 10\n", "utf-8");
      await chmod(mock_claude, 0o755);

      const config = make_config();
      const mgr = new ClaudeSessionManager(config);
      process.env.CLAUDE_BIN = mock_claude;

      const session = await mgr.spawn({
        entity_id: "alpha",
        feature_id: "alpha-42",
        archetype: "builder",
        dna: [],
        model: { model: "opus", think: "high" },
        worktree_path: tmp,
        prompt: "test",
        interactive: false,
      });

      expect(mgr.get_active()).toHaveLength(1);
      expect(mgr.get_by_entity("alpha")).toHaveLength(1);
      expect(mgr.get_by_entity("beta")).toHaveLength(0);
      expect(mgr.get_by_feature("alpha-42")).toBeTruthy();
      expect(mgr.get_by_feature("alpha-99")).toBeNull();

      // Clean up — kill sends SIGTERM; session map cleanup is async
      await mgr.kill(session.session_id);
      await wait_for(() => mgr.get_active().length === 0);
      expect(mgr.get_active()).toHaveLength(0);

      delete process.env.CLAUDE_BIN;
    });
  });

  describe("CLAUDE_CONFIG_DIR injection", () => {
    /** Minimal mock registry that returns entity configs by ID. */
    class MockRegistry {
      private entities = new Map<string, EntityConfig>();

      add(config: EntityConfig): void {
        this.entities.set(config.entity.id, config);
      }

      get(id: string): EntityConfig | undefined {
        return this.entities.get(id);
      }
    }

    function make_entity(id: string, claude_config_dir?: string): EntityConfig {
      return EntityConfigSchema.parse({
        entity: {
          id,
          name: id,
          repos: [],
          channels: { category_id: "", list: [] },
          memory: { path: `/tmp/test-memory/${id}` },
          secrets: { vault_name: `entity-${id}` },
          ...(claude_config_dir ? { subscription: { claude_config_dir } } : {}),
        },
      });
    }

    it("injects CLAUDE_CONFIG_DIR when entity has subscription.claude_config_dir", async () => {
      const mock_claude = join(tmp, "mock-claude-env");
      // Script that prints its CLAUDE_CONFIG_DIR to stdout
      await writeFile(
        mock_claude,
        '#!/bin/bash\necho "{\\"type\\":\\"result\\",\\"content\\":\\"$CLAUDE_CONFIG_DIR\\"}"\nexit 0\n',
        "utf-8",
      );
      await chmod(mock_claude, 0o755);

      const config = make_config();
      const mgr = new ClaudeSessionManager(config);

      const registry = new MockRegistry();
      registry.add(make_entity("test-entity", "/tmp/test-claude-config"));
      mgr.set_registry(registry as unknown as import("../registry.js").EntityRegistry);

      process.env.CLAUDE_BIN = mock_claude;

      const completed = new Promise<string[]>((resolve) => {
        mgr.on("session:completed", (result) => resolve(result.output_lines));
      });

      await mgr.spawn({
        entity_id: "test-entity",
        feature_id: "test-42",
        archetype: "builder",
        dna: [],
        model: { model: "opus", think: "high" },
        worktree_path: tmp,
        prompt: "test",
        interactive: false,
      });

      const output = await completed;
      // The mock script echoes $CLAUDE_CONFIG_DIR — verify it was set
      expect(output.some((l) => l.includes("/tmp/test-claude-config"))).toBe(true);

      delete process.env.CLAUDE_BIN;
    });

    it("expands tilde in claude_config_dir to absolute path", async () => {
      const mock_claude = join(tmp, "mock-claude-tilde");
      // Script that prints its CLAUDE_CONFIG_DIR to stdout
      await writeFile(
        mock_claude,
        '#!/bin/bash\necho "{\\"type\\":\\"result\\",\\"content\\":\\"$CLAUDE_CONFIG_DIR\\"}"\nexit 0\n',
        "utf-8",
      );
      await chmod(mock_claude, 0o755);

      const config = make_config();
      const mgr = new ClaudeSessionManager(config);

      const registry = new MockRegistry();
      registry.add(make_entity("tilde-entity", "~/.lobsterfarm/entities/tilde/.claude-config"));
      mgr.set_registry(registry as unknown as import("../registry.js").EntityRegistry);

      process.env.CLAUDE_BIN = mock_claude;

      const completed = new Promise<string[]>((resolve) => {
        mgr.on("session:completed", (result) => resolve(result.output_lines));
      });

      await mgr.spawn({
        entity_id: "tilde-entity",
        feature_id: "test-tilde",
        archetype: "builder",
        dna: [],
        model: { model: "opus", think: "high" },
        worktree_path: tmp,
        prompt: "test",
        interactive: false,
      });

      const output = await completed;
      const expected = join(homedir(), ".lobsterfarm/entities/tilde/.claude-config");
      // Tilde must be expanded — the injected path should start with / not ~
      expect(output.some((l) => l.includes(expected))).toBe(true);
      expect(output.some((l) => l.includes("~/.lobsterfarm"))).toBe(false);

      delete process.env.CLAUDE_BIN;
    });

    it("does NOT inject CLAUDE_CONFIG_DIR when entity has no subscription", async () => {
      const mock_claude = join(tmp, "mock-claude-noenv");
      // Script that prints CLAUDE_CONFIG_DIR (should be empty)
      await writeFile(
        mock_claude,
        '#!/bin/bash\necho "{\\"type\\":\\"result\\",\\"content\\":\\"CONFIG_DIR=$CLAUDE_CONFIG_DIR\\"}"\nexit 0\n',
        "utf-8",
      );
      await chmod(mock_claude, 0o755);

      const config = make_config();
      const mgr = new ClaudeSessionManager(config);

      const registry = new MockRegistry();
      registry.add(make_entity("plain-entity"));
      mgr.set_registry(registry as unknown as import("../registry.js").EntityRegistry);

      process.env.CLAUDE_BIN = mock_claude;

      const completed = new Promise<string[]>((resolve) => {
        mgr.on("session:completed", (result) => resolve(result.output_lines));
      });

      await mgr.spawn({
        entity_id: "plain-entity",
        feature_id: "test-43",
        archetype: "builder",
        dna: [],
        model: { model: "opus", think: "high" },
        worktree_path: tmp,
        prompt: "test",
        interactive: false,
      });

      const output = await completed;
      // CONFIG_DIR= should be empty (no value after =)
      expect(output.some((l) => l.includes("CONFIG_DIR="))).toBe(true);
      expect(output.some((l) => l.includes("CONFIG_DIR=/"))).toBe(false);

      delete process.env.CLAUDE_BIN;
    });

    it("works without a registry (backward compatible)", async () => {
      const mock_claude = join(tmp, "mock-claude-noreg");
      await writeFile(
        mock_claude,
        '#!/bin/bash\necho "{\\"type\\":\\"result\\",\\"content\\":\\"ok\\"}"\nexit 0\n',
        "utf-8",
      );
      await chmod(mock_claude, 0o755);

      const config = make_config();
      const mgr = new ClaudeSessionManager(config);
      // No registry set — should not throw

      process.env.CLAUDE_BIN = mock_claude;

      const completed = new Promise<void>((resolve) => {
        mgr.on("session:completed", () => resolve());
      });

      await mgr.spawn({
        entity_id: "no-registry-entity",
        feature_id: "test-44",
        archetype: "builder",
        dna: [],
        model: { model: "opus", think: "high" },
        worktree_path: tmp,
        prompt: "test",
        interactive: false,
      });

      await completed;
      // Session completed successfully without a registry
      expect(mgr.get_active()).toHaveLength(0);

      delete process.env.CLAUDE_BIN;
    });

    it("merges CLAUDE_CONFIG_DIR with caller-provided env", async () => {
      const mock_claude = join(tmp, "mock-claude-merge");
      await writeFile(
        mock_claude,
        '#!/bin/bash\necho "{\\"type\\":\\"result\\",\\"content\\":\\"GH=$GH_TOKEN CCD=$CLAUDE_CONFIG_DIR\\"}"\nexit 0\n',
        "utf-8",
      );
      await chmod(mock_claude, 0o755);

      const config = make_config();
      const mgr = new ClaudeSessionManager(config);

      const registry = new MockRegistry();
      registry.add(make_entity("merge-entity", "/tmp/merge-config"));
      mgr.set_registry(registry as unknown as import("../registry.js").EntityRegistry);

      process.env.CLAUDE_BIN = mock_claude;

      const completed = new Promise<string[]>((resolve) => {
        mgr.on("session:completed", (result) => resolve(result.output_lines));
      });

      await mgr.spawn({
        entity_id: "merge-entity",
        feature_id: "test-45",
        archetype: "builder",
        dna: [],
        model: { model: "opus", think: "high" },
        worktree_path: tmp,
        prompt: "test",
        interactive: false,
        env: { GH_TOKEN: "ghp_test123" },
      });

      const output = await completed;
      // Both GH_TOKEN and CLAUDE_CONFIG_DIR should be present
      expect(output.some((l) => l.includes("GH=ghp_test123"))).toBe(true);
      expect(output.some((l) => l.includes("CCD=/tmp/merge-config"))).toBe(true);

      delete process.env.CLAUDE_BIN;
    });
  });
});
