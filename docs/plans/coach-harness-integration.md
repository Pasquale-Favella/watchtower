# Piano: migliorare Coach & Skills e integrazione harness

> Solo piano, nessuna implementazione. Valutazione dell'architettura attuale e proposte concrete d'evoluzione.

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

## 3. Principi architetturali per l'evoluzione

- **Lifecycle esplicito** — raggruppare stato, processi e probe per `instanceId`; chiudere o interrompere un'istanza deve rilasciare le sue risorse.
- **Probe senza setup** — una verifica di salute non deve avviare login, MCP o sessioni conversazionali; deve avere un timeout e produrre uno stato leggibile.
- **Stato osservabile** — rappresentare `pending`, `ready`, `warning`, `error` e `disabled` senza trasformare l'assenza di verifica in uno stato `ready`.
- **Capability normalizzate** — convertire modelli e modalità in descrittori condivisi prima di passarli alla UI, mantenendo gli adattamenti specifici per harness nel main process.
- **Eventi e cancellazione deterministici** — assegnare ID stabili agli eventi e attendere un drain breve prima di chiudere un run cancellato.
- **Privacy prima della persistenza** — mantenere spawn-per-run; valutare processi persistenti solo dopo metriche e una decisione esplicita rispetto all'ADR 0012.

## 4. Stato e direzione

| Area             | Stato attuale                                                                         | Direzione proposta                                                                      |
| ---------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Registry         | 14 spec statiche, chiave `kind`, una istanza per tool                                 | Introdurre `instanceId`, retrocompatibile con `instanceId = kind`                       |
| Discovery/probe  | `which()` + fallback bundled; ACP probe all'apertura; auth verificata solo per Claude | Snapshot gestito, timeout per probe, stato visibile e refresh esplicito                 |
| Auth             | `unknown` per la maggior parte degli harness; hint solo Claude                        | Stato e comando d'accesso dichiarati per harness, senza setup automatico                |
| Modelli/mode     | Branching tra `models/modes`, `configOptions` e casi specifici                        | Descrittori capability normalizzati e mapping concentrato in `model-routing.ts`         |
| Sessioni         | Spawn-per-run; resume tramite `existingSessionId` persistito dal CLI                  | Cursor opaco/versionato; mantenere spawn-per-run salvo metriche che giustifichino altro |
| Streaming/eventi | `deriveCoachEvents` da AI SDK; merge FIFO quando manca `id`                           | Eventi canonici nel main e identificatori stabili per i tool                            |
| Cancel           | `gen.return()` senza barriera di drain                                                | Interruzione strutturata, drain limitato e finalizzazione esplicita                     |
| MCP attach       | Ledger MCP stdio per default; sidecar HTTP per harness compatibili                    | Mantenere il pool app-scoped (ADR 0027), isolare probe e run                            |
| Picker UX        | Rail e lista searchable; lazy inspect; default sintetico                              | Stati di disponibilità onesti, selezione coerente e azioni di recupero                  |
| Boundary         | Tipi reali `ACPProviderSettings`; cast limitati al flusso SDK                         | Conservare i contratti tipizzati e Zod come fonte wire                                  |

Vincoli da preservare:

- Spawn-per-run è coerente con la privacy dell'ADR 0012: nessun agent long-lived oltre il run.
- Il ledger MCP read-only con argomento `scope` e briefing dual-scope resta un elemento centrale del grounding.
- Tipizzare `acpConfig` come slice statico di `ACPProviderSettings` evita drift.

## 5. Piano di miglioramento (evolutivo, non rewrite)

Principio: **non cambiare SDK né protocollo** (restano `ai` v6 + ACP). Si introduce un layer "managed instance" sopra il registry esistente, si rendono oneste probe/auth/picker, si semplifica il routing model/mode, si robustano cancel/resume/eventi. Ogni fase è shippabile da sola.

### Fase 0 — Chiave `instanceId` + snapshot managed (fondazione)

- Introdurre `HarnessInstance {instanceId, kind, displayName, enabled, status: pending|ready|warning|error|disabled, auth:{status, label?}, version?, modelsCount?}` derivato da spec + detect, con `instanceId = kind` per default (retrocompatibile: il renderer continua a funzionare).
- Sostituire `detect()` a ogni run con un `HarnessSnapshotStore` nel main: una probe per istanza all'avvio + su `PATH` change + refresh manuale; broadcast `coach:harnesses-changed` invece di `invoke` a ogni keystroke. `coach:run` non fa più `detect()` sincrono, legge lo snapshot.
- Accettazione: aprire/chiudere la sezione non spawna processi;的時間 `coach:harnesses` risponde da cache <50ms; log operativo mostra una sola probe per istanza all'avvio.

