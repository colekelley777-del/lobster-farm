import { statSync } from "node:fs";
import { chmod, copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type LobsterFarmConfig,
  type PathConfig,
  type TemplateVariables,
  agents_dir,
  claude_hooks_dir,
  claude_md_path,
  claude_settings_path,
  dna_versions_dir,
  entities_dir,
  global_config_path,
  lobsterfarm_dir,
  logs_dir,
  queue_dir,
  scripts_dir,
  skills_dir,
  sop_dir,
  templates_dir,
  tools_md_path,
  user_md_path,
  write_resolved,
  write_yaml,
} from "@lobster-farm/shared";

/** Resolve the monorepo config/ directory from the CLI source location. */
function config_templates_dir(): string {
  const this_file = fileURLToPath(import.meta.url);
  // Walk up from the current file until we find a directory containing config/
  let dir = dirname(this_file);
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, "config");
    try {
      if (statSync(candidate).isDirectory()) {
        return candidate;
      }
    } catch {
      // not found at this level, keep going up
    }
    dir = dirname(dir);
  }
  throw new Error(
    "Could not locate config/ directory in the monorepo. " +
      "Make sure you're running from the lobster-farm monorepo.",
  );
}

/** Agent archetype role to template filename mapping. */
const AGENT_TEMPLATE_MAP: Record<string, string> = {
  planner: "planner.md",
  designer: "designer.md",
  builder: "builder.md",
  operator: "operator.md",
  commander: "commander.md",
};

/**
 * Generate all configuration files from templates.
 *
 * Writes to ~/.lobsterfarm/ and ~/.claude/ using the provided template variables.
 */
export async function generate_config_files(
  vars: Partial<TemplateVariables>,
  agent_names: Record<"planner" | "designer" | "builder" | "operator", string>,
  path_overrides?: Partial<PathConfig>,
): Promise<string[]> {
  const created: string[] = [];
  const config_dir = config_templates_dir();

  // ── ~/.claude/CLAUDE.md ──
  const claude_template = join(config_dir, "claude", "CLAUDE.md");
  const claude_out = claude_md_path(path_overrides);
  await write_resolved(claude_template, claude_out, vars);
  created.push(claude_out);

  // ── ~/.lobsterfarm/user.md ──
  const user_template = join(config_dir, "lobsterfarm", "user.md");
  const user_out = user_md_path(path_overrides);
  await write_resolved(user_template, user_out, vars);
  created.push(user_out);

  // ── ~/.lobsterfarm/tools.md ──
  const tools_template = join(config_dir, "lobsterfarm", "tools.md");
  const tools_out = tools_md_path(path_overrides);
  await write_resolved(tools_template, tools_out, vars);
  created.push(tools_out);

  // ── Agent files: rename based on user-chosen names ──
  for (const [role, template_file] of Object.entries(AGENT_TEMPLATE_MAP)) {
    const name = agent_names[role as keyof typeof agent_names];
    const agent_template = join(config_dir, "claude", "agents", template_file);
    const output_filename = `${name.toLowerCase()}.md`;
    const agent_out = join(agents_dir(path_overrides), output_filename);
    await write_resolved(agent_template, agent_out, vars);
    created.push(agent_out);
  }

  // ── Reviewer agent (not renamed — always "reviewer") ──
  const reviewer_template = join(config_dir, "claude", "agents", "reviewer.md");
  const reviewer_out = join(agents_dir(path_overrides), "reviewer.md");
  await write_resolved(reviewer_template, reviewer_out, vars);
  created.push(reviewer_out);

  // ── Skills: copy all skill directories ──
  const skills_src = join(config_dir, "claude", "skills");
  try {
    const skill_dirs = await readdir(skills_src, { withFileTypes: true });
    for (const entry of skill_dirs) {
      if (!entry.isDirectory()) continue;
      const skill_name = entry.name;
      const src_skill_file = join(skills_src, skill_name, "SKILL.md");
      const dest_skill_dir = join(skills_dir(path_overrides), skill_name);
      const dest_skill_file = join(dest_skill_dir, "SKILL.md");
      await mkdir(dest_skill_dir, { recursive: true });
      await copyFile(src_skill_file, dest_skill_file);
      created.push(dest_skill_file);
    }
  } catch {
    // skills directory might not exist — not fatal
  }

  // ── Hooks: copy all hook scripts and chmod +x ──
  // Hooks are tiny shell scripts invoked by Claude Code during lifecycle
  // events (SessionStart, PreToolUse, Stop, etc.). See generate_settings()
  // for the settings.json registration that wires them up.
  const dest_hooks_dir = claude_hooks_dir(path_overrides);
  await mkdir(dest_hooks_dir, { recursive: true });

  // Lifecycle hooks (SessionStart etc.) live in config/claude/hooks/.
  const lifecycle_hooks_src = join(config_dir, "claude", "hooks");
  try {
    const hook_entries = await readdir(lifecycle_hooks_src, { withFileTypes: true });
    for (const entry of hook_entries) {
      if (!entry.isFile()) continue;
      const src_file = join(lifecycle_hooks_src, entry.name);
      const dest_file = join(dest_hooks_dir, entry.name);
      await copyFile(src_file, dest_file);
      // Preserve executability — copyFile doesn't always carry perms across
      // filesystems, so set +x explicitly on shell scripts.
      if (entry.name.endsWith(".sh")) {
        await chmod(dest_file, 0o755);
      }
      created.push(dest_file);
    }
  } catch {
    // hooks directory might not exist — not fatal
  }

  // PreToolUse guard hooks live in config/hooks/ (alongside their tests).
  // We deploy entity-isolation.sh here because generate_settings() references
  // it by absolute path in ~/.claude/settings.json — without the file, the
  // hook call errors out on every tool invocation. Other scripts in
  // config/hooks/ are currently wired inline in generate_settings() and don't
  // need deployment yet; add them to this list as they're migrated to
  // file-based registration.
  const guard_hooks_src = join(config_dir, "hooks");
  const guard_hook_files = ["entity-isolation.sh"];
  for (const name of guard_hook_files) {
    try {
      const src_file = join(guard_hooks_src, name);
      const dest_file = join(dest_hooks_dir, name);
      await copyFile(src_file, dest_file);
      await chmod(dest_file, 0o755);
      created.push(dest_file);
    } catch {
      // Missing guard hook script — not fatal. The inline fallback (if any)
      // in generate_settings() will still protect the session.
    }
  }

  return created;
}

