---
name: setup
description: Set up this computer for Myind in one step, so it processes what the phone queues in the user's private Myind GitHub repository. Use for "/myind:setup", "set up Myind on this computer", "connect my computer to Myind", "connect my Myind repo", "use another branch for Myind", "install the Myind worker", "install whisper for Myind", "run Myind in the background", "refresh the Myind background worker", "stop the Myind worker". Checks the tools and offers to install what is missing, finds the brain repository and branch, sets up the worker and, only if the user says yes, keeps it running in the background.
argument-hint: "[owner/repository] [branch]"
---

# Set up this computer for Myind

The phone and this computer share one private GitHub repository (the brain). The worker ships inside this plugin, so
nothing needs downloading. The only question the user may get is which repository, and only when it can't be worked
out. Run each step in order and stop at the first one that fails, saying what to do.

Never ask for, print or store a token: git and `gh` use the user's own login. Install a tool only after the user said
yes to that list (step 2). Never create a repository, switch a branch with work in it or install a background service without a
yes. Myind never fetches a video's content: never install, suggest or run anything that downloads from a video site.

## 1. Find the worker

`CLAUDE_PLUGIN_ROOT` is empty in this shell, so use this block exactly as written. It tries this plugin's folder, the
path the plugin's SessionStart hook recorded, Claude Code's list of installed plugins, then a search.

```bash
# locate-worker
W=""
for c in "${CLAUDE_PLUGIN_ROOT}/worker/myind-worker.mjs" \
  "$(node -e 'try{const p=require(process.env.MYIND_HOME?process.env.MYIND_HOME+"/plugin.json":require("os").homedir()+"/.myind/plugin.json").workerPath;if(p)console.log(p)}catch{}' 2>/dev/null)" \
  "$(node -e 'try{const j=require(require("os").homedir()+"/.claude/plugins/installed_plugins.json");for(const[k,v]of Object.entries(j.plugins||{}))if(k.startsWith("myind@"))for(const e of[].concat(v))if(e&&e.installPath)console.log(e.installPath+"/worker/myind-worker.mjs")}catch{}' 2>/dev/null | head -1)" \
  "$(find "$HOME/.claude/plugins/cache" -path '*/myind/*/worker/myind-worker.mjs' 2>/dev/null | sort -r | head -1)"; do
  if [ -n "$c" ] && [ -f "$c" ]; then W="$c"; break; fi
done
echo "worker: ${W:-not found}"
```

Use `"$W"` in every later step (each Bash call starts fresh, so put the block before the command each time). If it says
`not found`, tell the user to run `/plugin install myind@myind` and start a new session.

If `node` itself is missing or older than 22, stop here and give the line: macOS `brew install node`; Linux
`curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash && nvm install 22`.

## 2. Check the tools, and install what is missing (ask first)

```bash
node "$W" doctor
```

It prints one line per tool: `ok`, `MISSING` (required: node 22+, git, `gh` signed in) or `optional`, with the exact
install line for this system (Homebrew on macOS, apt/pipx on Linux, winget on Windows) under anything not ok.

| Tool | Why | Optional? |
|---|---|---|
| node 22+, git, `gh` signed in | the worker, the clone, finding the repository | required |
| `claude` | full notes (without it: picked sentences, `basic`) | optional |
| `ffmpeg` | Whisper and some photo formats | optional |
| `whisper` | recordings and video files the user shares: openai-whisper, or whisper.cpp plus a model in `~/.myind/models` | optional |

If anything is not ok, show the list and ask once with AskUserQuestion: **Install these now** / **Only the required ones**
/ **Skip**. On a yes, run exactly:

```bash
node "$W" install --missing --yes          # or: node "$W" install whisper --yes
```

It runs each step with no shell and stops a tool at its first failing step. Lines that need a shell (the `claude`
installer, nvm) are only printed: give them to the user. `gh auth login` opens a browser, so the user runs it. whisper.cpp's model: `--model base|small|large-v3-turbo` (default `small`, 466 MB).
Then run `node "$W" doctor` again. If it still ends `cannot set up yet`, stop and say what is left.

## 3. Find the brain repository

If the user gave `owner/repository` (`$ARGUMENTS`), use it and skip the search. Otherwise:

```bash
node "$W" find-repos --json
```

