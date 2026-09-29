# Familiebot 👨‍👩‍👧‍👦

En Telegram-bot som håndterer familiens kalender og påminnelser. Den tar imot ukeplaner (PDF/bilde) og fritekst, trekker ut det viktige med Claude API, og skriver til Google Kalender. Botten kjører som en Cloudflare Worker (TypeScript) med KV, Queues og Cron Trigger.

- **Fritekst:** «Sverre har fotball torsdag kl 17» havner rett i kalenderen, og du får en kvittering med lenke. Rettelser som «nei, kl. 09» oppdaterer siste oppføring.
- **Ukeplan:** Du sender PDF eller bilde og får en oppsummering med knappene **[OK] [Rett] [Avbryt]**. Ingenting skrives før du trykker OK.
- **Kommandoer:** `/uke`, `/neste`, `/angre` og `/hjelp`.
- **Søndag kl. 18:** Botten minner deg på ukeplanen hvis ingen er behandlet siden mandag.

## Arkitektur

```
Telegram ──webhook──▶ Worker (fetch)
                       │ 1. sjekk X-Telegram-Bot-Api-Secret-Token
                       │ 2. sjekk chat-ID (andre ignoreres uten svar)
                       │ 3. legg oppdateringen i køen, svar 200 umiddelbart
                       ▼
                    Cloudflare Queue ──▶ Worker (queue)
                                           ├─ Claude API (tekst / PDF / bilde → JSON, validert med zod)
                                           ├─ Google Calendar API (upsert via agentKey)
                                           ├─ KV (utkast, siste oppføringer, ukeplanhistorikk, token-cache)
                                           └─ Telegram (oppsummering, knapper, kvitteringer)
Cron (søn 16/17 UTC) ──▶ Worker (scheduled) ──▶ påminnelse kl. 18 Oslo-tid
```

Alt arbeid mot Claude skjer i køen. PDF-analyse kan ta lenger enn de 30 sekundene `waitUntil` gir. En kø-consumer kan kjøre i opptil 15 minutter.

### Filer

| Fil | Innhold |
|---|---|
| `src/index.ts` | Inngangspunkt: `fetch` (webhook), `queue` og `scheduled` |
| `src/webhook.ts` | Verifisering av secret, chat-ID-lås, legging i kø |
| `src/router.ts` | Sender hver oppdatering til riktig handler |
| `src/handlers/*` | Tekst, dokument, knapper, kommandoer, commit og cron |
| `src/claude.ts` | Systemprompt og Claude-kall (structured outputs) |
| `src/schema.ts` | JSON-skjema (zod), streng validering og normalisering |
| `src/mapping.ts` | Kalenderregler: punkt → Google-hendelse(r) |
| `src/key.ts` | Idempotensnøkkel `agentKey` |
| `src/dates.ts` | Tidssone, ISO-uker og relative datoer |
| `src/calendar.ts` | Google Calendar-klient (OAuth med refresh token) |
| `src/store.ts` | KV-nøkler og tilstand |
| `test/` | Tester og eksempler på ukeplaner og fritekst |

## Konfigurasjon

