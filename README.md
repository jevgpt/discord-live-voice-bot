# Discord Live Voice Bot

A Discord bot that **sits in a voice channel, listens, talks back in real time, and actually runs the
server**: it posts messages, moves people, hands out roles, edits channel permissions, bans, plays music
and remembers things about the people it talks to, all from spoken conversation.

No push-to-talk, no wake word. Speech goes straight to a realtime model over a WebSocket, and everything
that can hurt is locked behind an owner gate that answers one narrow question: *who actually said that?*

[![CI](https://github.com/jevgpt/discord-live-voice-bot/actions/workflows/ci.yml/badge.svg)](https://github.com/jevgpt/discord-live-voice-bot/actions/workflows/ci.yml)
![Node](https://img.shields.io/badge/node-%E2%89%A5%2022.12-339933)
![Licence](https://img.shields.io/badge/licence-MIT-blue)

> **Türkçe kısa özet.** Ses kanalında gerçek zamanlı konuşan, müzik çalan ve sunucuyu sesli komutla
> yöneten bir Discord botu. Yıkıcı her işlem (ban, kanal silme, rol verme…) yalnızca sahibin sesiyle ve
> geri alınamayanlar sahibin sesli "evet"iyle çalışır. `BOT_LANGUAGE=tr` ile loglar, panel, komutlar ve
> konuşma tamamen Türkçedir. Kurulum aşağıda; dört değer yeterli.

---

## Contents

- [What it does](#what-it-does)
- [Setup](#setup)
- [Talking to it](#talking-to-it)
- [The owner gate](#the-owner-gate)
- [How the sound works](#how-the-sound-works)
- [Several servers at once](#several-servers-at-once)
- [Local brain](#local-brain-running-without-openai)
- [Judgments (Jev)](#judgments-jev)
- [Self-diagnosis](#self-diagnosis)
- [Admin panel](#admin-panel)
- [Docker](#docker)
- [Configuration](#configuration)
- [Upgrading from 1.32](#upgrading-from-132)
- [Project layout](#project-layout)
- [Development](#development)
- [Notes from the workbench](#notes-from-the-workbench)
- [Where it is going](#where-it-is-going)

---

## What it does

- **Real-time voice conversation.** Discord's Opus is decoded straight to 24 kHz mono, mixed, and
  streamed to the model in 20 ms frames; the reply comes back the same way. From "somebody stopped
  talking" to "first audio out" is typically about a second.
- **124 server tools.** Messages and DMs, members, roles, channels and their layout and permissions,
  threads and forum posts, reactions, pins and polls, emoji and stickers, scheduled events,
  auto-moderation, webhooks, moderation, invites, the audit log, server settings, music with saved lists,
  reminders, drawing, video reading, notes and conversation summaries. 67 of them are the owner's alone;
  the rest check who is asking before they act in the bot's name.
- **Its own music player.** yt-dlp + ffmpeg, search or direct link, a queue that survives a restart,
  loop, shuffle, seek, "play this next", and **ducking**: the music drops while the bot speaks and comes
  back when it stops.
- **Per-person memory.** "Remember that my cat is called Smoke" is stored for you, and handed to the model
  the next time you speak (as notes about you, not as orders).
- **Knows who is talking.** One voice at a time: while somebody holds the floor only their audio is sent,
  the floor passes at a pause to whoever has waited longest, and the owner takes it at once. Every
  transcript fragment is placed against a per-person record of who was audible when, and a line is read
  as one path of speakers rather than a vote per fragment, so each line reaches the model under its
  speaker's name. How well is measured, not guessed: `npm run bench` scores it on simulated rooms.
- **Hears quiet people, ignores fans.** Voice detection is per person, against their own microphone's
  noise floor, so a quiet voice counts and a desk fan does not.
- **Knows what is for it.** With a Jev key every line is judged as it settles (said to the bot? a request,
  a question, banter, people talking among themselves?) and a reply to a line that was not for the bot
  never reaches the channel.
- **Keeps talking offline.** If the realtime API is out of credit or unreachable, a local pipeline takes
  over: Whisper for ears, any chat model for the brain, Chatterbox for the voice.
- **Reports on itself.** Every five minutes and whenever a session closes: clock drift, how much of the
  transcript the audio could place, what the owner gate refused and why, what Jev decided, slow tools,
  and the audio path's own health, live on a dashboard with an hour of history. A flight recorder and a
  replay script turn a bad evening into a test.
- **Several servers at once**, each with its own conversation, model session, audio path, music queue and
  owner gate, under a cap you set.
- **English and Turkish.** Every string a human sees lives in `src/locales/`; `BOT_LANGUAGE` picks one.

### What it is not

A hosted service. It is one Node process on your machine, talking to the model APIs directly with your
own keys. Nothing is transcribed to disk unless you allow it (`RECORD_TRANSCRIPTS=0` keeps transcripts
and message text out of the log and only counts events), and every server you let it talk in is one more
realtime session on your bill, which is what `MAX_LIVE_SESSIONS` and `DAILY_LIVE_SECONDS` are for.

---

## Setup

**Requirements**

- **Node.js 22.12+** (CI runs 22 and 24)
- A **Discord application** with a bot token
- An **OpenAI API key** with access to the realtime model
- Optional: a **DeepSeek** key (written replies), **Python 3** and a CUDA GPU (local brain),
  a **Jev** key from [typesafe.ai](https://typesafe.ai) (line judgments)

ffmpeg ships with the project (`ffmpeg-static`). yt-dlp is fetched into `tools/bin/` on first use and
checked against the release's published SHA-256 sums before it is ever run.

```bash
git clone https://github.com/jevgpt/discord-live-voice-bot.git
cd discord-live-voice-bot
npm install
cp .env.example .env                                  # four values are required, see below
cp data/characters.example.json data/characters.json  # optional: a persona to start from
npm start
```

The four values that must be set are `DISCORD_TOKEN`, `GUILD_ID`, `CHANNEL_ID` and `OPENAI_API_KEY`.
Everything else has a working default and is documented in [`.env.example`](.env.example). A value the
bot cannot read (`PANEL=of`, an id that is not a Discord snowflake, `BRAIN_MODE=lcoal`) is reported once
at boot instead of being guessed at.

**Discord application**

1. <https://discord.com/developers/applications> → *New Application* → *Bot* → *Reset Token*.
2. Under *Privileged Gateway Intents* enable **Message Content**, **Server Members** and **Presence** if
   you want it to read messages, resolve member names and see activity. It detects what it was granted
   and works with less.
3. Invite it with the `bot` and `applications.commands` scopes and the permissions you actually want it
   to have. Role and channel tools only reach roles below the bot's own highest role.
4. Copy the server id and the voice channel id (Developer Mode → right-click → *Copy ID*).

**The owner.** Set `OWNER_ID` to your own user id. Leave it empty and every voice admin tool is off:
there is no default owner, and there is no "whoever set it up first".

---

## Talking to it

Say the assistant's name and it answers. A handful of phrases are matched locally, by a grammar defined in
the active locale, so they work even without the tool backend:

| You say | It does |
| --- | --- |
| "play Rammstein Puppe" | Plays or queues a track |
| "stop the music", "pause", "resume", "skip the song", "turn the music down", "what's playing" | Music control |
| "play Puppe next" / "bundan sonra Puppe çal" | Puts it at the front of the queue |
| "loop this song", "repeat the queue", "stop repeating" / "şarkıyı tekrarla", "tekrarı kapat" | Loops a track or the whole queue |
| "shuffle" / "karıştır" | Shuffles what is waiting; the current track keeps playing |
| "go to 1:30", "skip ahead 30 seconds", "start the song over" / "30 saniye ileri sar", "başa sar" | Seeks within the track |
| "move 3 to 1", "remove 3 from the queue", "clear the queue" / "3'ü 1'e taşı", "sırayı temizle" | Queue editing |
| "write hello in the general channel" | Posts a message |
| "read the general channel" / "what's written in general" | Reads recent messages (channels *you* can read) |
| "join the lounge channel" / "leave the channel" | Moves between voice channels |
| *(owner or admin)* "switch to the Aria character" | Changes the active persona |

Everything else goes to the assistant, which decides whether to call a tool, search the web or just
answer:

| You say | It does |
| --- | --- |
| "remember that my cat is called Smoke" | Stores a note about you |
| "what was said today" | Summarises this server's conversation, leaving out channels someone listening cannot read |
| "who joined the server last?" | Reads the channel you point it at and answers |
| *(owner)* "ban him", "give Ali the chill role", "lock the channel" | Admin tools |
| *(owner)* "move this channel under Lounge", "throw him out of voice" | Channel layout and voice moderation |

### Who may do what

| | Owner | Admins (`ADMIN_USER_IDS`, `ADMIN_ROLE_IDS`, *Manage Server*) | Everybody else |
| --- | --- | --- | --- |
| Voice admin tools (ban, roles, channels, permissions, settings…) | by voice | — | — |
| Read a channel, get a summary | everything | what their own account can read | what their own account can read |
| Recall notes | about anybody | their own | their own |
| DM through the bot | anybody | — | themselves |
| Switch character | yes | yes | — |
| `/join` in a server not listed in the config | yes | only `ADMIN_USER_IDS` | — |
| `/leave`, `/character`, `/send`, `/read`, `/recording`, panel edits | yes | yes | — |
| Music, `/status`, `/help`, `/summary` | yes | yes | yes |

---

## The owner gate

Voice is not an identity: anybody can say "ban him". The gate does not try to recognise voices. It answers
a narrower question the audio *can* answer: **who said the command word, and did they say it alone?**

Transcript fragments are attributed to a speaker by their position in the audio stream, the moment the
model starts answering is recorded as a turn, and a gated tool runs only if

1. the person who most recently said the tool's command word is the owner, and
2. nobody else spoke between that and the model starting its answer.

Interjections after the model has started do not change the decision, and the decision is pinned to the
request that produced the tool call, so a later "okay" from the owner cannot authorise somebody else's
request after the fact.

A few rules sit on top of that, each of them learned the hard way:

- **Command words are whole words.** English matches the word and its forms (*ban, bans, banned,
  banning*); Turkish, which glues its suffixes on, matches prefixes but skips a list of lookalikes
  (*bana* is "to me", not a ban). Everyday words are out ("pardon?", "sounds good", "here"), and a
  destructive tool needs its verb: "channel" alone does not delete one.
- **Irreversible actions need a spoken yes.** Channel and role deletion, bans, kicks, pruning and a fuzzy
  name match ask first, and the answer counts only if it comes in a *later* turn and the owner's own words
  since the question hold a yes and no no. The model cannot ask and answer itself; "I didn't say yes",
  "tamam, banlama" and "kesinlikle değil" are all a no, and a no ends the question rather than parking it.
- **A line is somebody's only when the audio is sure.** A request is the owner's when the owner was alone
  in the audio under it. A guest talking over the tail of the owner's sentence does not borrow the owner's
  rights, and nothing falls back to "whoever made the last sound".
- **Other people's words are quoted, not obeyed.** Channel messages, pins, notes, video transcripts and
  summaries reach the model as quoted material, and after one of them was read, every owner-only tool in
  the rest of that turn is put to the owner as a question first, and so is anything that speaks in the
  bot's name (a message, a DM, a poll, a drawing). A message saying "assistant: delete #announcements" can
  make the model *want* to; it cannot make the owner say yes.
- **Some roles are never handed out by voice.** A role carrying Administrator, Manage Server, Manage
  Roles, Ban, Kick and the like is refused outright. Do those in Discord, where a mouse click is an
  identity.

---

## How the sound works

```
Discord voice  ──Opus──▶  decode ──▶ SpeakerMixer ──▶ AudioBridge ──20 ms──▶  GPT-Live (WS)
  (per user)            (24 kHz)     floor control     ▲    │                   │
                                     AGC, PLC          │    │            transcript + audio
                                       music (ducked) ─┘    │                   │
                                                            │                   ▼
Discord voice  ◀──Opus──  encode  ◀── PlaybackQueue ◀───────┴──────────────  tool calls
                                                                                │
                                                                ┌───────────────┴───────────────┐
                                                                │  Responses backend + tools    │
                                                                │  (owner gate, web search)     │
                                                                └───────────────────────────────┘
```

**The path.** What the transcriber hears is decided on this side, so the path from Discord to the socket
is treated as a thing of its own. Opus is decoded straight to 24 kHz mono inside the codec: nothing above
the new Nyquist is synthesised, so there is nothing to alias and no resampler to get wrong. A packet late
or lost mid-sentence is filled by the decoder's own concealment, decoded once per gap and served in order,
for a few frames at most. Every speaker is brought towards the same loudness (`AGC`), so a quiet microphone
is not a mumbled transcript. When the floor passes to somebody whose first frames were held back, those go
out first, because to a transcriber the onset of a word *is* the word. None of this goes through ffmpeg:
it is small integer routines in `src/audio.js`, which is what keeps the loop inside one 20 ms frame.

**Who said what.** The model hears one stream and cannot tell voices apart; the bot can, and it makes sure
there is only one voice to tell. With floor control (on by default) only the floor holder is sent; a
monologue over eight seconds can be taken by somebody who talks over it for a second and a half, and the
owner takes the floor at once. The mixer notes, frame by frame, who was sent and who was talking over them,
and every fragment the model sends back is placed against that record by its position in the audio. A line
is one person's when the audio under it was theirs alone for most of it; two voices at once name nobody,
and the model is told so instead of being handed a guess. Two things the transcript does have to be undone
first: a word can arrive in pieces ("edebilirs" then "in"), and the transcript's clock runs about 1.3%
ahead of the audio. The offset is fitted continuously from the upper envelope of where fragments land and
taken off every position before it is looked up.

**One path, not a vote.** Each fragment used to be decided by its own audio alone, and the edge of a turn
is where that goes wrong: the last word of one person lands half in the next person's audio. A line is now
read as one sticky path of speakers (a small Viterbi pass, `ATTRIBUTION=hmm`), so a boundary fragment takes
its speaker from its neighbours unless its own audio clearly says otherwise. The path is allowed to take
the owner's name off a fragment and never to put it on one, and the owner gate does not read the path at
all: it reads the per-fragment record, as before.

**Hearing who is talking at all.** "Is this person speaking" used to be one bar for every microphone (a
peak of 400), which a quiet voice sat under and a desk fan sat over. Each person is now judged against
their own microphone (`VAD=adaptive`): the frame's energy in dB after a high-pass, against the quietest
moment of their last 1.6 seconds, 6 dB above it to start and 5 dB to keep going, never below -55 dBFS. A
sound that holds steady for 300 ms becomes the new floor, which is how a fan stops being a person, and a
frame whose peak towers 15 dB over its average is a click, not a word. The health report shows each
person's floor and bar.

**Measuring it.** Both of the above are judged on numbers, not on a good evening:

- `npm run bench` plays 14 kinds of simulated room (clean handovers, a monologue taken over, the owner
  cutting in, two voices summed, "evet" inside somebody else's turn, words in two pieces, late packets, the
  1.3% clock, a transcript a second late, four people at once, guests saying the owner's commands) through
  the real mixer, attribution, line pipeline and owner gate. Ground truth rides in the signs of each
  packet's samples, so even audio released late after a handover is scored exactly.
- `npm run bench:vad` runs generated voices at -18 to -48 dBFS over fans, hum, rumble, typing and music.

| Attribution (112 rooms, 13,155 fragments) | vote | hmm |
| --- | --- | --- |
| fragments right | 98.3% | 98.3% |
| lines wrong | 0.4% | 0.3% |
| owner's name on somebody else's fragments / lines | 22 / 3 | 6 / 0 |
| guest commands that opened the gate | 0 / 80 | 0 / 80 |

| Voice detection (60 generated rooms) | peak (old) | adaptive |
| --- | --- | --- |
| quiet speaker at -42 dBFS, speech heard | 70.7% | 96.0% |
| very quiet speaker at -48 dBFS | 45.1% | 85.5% |
| fan, hum or music taken for speech | 52.8% | 1.7% |
| words chopped in two | 1,122 | 487 |
| a silent guest's fan holding the floor | 97.8% of the time | 0.4% |
| cost per 20 ms tick, ten people | 33 µs | 59 µs |

The rooms are simulated, so they compare the two ways fairly rather than promise a number for your
server; `TRACE=1` in a real room is the real check, and `scripts/replay-trace.mjs --mode both` runs a real
recording through both.

**The reply.** The realtime model starts answering on its own about a second after somebody stops. With Jev
the line is judged as soon as its pieces stop arriving; if the bot has not started speaking yet its audio
is held for up to 2 s, and a reply to a line that was not for the bot is dropped and kept off the channel,
with the model told its answer was not played. A line that names the bot never waits.

---

## Several servers at once

`GUILD_ID` and `CHANNEL_ID` are the primary server. Add more with `VOICE_TARGETS`:

```
VOICE_TARGETS=987654321098765432:111222333444555666,876543210987654321:222333444555666777
```

Every server gets its own conversation, model session, audio path, music queue, speaker attribution and
runtime settings, so a command spoken in one cannot authorise anything in another, and turning the owner
priority off in one leaves the others alone. `/join` in a server that is not listed builds a session for
it without a restart, but only for the owner or `ADMIN_USER_IDS`: a new session is a realtime connection
on the owner's keys, and a public bot should not hand those to whoever invited it somewhere.

Each open conversation is a separate realtime session, so the cost grows with the number of them.
`MAX_LIVE_SESSIONS` (default 2) caps how many may be connected at once, a session that is still closing
included. A server over the cap still runs its tools and plays music; it stays quiet until a slot frees,
and then the one that has waited longest gets it. `/status` and the panel say who is waiting.

### Slash commands

`/join` `/leave` `/panel` `/character` `/send` `/read` `/status` `/music` `/summary` `/recording` `/help`

Slash commands run as the person who typed them. `/summary` and `/read` cover the server they are asked
in and the channels that person's own account can read; only the owner gets everything. When something is
asked for out loud and somebody in the voice channel may not read it, the answer comes privately instead.

---

## Local brain (running without OpenAI)

With `BRAIN_MODE=auto`, a credit or key error from the realtime API switches the bot to a local pipeline
instead of leaving it silent, and it switches back once the realtime side recovers:

| Stage | Component |
| --- | --- |
| Ears | faster-whisper, served by `tools/chatterbox_server.py --stt` |
| Brain | any OpenAI-compatible chat model (DeepSeek by default), with the same tools |
| Mouth | Chatterbox TTS, optionally cloning a reference voice |

```powershell
# one-off install into .venv-chatterbox (Windows, CUDA)
tools\setup-chatterbox.ps1
# the bot starts the server itself when it needs it; to run it by hand:
tools\run-chatterbox.cmd
```

Voice commands, tools and the owner gate all work in this mode; web search does not.

The Chatterbox server only answers requests addressed to a loopback name and carrying no browser `Origin`,
so a web page you happen to have open cannot switch off your local brain. When the bot starts the server it
gives it a fresh token, kept in `data/chatterbox.token` so that a bot restarted after a crash can still
talk to the server it left behind. If you start the server by hand with `--token` (or `CHATTERBOX_TOKEN`),
give the bot the same value in `LOCAL_TTS_TOKEN`. It works through a forwarded port
(`ssh -L 9000:127.0.0.1:8020`) too.

---

## Judgments (Jev)

With `JEV_API_KEY` set, [Jev](https://typesafe.ai) (TypeSafe's System One model) answers narrow, typed
questions about what people say, as probabilities, and the code decides what to do with them:

- **Was that for the bot?** Every line, the moment its pieces stop arriving, with the room in view: who is
  in the channel and what the bot last said. Measured on real lines, "Adem naber" from the only person
  present is 6% *for the bot* (50% without the room), "Melis naber" 96%, a reply to the bot's own "sen
  naber?" 92%. Below 30% the reply is kept off the channel; banter above 70% is pointed out to the model.
- **The owner gate's second opinion.** When the keyword list does not recognise how the owner phrased a
  request, Jev is asked whether the owner's own words ask for that tool; a clear yes (80%) opens the gate.
  Who spoke stays the audio's call.
- **The local brain.** With no model listening for itself, the same question decides whether to answer.

A slow Jev costs a moment, never a reply. After five failures in a row the session stops asking,
`JEV_MAX_CALLS` caps requests per session, `JEV=0` turns it off, and `JEV_REPLY_GATE=0` leaves only the
advice to the model. Worth knowing: a judged line, the names of the people in the room and the bot's
last line are sent to Jev's API, whatever `RECORD_TRANSCRIPTS` says about the disk.

---

## Self-diagnosis

Every five minutes, when a live session closes and when the bot stops, the session reports on itself in a
few log lines and one panel event: the drift of the transcript's clock, the share of fragments the audio
could place, lines nobody owned, the gate's refusals with their reasons, Jev's verdicts and latency, slow
tools, and the audio path itself (audio sent against the wall clock, how late the 20 ms loop has run,
holes mid-sentence and how many the decoder filled, frames a full queue threw away, every speaker's
measured level and the gain in effect). It warns when the drift is large, most lines belong to nobody,
the send rate is off the clock or holes are frequent.

`TRACE=1` turns on the flight recorder: who the mixer heard on each frame, where the transcript put every
fragment and where it was looked up, and every decision as it was taken, into
`data/traces/<time>.jsonl`. No audio; words only when `RECORD_TRANSCRIPTS` allows. A trace replays through
the attribution as it is *now*:

```
node scripts/replay-trace.mjs data/traces/<file>.jsonl
```

and lists every fragment decided differently from the live session, so a live failure becomes a test
and a change to the attribution is judged against real rooms.

`TRACE_AUDIO=1` writes exactly the audio sent to the model as `data/traces/sent-<time>.wav`. When a
transcript comes back wrong, that file settles whether the far end misheard or this side changed the sound.

---

## Admin panel

`http://127.0.0.1:8787` opens on a **dashboard**: a card per server (session state, who holds the floor,
who is in voice, what is playing, the day's quota) and the last hour of that server in small charts:
response time, session state, transcript drift, how much of the transcript the audio placed, gate
decisions, Jev's verdicts and latency, tool latency, the audio loop's lateness and dropped frames. The
history lives in memory only, ten-second slots for an hour, about 50 KB per server.

The **Gate audit** tab lists every decision the owner gate took: the tool, who asked, allowed or refused,
and why ("not the owner", "somebody spoke after", "waiting for a spoken yes", "untrusted read in this
turn", "risky role refused"). The **Activity** tab has DMs and channel replies, voice transcripts, tool
calls, music and memory, filters by kind, server and text, holds still while you read and exports exactly
what is on screen as JSONL. The page updates over `/api/stream` (Server-Sent Events) and falls back to
polling; it loads nothing from the network, works on a phone and follows the system's light or dark
theme. `/healthz` returns a status object and `/metrics` exposes Prometheus counters, per server. The OpenAI and DeepSeek keys can be entered here; they are
written into `.env` (after a backup of the old file) and never shown back in full.

By default it binds to loopback only and checks the Host header against DNS rebinding. To reach it from
elsewhere (a container, another machine) set `PANEL_HOST` and **`PANEL_TOKEN`**. Beyond loopback the
panel refuses to start without a token. Visit `/login?token=…` once for a cookie (paste the token as it
is; only `&`, `#` and `%` need percent-encoding), or send `Authorization: Bearer …`. Behind a reverse
proxy, add the name it forwards to `PANEL_ALLOWED_HOSTS`. Every endpoint, the stream included, sits behind
the same Host check and token, and with `RECORD_TRANSCRIPTS=0` none of them hands out anybody's words.

`PANEL=0` turns it off; `RECORD_TRANSCRIPTS=0` keeps message and transcript text out of
`data/activity.jsonl` entirely.

---

## Docker

```bash
docker build -t discord-live-voice-bot .
docker run --env-file .env -v "$(pwd)/data:/app/data" discord-live-voice-bot
```

The image runs Node 22 as the unprivileged `node` user (uid 1000, so a mounted `data/` must be writable
by it) under `tini`, which reaps the ffmpeg and yt-dlp children of a skipped track. yt-dlp is baked in
through the same checksum-verified downloader the bot uses; pin it with
`--build-arg YTDLP_VERSION=2026.08.19` for an image that builds the same way twice. The `HEALTHCHECK`
(`node src/healthcheck.js`) asks `/healthz`, reading `PANEL`, `PANEL_PORT` and `PANEL_TOKEN` exactly the
way the bot does, and passes when the panel is off. The panel's key form cannot rewrite `/app/.env` in a
container, so keys belong in the `--env-file`. To open the panel from the host:

```bash
docker run --env-file .env -e PANEL_HOST=0.0.0.0 -e PANEL_TOKEN=<16+ characters> \
  -p 127.0.0.1:8787:8787 -v "$(pwd)/data:/app/data" discord-live-voice-bot
```

The Chatterbox voice is not in the image; point `LOCAL_TTS_URL` at a server outside it.

---

## Configuration

Every option lives in `.env` and is documented in [`.env.example`](.env.example). The ones worth knowing:

| Variable | Default | What it controls |
| --- | --- | --- |
| `BOT_LANGUAGE` | `en` | Logs, speech, panel and voice-command matching (`en`, `tr`) |
| `OWNER_ID` | *(empty)* | The only voice that may use admin tools; empty turns them off |
| `VOICE_TARGETS` | *(empty)* | Extra servers, as `guildId:channelId` pairs separated by commas |
| `MAX_LIVE_SESSIONS` | `2` | How many servers may hold a realtime session at once |
| `DAILY_LIVE_SECONDS` | `0` | Daily realtime budget across all servers; `0` is unlimited |
| `FLOOR_CONTROL` | `1` | One voice at a time: only the floor holder is sent to the model |
| `OWNER_PRIORITY` | `1` | While the owner speaks, only their audio is sent |
| `AGC` | `1` | Per-speaker loudness towards −20 dBFS (+18 / −6 dB at most) |
| `PRIME_FRAMES` | `2` | A talk-spurt is sent from this frame on, a margin against a late packet |
| `VAD` | `adaptive` | Voice detection per person against their own noise floor; `peak` is the old single bar |
| `ATTRIBUTION` | `hmm` | A line's speakers read as one path; `vote` decides every fragment on its own |
| `RESEARCH_MODEL` | *(empty)* | Enables the full tool set and web search through the Responses API |
| `BRAIN_MODE` | `auto` | `auto` falls back to the local brain, `local` always, `live` never |
| `MUSIC_VOLUME` / `MUSIC_DUCK_VOLUME` | `35` / `12` | Music level, and its level while the bot speaks |
| `YTDLP_VERSION` | `latest` | The yt-dlp release to fetch (checked against its SHA-256 sums) |
| `RECORD_TRANSCRIPTS` | `1` | Whether transcripts and message text are written to disk |
| `PANEL_HOST` / `PANEL_TOKEN` | `127.0.0.1` / *(empty)* | Where the panel listens; a token is required beyond loopback |
| `LOCAL_TTS_LANG` / `LOCAL_STT_LANG` | bot language / `auto` | Language of the local voice, and of the local ears |
| `JEV_API_KEY` | *(empty)* | Enables Jev line judgments |
| `JEV_REPLY_GATE` | `1` | Keep a reply off the channel when its line was not for the bot |
| `TRACE` / `TRACE_AUDIO` | `0` | The flight recorder / the audio that was sent, to `data/traces/` |

Runtime settings changed by voice or from the panel (`brain`, `owner_priority`, `idle_close_minutes`…)
apply to the server they were changed in and last until a restart. `record` is the exception: it decides
what the one shared log writes to disk, so it is process-wide.

---

## Upgrading from 1.32

Most of 1.33 is invisible until somebody tries something they should not. The parts you may notice:

- Irreversible actions wait for the owner to say yes out loud, in a later turn; a guest cannot confirm,
  and neither can the model.
- Guests read only what their own Discord account can read, get only their own notes, DM only themselves,
  and cannot edit or delete the bot's posts or switch its character. Admins get the same reading rules on
  slash commands.
- `/join` in a server that is not in `GUILD_ID`/`VOICE_TARGETS` is for the owner and `ADMIN_USER_IDS`.
- Roles carrying moderator or admin permissions are no longer handed out by voice.
- Runtime settings apply to the server they were changed in; `record` stays process-wide.
- `LOCAL_TTS_LANG` and `LOCAL_STT_LANG` no longer mean Turkish when unset. If you relied on that, add
  `LOCAL_TTS_LANG=tr` and `LOCAL_STT_LANG=tr`, or set `BOT_LANGUAGE=tr`; the bot says so at boot.
- A value the bot cannot read is reported at boot, and a switch it cannot read keeps its default instead
  of turning on.
- The container runs as `node` (uid 1000): a mounted `data/` has to be writable by it.
- Voice detection is per person now (`VAD=adaptive`) and lines are read as one path of speakers
  (`ATTRIBUTION=hmm`). Both have the old behaviour one setting away: `VAD=peak`, `ATTRIBUTION=vote`.
- The music queue, loop mode and volume are kept in `data/music-queues.json` and come back paused after a
  restart. "Stop the music" still clears the queue.

---

## Project layout

```
src/
  index.js          configuration, shared services, the session registry, event routing
  guildsession.js   one server's session: its fields, wiring, voice channel and lifecycle
  session/          the rest of that class, by concern: transcript, replygate (Jev), speakers,
                    livelink (the realtime session), localvoice, settings, constants
  live.js           GPT-Live WebSocket session and tool dispatch
  liveslots.js      MAX_LIVE_SESSIONS: who holds a slot, who gets the next one
  audio.js          mixing, floor control, AGC, ring buffers
  bridge.js         the 20 ms send/receive loop
  voice.js          voice connection, receivers, packet-loss concealment, rejoin logic
  attribution.js    who said what, command words, spoken answers (the basis of the owner gate)
  speakerpath.js    the Viterbi pass that reads a line's speakers as one path
  runs.js           transcript pieces -> one line per speaker
  replay.js         the transcript pipeline without a session (benchmark and trace replay)
  jev.js            typed judgments (Jev)          health.js   the session's report on itself
  trace.js          flight recorder + replay (scripts/replay-trace.mjs)
  commands.js       slash commands and spoken-command grammar
  music.js          yt-dlp + ffmpeg player: queue, loop, shuffle, seek, ducking
  queuestore.js     the music queue kept across restarts
  ytdlp.js          the checksum-verified yt-dlp download
  quota.js          the daily realtime budget, per-session usage
  summary.js        conversation summaries, scoped to a server and a readership
  localbrain.js     offline chat loop              localstt.js  offline ears
  panel.js          admin panel: routes, auth, the live stream
  panelpage.js      the dashboard page itself      metrics.js   an hour of history per server
  memory.js         per-person notes
  config.js         .env parsing and the warnings it prints at boot
  healthcheck.js    the container's health check, reading the panel settings like the bot
  tools/            the 124 model-callable tools (access.js: who is asking)
  locales/          en and tr string bundles       i18n/        locale lookup
tools/              Chatterbox server and install scripts
test/               unit tests plus a full offline self-test
bench/              simulated rooms for the attribution and the voice detector
scripts/            locale checker, trace replay, id and role helpers
```

---

## Development

```bash
npm run lint          # oxlint, warnings are errors
npm run check:locales # both bundles hold the same keys; every key the code uses exists
npm run test:unit     # node:test, ~880 tests
npm run selftest      # end-to-end offline test with a mocked realtime server
npm run check         # all of the above, which is what CI runs on Node 22 and 24
npm run bench         # attribution on simulated rooms, vote against hmm (--json for machines)
npm run bench:vad     # the voice detector on generated voices and noise, peak against adaptive
```

A change to how the bot decides who said what should come with its `npm run bench` table, before and
after. The benchmark is not in `npm test` (it takes a few seconds per mode), but a small slice of it is,
so it cannot quietly rot.

The self-test runs the real audio path, the tool registry, the owner gate and a mock realtime server
without touching the network, so it is safe to run anywhere, including on a train.

When you add a user-visible string, add it to both `src/locales/en` and `src/locales/tr`; the checker
will tell you if you forgot, and it follows ternaries and template literals, so it will also tell you if
you were clever about it.

---

## Notes from the workbench

The first three happened in real rooms. The rest were caught on paper before a room could find them.
Every one of them is a test now.

- **"Adamsın sen" came back as "Ağlar mısın sen."** ("You're the man" → "Are you crying?") A two-tap
  downsampler folded the hiss of *s* and *ş* into the speech band. The codec now decodes at 24 kHz and
  there is no downsampler left to blame.
- **"Melis sus" worked, and six seconds later "Artık konuş" undid it.** The transcript had dropped the
  ending of "artık konuşma" (don't talk any more). Giving the voice back by mistake is the direction the
  owner minds, so the bare way back now needs the bot's name next to it.
- **"Pardon, silme" opened the gate, and fifty more messages went.** In Turkish the negative is glued
  onto the verb, so "don't delete" *contains* "delete". Negated words no longer count as the command
  they negate.
- **"Banana" could open the ban tools.** So could "bank", "band" and a polite "pardon?". Command words
  are whole words now; the fruit has been cleared of all charges.
- **The bot could ask "are you sure?" and answer "yes" on the owner's behalf.** Very efficient, no
  consent involved. A yes now has to come out of the owner's mouth, in a later turn.
- **Two servers taking turns for 25 minutes would have been billed as five hours.** The daily quota
  shared one running total between every session. Nobody's evening is that long.
- **The rejoin plan had five attempts, and the first one cancelled the other four.** Optimism is not a
  retry strategy.
- **The 20 ms loop had a twin.** It never ticked; it only woke up and got counted, like a colleague who
  attends every meeting.
- **A guest's "ban" could come back as the owner's word.** Only in a summed room, only when the far end sent
  two pieces from the same point of the stream, 1 time in 80. Nobody would have found that by ear; the
  benchmark found it on its first run.
- **In the detector's test rooms, a desk fan was the most talkative member of the server.** It held the
  floor 97.8% of the time. It has since been asked to wait its turn like everybody else.
- **`/music stop` had never worked.** Every subcommand read the `query` option only `play` has, and Discord
  throws on a missing required option. Saying "stop the music" worked all along, which may be why nobody
  noticed.

---

## Where it is going

The core is a diarization problem solved without diarization: one mixed stream, a per-person record of who
was audible, and positions on a clock that is not ours. In the order they are planned:

- **Floor control** (done): send one voice, and the overlap every later step is worst at is gone.
- **The sound as a path of its own** (done): decode at the model's rate, conceal lost packets, normalise
  loudness, never lose an onset to a handover, and measure all of it.
- **The owner gate, hardened** (done): whole-word command words, a spoken yes that the model cannot
  supply, other people's words quoted instead of obeyed, and tools that check who is asking.
- **The transcript's clock, settled**: the send rate is now measured against the wall clock; if it is
  exact, the ~1.3% drift is the far end's alone and the model of it stays.
- **Per-person adaptive voice detection** (done): energy in dB against a tracked noise floor per person
  instead of one absolute threshold for every microphone. A quiet speaker is a speaker; a fan is not.
- **Fragment assignment as inference** (done): a sticky Viterbi path over a line's fragments instead of a
  per-fragment vote, measured on simulated rooms before it was made the default.
- **Owner cut-ins**: the benchmark shows about one owner command in ten refused when it is said right on a
  guest's last syllable, because the owner is not alone for 80% of the word. The gate is right to be
  strict; the floor handover can be quicker.
- **Reply control at the protocol**, if the realtime API exposes it: the application starting the reply
  after the verdict, instead of holding and dropping audio.
- **The session module in pieces** (done, first cut): the transcript pipeline, the reply gate, speakers,
  the realtime link and local voice each live in `src/session/`, each file saying which fields it writes
  and which it only reads. The next cut turns the fields several of them share into interfaces.

## Licence

MIT, see [LICENSE](LICENSE).
