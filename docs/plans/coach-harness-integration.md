# Piano: migliorare Coach & Skills e integrazione harness (lezioni da t3code)

> Solo piano, nessuna implementazione. Confronto Watchtower vs [pingdotgg/t3code](https://github.com/pingdotgg/t3code) (`main` al 23/09/2026) e proposte concrete d'evoluzione.

## 1. Obiettivo

Rendere il consumo delle harness in Coach & Skills più **fluido**: meno click, meno cold-start, meno stati bugiardi (picker popolato ma run KO), cancel/resume robusti, auth chiara per ogni harness, picker che non propone harness rotte.

Vincoli esistenti (non negoziabili in questo piano):

- ADR 0012: local-first, niente API key, auth = login proprio della CLI host, `scrubEnv` di default.
- ADR 0016/0018: registry data-driven, una spec per harness, seam tipato sul package reale (`ai` v6 + `@mcpc-tech/acp-ai-provider`), handshake progressivo per modelli/mode.
- ADR 0017/0021: una sola superficie chat, un solo agent con due scope (coaching + skill authoring).
- ADR 0019/0020/0025/0026/0027: ledger MCP in-app, fallback HTTP/sidecar pooled per harness che rifiutano stdio.

## 2. Come funziona oggi Watchtower (sintesi ispezione)

Percorso run attuale:

```
features/coach-skills (store zustand + conversation/thread/blocks/harness-model-picker)
 → preload → ipcMain coach:* → createCoachRunner → HarnessRuntime
 → loadHarnessSdk() (dynamic import ai + acp-ai-provider)
 → createACPProvider({command, args, env scrubbed, session:{cwd, mcpServers}, existingSessionId?})
 → initSession() → session CoachEvent {sessionId, models?, modes?}
 → streamText({model: provider.languageModel(modelId, modeId), prompt})
 → deriveCoachEvents → coach:event → renderer bubbles
 → finally provider.cleanup() // ogni run killa il child
```

Punti chiave:

- `src/main/agents/harnesses/types.ts`: `HarnessSpec {kind, displayName, commands[], bundled?, requires?, scrubEnv[], clientMcpTransport?, preference?, adapter: AcpAdapter|DirectAdapter}`. 14 spec (`claude, codex, opencode, grok, gemini, goose, qwen, kimi, copilot, cline, kilo-code, cursor, droid, pi`).
- `detect.ts`: probe `which()` su PATH (+ `.exe/.cmd/.bat` su win32), fallback `bundled`, gate `requires`. `pickPreferredHarness`: primo `configured`, altrimenti primo in `preference`.
- `auth-probe.ts`: solo `claude` (`claude auth status --json`, timeout 5s). Tutte le altre harness restano `unknown`.
- `runtime.ts`: `run()` + `inspect()`. Resume fragile: se resume expendable (probe) fallisce → retry fresh; resume conversazionale strict. Routing model/mode molto branchato: legacy `models/modes` vs `configOptions` vs `thought_level/reasoning_effort`, caso speciale Codex `gpt-5.6-luna[low]` → decompose base+effort, `pi` solo config, `minimal resume` che indovina `model/mode/thought_level`.
- `ipc.ts` runner: validazione prompt, `detect()` a ogni run, attach ledger MCP (null silenzioso se no `ledger.db`), briefing solo al primo run (`!sessionId`), workspace `mkdtemp(watchtower-coach-)` riusato per conversazione, `cancel` via `gen.return()`, `reset` con `rmSync` retry win32. `inspect` con coalescing single-slot.
- Renderer: `harness-model-picker.tsx` stile rail icone + lista searchable, lazy `onInspect(kind)` su open/hover, cache `modelsByKind`, riga sintetica `Model: default`. Store con `modelsByKind: Record<kind, ...>`, un solo `activeRunId`, `running` blocca send, retry solo ultimo assistant, merge tool fragile (`first-started FIFO` se manca `id`), preview 400ch.

Frizioni osservate:

1. Handshake bugiardo: `initSession` riporta modelli senza autenticare → picker pieno, run KO. Solo Claude ha `authProbe`.
2. Costo probe: ogni harness non-cached = spawn ACP. Browsing della rail = N spawn. `Loading models…` + cold-start.
3. Routing model/mode iper-branchato e fragile a ogni cambio catalogo upstream.
4. Briefing solo su `!sessionId`: cambio scope mid-conversation perso; fresh-install senza MCP silenzioso.
5. Chiave = `kind` (stringa tool): niente multi-istanza (es. `codex_personal` + `codex_work`), niente `CODEX_HOME` separati.
6. Sessioni non persistenti: ogni run spawna e killa; resume = `existingSessionId` + persistenza on-disk dell'agent, non sempre affidabile.
7. Cancel a una fase (`gen.return()`), `pendingEvents={}` resettato a ogni run → possibili late-event persi.
8. Tool merge senza `id` → FIFO; `reasoning` dual `delta/text`; catalogo stale se `session` senza `models/modes`.
9. Workspace temp invisibile, switch harness = new conversation obbligata e distruttiva.
10. `ClaudeAuthHint` solo per Claude; icone `goose/kilo-code/futuri → Bot`; `inspect fail → pickers absent` senza errore visibile.

## 3. Come fa t3code (sintesi ispezione)

t3code non è un agent, è una **control-surface sopra CLI già installate**. Ownership netta (`docs/internals/overview.md`): processi, terminali, Git, file appartengono al **server** (`apps/server`, Node 24 + Effect-TS); client (web/desktop/mobile) parla solo via **RPC versionato** (`packages/contracts/src/rpc.ts`). Engine serializza comandi, `decider.ts` puro senza I/O, `projector.ts` proietta, reactors fanno side-effect.

Pattern rilevanti (file reali su `main`):

- **Driver SPI, non registry statico** — `apps/server/src/provider/ProviderDriver.ts`: `interface ProviderDriver<Config> { driverKind, metadata, configSchema, defaultConfig, create(input:{instanceId, displayName, environment, enabled, config}) => Effect<ProviderInstance> }`. `builtInDrivers.ts` ne lista 6 (`Codex, Claude, Cursor, Grok, OpenCode, Antigravity`). `ProviderInstanceRegistry` = `Map<instanceId, Instance>` in scope proprio: chiudere scope = kill child + fibre + watcher. Due istanze stesso driver (personal/work) = `CODEX_HOME` diversi, zero stato condiviso.
- **Snapshot managed con probe sicura** — `makeManagedServerProvider.ts`: `pending → checkProvider (probe reale con timeout, mai throw) → enrichSnapshot (version advisory + maintenance) → streamChanges (SubscriptionRef/Stream per UI live)`. Wire `ServerProvider {instanceId, driver, enabled, installed, version, status: ready|warning|error|disabled, auth:{status,email,label,type}, models[], skills[], slashCommands[], usageLimits, continuation:{groupKey}, workspaceSnapshots[]}`.
- **Probe che non fa setup** — esplicito in `docs/internals/providers.md`: "Setup must not happen as health-check side effect". Claude: `claude --version` + `query({prompt: never-yield})` leggendo solo `initializationResult()` poi `abort()`, con `disableAllHooks, strictMcpConfig, mcpServers:{}`. Codex: short-lived `codex app-server` + `initialize {clientInfo}` poi parallelo `account/read + model/list (paginato) + skills/list + rateLimits (timeout 3s, enrichment-only)`. Cursor/Grok/Antigravity via ACP: solo `initialize`, mai auth/session nel probe. OpenCode: `--version` + inventory via server owned, solo modelli `connected`.
- **Trasporto eterogeneo dietro adapter unico** — `Services/ProviderAdapter.ts`: `startSession/sendTurn/interruptTurn/stopSession/listSessions/readThread/rollbackThread/streamEvents`. Claude via `@anthropic-ai/claude-agent-sdk`, Codex via client `codex app-server` tipato, Cursor/Grok/Antigravity via `effect-acp/client`, OpenCode via `@opencode-ai/sdk` HTTP verso server owned (un server per thread). `AcpSessionRuntime.ts` è il riferimento: `spawn → stderr drain → initialize → authenticate → new|load|resume → prompt (semaforo + fiber) → cancel (Fiber.interrupt + agent.cancel + drain barrier) → Stream.fromQueue(eventQueue)` con `ToolCallUpdated` coalesced.
- **Modelli/mode come capability descriptors** — `model-manifest.json` bundled + fetch, `optionDescriptors[] (reasoningEffort, serviceTier, variant, agent, fastMode…)` con `isDefault/currentValue`. `RuntimeMode: approval-required|auto-accept-edits|auto|full-access` + `interactionMode: default|plan`. ACP: `set_config_option(mode/model)`. Custom models con fallback capabilities.
- **Chiave = `instanceId`, mai `driverKind`** — `resolveSelectableProviderInstanceEntry(storedId)`: esatto se enabled+available, else `ready → non-error`, mai errored come default new-user. Cambio istanza resetta modello al default di quella istanza. `lockedProvider` / `lockedContinuationGroupKey` per edit/thread esistenti.
- **Resume cursor opaco versionato** — `resumeCursor: unknown` con `CURSOR_RESUME_VERSION=1`, decode tollerante → `undefined = no resume`, mai errore.
- **Cancel a due fasi** — signal + drain barrier (`session/cancel` + interrupt fiber + `drainEvents` prima di settle turno). Rollback rifiutato pre-filesystem se `supportsConversationRollback=false`.
- **MCP/thread-scoped** — al `session/new|load`: `mcpServers[], additionalDirectories[]`. `snapshotForCwd(cwd)`: catalogo macchina + inventario workspace separati, cache 16 cwd, timeout 10–20s con fallback.
- **UX: wizard + picker onesto** — `WelcomeWizard` (skip se workspace esiste): 1) target env preselezionato, 2) `providerReadiness` solo `claude/codex` (altri in Settings) con stati `checking|install|signIn|attention|ready|disabled` e bottone che apre **terminale con comando già pronto** usando `binaryPath` dell'istanza, 3) import progetti da history Claude/Codex (Git prima, default `git + attivi 30gg + ≥3 conv`, best-effort 100 file/64MiB). `ModelPicker`: sidebar per istanza, search fuzzy, favorites, virtualized list, riga `isUnavailable`, CTA inline `Setup` se non installato/unauth/zero modelli, trigger che conserva label + badge `Unavailable`.

