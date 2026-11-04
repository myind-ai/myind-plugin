# Myind for Claude Code

Your phone saves links and files to **your own private GitHub repository**. This Claude Code plugin turns this computer
into the worker that reads them: recordings, web pages, PDFs, photos, and videos from the words you bring become a
transcript, notes, key lessons with their moment, tags and topic pages, pushed back for the phone to show.

Node 22+, no npm packages. Nothing runs on anyone's server: git and `gh` use your own login, and the AI is your own
Claude Code (`claude -p` with no tools; saved text is passed as data, never as instructions).

## Install

```text
/plugin marketplace add myind-ai/myind-plugin
/plugin install myind@myind
/myind:setup
```

## First run: `/myind:setup`

It walks you through, asking before anything is installed or changed:

1. **Tools.** `doctor` checks node 22+, git, `gh` (signed in), `claude`, ffmpeg and Whisper, and shows the exact line
   for your system (Homebrew, apt/pipx, winget). Say yes and it runs them (`myind-worker install --missing --yes`);
   lines that need a shell are shown for you to run.
2. **Your repository.** It finds your private repositories that look like a Myind brain (`myind.json`, `inbox/`,
   `library/`), or uses the one you name. A public repository is never used.
3. **Your branch.** The default branch, unless you ask for another (`myind-worker branches --repo you/brain`).
4. **The worker.** It clones your repository to `~/.myind/repo`, checks in so the phone shows this computer, and, on a
   yes, keeps running in the background (launchd on macOS, a systemd user unit on Linux).

## Videos: you bring the words

Myind never fetches a video's content: YouTube's and Instagram's terms forbid automated collection. A video link your
phone saved waits as **needs words**. Run `/myind:words`: it lists them, you paste the transcript the site itself shows
(YouTube: Show transcript), the creator's captions or your own notes, or give a `.txt`, `.vtt` or `.srt` file, and the
computer learns from them: a transcript with chapters and time links, notes, lessons, tags and topics.

```bash
node $W needs-words
node $W words <id> talk.vtt --chapters chapters.txt
node $W add https://youtu.be/<id> --words notes.txt --title "A talk"
```

## Connect your own repository and branch by hand

```bash
W=$(node -p "require(process.env.HOME+'/.myind/plugin.json').workerPath")   # written by the plugin when a session starts
# from a clone of this repository instead: W=plugins/myind/worker/myind-worker.mjs
node $W doctor
node $W branches --repo you/your-brain
node $W setup --repo you/your-brain --branch main
node $W once                       # pull the inbox, read every job, push the results
node $W status                     # what waits, what failed and why, which tools are here
```

## Working on the data

`~/.myind/repo` is an ordinary clone of your repository:

| Path | What it is |
|---|---|
| `inbox/<id>.json` | a link or file the phone queued; `"needs": "words"` marks a video waiting for your words; `reason` says why it waits |
| `failed/<id>.json` | a job that can't be done, with `error` and `errorCode`. Retry it from the phone |
| `library/<type>/<date>_<slug>_<id8>/` | `transcript.md` (a heading per chapter, a time link per paragraph), `notes.md`, `learning.json`, `meta.json`, `description.md` |
| `topics/<slug>.md` | a page per subject that grows as you save more (`node $W evolve`) |

Ask Claude Code "what did I save about rebasing?" and the `myind-brain` skill answers from these files, with links to
the moment in each video.

## Troubleshooting

| You see | Do |
|---|---|
| a video says needs words | `/myind:words`, or Add the words on the phone |
| `cannot set up yet: gh` | `gh auth login` |
| Hindi or Marathi transcripts are junk | use a large Whisper model (`whisperModel: "large-v3-turbo"`, or whisper.cpp `--model large-v3-turbo`) |
| the background worker runs an old version | run `/myind:setup` again after a plugin update |

## Tests

```bash
node --test "tools/worker/*.test.mjs"
```

A local bare repository and stand-ins for `gh`, `claude`, `whisper` and `wp-brain`; no network.

## Licence

MIT. See [LICENSE](LICENSE).
