import { tmpdir } from "node:os";
import { join } from "node:path";
import { LobsterFarmConfigSchema } from "@lobster-farm/shared";
import type { LobsterFarmConfig } from "@lobster-farm/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BotPoolTestBase } from "./helpers/test-bot-pool-base.js";

// ── Mocks ──

vi.mock("../actions.js", () => ({
  notify: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../persistence.js", () => ({
  save_pool_state: vi.fn().mockResolvedValue(undefined),
  load_pool_state: vi.fn().mockResolvedValue({
    bots: [],
    session_history: {},
    avatar_state: {},
  }),
}));

vi.mock("../sentry.js", () => ({
  captureException: vi.fn(),
  addBreadcrumb: vi.fn(),
}));

vi.mock("../rate-limit-recovery.js", () => ({
  scan_and_recover: vi.fn().mockReturnValue([]),
}));

// ── Tests ──

/**
 * inject_message_to_bot must propagate the submit-confirmation boolean from
 * send_via_tmux: a success log + true return only when the submit was
 * actually confirmed, a warning + false return when it wasn't (#65).
 */
describe("inject_message_to_bot submit-confirmation propagation (issue #65)", () => {
  let temp_dir: string;
  let config: LobsterFarmConfig;
  let pool: BotPoolTestBase;

  beforeEach(() => {
    vi.clearAllMocks();
    temp_dir = join(tmpdir(), `inject-confirm-test-${Date.now()}`);
    config = LobsterFarmConfigSchema.parse({
      user: { name: "Test" },
      paths: { lobsterfarm_dir: temp_dir },
    });
    pool = new BotPoolTestBase(config);

    // Session is alive and at the prompt — ready to receive immediately.
    vi.spyOn(pool as unknown as Record<string, unknown>, "is_tmux_alive" as never).mockReturnValue(
      true as never,
    );
    vi.spyOn(pool as unknown as Record<string, unknown>, "is_at_prompt" as never).mockReturnValue(
      true as never,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function stub_send(result: boolean) {
    return vi
      .spyOn(pool as unknown as Record<string, unknown>, "send_via_tmux" as never)
      .mockResolvedValue(result as never);
  }

  it("returns true and logs success when the submit is confirmed", async () => {
    stub_send(true);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const ok = await pool.inject_message_to_bot("pool-1", "hello");

    expect(ok).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Injected message into pool-1"));
    expect(warn).not.toHaveBeenCalled();
  });

  it("returns false and warns when the submit is not confirmed", async () => {
    stub_send(false);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const ok = await pool.inject_message_to_bot("pool-1", "hello");

    expect(ok).toBe(false);
    // No success log fired on an unconfirmed (likely dropped) submit.
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("Injected message into pool-1"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("submit not confirmed"));
  });

  it("returns false when send_via_tmux throws", async () => {
    vi.spyOn(
      pool as unknown as Record<string, unknown>,
      "send_via_tmux" as never,
    ).mockRejectedValue(new Error("tmux send failed") as never);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const ok = await pool.inject_message_to_bot("pool-1", "hello");

    expect(ok).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Failed to inject message"));
  });
});