**Hemmeligheter** settes som Worker secrets og ligger aldri i repoet: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_ALLOWED_CHAT_ID`, `ANTHROPIC_API_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` og `GOOGLE_REFRESH_TOKEN`.

**Innstillinger** ligger under `[vars]` i `wrangler.toml`:

| Variabel | Standard | Betydning |
|---|---|---|
| `GOOGLE_CALENDAR_ID` | Familie-kalenderen | Kalenderen det skrives til |
| `CHILDREN` | Sverre (2C, blå), Astrid (Friluftsgruppa, rosa) | Navn, `colorId` og kjennetegn Claude bruker for å finne riktig barn |
| `BOTH_COLOR_ID` | `5` (gul) | Fargen for «Begge» |
| `REQUIRE_APPROVAL_FOR_TEXT` | `false` | `true`: fritekst går også gjennom [OK]/[Rett]/[Avbryt] |
| `AUTO_APPROVE` | `false` | `true`: ukeplaner skrives uten godkjenning |
| `CLAUDE_MODEL` | `claude-opus-5-5` | Claude-modellen som brukes |
| `CLAUDE_EFFORT` | `medium` | `low`/`medium`/`high`: høyere gir grundigere, men tregere og dyrere svar |
| `DEFAULT_EVENT_MINUTES` | `60` | Lengden på en hendelse når bare starttid er kjent |
| `EVENT_REMINDER_MINUTES` | `60` | Varsel før hendelser med klokkeslett |
| `LOW_CONFIDENCE` | `0.7` | Punkter under denne grensen markeres med ⚠️ |

Fargekoder i Google Calendar: 1 lavendel, 2 salvie, 3 drue, **4 flamingo (rosa)**, **5 banan (gul)**, 6 mandarin, 7 påfugl, 8 grafitt, **9 blåbær (blå)**, 10 basilikum, 11 tomat.

## Oppsett steg for steg

Forutsetninger: Node 20+, en Cloudflare-konto og en Google-konto som eier kalenderen.

```bash
npm install
npx wrangler login
```

### 1. Opprett boten i BotFather

1. Åpne Telegram og snakk med [@BotFather](https://t.me/BotFather).
2. Send `/newbot`, og velg navn og brukernavn (må slutte på `bot`).
3. Ta vare på **tokenet** du får. Det blir `TELEGRAM_BOT_TOKEN`.
4. Valgfritt: send `/setcommands`, velg boten og lim inn:
   ```
   uke - Denne ukens oppføringer
   neste - De neste 7 dagene
   angre - Slett siste opprettede oppføring
   hjelp - Hva boten kan
   ```

### 2. Finn chat-ID-en din

1. Send en hvilken som helst melding til den nye boten.
2. Kjør (webhooken er ikke satt ennå, så `getUpdates` virker):
   ```bash
   curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates"
   ```
3. Finn `"chat":{"id": 123456789, ...}`. Tallet er `TELEGRAM_ALLOWED_CHAT_ID`.

### 3. Google OAuth

Botten bruker bare to scopes: **`calendar.events`** og **`calendar.readonly`**.

1. Gå til [Google Cloud Console](https://console.cloud.google.com/) og opprett et prosjekt, f.eks. «familiebot».
2. Åpne **APIs & Services → Library** og aktiver **Google Calendar API**.
3. Åpne **OAuth consent screen**:
   - Brukertype: External. Legg inn appnavn og e-posten din.
   - Under Scopes legger du til `.../auth/calendar.events` og `.../auth/calendar.readonly`.
   - Under Test users legger du til Google-kontoen din.
   - **Viktig:** Refresh tokens for apper i status «Testing» utløper etter 7 dager. Trykk **Publish app** (til «In production»). For personlig bruk trenger du ikke verifisering; du får bare en advarsel om «ubekreftet app» når du logger inn.
4. Åpne **Credentials → Create credentials → OAuth client ID**, velg type **Desktop app**, og noter **Client ID** og **Client secret**.
5. Hent refresh token:
   ```bash
   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... npm run google-token
   ```
   Åpne lenken som skrives ut, logg inn med kontoen som eier kalenderen og godkjenn. Refresh tokenet skrives ut i terminalen.
6. Kalender-ID-en står allerede i `wrangler.toml` (`GOOGLE_CALENDAR_ID`). Du finner den under Google Kalender → Innstillinger for kalenderen → «Integrer kalender».

### 4. Opprett KV og kø

```bash
npx wrangler kv namespace create STATE
# lim inn id-en i wrangler.toml under [[kv_namespaces]]

npx wrangler queues create familiebot-jobs
```

### 5. Sett secrets

Lag en lang, tilfeldig webhook-secret. Den kan bare inneholde `A-Z a-z 0-9 _ -`, med maks 256 tegn:

```bash
openssl rand -hex 32
```

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put TELEGRAM_ALLOWED_CHAT_ID
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put GOOGLE_REFRESH_TOKEN
```

### 6. Deploy

```bash
npm test
npm run deploy
```

Noter URL-en, f.eks. `https://familiebot.<ditt-subdomene>.workers.dev`.

### 7. Sett webhook (med `secret_token`)

```bash
curl -s "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -H "content-type: application/json" \
  -d '{
    "url": "https://familiebot.<ditt-subdomene>.workers.dev/telegram",
    "secret_token": "<TELEGRAM_WEBHOOK_SECRET>",
    "allowed_updates": ["message", "callback_query"],
    "drop_pending_updates": true
  }'

# Sjekk status:
curl -s "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
```

Send `/hjelp` til boten. Logger kan du følge med `npx wrangler tail`.

### Lokal utvikling

```bash
cp .dev.vars.example .dev.vars   # fyll inn verdier
npm run dev
npm test          # tester
npm run typecheck
```

## Kalenderregler

| Type | I kalenderen |
|---|---|
| `event` med tid | Vanlig hendelse (standard 60 min) med varsel 60 min før |
| `event` uten tid | Heldagshendelse |
| `deadline` | Heldagshendelse på fristdatoen med varsel **2 dager før kl. 18:00**, pluss en kort hendelse «⏰ Frist i dag» **kl. 07:30** samme dag (se merknad) |
| `reminder`, eller punkter med `bring` | Popup **kvelden før kl. 19:00**, med «ta med»-listen i beskrivelsen |
| `info` | Skrives ikke til kalenderen, men vises i oppsummeringen |