### Fase 1 — Probe oneste, senza side-effect

- Regola: **health-check ≠ setup**. La probe fa solo `initialize` ACP (mai `authenticate`/`session/new`, mai MCP nostri, mai hooks) con timeout 5–8s, mai throw: ritorna `warning/error` con messaggio azionabile + `binaryPath` reale.
- Per Claude tenere `auth status --json`; aggiungere probe leggere dove l'upstreams lo consente senza login (versione CLI / `initialize` ACP); per le altre restare `unknown → attention` invece di fingere `ready`.
- Il picker non propone mai come default una istanza `error`; propone `ready → attention/unknown → mai error`. Riga con badge `Unavailable` + tooltip.
- Accettazione: harness non loggata non appare più "pronta"; nessun browser/login si apre durante la probe.

### Fase 2 — Auth flow per harness (non solo Claude)

- Estendere `auth:{status: configured|unknown|error, label?, hintCommand?}` a ogni spec: comando di login canonico per harness (es. `claude auth login`, `codex login`, …) + `binaryPath` risolto.
- UI: pill contestuale per harness corrente (generalizzare `ClaudeAuthHint`), con comando copiabile e — dove sicuro — bottone "apri terminale con comando pronto". Toggle passthrough resta in Settings, ma la probe invalida la warm session con messaggio esplicito invece di fallback silenzioso.
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

### Fase 6 — Picker e composer più fluidi

- Picker: tenere la rail, aggiungere (a) sezione per istanza quando `instanceId != kind` (oggi 1:1, predisporre), (b) search fuzzy + riga `isUnavailable` + CTA inline `Setup` che apre hint auth, (c) cambio istanza → reset modello al default di quella istanza (no coppie cross-harness), (d) trigger che conserva label anche a catalogo assente + badge.
- Composer: `TraitsPicker` leggero solo per harness che espongono `optionDescriptors` (reasoning effort, tier, variant) invece di infilarli nei nomi modello bracketed; limite invio come `composerSubmission` (120k char) con messaggio chiaro.
- Welcome: restare su `ConversationWelcome`, aggiungere step "pronto all'uso" solo se zero harness `ready`: lista con stato + comando copiabile, mantenendo il flusso leggero.
- Accettazione: da zero harness a primo run riuscito in ≤3 click guidati; mai default su harness rotta.

### Fase 7 — MCP attach e briefing più robusti

- Probe sempre con zero nostri MCP (già vero per Claude, estendere a tutti); run con ledger MCP thread-scoped a `session/new` (concettualmente: passare `mcpServers` solo al run, mai alla probe).
- Briefing: oltre al primo run, re-inviare un mini-briefing quando lo `scope` cambia mid-conversation (oggi perso) e quando il run parte senza MCP (fresh-install): invece di silenzio, una notice "senza dati ledger — la risposta sarà generica".
- Accettazione: cambio periodo a conversazione avviata → l'agent riceve il nuovo window label; fresh-install → l'utente capisce perché.

## 6. Scelta d'approccio

**No a un rewrite.** Watchtower è un'app Electron single-user, local-first e con vincoli di privacy stretti; un server esterno o sessioni persistenti per default aumenterebbero la superficie operativa e contrasterebbero con l'ADR 0012.

**Sì a un cambio di approccio mirato**, in 3 punti:

1. **Da "registry statico + probe a ogni uso" a "istanze managed con snapshot live"** (Fasi 0–1). È il cambio più redditizio: elimina spawn a raffica, stati bugiardi, picker che mente.
2. **Da "chiave kind" a "chiave instanceId"** (Fase 0, default `instanceId=kind`). Abilita personal/work, `CODEX_HOME` separati, profili — senza rompere nulla oggi.
3. **Da "branching model/mode sparso" a "capability descriptors normalizzati"** (Fase 3) + **eventi canonici** (Fase 4). Riduce il costo di ogni nuova harness da "patch in 3 file" a "riga di tabella + test".

Non introdurre server esterni, sessioni persistenti per default, manifest remoti o un onboarding completo senza una necessità misurata. Rivalutare dopo le Fasi 0–4 usando p95 handshake e tasso di run falliti dopo una probe positiva.

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

## 9. Riferimenti interni

- Watchtower: `src/main/agents/{runtime,ipc,events,detect,auth-probe,prompts}.ts`, `src/main/agents/harnesses/*`, `src/main/agents/ledger-mcp/*`, `src/shared/schemas/agents.ts`, `src/renderer/src/features/coach-skills/*`, ADR 0016–0022, 0025–0027, `docs/architecture.md`.