## 4. Tabella comparativa

| Dimensione | Watchtower oggi | t3code | Giudizio |
|---|---|---|---|
| Registry | 14 spec statiche, chiave `kind: string`, un'istanza per tool | Driver SPI + `configSchema`, chiave `instanceId`, N istanze per driver in scope separati | t3code superiore; Watchtower non modella personal/work, `CODEX_HOME` separati, profili Antigravity |
| Discovery/probe | `which()` PATH + bundled fallback a ogni `detect()`/`inspect()`; spawn ACP per probe; solo Claude ha auth-probe | `pending → probe con timeout → enrich → stream`; probe mai con side-effect (no MCP/hooks/login); una probe per istanza, UI live via subscription | t3code superiore: elimina handshake bugiardi e spawn a raffica |
| Auth | `unknown` per 13/14 harness; hint solo Claude; passthrough via env ereditato poco scopribile | `auth:{status,email,label,type}` per istanza + `ProviderAuthFlow` dedicato, installer con lease atomiche, shadow home, terminale precompilato | t3code superiore |
| Modelli/mode | Branching `legacy/config/thought_level` + casi speciali (Codex bracketed); `minimal resume` che indovina | `optionDescriptors[]` uniformi + `RuntimeMode`; ACP sempre `set_config_option` | t3code superiore per manutenibilità; Watchtower più fedele al wire instabile ma fragile |
| Sessioni | Spawn-per-run + `cleanup()` in `finally`; resume via `existingSessionId` on-disk | Sessioni persistenti owned dal server, `resumeCursor` opaco versionato, rollback esplicito | t3code superiore per fluidità; Watchtower più semplice e più privacy-safe (niente long-lived) — tradeoff da decidere |
| Streaming/eventi | `deriveCoachEvents` da `fullStream` AI SDK, merge tool FIFO se manca `id` | Adapter normalizza a eventi canonici (`streamEvents`), `ToolCallUpdated` coalesced, un solo formato per UI/log/event-store | t3code superiore |
| Cancel | `gen.return()` una fase, fire-forget | signal + drain barrier, cancel nativo per driver | t3code superiore |
| MCP attach | ledger MCP stdio di default, HTTP sidecar pooled solo per spec `clientMcpTransport:'http'`; briefing solo primo run | MCP thread-scoped a `session/new\|load` + `snapshotForCwd`; probe con `mcpServers:{}` | t3code superiore per isolamento; Watchtower ha già il pool app-scoped (ADR 0027) da riusare |
| Picker UX | Rail + lista searchable, lazy inspect su open/hover, `Model: default` sintetico; auto-select primo harness | Sidebar per istanza, fuzzy+favorites+virtualized, CTA `Setup` inline, mai default errored, reset modello su cambio istanza | t3code superiore; la rail Watchtower è già vicina, mancano stati onesti e CTA |
| Onboarding | `ConversationWelcome` + chips + nota no-harness | `WelcomeWizard` 3 step + import history + terminale precompilato | t3code superiore per first-run |
| Tipizzazione boundary | Seam = tipi reali del package (`ACPProviderSettings`), cast solo su `fullStream` | Contracts versionati + client ACP/Codex generati da schema | Pari intento; t3code più spinto sul boundary versionato |

