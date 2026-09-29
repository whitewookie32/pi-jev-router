import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_OUTPUT_BYTES = 16 * 1024;
const BOOTSTRAP_TIMEOUT_MS = 2_000;
const BRIDGE_TIMEOUT_MS = 8_000;
const extensionDir = dirname(fileURLToPath(import.meta.url));
const bridgePath = join(extensionDir, "jev_router_bridge.py");

type Tier = { provider: string; hermesModel: string; model: string };
type RouterConfig = {
  hermes: { home: string; source: string; launcher: string };
  router: { minConfidence: number; tiers: Record<string, Tier> };
  behavior: { preserveManualModelChoice: boolean; routeCommanderPlans: boolean };
};
type Decision = {
  status?: unknown;
  reason?: unknown;
  route?: unknown;
  tier?: unknown;
  route_confidence?: unknown;
  tier_confidence?: unknown;
  effective_provider?: unknown;
  effective_model?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function expandHome(path: string): string {
  return path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

function parseRouting(value: unknown): RouterConfig | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.enabled !== "boolean" || value.enabled !== true) return undefined;
  const rawHermes = isRecord(value.hermes) ? value.hermes : {};
  const rawRouter = value.router;
  const rawBehavior = value.behavior;
  if (!isRecord(rawRouter) || !isRecord(rawBehavior) || !isRecord(rawRouter.tiers)) return undefined;
  if (typeof rawRouter.minConfidence !== "number" || rawRouter.minConfidence < 0 || rawRouter.minConfidence > 1) return undefined;
  if (typeof rawBehavior.preserveManualModelChoice !== "boolean" || typeof rawBehavior.routeCommanderPlans !== "boolean") return undefined;

  const home = expandHome(nonEmptyString(rawHermes.home) ? rawHermes.home : process.env.HERMES_HOME || "~/.hermes");
  const source = expandHome(nonEmptyString(rawHermes.source) ? rawHermes.source : process.env.HERMES_AGENT_SOURCE || join(home, "hermes-agent"));
  const launcher = expandHome(nonEmptyString(rawHermes.launcher) ? rawHermes.launcher : join(source, ".hermes", "bin", "hermes"));
  const tiers: Record<string, Tier> = {};
  for (const [name, rawTier] of Object.entries(rawRouter.tiers)) {
    if (!isRecord(rawTier) || !nonEmptyString(rawTier.provider) || !nonEmptyString(rawTier.hermesModel) || !nonEmptyString(rawTier.model)) return undefined;
    tiers[name] = { provider: rawTier.provider, hermesModel: rawTier.hermesModel, model: rawTier.model };
  }
  return {
    hermes: { home, source, launcher },
    router: { minConfidence: rawRouter.minConfidence, tiers },
    behavior: {
      preserveManualModelChoice: rawBehavior.preserveManualModelChoice,
      routeCommanderPlans: rawBehavior.routeCommanderPlans,
    },
  };
}

function loadConfig(): RouterConfig | undefined {
  const agentDir = getAgentDir();
  const appSettings = readJson(join(agentDir, "settings.json"));
  if (isRecord(appSettings) && Object.hasOwn(appSettings, "jevRouting")) return parseRouting(appSettings.jevRouting);
  return parseRouting(readJson(join(agentDir, "jev-routing.json")));
}

function runProcess(command: string, args: string[], input: string, environment: NodeJS.ProcessEnv, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: homedir(),
      env: environment,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    let settled = false;
    const finish = (result: Error | string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      result instanceof Error ? reject(result) : resolve(result);
    };
    const collect = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (Buffer.byteLength(output, "utf8") > MAX_OUTPUT_BYTES) {
        child.kill();
        finish(new Error("router output exceeded its bound"));
      }
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error("router timed out"));
    }, timeoutMs);
    child.stdout.on("data", collect);
    child.stderr.on("data", () => {});
    child.once("error", () => finish(new Error("router process failed")));
    child.once("close", (code) => {
      if (code !== 0) return finish(new Error("router process failed"));
      finish(output);
    });
    child.stdin.end(input);
  });
}

