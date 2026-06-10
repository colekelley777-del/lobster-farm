import { z } from "zod";
import {
  ArchetypeRoleSchema,
  ChannelTypeSchema,
  EntityStatusSchema,
  RepoStructureSchema,
} from "./enums.js";

export const ChannelMappingSchema = z.object({
  type: ChannelTypeSchema,
  id: z.string(),
  purpose: z.string().optional(),
  assigned_feature: z.string().nullable().optional(),
  dynamic: z.boolean().optional(),
  /**
   * Optional archetype override for this channel.
   * When set on a work_room channel, incoming messages auto-assign a pool bot
   * running as this archetype instead of defaulting to "planner".
   * Example: a #marketing channel sets assigned_archetype: marketer to
   * route messages to Tristan instead of Gary.
   */
  assigned_archetype: ArchetypeRoleSchema.optional(),
});
export type ChannelMapping = z.infer<typeof ChannelMappingSchema>;

export const ChannelsSchema = z
  .object({
    category_id: z.string().default(""),
    role_id: z.string().optional(),
    list: z.array(ChannelMappingSchema).default([]),
  })
  .default({ category_id: "", list: [] });
export type Channels = z.infer<typeof ChannelsSchema>;

// Per-entity configuration (~/.lobsterfarm/entities/{id}/config.yaml)
// Uses snake_case keys to match YAML file format.
export const EntityConfigSchema = z.object({
  entity: z.object({
    id: z.string().regex(/^[a-z0-9-]+$/, "Entity ID must be lowercase alphanumeric with hyphens"),
    name: z.string(),
    description: z.string().default(""),
    status: EntityStatusSchema.default("active"),

    // Blueprint this entity follows. Defines archetypes, SOPs, guidelines,
    // channel structure, model defaults. Entity config only needs overrides.
    blueprint: z.string().optional(),

    // PR review lifecycle version (#257).
    //   "v1" — legacy: pull_request.opened spawns reviewer immediately, then
    //          falls through to pr-cron / bypass branches when CI is pending.
    //   "v2" — event-driven: pull_request.opened is a no-op; check_suite.completed
    //          drives the entire lifecycle (CI → review → merge-gate).
    // Default v1 during the rollout window. Cutover is per-entity.
    pr_lifecycle: z.enum(["v1", "v2"]).default("v1"),

    repos: z
      .array(
        z.object({
          name: z.string(),
          url: z.string(),
          path: z.string(),
          structure: RepoStructureSchema.default("monorepo"),
        }),
      )
      .default([]),

    accounts: z
      .object({
        github: z
          .object({
            org: z.string().optional(),
            user: z.string().optional(),
            // Override the default GitHub App installation ID for this entity.
            // Used by the AutoReviewer to authenticate against repos owned by
            // different GitHub accounts (e.g. rg-jax vs ultim8).
            github_app_installation_id: z.string().optional(),
          })
          .optional(),
        vercel: z
          .object({
            project: z.string().optional(),
          })
          .optional(),
        sentry: z
          .object({
            project: z.string().optional(),
            // Array of Sentry projects mapped to this entity.
            // Used by the triage module to route webhooks and build prompts.
            projects: z
              .array(
                z.object({
                  slug: z.string(),
                  type: z.string().optional(), // e.g. "frontend" | "backend"
                  repo: z.string().optional(), // which entity repo this maps to
                }),
              )
              .optional(),
          })
          .optional(),
      })
      .default({}),

    channels: ChannelsSchema,

    memory: z.object({
      path: z.string(),
      auto_extract: z.boolean().default(true),
    }),

    // SOPs and guidelines come from the blueprint. Only list overrides here.
    sop_overrides: z
      .object({
        add: z.array(z.string()).default([]),
        remove: z.array(z.string()).default([]),
      })
      .optional(),

    guideline_overrides: z
      .object({
        add: z.array(z.string()).default([]),
        remove: z.array(z.string()).default([]),
      })
      .optional(),

    secrets: z.object({
      vault: z.string().default("1password"),
      vault_name: z.string(),
      // 1Password reference for entity-specific GitHub token.
      // When set, injected as GH_TOKEN into agent tmux sessions via `op run`.
      // e.g., "op://entity-my-app/github/credential"
      github_token_ref: z.string().optional(),
    }),

    // Per-entity Claude Max subscription. When set, CLAUDE_CONFIG_DIR is
    // injected into session environments so this entity uses a separate
    // Claude account (billing, rate limits). See docs/per-entity-subscriptions.md.
    subscription: z
      .object({
        claude_config_dir: z.string().optional(),
      })
      .optional(),
  }),
});

export type EntityConfig = z.infer<typeof EntityConfigSchema>;
