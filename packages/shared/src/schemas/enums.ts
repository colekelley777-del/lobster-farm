import { z } from "zod";

export const ArchetypeRoleSchema = z.enum([
  "planner",
  "designer",
  "builder",
  "reviewer",
  "operator",
  "commander",
  "marketer",
]);
export type ArchetypeRole = z.infer<typeof ArchetypeRoleSchema>;

export const ChannelTypeSchema = z.enum(["general", "work_room", "work_log", "alerts"]);
export type ChannelType = z.infer<typeof ChannelTypeSchema>;

export const EntityStatusSchema = z.enum(["active", "paused", "archived"]);
export type EntityStatus = z.infer<typeof EntityStatusSchema>;

export const AgentModeSchema = z.enum(["dedicated", "generalist", "hybrid"]);
export type AgentMode = z.infer<typeof AgentModeSchema>;

export const ModelNameSchema = z.enum(["opus", "sonnet", "haiku"]);
export type ModelName = z.infer<typeof ModelNameSchema>;

export const ThinkLevelSchema = z.enum(["none", "standard", "high", "xhigh", "max"]);
export type ThinkLevel = z.infer<typeof ThinkLevelSchema>;

export const RepoStructureSchema = z.enum(["monorepo", "single"]);
export type RepoStructure = z.infer<typeof RepoStructureSchema>;

export const PrioritySchema = z.enum(["critical", "high", "medium", "low"]);
export type Priority = z.infer<typeof PrioritySchema>;