/** Generate the ~/.claude/settings.json with bypass permissions and hooks. */
export async function generate_settings(path_overrides?: Partial<PathConfig>): Promise<string> {
  // Absolute paths to deployed hook scripts. We use absolute paths rather than
  // relying on $HOME expansion because Claude Code's hook runner doesn't
  // guarantee a shell wrapper.
  const session_start_hook = join(claude_hooks_dir(path_overrides), "session-start-inject.sh");
  const entity_isolation_hook = join(claude_hooks_dir(path_overrides), "entity-isolation.sh");

  const settings = {
    permissions: {
      defaultMode: "bypassPermissions",
    },
    effortLevel: "high",
    skipDangerousModePermissionPrompt: true,
    hooks: {
      SessionStart: [
        {
          matcher: "",
          hooks: [
            {
              type: "command",
              // Deployed by generate_config_files() from
              // config/claude/hooks/session-start-inject.sh. Reads the
              // LF_PENDING_FILE env var (set by the daemon before spawn)
              // and emits the pending Discord message as additionalContext.
              // No-ops if the env var is unset or the file is missing.
              command: session_start_hook,
              timeout: 5,
            },
          ],
        },
      ],
      PreToolUse: [
        {
          matcher: "Edit|Write",
          hooks: [
            {
              type: "command",
              // tool_input comes from the hook's stdin JSON. The old $TOOL_INPUT
              // env var was dropped by CLI v2.1.185, which silently turned this
              // branch-protection check into a no-op (FILE was always empty, so
              // the repo-path guard never matched and every edit was allowed).
              command: `bash -c 'IN=$(cat); FILE=$(printf "%s" "$IN" | jq -r ".tool_input.file_path // empty"); REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0; case "$FILE" in "$REPO_ROOT"/*) ;; *) exit 0;; esac; BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null) || exit 0; if [ "$BRANCH" = "main" ] || [ "$BRANCH" = "master" ]; then echo "BLOCK: Direct edits to $BRANCH are not allowed. Create a feature branch first." >&2; exit 2; fi'`,
            },
          ],
        },
        {
          matcher: "Edit|Write",
          hooks: [
            {
              type: "command",
              // tool_input comes from the hook's stdin JSON. The old $TOOL_INPUT
              // env var was dropped by CLI v2.1.185, which silently turned this
              // secret scan into a no-op (it was grepping an empty string).
              command:
                'bash -c \'IN=$(cat); if printf "%s" "$IN" | grep -qiE "(sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{36,}|AKIA[A-Z0-9]{16}|xox[bpras]-[a-zA-Z0-9-]+|-----BEGIN (RSA |EC |DSA )?PRIVATE KEY-----)"; then echo "BLOCK: Detected potential hardcoded secret in tool input." >&2; exit 2; fi\'',
            },
          ],
        },
        {
          // Entity isolation — pool bots run with bypassPermissions and would
          // otherwise be able to read any entity's files on disk. This hook
          // blocks reads/writes/bash against sibling entities under
          // ~/.lobsterfarm/entities/<other>/ when a session is scoped to a
          // specific entity. Deployed by generate_config_files() from
          // config/hooks/entity-isolation.sh.
          matcher: "Bash|Read|Edit|Write|NotebookEdit",
          hooks: [
            {
              type: "command",
              command: `bash ${entity_isolation_hook}`,
              timeout: 5,
            },
          ],
        },
      ],
      Stop: [
        {
          matcher: "",
          hooks: [
            {
              type: "command",
              // Reply-enforcement (issue #39): the daemon may instruct us to
              // block this turn (exit 2 with stderr reminder) when the agent
              // produced assistant text but didn't route it through Discord.
              // On any other condition (or if curl/jq fail / daemon
              // unreachable), exit 0 — a wedged daemon must never wedge an
              // agent.
              command:
                // session_id/cwd come from the hook's stdin JSON (the stable
                // interface). The old $CLAUDE_SESSION_ID env var was dropped by
                // CLI v2.1.185, which silently broke session confirmation.
                "IN=$(cat); SID=$(printf '%s' \"$IN\" | jq -r '.session_id // empty'); " +
                '[ -z "$SID" ] && SID="${CLAUDE_CODE_SESSION_ID:-}"; ' +
                "CWD=$(printf '%s' \"$IN\" | jq -r '.cwd // empty'); [ -z \"$CWD\" ] && CWD=\"$(pwd)\"; " +
                "RESP=$(curl -s -X POST http://localhost:7749/hooks/stop " +
                "-H 'Content-Type: application/json' " +
                '-d "{\\"session_id\\": \\"$SID\\", \\"working_dir\\": \\"$CWD\\"}" 2>/dev/null) || exit 0; ' +
                "if echo \"$RESP\" | jq -e '.block == true' >/dev/null 2>&1; then " +
                "echo \"$RESP\" | jq -r '.reminder' >&2; " +
                "exit 2; " +
                "fi; " +
                "exit 0",
              timeout: 10,
            },
          ],
        },
      ],
    },
  };

  const out = claude_settings_path(path_overrides);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
  return out;
}

/** Create the directory structure under ~/.lobsterfarm/. */
export async function create_directory_structure(
  path_overrides?: Partial<PathConfig>,
): Promise<string[]> {
  const dirs = [
    lobsterfarm_dir(path_overrides),
    entities_dir(path_overrides),
    sop_dir(path_overrides),
    queue_dir(path_overrides),
    logs_dir(path_overrides),
    scripts_dir(path_overrides),
    templates_dir(path_overrides),
    dna_versions_dir(path_overrides),
    agents_dir(path_overrides),
    skills_dir(path_overrides),
    claude_hooks_dir(path_overrides),
  ];

  for (const dir of dirs) {
    await mkdir(dir, { recursive: true });
  }

  return dirs;
}

/** Write the global config.yaml. */
export async function write_global_config(
  config: LobsterFarmConfig,
  path_overrides?: Partial<PathConfig>,
): Promise<string> {
  const out = global_config_path(path_overrides);
  await write_yaml(out, config);
  return out;
}
