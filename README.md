# claude-mods

Bilal's collection of Claude Code mods. Each mod lives in its own folder under
`plugins/`, and this repository is a plugin marketplace listing all of them in
`.claude-plugin/marketplace.json`.

## Mods

| Mod | What it does |
| --- | --- |
| `limit-hint` | Shows your 5-hour usage limit: a full-width progress bar above the prompt and a short figure in the footer on the desktop app, and the hint line in the terminal. |
| `model-hint` | Suggests a model and effort for the prompt you're writing, judged by word rules or by Haiku (a small request per new prompt), adjusted for your usage limits and how full the context is. Shown on the desktop app in a "Model hints" band above the limit band, with an animated pixel Claude whose mood follows the band, and a Use button that warns before a switch that would re-read a long chat. |

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install limit-hint --marketplace bilalmkhalil/claude-mods
/plugin install model-hint --marketplace bilalmkhalil/claude-mods
```

From a shell:

```
claude plugin install limit-hint --marketplace bilalmkhalil/claude-mods
claude plugin install model-hint --marketplace bilalmkhalil/claude-mods
```

Answer `y` to add the marketplace, then choose the user scope.

## Adding a mod

1. Put the mod's folder in `plugins/<mod-name>/`.
2. Add an entry for it to `.claude-plugin/marketplace.json`.