- **Tittel:** «Sverre: tittel», «Astrid: tittel» eller «Begge: tittel». Farge etter barn.
- **Beskrivelse:** hva som skal huskes, `action_required`, eventuell merknad og `source_quote`.
- **Varsler regnes med sommertid:** kvelden før kl. 19 blir riktig også natten klokka stilles.

**Merknad om fristvarsel kl. 07:30:** Google Calendar tillater bare varsler *før* starten på en hendelse. En heldagshendelse starter kl. 00:00, så den kan ikke ha et varsel kl. 07:30 samme dag. Derfor lager botten en egen, kort hendelse kl. 07:30 med varsel ved start. Den hører til fristen og følger med ved `/angre` og sletting.

## Idempotens og tilstand

- Hver hendelse får `extendedProperties.private.agentKey = sha256(barn|dato|normalisert tittel)` (32 hex-tegn). Kommer det samme punktet inn igjen, for eksempel fra en ny versjon av ukeplanen, oppdateres den eksisterende hendelsen i stedet for å lage en ny.
- En ny versjon av ukeplanen for samme barn og uke sammenlignes med forrige versjon. Kvitteringen viser hva som er opprettet, oppdatert, uendret, flyttet og hoppet over, og hvilke punkter som er borte fra ukeplanen. Borte punkter slettes **bare** hvis du trykker «Slett fjernede».
- KV-nøkler:

| Nøkkel | Innhold |
|---|---|
| `draft:<id>` | Ventende godkjenninger |
| `history` | De siste oppføringene, brukt til rettelser og `/angre` |
| `msg:<message_id>` | Kobling fra Telegram-melding til kalenderhendelser (svar på en kvittering for å rette akkurat den) |
| `weekplan:<barn>:<uke>` | Forrige versjon av hver ukeplan |
| `meta:last_weekplan_at` | Brukes av søndagspåminnelsen |
| `mode` | Venter på oppfølgingssvar eller rettelse |
| `google:access_token` | Cachet access token |
| `seen:<update_id>` | Hindrer at samme oppdatering behandles to ganger |

## Sikkerhet

- Hvert webhook-kall må ha riktig `X-Telegram-Bot-Api-Secret-Token`, som sammenlignes i konstant tid. Ellers svarer boten 401.
- Meldinger og knappetrykk fra andre chat-ID-er ignoreres helt, uten svar. Dette sjekkes både i webhooken og i køen.
- Innholdet i PDF-er, bilder og meldinger regnes som **data**. Systemprompten sier eksplisitt at kommandolignende tekst i dokumenter skal ignoreres. Claude kan bare returnere JSON etter et fast skjema, som valideres med zod. Modellen har ingen verktøy og kan ikke slette noe.
- **Ingenting slettes uten bekreftelse:** Sletting skjer bare etter trykk på knappen i `/angre` eller «Slett fjernede».
- Loggingen er strukturert (JSON). Den viser hva som ble lest og skrevet (ID-er, `agentKey`, antall, modell, tokenforbruk), men aldri hemmeligheter eller meldingstekst.

## Claude

- Modellen er `claude-opus-5-5` med `effort: medium`. Du kan bytte til `claude-sonnet-5-5` i `wrangler.toml` for lavere kostnad.
- Botten bruker structured outputs (`output_config.format`) via Anthropic-SDK-et, slik at svaret alltid følger JSON-skjemaet. Deretter valideres det strengt med zod (datoer, klokkeslett, uke, confidence).
- Server-side fallback (`fallbacks: "default"`) er slått på. Hvis sikkerhetsfilteret til modellen avviser en forespørsel, kjøres den automatisk på nytt på en annen modell.
- Botten bygger en datotabell og legger den i prompten: i dag, i morgen, «fredag» og «neste fredag» i Europe/Oslo. Da trenger ikke modellen regne ut datoene selv.
  - «fredag» / «på fredag» = førstkommende fredag etter i dag.
  - «neste fredag» = fredag i neste uke.

### Tillegg til JSON-skjemaet

Skjemaet følger spesifikasjonen, med to tillegg per punkt:

- `notes`: forklaring når Claude er usikker, som spesifikasjonen ber om.
- `child`: gjør at én fritekstmelding kan gjelde flere barn («Sverre har fotball og Astrid svømming»).

`date` kan være `null` når datoen mangler. Da stiller botten ett oppfølgingsspørsmål i stedet for å gjette.

## Kjente begrensninger

- **KV er eventually consistent:** Endringer kan bruke opptil ett minutt på å nå andre lokasjoner. All tilstand leses og skrives fra køen, med én jobb om gangen (`max_concurrency = 1`), så i praksis er dette ikke et problem for én bruker.
- **Workers Free-planen** har 10 ms CPU per kall. Base64-koding av store PDF-er kan gå over grensen, og da anbefales Workers Paid. Ventetid på Claude teller ikke som CPU.
- **Filstørrelse:** Telegram lar boter laste ned filer på maks 20 MB.