Cosa tenere di Watchtower (non copiare alla cieca):

- Spawn-per-run è una scelta privacy coerente (ADR 0012): nessun long-lived agent oltre il run. t3code tiene server/thread persistenti — più fluido ma più superficie.
- Ledger MCP read-only con `scope` arg + briefing dual-scope è già un buon grounding; t3code non ha questo pezzo.
- Tipizzare `acpConfig` come slice statico di `ACPProviderSettings` evita drift — tenere.

## 5. Piano di miglioramento (evolutivo, non rewrite)

Principio: **non cambiare SDK né protocollo** (restano `ai` v6 + ACP). Si introduce un layer "managed instance" sopra il registry esistente, si rendono oneste probe/auth/picker, si semplifica il routing model/mode, si robustano cancel/resume/eventi. Ogni fase è shippabile da sola.

### Fase 0 — Chiave `instanceId` + snapshot managed (fondazione)

- Introdurre `HarnessInstance {instanceId, kind, displayName, enabled, status: pending|ready|warning|error|disabled, auth:{status, label?}, version?, modelsCount?}` derivato da spec + detect, con `instanceId = kind` per default (retrocompatibile: il renderer continua a funzionare).
- Sostituire `detect()` a ogni run con un `HarnessSnapshotStore` nel main: una probe per istanza all'avvio + su `PATH` change + refresh manuale; broadcast `coach:harnesses-changed` invece di `invoke` a ogni keystroke. `coach:run` non fa più `detect()` sincrono, legge lo snapshot.
- Accettazione: aprire/chiudere la sezione non spawna processi;的時間 `coach:harnesses` risponde da cache <50ms; log operativo mostra una sola probe per istanza all'avvio.

