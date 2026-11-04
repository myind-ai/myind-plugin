# Myind PC worker

Updated: 2026-11-04 (videos: the owner brings the words, `needs-words` / `words` / `add --words`; `install`, `--branch`, `branches`; the 2026-11-04 subtitle-reading opt-in was removed; [guide](the Myind app repository's docs/myind/plugin/video-plugin-guide.md))

**Set it up from Claude Code, with no checkout of this repository:**

```text
/plugin marketplace add <owner>/<repo>
/plugin install myind@myind
/myind:setup
```

`/myind:setup` checks the tools, finds your private brain repository, runs `setup`, and asks before keeping it running.
The worker's code lives in the plugin, [`plugins/myind/worker/`](../../plugins/myind/worker/); this folder holds its
tests, and `tools/worker/myind-worker.mjs` forwards to the plugin copy, so the commands below work from a checkout too.

Runs on your PC. A phone that can't process a link commits `inbox/<id>.json` to your private GitHub repository; this
worker pulls it, reads the source with your existing tools and Claude Code, and pushes the result back for the phone.

**It never fetches a video's content.** YouTube's and Instagram's terms forbid downloading or automated collection, so a
video link is read only from words the owner brings: pasted on the phone, written by Gemini from a public YouTube link
with the owner's key, or given here:

```bash
node tools/worker/myind-worker.mjs needs-words                       # links the phone queued as "needs": "words"
node tools/worker/myind-worker.mjs words <id> talk.vtt --chapters chapters.txt   # or .srt, plain text, or - for stdin
node tools/worker/myind-worker.mjs add https://youtu.be/x --words notes.txt --title "A talk"
```

A `"needs": "words"` job is never read by `once`; it waits, with no failure and no retry commits. `words` learns from
the words exactly as from pasted ones (`transcriptKind: pasted`): `claude -p` with no tools and the words between
random markers, notes, lessons, related items, one commit that also clears the inbox job, a push, then `evolve`
(`--no-evolve` skips it). A `.vtt`, `.srt` or lines starting with a time become a transcript with a heading per chapter
(`--chapters` takes `0:00 Intro` lines) and a time link per paragraph on YouTube. An older phone's video job with no
words still fails with `errorCode: needs-words`. In Claude Code, `/myind:words` walks the owner through it.
Related: [storage format](the Myind app repository's docs/myind/storage-format.md), [architecture](the Myind app repository's docs/myind/architecture.md),
[Claude Code plugin](../../plugins/myind/README.md)

## What it needs

| Tool | For | Without it |
|---|---|---|
| Node 22 or newer, git | the worker | it can't run |
| `gh`, signed in | cloning, reading files the phone stored in release assets | file jobs wait in the inbox |
| `claude`, signed in | summaries and lessons | saved with picked sentences, `quality: basic`, `processedBy: pc-local` |
| Whisper: `whisper` (openai-whisper, ideally `large-v3-turbo`) or `whisper-cli` (whisper.cpp + a `ggml-*.bin` in `~/.myind/models`, and ffmpeg) | audio and video files you shared | no transcript, the job waits; Hindi needs a large model, `base` gives junk |
| `wp-brain` | web pages, `--workpulse` | page jobs wait in the inbox |

A missing tool never fails a job: the job waits. `status` shows what's present.

Where `wp-brain` is found, first match wins:

| Tool | Environment | `~/.myind/worker.json` | Used if it exists |
|---|---|---|---|
| `wp-brain` | `MYIND_WP_BRAIN` | `wpBrain` | `WP_CLI`, the WorkPulse repo under `~/Documents/GitHub/workpluse/`, then `~/workpulse-extension/cli/` |

`MYIND_GH`, `MYIND_CLAUDE`, `MYIND_WHISPER` and `MYIND_WHISPER_CPP` (or `gh`, `claude`, `whisper`, `whisperCpp`
in `worker.json`) override PATH. Other settings in `worker.json`: `language` (what summaries are
written in, default `English`), `claudeModel`, `whisperModel`, `whisperEngine` (`openai` or `cpp`; default: openai when
present), `whisperCppModel` (a path), `branch` (written by `setup --branch`).

`"llm"`: which command-line AI reads text: `"claude"` (default), `"codex"` (`codex exec --sandbox read-only
--ignore-user-config`, model `codexModel`) or `"gemini"` (`gemini --approval-mode default -e none -o json`, model
`geminiModel`). `MYIND_CODEX` / `MYIND_GEMINI` (or `codex`, `gemini` in `worker.json`) override PATH. Items it writes
say `processedBy: "pc-codex"` or `"pc-gemini"`. Images and PDFs are still read only by claude. claude is the strictest
(no tools at all); codex and gemini keep their own read-only modes, run in an empty folder, and get the same markers and
reply checks.
`MYIND_HOME` moves `~/.myind`.

## Use

```bash
node tools/worker/myind-worker.mjs doctor                    # node, git, gh signed in, claude, ffmpeg, whisper
node tools/worker/myind-worker.mjs install --missing         # PRINTS the install / update steps; add --yes to run them
node tools/worker/myind-worker.mjs find-repos                # your private repositories that look like a Myind brain
node tools/worker/myind-worker.mjs branches --repo owner/name # its branches and the default (reads only)
node tools/worker/myind-worker.mjs setup --repo owner/name [--branch NAME]
                                                             # clones to ~/.myind/repo (or switches a clean clone), checks in
node tools/worker/myind-worker.mjs status                    # pending, failed, last run, tools
node tools/worker/myind-worker.mjs once                      # pull, process every job, check in, push
node tools/worker/myind-worker.mjs watch --every 300         # the same on a loop
node tools/worker/myind-worker.mjs evolve                    # update topics/<slug>.md for tags that gained items
node tools/worker/myind-worker.mjs launchd-plist             # PRINTS a launchd plist; it installs nothing
node tools/worker/myind-worker.mjs install-service           # writes and loads a launch agent (macOS) or systemd user unit (Linux)
node tools/worker/myind-worker.mjs uninstall-service         # stops and removes it
```

`once` options: `--force` (redo a `full` item), `--limit N`, `--workpulse` (also `wp-brain library add` and one Brain lesson
per lesson; a failure there only warns). The old `--with-video` and `--cookies-from-browser` were removed and now stop with
a message.

**Background.** `install-service` copies the worker to `~/.myind/worker/` (the plugin's folder changes on every update)
and writes `~/Library/LaunchAgents/com.myind.worker.plist`, loaded with `launchctl bootstrap`, or
`~/.config/systemd/user/myind-worker.service`, enabled with `systemctl --user enable --now`. Options: `--every N`,
`--workpulse`, `--no-load` (write only). Run it again after a plugin update; a SessionStart line says when. It holds the
full path of today's Node and the folders tools were found in, so run it again after moving them too. `/myind:setup` only
runs it after you say yes.

**Check-in.** `setup` and every `once` (so every `watch` pass) write `devices/<computer>.json`: the short host name, the
worker version, which tools are present (true/false, no paths), and the pending and failed counts. It's committed by
explicit path, and only when something changed, when it's 30 minutes old while jobs wait, or 12 hours old when nothing
waits, so an idle `watch` adds two commits a day. `"heartbeatMinutes"` changes the 30 and `"heartbeatIdleMinutes"` the
720; `"heartbeat": false` turns it off (the phone then shows no computer).

No token is stored anywhere. git and `gh` use your own login.

## What it guarantees

- **One commit per job.** Finishing writes the library folder and removes the inbox file together; failing moves the job to
  `failed/` together, with a one-line error. Paths are staged explicitly.
- **One bad job doesn't stop the others.**
- **Never replaces `full`** without `--force`, and `--force` keeps the old item when the new read fails.
- **Source text is data.** It goes to `claude -p --tools ""` on stdin between random markers, with no settings, hooks or MCP
  servers loaded. The reply must match the schema exactly, gets one retry, and is stored as text. Nothing from it is run.
- **`full` means all of it was read.** Long text goes in chunks and the notes are merged; one unread chunk means `basic`.
- **No secrets.** Every text file is checked for secret shapes before committing. A hit refuses that file and names it,
  never printing the value. A hit in `learning.json` fails the job.
- **Bodies stay out of git** and go only to a private repository: uploading to a public one is refused.
- **Pushes:** `git pull --rebase` and push with up to 3 retries, after each job. If another device wrote the same file, your
  commit is kept on a `myind-conflict/<time>` branch and the job is done again next run.

## Tests

```bash
node --test "tools/worker/*.test.mjs"
```

The tests import the worker from `plugins/myind/worker/`. `pc-setup.test.mjs` also checks there is only that one copy.

Use the quoted pattern: on Node 24, `node --test tools/worker/` treats the folder as one test file and fails. The tests use a
local bare repo and fake `gh`, `claude`, `wp-brain` and `whisper` on PATH (no downloader of any kind), and make no
network calls. `no-downloader.test.mjs` fails if a downloader is named anywhere in the plugin, these tests or the app.