async function resolveDecision(config: RouterConfig, message: string): Promise<Decision | undefined> {
  const environment = {
    ...process.env,
    HERMES_HOME: config.hermes.home,
    HERMES_AGENT_SOURCE: config.hermes.source,
  };
  const runtime = JSON.parse(await runProcess(
    config.hermes.launcher,
    ["--print-runtime-command"],
    "",
    environment,
    BOOTSTRAP_TIMEOUT_MS,
  ));
  if (!Array.isArray(runtime) || !nonEmptyString(runtime[0])) return undefined;
  const raw = await runProcess(
    runtime[0],
    ["-I", bridgePath],
    JSON.stringify({ message }),
    environment,
    BRIDGE_TIMEOUT_MS,
  );
  const decision: unknown = JSON.parse(raw);
  return isRecord(decision) ? decision as Decision : undefined;
}

function routeLabel(decision: Decision): string {
  const route = nonEmptyString(decision.route) ? decision.route : "direct";
  const tier = nonEmptyString(decision.tier) ? decision.tier : "unchanged";
  return `JEV ${route}/${tier}`;
}

export default function jevRouter(pi: ExtensionAPI) {
  let automaticTarget: string | undefined;
  let automaticRouting = true;

  pi.on("model_select", (event, ctx) => {
    const selected = `${event.model.provider}/${event.model.id}`;
    if (automaticTarget === selected) {
      automaticTarget = undefined;
      return;
    }
    if (event.source === "set" && loadConfig()?.behavior.preserveManualModelChoice) {
      automaticRouting = false;
      ctx.ui.setStatus("jev-routing", "JEV paused (manual model)");
    }
  });

  pi.registerCommand("jev-routing", {
    description: "Show or control Hermes JEV model routing: auto, off, status",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase() || "status";
      if (action === "auto") automaticRouting = true;
      else if (action === "off") automaticRouting = false;
      else if (action !== "status") {
        ctx.ui.notify("Usage: /jev-routing [auto|off|status]", "warning");
        return;
      }
      const state = automaticRouting ? "auto" : "paused";
      ctx.ui.setStatus("jev-routing", `JEV ${state}`);
      ctx.ui.notify(`JEV routing: ${state}`, "info");
    },
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const config = loadConfig();
    if (!config || !automaticRouting) return;
    const decision = await resolveDecision(config, event.prompt).catch(() => undefined);
    if (!decision || decision.status !== "routed" || !nonEmptyString(decision.tier)) return;
    if (typeof decision.route_confidence !== "number" || decision.route_confidence < config.router.minConfidence) {
      ctx.ui.setStatus("jev-routing", "JEV confidence below app setting");
      return;
    }

    const tier = config.router.tiers[decision.tier];
    if (!tier || decision.effective_provider !== tier.provider || decision.effective_model !== tier.hermesModel) {
      ctx.ui.setStatus("jev-routing", "JEV config mismatch");
      return;
    }
    const scoped = ctx.scopedModels;
    if (scoped.length > 0 && !scoped.some(({ model }) => model.provider === tier.provider && model.id === tier.model)) {
      ctx.ui.setStatus("jev-routing", "JEV target outside model scope");
      return;
    }
    const model = ctx.modelRegistry.find(tier.provider, tier.model);
    if (!model) {
      ctx.ui.setStatus("jev-routing", "JEV target unavailable");
      return;
    }
    const key = `${tier.provider}/${tier.model}`;
    if (ctx.model?.provider !== tier.provider || ctx.model.id !== tier.model) {
      automaticTarget = key;
      if (!await pi.setModel(model)) {
        automaticTarget = undefined;
        ctx.ui.setStatus("jev-routing", "JEV target unauthenticated");
        return;
      }
    }
    ctx.ui.setStatus("jev-routing", routeLabel(decision));
  });
}
