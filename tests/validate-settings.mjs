import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const path = process.argv[2];
assert(path, "pass a settings JSON path");
const settings = JSON.parse(readFileSync(path, "utf8"));
const config = settings.jevRouting;
assert(config && typeof config === "object" && !Array.isArray(config), "jevRouting object is required");
assert.equal(config.schemaVersion, 1, "schemaVersion must be 1");
assert.equal(typeof config.enabled, "boolean", "enabled must be boolean");
assert(config.hermes && typeof config.hermes === "object", "hermes object is required");
assert.equal(typeof config.hermes.home, "string", "hermes.home must be a string");
assert(!config.hermes.home.startsWith("/Users/"), "example must not contain a machine-specific home path");
assert(config.router && typeof config.router === "object", "router object is required");
assert.equal(typeof config.router.minConfidence, "number", "minConfidence must be numeric");
assert(config.router.minConfidence >= 0 && config.router.minConfidence <= 1, "minConfidence must be between zero and one");
assert(config.router.tiers && typeof config.router.tiers === "object", "tiers object is required");
for (const [name, tier] of Object.entries(config.router.tiers)) {
  assert(tier && typeof tier === "object", `${name} must be an object`);
  for (const field of ["provider", "hermesModel", "model"]) {
    assert.equal(typeof tier[field], "string", `${name}.${field} must be a string`);
    assert(tier[field].trim(), `${name}.${field} must not be empty`);
  }
}
assert(config.behavior && typeof config.behavior === "object", "behavior object is required");
for (const field of ["preserveManualModelChoice", "routeCommanderPlans"]) {
  assert.equal(typeof config.behavior[field], "boolean", `${field} must be boolean`);
}
console.log("settings schema valid");
