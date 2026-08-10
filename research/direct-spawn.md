# Research: non-interactive output formats of the direct-spawn harness candidates

Pathfinder map 27, ticket 35. Sources: project READMEs + docs fetched live (qwen-code, kimi/kimi-code, crush, zerostack, codebuff), previous research (research/harness-inventory, research/acp-coverage), provider files for identities.

## Verdict first: three candidates are reclassified — they speak ACP, not direct spawn

| Harness | Evidence | New mechanism |
| --- | --- | --- |
| qwen (qwen-code) | `qwen serve` = ACP daemon over HTTP+SSE (official docs); ALSO headless `qwen -p` | **ACP** (fallback tiers); direct `-p` as a contract if needed |
| kimi | `kimi acp` = ACP server over stdio (official README) | **ACP** |
| kimi-code | `kimi acp` — "Kimi Code CLI speaks the Agent Client Protocol" (official README) | **ACP** |

This updates the ACP coverage matrix (ticket 29): confirmed ACP speakers now include **qwen, kimi, kimi-code**. Remaining unverified ACP: claude, codex, roo-code, devin.

## Direct-spawn candidates with a verifiable non-interactive contract

| Harness | Binary | Non-interactive mode | Output format | Resume | Token usage | Confidence |
| --- | --- | --- | --- | --- | --- | --- |
| qwen | qwen | `qwen -p "..."` (headless, for CI/scripts) | plain text (structured unknown) | session mgmt yes | unknown | high |
| copilot CLI | github-copilot / gh copilot | `gh copilot suggest "..."` | plain text | no | no | high |
| zerostack | zerostack (Rust) | TUI-first; `-p`-style flag unverified | unknown | save/load/resume yes | no | medium |

## Direct-spawn candidates — unverified (verify before writing a driver)

| Harness | Notes |
| --- | --- |
| droid (factory) | readme not public; unknown |
| zcode (z.ai) | CLI v0.14.x exists (provider file); non-interactive mode unknown |
| codebuff | repo/docs not surfaced; unknown |
| crush (charmbracelet) | TUI, session-based; non-interactive flag unverified |
| hermes agent | unknown |
| openclaw | unknown |
| lingtai-tui | TUI agent; unknown |
| mistral-vibe | unknown |
| forge | unknown |
| mux | identity unverified |
| open-design | unknown |
| codewhale | unknown |

## Conclusion for the generic direct driver (Adapter strategy decision)

- The realistic direct-spawn set with a verifiable contract today is small: **qwen `-p` (if not routed via ACP), copilot-cli `suggest`, zerostack**. Most others need a per-CLI verification pass during the build phase before a driver is written.
- Observed output contracts are **plain text**; no JSON/JSONL surfaced in this pass. The generic driver should therefore model the output contract as a per-harness spec field (`text` | `json` | `jsonl`), defaulting to `text`, and the direct descriptor's command template declares the non-interactive flags.
- Build-phase rule: a direct driver is only written for a harness whose non-interactive mode and output contract have been verified on a real CLI; unverified candidates stay listed-but-not-drivable.
