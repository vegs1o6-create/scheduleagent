# Familiebot 👨‍👩‍👧‍👦

En Telegram-bot som håndterer familiens kalender og påminnelser. Den tar imot ukeplaner (PDF/bilde) og fritekst, trekker ut det viktige med en språkmodell (standard: OpenAI-modell i Microsoft Foundry, alternativt Claude API), og skriver til Google Kalender. Botten kjører som en Cloudflare Worker (TypeScript) med KV, Queues og Cron Trigger.

- **Fritekst:** «Sverre har fotball torsdag kl 17» havner rett i kalenderen, og du får en kvittering med lenke. Rettelser som «nei, kl. 09» oppdaterer siste oppføring.
- **Ukeplan:** Du sender PDF, Word (.docx) eller bilde i Telegram, **eller legger filen i en Google Drive-mappe** (der fungerer også Google Docs). Du får en oppsummering med knappene **[OK] [Rett] [Avbryt]**, og ingenting skrives før du trykker OK.
- **Kommandoer:** `/uke`, `/neste`, `/angre`, `/notat`, `/notater` og `/hjelp`.
- **Infoskjerm:** `/skjerm` er en side for en iPad på veggen, med kalenderen til venstre og et notatfelt («Husk») til høyre. Se [Infoskjerm på iPad](#infoskjerm-på-ipad).
- **Søndag kl. 18:** Botten minner deg på ukeplanen hvis ingen er behandlet siden mandag.

## Arkitektur

```
Telegram ──webhook──▶ Worker (fetch)
                       │ 1. sjekk X-Telegram-Bot-Api-Secret-Token
                       │ 2. sjekk chat-ID (andre ignoreres uten svar)
                       │ 3. legg oppdateringen i køen, svar 200 umiddelbart
                       ▼
                    Cloudflare Queue ──▶ Worker (queue)
                                           ├─ Microsoft Foundry / Claude API (tekst / PDF / bilde → JSON, validert med zod)
                                           ├─ Google Calendar API (upsert via agentKey)
                                           ├─ KV (utkast, siste oppføringer, ukeplanhistorikk, token-cache)
                                           └─ Telegram (oppsummering, knapper, kvitteringer)
Cron (hvert 5. min) ───▶ Worker (scheduled) ──▶ nye filer i Drive-mappen? ──▶ Queue
Cron (søn 16/17 UTC) ──▶ Worker (scheduled) ──▶ påminnelse kl. 18 Oslo-tid
```

Alt arbeid mot modellen skjer i køen. PDF-analyse kan ta lenger enn de 30 sekundene `waitUntil` gir. En kø-consumer kan kjøre i opptil 15 minutter.

### Filer

| Fil | Innhold |
|---|---|
| `src/index.ts` | Inngangspunkt: `fetch` (webhook), `queue` og `scheduled` |
| `src/webhook.ts` | Verifisering av secret, chat-ID-lås, legging i kø |
| `src/router.ts` | Sender hver oppdatering til riktig handler |
| `src/handlers/*` | Tekst, dokument, knapper, kommandoer, commit og cron |
| `src/claude.ts` | Systemprompt, felles prompter og Claude-kall (structured outputs) |
| `src/foundry.ts` | OpenAI-modell i Microsoft Foundry via Responses API (structured outputs) |
| `src/schema.ts` | JSON-skjema (zod), streng validering og normalisering |
| `src/mapping.ts` | Kalenderregler: punkt → Google-hendelse(r) |
| `src/docx.ts` | Uttrekk av tekst (og tabeller) fra Word-filer |
| `src/key.ts` | Idempotensnøkkel `agentKey` |
| `src/dates.ts` | Tidssone, ISO-uker og relative datoer |
| `src/google-auth.ts` | OAuth med refresh token, delt av Kalender og Drive |
| `src/calendar.ts` | Google Calendar-klient |
| `src/drive.ts`, `src/handlers/drive.ts` | Overvåking av Drive-mappen |
| `src/store.ts` | KV-nøkler og tilstand |
| `src/display.ts` | Infoskjermen (`/skjerm`): HTML-siden, kalenderdata og notater |
| `test/` | Tester og eksempler på ukeplaner og fritekst |

## Konfigurasjon

**Hemmeligheter** settes som Worker secrets og ligger aldri i repoet: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_ALLOWED_CHAT_ID`, `FOUNDRY_API_KEY` (eller `ANTHROPIC_API_KEY` hvis `AI_PROVIDER = "anthropic"`), `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` og `GOOGLE_REFRESH_TOKEN`.

**Innstillinger** ligger under `[vars]` i `wrangler.toml`:

| Variabel | Standard | Betydning |
|---|---|---|
| `GOOGLE_CALENDAR_ID` | Familie-kalenderen | Kalenderen det skrives til |
| `CHILDREN` | Sverre (2C, blå), Astrid (Friluftsgruppa, rosa) | Navn, `colorId` og kjennetegn modellen bruker for å finne riktig barn |
| `BOTH_COLOR_ID` | `5` (gul) | Fargen for «Begge» |
| `REQUIRE_APPROVAL_FOR_TEXT` | `false` | `true`: fritekst går også gjennom [OK]/[Rett]/[Avbryt] |
| `AUTO_APPROVE` | `false` | `true`: ukeplaner skrives uten godkjenning |
| `AI_PROVIDER` | `foundry` | `foundry` (OpenAI i Microsoft Foundry) eller `anthropic` (Claude) |
| `FOUNDRY_ENDPOINT` | – | Endepunktet til Foundry-ressursen, f.eks. `https://<ressurs>.openai.azure.com/` |
| `FOUNDRY_DEPLOYMENT` | `gpt-5-mini` | Navnet på deploymenten i Foundry |
| `FOUNDRY_REASONING_EFFORT` | `medium` | `low`/`medium`/`high` for resonneringsmodeller. Tom for gpt-4.1/gpt-4o |
| `CLAUDE_MODEL` | `claude-sonnet-5-5` | Claude-modellen (bare med `anthropic`) |
| `CLAUDE_EFFORT` | `medium` | `low`/`medium`/`high` (bare med `anthropic`) |
| `DEFAULT_EVENT_MINUTES` | `60` | Lengden på en hendelse når bare starttid er kjent |
| `EVENT_REMINDER_MINUTES` | `60` | Varsel før hendelser med klokkeslett |
| `LOW_CONFIDENCE` | `0.7` | Punkter under denne grensen markeres med ⚠️ |
| `DRIVE_FOLDER_ID` | tom (av) | Google Drive-mappen som overvåkes for nye ukeplaner |
| `DISPLAY_CALENDAR_IDS` | tom (= `GOOGLE_CALENDAR_ID`) | Kalendere som vises på infoskjermen, kommaseparert |
| `DISPLAY_DAYS` | `14` | Hvor mange dager frem infoskjermen viser |
| `WEATHER_LAT`, `WEATHER_LON` | Oppsal, Oslo | Posisjonen for værvarselet fra Yr på infoskjermen. Tom = ingen vær |

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
   notat - Legg til notat på infoskjermen
   notater - Vis og fjern notater
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

Botten bruker tre scopes: **`calendar.events`** og **`calendar.readonly`** for kalenderen, og **`drive.readonly`** for Drive-mappen. Botten kan bare *lese* filer i Drive, ikke endre eller slette dem. Vil du ikke bruke Drive, kjører du scriptet med `INCLUDE_DRIVE=false`, og da får du bare de to kalender-scopene.

1. Gå til [Google Cloud Console](https://console.cloud.google.com/) og opprett et prosjekt, f.eks. «familiebot».
2. Åpne **APIs & Services → Library** og aktiver **Google Calendar API** og **Google Drive API**.
3. Åpne **OAuth consent screen**:
   - Brukertype: External. Legg inn appnavn og e-posten din.
   - Under Scopes legger du til `.../auth/calendar.events`, `.../auth/calendar.readonly` og `.../auth/drive.readonly`.
   - Under Test users legger du til Google-kontoen din.
   - **Viktig:** Refresh tokens for apper i status «Testing» utløper etter 7 dager. Trykk **Publish app** (til «In production»). For personlig bruk trenger du ikke verifisering; du får bare en advarsel om «ubekreftet app» når du logger inn. Trykk «Avansert → Gå til familiebot».
4. Åpne **Credentials → Create credentials → OAuth client ID**, velg type **Desktop app**, og noter **Client ID** og **Client secret**.
5. Hent refresh token:
   ```bash
   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... npm run google-token
   ```
   Åpne lenken som skrives ut, logg inn med kontoen som eier kalenderen og godkjenn. Refresh tokenet skrives ut i terminalen.
6. Kalender-ID-en står allerede i `wrangler.toml` (`GOOGLE_CALENDAR_ID`). Du finner den under Google Kalender → Innstillinger for kalenderen → «Integrer kalender».

### 3b. Google Drive-mappe for ukeplaner

1. Opprett en mappe i Google Drive, f.eks. **«Ukeplaner»**. Den må ligge på samme Google-konto som du ga tilgang til i steg 3.
2. Åpne mappen. ID-en er den siste delen av adressen: `https://drive.google.com/drive/folders/`**`1AbCdEf...`**
3. Lim ID-en inn i `wrangler.toml`:
   ```toml
   DRIVE_FOLDER_ID = "1AbCdEf..."
   ```
   ID-en er ikke hemmelig. Den gir ikke tilgang uten innlogging.
4. Hvert 5. minutt ser botten etter nye PDF-er og bilder (jpg/png) i mappen:
   - Når den finner en ny fil, sender den «📁 Ny fil i Drive: …» i Telegram, og etterpå samme oppsummering med [OK] [Rett] [Avbryt] som for Telegram-PDF-er.
   - Filnavnet sendes med til Claude. «Ukeplan 2C uke 40.pdf» gjør det lettere å finne riktig barn og uke.
   - Hver fil behandles én gang. Laster du opp en ny versjon med samme navn, eller erstatter filen, behandles den på nytt, og kvitteringen viser hva som er endret.
   - Første gang ser botten bare på filer fra det siste døgnet, ikke hele mappen.
   - Filene blir liggende i mappen. Botten flytter eller sletter ingenting der.

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
npx wrangler secret put FOUNDRY_API_KEY   # eller ANTHROPIC_API_KEY med AI_PROVIDER = "anthropic"
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

### 7. Sett webhook (enklest: i nettleseren)

Åpne denne adressen i nettleseren:

```
https://familiebot.<ditt-subdomene>.workers.dev/setup?key=<TELEGRAM_WEBHOOK_SECRET>
```

Siden setter webhooken til riktig adresse med riktig `secret_token`. Den sjekker også at alle secrets finnes, og at Telegram-boten, chat-ID-en, Google-innloggingen, kalenderen, Drive-mappen og modellen (Foundry-deploymenten eller Claude-nøkkelen) virker. Hver sjekk får ✅ eller ❌ med forklaring. Siden er beskyttet med webhook-secreten og viser aldri verdiene til hemmelighetene. Du kan åpne den igjen når som helst.

### 7b. Sett webhook manuelt (alternativ)

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
| `event` med tid | Vanlig hendelse (standard 60 min) |
| `event` uten tid | Heldagshendelse |
| `deadline` | Heldagshendelse på fristdatoen |
| `reminder` | Heldagshendelse, eller vanlig hendelse hvis den har tid, med «ta med»-listen i beskrivelsen |
| `info` | Skrives ikke til kalenderen, men vises i oppsummeringen |

- **Tittel:** «Sverre: tittel», «Astrid: tittel» eller «Begge: tittel». Farge etter barn.
- **Beskrivelse:** hva som skal huskes, `action_required`, eventuell merknad og `source_quote`.

### Varsler: ingen som standard, du velger etterpå

Hendelsene lages **uten** varsler. Kalenderens egne standardvarsler slås også av for dem.

Etter lagring spør botten: «🔔 Vil du ha varsel på noen av disse?»
- **Én oppføring** (typisk fritekst): du svarer ja eller nei.
- **Flere oppføringer** (ukeplan): du krysser av for dem du vil ha varsel på, og trykker **Lagre varsler**. Det finnes også **Velg alle** og **Ingen varsler**.

Velger du varsel, gjelder disse tidene:

| Type | Varsel |
|---|---|
| `deadline` | **2 dager før kl. 18:00**, pluss en kort hendelse «⏰ Frist i dag» **kl. 07:30** samme dag (se merknad) |
| `reminder`, punkter med `bring`, og heldagshendelser | **Kvelden før kl. 19:00** |
| `event` med klokkeslett | **1 time før** (`EVENT_REMINDER_MINUTES`), og i tillegg kvelden før hvis noe skal tas med |

- **Valgene huskes:** Et valgt varsel beholdes når du retter oppføringen («nei, kl. 09») og når samme ukeplan kommer på nytt. Botten spør ikke om igjen for oppføringer som allerede har varsel.
- **Sommertid:** Varseltidene regnes med sommertid, så kvelden før kl. 19 blir riktig også natten klokka stilles.

**Merknad om fristvarsel kl. 07:30:** Google Calendar tillater bare varsler *før* starten på en hendelse. En heldagshendelse starter kl. 00:00, så den kan ikke ha et varsel kl. 07:30 samme dag. Derfor lager botten en egen, kort hendelse kl. 07:30 med varsel ved start, men bare når du har valgt varsel. Den hører til fristen og følger med ved `/angre` og sletting.

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
| `remind:<token>` | Åpne spørsmål om varsler |
| `notes` | Notatene på infoskjermen |
| `drive:cursor`, `drive:done:<fil-id>` | Hvor langt Drive-mappen er sjekket, og hvilke filer (og versjoner) som er behandlet |

## Infoskjerm på iPad

`https://familiebot.<ditt-subdomene>.workers.dev/skjerm?key=<DISPLAY_KEY>` viser:

- **Øverst:** værvarsel fra Yr for 7 dager: symbol, maks/min-temperatur og nedbør (vises fra 0,5 mm).
- **Venstre:** klokke, dato og kalenderen de neste 14 dagene, gruppert per dag. «I dag» er uthevet, hendelser som er ferdige tones ned, og fargene er de samme som i Google Kalender (Sverre blå, Astrid rosa, Begge gul).
- **Høyre («Husk»):** notater som ikke hører hjemme i kalenderen. Legg til med **+ Notat** på skjermen eller `/notat tekst` i Telegram. Trykk på et notat på skjermen (eller bruk `/notater` i Telegram) for å fjerne det.

Siden henter nye data hvert 2. minutt, laster seg selv på nytt ved midnatt, og følger lys/mørk modus på iPaden. Mister den kontakten, står det «Ikke oppdatert på X min» øverst til høyre. Den er skrevet for å virke også på eldre iPader (iOS 12+).

### Oppsett

1. Lag en nøkkel og legg den inn som secret:
   ```bash
   openssl rand -hex 16
   npx wrangler secret put DISPLAY_KEY
   ```
   Bruk en annen verdi enn webhook-secreten. Nøkkelen gir bare tilgang til å lese kalenderen og endre notatene.
2. Deploy (`npm run deploy`).
3. På iPaden: åpne adressen i **Safari** → Del-knappen → **Legg til på Hjem-skjerm**. Åpnet fra Hjem-skjermen vises siden i fullskjerm uten adresselinje.
4. Innstillinger på iPaden:
   - **Skjerm og lysstyrke → Autolås → Aldri** (og ha laderen i).
   - Valgfritt: **Tilgjengelighet → Guidet tilgang** låser iPaden til denne appen. Start med trippelklikk på Hjem-/toppknappen.
   - Valgfritt: **Skjerm og lysstyrke → Automatisk** (lys/mørk) gir mørk skjerm om kvelden.
5. **Vær:** sett `WEATHER_LAT` og `WEATHER_LON` i `wrangler.toml` til der dere bor (høyreklikk på huset i Google Maps, så kopierer du koordinatene). Satt til Oppsal i Oslo.
6. Flere kalendere (f.eks. en delt jobbkalender): sett `DISPLAY_CALENDAR_IDS = "familie-id,annen-id"` i `wrangler.toml`. Google-kontoen fra steg 3 må ha tilgang til dem.

Siden bruker rundt 720 kall til Google Kalender i døgnet (ett hvert 2. minutt), godt innenfor gratisgrensene. Værdata hentes fra [MET Norway](https://api.met.no/) (samme data som Yr, gratis) og caches i Cloudflare i 30 minutter. Feiler værkallet, vises kalenderen som vanlig uten vær. Notater skrives til KV bare når du legger til eller fjerner et.

## Sikkerhet

- Hvert webhook-kall må ha riktig `X-Telegram-Bot-Api-Secret-Token`, som sammenlignes i konstant tid. Ellers svarer boten 401.
- Infoskjermen (`/skjerm`) krever `DISPLAY_KEY` i adressen. Den kan lese kalenderen og endre notatene, men ikke endre kalenderen.
- Meldinger og knappetrykk fra andre chat-ID-er ignoreres helt, uten svar. Dette sjekkes både i webhooken og i køen.
- Innholdet i PDF-er, bilder og meldinger regnes som **data**. Systemprompten sier eksplisitt at kommandolignende tekst i dokumenter skal ignoreres. Modellen kan bare returnere JSON etter et fast skjema, som valideres med zod. Modellen har ingen verktøy og kan ikke slette noe.
- **Ingenting slettes uten bekreftelse:** Sletting skjer bare etter trykk på knappen i `/angre` eller «Slett fjernede».
- Loggingen er strukturert (JSON). Den viser hva som ble lest og skrevet (ID-er, `agentKey`, antall, modell, tokenforbruk), men aldri hemmeligheter eller meldingstekst.

## Microsoft Foundry (standard)

1. Opprett en Foundry-ressurs på [ai.azure.com](https://ai.azure.com) (eller en Azure OpenAI-ressurs i Azure-portalen).
2. Under **Models + endpoints**: deploy en modell som støtter bilder og structured outputs, f.eks. `gpt-5-mini`, `gpt-5` eller `gpt-4.1`. Noter **deployment-navnet**.
3. Kopier **endepunktet** og **nøkkelen** (Keys and Endpoint). Sett `FOUNDRY_ENDPOINT` og `FOUNDRY_DEPLOYMENT` i `wrangler.toml`, og nøkkelen som secret: `npx wrangler secret put FOUNDRY_API_KEY`.
4. Bruker du en modell uten resonnering (gpt-4.1, gpt-4o), sett `FOUNDRY_REASONING_EFFORT = ""`.

Detaljer:

- Botten bruker v1-API-et (`/openai/v1/responses`) med `api-key`-header, så ingen `api-version` trengs.
- Structured outputs (`text.format` med `strict: true`) gjør at svaret følger samme JSON-skjema som for Claude. Skjemaet lages fra zod-skjemaet, og svaret valideres like strengt etterpå.
- PDF-er lastes opp til Foundry (`purpose: assistants`) og slettes rett etter kallet. Bilder sendes inline som data-URL.
- Svar lagres ikke hos Azure (`store: false`). Stopper Azure sitt innholdsfilter en forespørsel, får du en forklarende feilmelding i Telegram.

## Claude (alternativ)

Sett `AI_PROVIDER = "anthropic"` og secret `ANTHROPIC_API_KEY`.

- Modellen er `claude-sonnet-5-5` med `effort: medium`. Gir uttrekket fra ukeplanene for dårlig kvalitet, kan du bytte til `claude-opus-5-5` eller sette `CLAUDE_EFFORT = "high"`.
- PDF-er og bilder lastes opp via Claudes Files API i stedet for å base64-kodes i Workeren. Det sparer CPU-tid. Filene slettes automatisk hos Anthropic etter en time.
- Botten bruker structured outputs (`output_config.format`) via Anthropic-SDK-et, slik at svaret alltid følger JSON-skjemaet. Deretter valideres det strengt med zod (datoer, klokkeslett, uke, confidence).
- Server-side fallback (`fallbacks: "default"`) er slått på. Hvis sikkerhetsfilteret til modellen avviser en forespørsel, kjøres den automatisk på nytt på en annen modell.
- Botten bygger en datotabell og legger den i prompten: i dag, i morgen, «fredag» og «neste fredag» i Europe/Oslo. Da trenger ikke modellen regne ut datoene selv.
  - «fredag» / «på fredag» = førstkommende fredag etter i dag.
  - «neste fredag» = fredag i neste uke.

### Word-filer (.docx)

Modellene kan ikke lese .docx direkte, så botten gjør om Word-filen til tekst først. Det skjer i Workeren, uten eksterne biblioteker:

- **Avsnitt** blir linjer.
- **Tabeller** blir `| celle | celle |`-rader, slik at kolonner som ukedager kommer med.
- **Topp- og bunntekst** tas med. Der står ofte ukenummeret.

Teksten sendes til modellen som et dokument. Inneholder Word-filen nesten ingen tekst, fordi ukeplanen er limt inn som et bilde, sendes det største bildet i stedet. Google Docs i Drive-mappen eksporteres som .docx og behandles likt.

### Tillegg til JSON-skjemaet

Skjemaet følger spesifikasjonen, med to tillegg per punkt:

- `notes`: forklaring når modellen er usikker, som spesifikasjonen ber om.
- `child`: gjør at én fritekstmelding kan gjelde flere barn («Sverre har fotball og Astrid svømming»).

`date` kan være `null` når datoen mangler. Da stiller botten ett oppfølgingsspørsmål i stedet for å gjette.

## Workers Free

Botten er laget for å holde seg innenfor gratisplanen:

| Grense (Free) | Hvordan botten holder seg under |
|---|---|
| 100 000 kall per døgn | Webhook og cron bruker noen hundre per døgn |
| 10 ms CPU per kall | Ventetid på modellen, Google og Telegram teller ikke. PDF-er lastes opp som filer uten base64-koding. |
| 50 utgående kall per kjøring | Eksisterende hendelser hentes i **ett** kall før en ukeplan skrives. En ukeplan på 10 punkter bruker rundt 15–20 kall. |
| KV: 1000 skriv per døgn | Drive-sjekken hvert 5. minutt skriver bare når det finnes en ny fil. Access token caches i en time. |
| Queues: 10 000 operasjoner per døgn | Noen få per melding |
| Cron triggers: 5 per konto | Botten bruker 2 |

Går du over CPU-grensen en sjelden gang, avbryter Cloudflare kallet, og botten svarer «Noe gikk galt». Skjer det ofte med store PDF-er, kan du gå over til Workers Paid (5 USD per måned).

## Kjente begrensninger

- **KV er eventually consistent:** Endringer kan bruke opptil ett minutt på å nå andre lokasjoner. All tilstand leses og skrives fra køen, med én jobb om gangen (`max_concurrency = 1`), så i praksis er dette ikke et problem for én bruker.
- **Ukeplaner med veldig mange punkter** (over ~35 kalenderhendelser på én gang) kan gå over grensen på 50 utgående kall i Workers Free.
- **Drive:** Filer oppdages innen ~5 minutter.
- **Word:** Bare `.docx`. Gamle `.doc`-filer må lagres som `.docx` eller PDF først. Tekstbokser og figurer med tekst i Word leses ikke alltid. Ser oppsummeringen tom ut, send filen som PDF.
- **Filstørrelse:** Telegram lar boter laste ned filer på maks 20 MB.
