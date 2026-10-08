# fast-overview

A Claude Code plugin that shows a short overview card above the prompt while Claude is still working on its answer. It only does this for conversational turns: explaining a concept, walking through your codebase, or weighing a trade-off.

```
⚡ Quick overview  codebase · Cerebras · 0.6s · Claude is still answering
  In short: omp is a Bun/TypeScript coding-agent CLI with a Rust core…
  • packages/coding-agent – the main CLI app
  • packages/natives – N-API bindings into the crates/pi-* Rust core
  Watch for: how the TS layer hands work to Rust
```

1. **A classifier decides.** A decision model (Jev, d1, Clef or GPT-6 Luna Decisions) estimates whether you're asking to understand something and will read a long answer. Tasks ("fix X", "commit") never get a card.
2. **A fast model writes the card.** Qwen3.8-27B on Cerebras, Groq or OpenRouter writes a one-line framing, the key ideas, an optional diagram, and the crux to watch for.
3. **The card is grounded in your repository.** It sees a map of the directories by size; the opening of `README.md`, `AGENTS.md`, `CLAUDE.md` and the manifests; the list of documentation pages; and `rg` matches for identifiers named in the prompt.

The card usually appears within a second, while Claude is still thinking.

## Install

```
/plugin install fast-overview --marketplace counterposition/fast-overview
```

Paste **one API key** when asked. An [OpenRouter](https://openrouter.ai/keys) key alone is enough: it reaches the overview model and every classifier. Leave the other key fields empty unless you have those keys.

Requires Claude Code 2.1.292 or later. Plugins built from function hooks are an early-access API that may change between releases. Some earlier builds only loaded them with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`.

## Keys and speed

Every key is optional on its own; you need at least one that can write cards (OpenRouter, Cerebras or Groq). Direct keys skip OpenRouter's hop.

| Key | Used for | Measured |
|---|---|---|
| OpenRouter | Cards, routed to Cerebras; any classifier | Card about 400 ms, classifier about 200–350 ms |
| Cerebras | Cards, direct | About 350 ms |
| Groq | Cards, direct | About 1.2 s; the free tier allows about 3 cards a minute |
| TypeSafe | Jev classifier, direct | About 140 ms |
| Liquid AI | d1 classifier, direct | About 250 ms |
| OpenAI | GPT-6 Luna Decisions classifier, direct | About 150–190 ms once warm |

Cards were timed on a 2.2k-token prompt; times exclude the one-off repository snapshot taken at session start. With no decision-model key, the overview model classifies the prompt itself.

You can also set keys as environment variables: `OPENROUTER_API_KEY`, `CEREBRAS_API_KEY`, `GROQ_API_KEY`, `TYPESAFE_API_KEY`, `LIQUID_API_KEY` or `OPENAI_API_KEY`.

## Use

- `/overview` shows the mode, the card provider and the classifier. `/overview auto | always | off` changes the mode.
- `/plugin` → Installed → fast-overview → **Configure options** changes everything else: keys, provider, model, classifier, project sharing and logging.
- When Claude finishes, the card collapses to one row: **show** expands it again, **helpful** / **not helpful** rate it, **dismiss** removes it. Click the buttons; in the terminal, ctrl+x tab also lets you use their hotkeys.

## Privacy

For prompts that qualify, the card provider receives your prompt, the recent conversation and, unless you turn off **Share project context**, the repository snapshot (file paths and the openings of the key files). For every prompt that isn't a slash command or one word, the classifier receives the prompt and a short excerpt of the conversation. If you use OpenRouter, it sees the same and passes it on. Check each provider's data-retention policy.

By default the plugin keeps only your ratings, with the classifier's verdict and timings: no prompts, cards or answers. Set logging to **full** to also keep those, or **off** to keep nothing (cards then offer no rating). Logs go to `~/.local/state/fast-overview/`, or `$FAST_OVERVIEW_LOG_DIR`.

## License

[MIT](LICENSE)

## Develop

```sh
claude --plugin-dir .          # load from this folder; keys can live in ./.env
claude plugin validate --strict .
claude plugin test .
```