### Fase 1 — Probe oneste, senza side-effect

- Regola: **health-check ≠ setup**. La probe fa solo `initialize` ACP (mai `authenticate`/`session/new`, mai MCP nostri, mai hooks) con timeout 5–8s, mai throw: ritorna `warning/error` con messaggio azionabile + `binaryPath` reale.
- Per Claude tenere `auth status --json`; aggiungere probe leggere dove l'upstreams lo consente senza login (versione CLI / `initialize` ACP); per le altre restare `unknown → attention` invece di fingere `ready`.
- Il picker non propone mai come default una istanza `error`; propone `ready → attention/unknown → mai error`. Riga con badge `Unavailable` + tooltip, come t3code.
- Accettazione: harness non loggata non appare più "pronta"; nessun browser/login si apre durante la probe.

### Fase 2 — Auth flow per harness (non solo Claude)

- Estendere `auth:{status: configured|unknown|error, label?, hintCommand?}` a ogni spec: comando di login canonico per harness (es. `claude auth login`, `codex login`, …) + `binaryPath` risolto.
- UI: pill contestuale per harness corrente (generalizzare `ClaudeAuthHint`), con comando copiabile e — dove sicuro — bottone "apri terminale con comando pronto" (pattern t3code). Toggle passthrough resta in Settings, ma la probe invalida la warm session con messaggio esplicito invece di fallback silenzioso.
- Accettazione: ogni harness `error/unknown` mostra cosa fare in 1 click; niente hint hardcoded solo-Claude.