It runs `gh repo list --json nameWithOwner,isPrivate --limit 200` and looks at the top level of each private repository
for `myind.json` (the phone writes it when it connects), `inbox/`, `library/` or `devices/`.

| Found | Do |
|---|---|
| One match | Use it, and say which one in one line ("Using me/myind-brain: it has the phone's myind.json") |
| Several | Ask once with AskUserQuestion, one option per match, `myind.json` ones first |
| None | Ask: "No Myind repository found. Create a private one called myind-brain?" Only on yes: `gh repo create myind-brain --private`, then use `<login>/myind-brain` (`gh api user --jq .login`). Tell the user to connect the phone to it too (Settings → Back up to GitHub) |

Never pick a public repository: a brain must be private. If `publicLookalikes` is not empty, say those are public and not used.

## 4. Pick the branch

The phone writes to the repository's default branch. Use another one only if the user asks (a test brain, say).

```bash
node "$W" branches --repo OWNER/NAME          # lists branches, marks the default; reads only
```

One branch, or the user named none: use the default and don't ask. Several and the user asked for a branch: ask once
which, default first.

## 5. Video links: the user brings the words

Say this once, in one or two lines: Myind never fetches a video's content (YouTube's and Instagram's terms forbid it), so
a video link is read from words the user brings. On the phone: Add the words. On this computer: `/myind:words` (the
`myind-words` skill) lists the videos waiting and helps them give the words. Nothing to choose here.

## 6. Set up the worker

```bash
node "$W" setup --repo OWNER/NAME [--branch BRANCH]
```

It clones to `~/.myind/repo` (or switches the clone to `--branch`, only when nothing in it is uncommitted), writes
`~/.myind/worker.json` (`repo`, `branch`, …), warns if the repository is not private, and checks in
(`devices/<computer>.json`), so the phone's Settings shows this computer. Then run `node "$W" status` and report what is waiting.

### Working on the data yourself

The clone is an ordinary git checkout of the user's own repository; say this in one or two lines if they ask:

```bash
DIR=$(node -p "require(process.env.HOME + '/.myind/worker.json').dir")
git -C "$DIR" pull --rebase                  # what the phone queued: inbox/<id>.json
ls "$DIR/inbox" "$DIR/failed"                 # waiting (with "reason") and failed (with "error", "errorCode")
node "$W" needs-words                         # video links waiting for the user's words (then /myind:words)
node "$W" once                                # pull, read every job, write library/<type>/<folder>/, push
ls "$DIR/library/youtube"                     # notes.md, learning.json, transcript.md (chapters + time links)
node "$W" evolve                              # topic pages in topics/ from tags that gained items
```

Edits by hand go in as normal commits (`git -C "$DIR" add <path> && git -C "$DIR" commit -m "docs: …" && git -C "$DIR" push`),
but never edit `learning.json` of a `full` item to say something it doesn't, and stop the background worker first
(`node "$W" uninstall-service`) so the two don't race. Anyone can also clone it elsewhere with `gh repo clone OWNER/NAME`.

## 7. Keep it running (ask first)

Ask once: "Run in the background? It checks your repository every 5 minutes and starts again when you log in." Only on yes:

```bash
node "$W" install-service
```

On macOS it writes `~/Library/LaunchAgents/com.myind.worker.plist` and loads it; on Linux a systemd user unit
`~/.config/systemd/user/myind-worker.service`, enabled with `systemctl --user`. It runs a copy of the worker in
`~/.myind/worker/`, because this plugin's folder changes on every update; after a plugin update, run `/myind:setup` again
(a SessionStart line says when). On no, say they can run `node "$W" once` whenever they like, or `/myind:setup` again later.

To stop it: `node "$W" uninstall-service`. To only see the launchd file: `node "$W" launchd-plist` (prints, installs nothing).

### Weekly report (ask first)

Ask once, with the background question or after it: "Remind you once a week where the Claude tokens went and what
waits for your words?" Only on yes: `node "$W" install-reminder` (Monday 10:00; `--weekday 0-6 --hour 0-23`). It runs
`report --write --notify` from the same copy in `~/.myind/worker/`, so rerun it after a plugin update too. To save tokens
on short captions, offer to set `"smallModel": "sonnet"` (or `"haiku"`) in `~/.myind/worker.json`.

## 8. Summary

Four or five lines: the repository and branch, where the clone is, how many videos wait for words, whether it runs in
the background, and any optional tool still missing with its install line. Nothing more.
