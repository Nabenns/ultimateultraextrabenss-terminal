import { readFileSync } from "node:fs";
import { z } from "zod";
import type { WorkerSpec } from "./types.js";

const WorkerSchema = z.object({
  name: z.string().min(1),
  port: z.number().int().min(1024).max(65535),
  cwd: z.string().min(1),
  agent: z.string().nullable().default(null),
  model: z.string().nullable().default(null),
  attach: z.boolean().default(true),
});

const ConfigSchema = z.object({
  workers: z.array(WorkerSchema).min(1),
});

export interface HubConfig {
  workers: WorkerSpec[];
}

export function parseConfig(raw: unknown): HubConfig {
  const parsed = ConfigSchema.parse(raw);

  const names = new Set<string>();
  const ports = new Set<number>();
  for (const w of parsed.workers) {
    if (names.has(w.name)) throw new Error(`duplicate name: ${w.name}`);
    if (ports.has(w.port)) throw new Error(`duplicate port: ${w.port}`);
    names.add(w.name);
    ports.add(w.port);
  }
  return { workers: parsed.workers };
}

export function loadConfig(path?: string): HubConfig {
  const resolved = path ?? process.env.HUB_CONFIG ?? "agents.config.json";
  const raw = JSON.parse(readFileSync(resolved, "utf8"));
  return parseConfig(raw);
}