### Fase 3 — Semplificare routing model/mode (capability descriptors)

- Introdurre `ModelDescriptor {id, label, group?}` + `ModeDescriptor {id, label}` normalizzati nel main subito dopo `initSession()`, invece di portare `configOptions` grezze fino al renderer e branchare in `runtime.ts`.
- Regole di mapping centralizzate in un solo modulo `model-routing.ts` con tabella per harness (Codex bracketed `base[effort]`, `pi` config-only, `opencode` config-only, Claude misto) + test a tabella. `applyModel/ModeSelection` diventano 2 funzioni totali: `resolveModel(spec, catalog, pick)`, `resolveMode(...)`; il caso `minimal resume` prova in ordine `model → mode → thought_level` e ritorna `undefined` invece di indovinare.
- Accettazione: aggiungere una nuova harness = aggiungere una riga di tabella + test, non un nuovo branch in 3 punti; suite `model-routing.test.ts` con casi Codex/Claude/pi/opencode/minimal.

### Fase 4 — Eventi canonici + cancel a due fasi

- Definire `CoachCanonicalEvent` (text-delta, reasoning, tool-started/updated/completed, session, done, error) già nel main; `deriveCoachEvents` mappa una sola volta, il renderer non fa più merge FIFO: ogni tool ha `id` stabile (generato se l'upstream non lo dà), update coalesced.
- Cancel: `session/cancel` (dove l'ACP provider lo espone) + `iterator.return()` + barrier di drain di ~1s prima di settle; `pendingEvents` keyed per `runId` e non più resettato globalmente; late-event dopo cancel marcati `cancelled`, non persi.
- Accettazione: doppio cancel ravvicinato non lascia child appesi (verifica su win32: nessun `EPERM` su reset); interleave di 2 tool non mischia più le card.

### Fase 5 — Resume opaco + sessioni senza bugie

- Scelta consigliata (evolutiva): **restare spawn-per-run** (privacy), ma introdurre `resumeCursor: {v:1, kind, sessionId}` opaco e validato con zod; decode fallito → fresh session, mai errore. Rimuovere `resumeIsExpendable`/probe-warm-session: la probe non produce più `sessionId` riusabile (era la fonte di resume fragili).
- Facoltativo (se la fluidità resta insufficiente): sessione persistente per conversazione attiva (un child per `conversationId`, kill su `reset`/cambio harness/quit). Solo dopo metriche: se p95 handshake >2s, rivalutare. In ogni caso il resume resta opaco/versionato.
- Accettazione: riaprire la app non corrompe mai il thread; sessione stale → fresh con notice, mai eccezione.

### Fase 6 — Picker e composer più fluidi (pattern t3code, stesso stack)

- Picker: tenere la rail, aggiungere (a) sezione per istanza quando `instanceId != kind` (oggi 1:1, predisporre), (b) search fuzzy + riga `isUnavailable` + CTA inline `Setup` che apre hint auth, (c) cambio istanza → reset modello al default di quella istanza (no coppie cross-harness), (d) trigger che conserva label anche a catalogo assente + badge.
- Composer: `TraitsPicker` leggero solo per harness che espongono `optionDescriptors` (reasoning effort, tier, variant) invece di infilarli nei nomi modello bracketed; limite invio come `composerSubmission` (120k char) con messaggio chiaro.
- Welcome: restare su `ConversationWelcome`, aggiungere step "pronto all'uso" solo se zero harness `ready`: lista con stato + comando copiabile (mini-wizard, non full `WelcomeWizard` t3code che qui sarebbe sovradimensionato).
- Accettazione: da zero harness a primo run riuscito in ≤3 click guidati; mai default su harness rotta.

### Fase 7 — MCP attach e briefing più robusti

- Probe sempre con zero nostri MCP (già vero per Claude, estendere a tutti); run con ledger MCP thread-scoped a `session/new` (concettualmente: passare `mcpServers` solo al run, mai alla probe).
- Briefing: oltre al primo run, re-inviare un mini-briefing quando lo `scope` cambia mid-conversation (oggi perso) e quando il run parte senza MCP (fresh-install): invece di silenzio, una notice "senza dati ledger — la risposta sarà generica".
- Accettazione: cambio periodo a conversazione avviata → l'agent riceve il nuovo window label; fresh-install → l'utente capisce perché.

## 6. Cambio di approccio: sì o no?

**No al rewrite "alla t3code".** Il modello t3code (Effect-TS, server owned con thread persistenti, RPC versionato, driver multistanza, catalog manifest) è superiore per un prodotto multi-client, ma per Watchtower (Electron single-user, local-first, privacy stretta) sarebbe sovradimensionato e aprirebbe superficie long-lived contro ADR 0012.

**Sì a un cambio di approccio mirato**, in 3 punti:

1. **Da "registry statico + probe a ogni uso" a "istanze managed con snapshot live"** (Fasi 0–1). È il cambio più redditizio: elimina spawn a raffica, stati bugiardi, picker che mente.
2. **Da "chiave kind" a "chiave instanceId"** (Fase 0, default `instanceId=kind`). Abilita personal/work, `CODEX_HOME` separati, profili — senza rompere nulla oggi.
3. **Da "branching model/mode sparso" a "capability descriptors normalizzati"** (Fase 3) + **eventi canonici** (Fase 4). Riduce il costo di ogni nuova harness da "patch in 3 file" a "riga di tabella + test".

Cosa NON copiare: thread/server persistenti di default, Effect-TS, manifest modelli bundled con fetch, import history progetti, `WelcomeWizard` completo. Rivalutare solo se le metriche (p95 handshake, tasso run-KO su picker popolato) restano rosse dopo Fasi 0–4.

## 7. Ordine di build consigliato e verifiche

1. Fase 0 (snapshot + instanceId) → `npm run typecheck && npm test`; smoke: sezione coach senza spawn, `coach:harnesses` <50ms.
2. Fase 1 (probe oneste) → test a tabella `detect/probe` con timeout/mock binari; smoke: harness sloggata = `attention`, mai `ready`.
3. Fase 3 (model-routing) → `model-routing.test.ts`; smoke su claude/codex/pi/opencode reali.
4. Fase 4 (eventi + cancel) → test merge tool interleave + doppio cancel; smoke win32 reset senza `EPERM`.
5. Fase 2 (auth UI) + Fase 6 (picker/composer) → smoke first-run ≤3 click.
6. Fase 5 (resume opaco) + Fase 7 (briefing/scope) → smoke cambio scope mid-conversation + restart app.

## 8. Rischi e non-obiettivi

- ACP `models`/`modes` restano UNSTABLE: i descriptors devono degradare a "nessun picker" senza errori.
- Win32: `cmd.exe /c` richiede args token-only; ogni nuova probe deve rispettarlo + `assertRealWorkspacePath`.
- `bundledEntry` dipende da `node_modules` sopravvissuto al packaging: le probe non devono assumere bundled disponibile in prod.
- Telemetry run resta zero da ACP (protocollo ritorna 0): costi sempre dal parse session-file, non dal seam.
- Non in scope: multi-run paralleli, rollback thread, server HTTP esterno, login automatico, scrittura skill su disco senza conferma utente.

## 9. Fonti

- Watchtower: `src/main/agents/{runtime,ipc,events,detect,auth-probe,prompts}.ts`, `src/main/agents/harnesses/*`, `src/main/agents/ledger-mcp/*`, `src/shared/schemas/agents.ts`, `src/renderer/src/features/coach-skills/*`, ADR 0016–0022, 0025–0027, `docs/architecture.md`.
- t3code (`main` 23/09/2026): `docs/internals/overview.md`, `docs/internals/providers.md`, `packages/contracts/src/rpc.ts`, `packages/contracts/src/providerInstance.ts`, `apps/server/src/provider/{ProviderDriver,builtInDrivers,makeManagedServerProvider}.ts`, `apps/server/src/provider/Layers/{ClaudeProvider,CodexProvider,CursorProvider,OpenCodeProvider,GrokProvider}.ts`, `apps/server/src/provider/acp/AcpSessionRuntime.ts`, `apps/server/src/orchestration/{decider,projector}.ts`, `apps/server/src/provider/{ModelManifest,ProviderAuthFlow,model-manifest.json}`, `components/onboarding/WelcomeWizard.tsx`, `ProviderModelPicker.tsx`, `composerProviderState.tsx`.
