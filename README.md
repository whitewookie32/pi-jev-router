# Pi JEV Router

A Pi extension that asks the existing Hermes JEV router to classify each original user turn, then applies the approved tier by selecting a configured Pi provider/model.

The extension never receives or stores JEV credentials. Its Python bridge returns only secret-free decision metadata and fails open: an invalid setting, unavailable model, unauthenticated provider, bridge error, or low-confidence decision leaves Pi's current model unchanged.

## Requirements

- Pi `>=0.85.1 <0.86.0`
- A local Hermes Agent checkout. By default the extension expects:
  - Hermes home: `~/.hermes`
  - source checkout: `~/.hermes/hermes-agent`
  - launcher: `~/.hermes/hermes-agent/.hermes/bin/hermes`
- Hermes JEV routing configured and enabled.
- Pi authenticated for every provider/model selected in the routing settings.

## Install

Install the package from Git:

```bash
pi install git:github.com/whitewookie32/pi-jev-router@main
```

Then merge the `jevRouting` object from [`settings.example.json`](settings.example.json) into Pi's global app settings at `~/.pi/agent/settings.json` and restart Pi.

Pi's documented settings file owns package installation and normal app preferences. `jevRouting` is this extension's namespaced app setting. Pi preserves unknown top-level settings, and the extension reads only that object.

## Choose providers and models

Each routing tier explicitly selects the Pi provider and model that should be used when Hermes returns that tier:

```json
{
  "jevRouting": {
    "router": {
      "tiers": {
        "luna": {
          "provider": "openai-codex",
          "hermesModel": "gpt-5.6-luna",
          "model": "gpt-5.6-luna"
        },
        "sol": {
          "provider": "openai-codex",
          "hermesModel": "gpt-5.6-terra-900k",
          "model": "gpt-5.6-terra"
        }
      }
    }
  }
}
```

- `provider` and `model` must identify a model currently registered and authenticated in Pi.
- `hermesModel` must exactly match the model returned by Hermes for that tier. This guard prevents an unexpected JEV decision from selecting an unintended Pi model.
- The sample deliberately maps Hermes's `gpt-5.6-terra-900k` to Pi's catalog ID `gpt-5.6-terra`; preserve that distinction unless the Hermes routing configuration changes.
- `minConfidence` is an additional Pi-side guard. Hermes maintains its own JEV configuration and thresholds.

Optional overrides in `jevRouting.hermes` are `source` and `launcher`; use them only when the default local Hermes layout does not apply.

## Controls

- `/jev-routing status` — show whether automatic routing is active.
- `/jev-routing auto` — resume routing after a manual model selection.
- `/jev-routing off` — pause automatic routing for the session.

When `preserveManualModelChoice` is `true`, selecting a model manually in Pi pauses automatic routing for the current session. JEV `delegate` and `kanban` labels do not trigger those operations in Pi; they affect only the configured model-tier decision.

## Compatibility

For backward compatibility, the extension falls back to `~/.pi/agent/jev-routing.json` only when the primary `jevRouting` app setting is absent. The namespaced app setting always wins, including when it is explicitly disabled.

## Verify

```bash
npm run test:settings
npx tsc -p tsconfig.json
```

For a live check, start Pi with an authenticated configured provider and submit a normal prompt. The footer will show `JEV <route>/<tier>` when a model is selected.
