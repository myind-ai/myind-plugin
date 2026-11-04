# Myind plugin for Claude Code

Sets up this computer for your Myind brain in one step, then reads the links and files your phone queued in your
private repository (videos, recordings, pages, PDFs, photos) into notes, lessons and topic pages, and answers "what did
I save about X". The worker ships inside the plugin (`worker/`, Node 22+, no npm packages), so nothing else needs
downloading.

```text
/plugin marketplace add myind-ai/myind-plugin
/plugin install myind@myind
/myind:setup
```

The marketplace is [github.com/myind-ai/myind-plugin](https://github.com/myind-ai/myind-plugin) (`.claude-plugin/marketplace.json` at its root).
The phone's Settings → Computer shows these lines with your brain repository already filled in
(`/myind:setup owner/brain`). Full guide: this repository's README.

| Part | What it does |
|---|---|
| `skills/setup` | `/myind:setup`: checks node, git, `gh`, `claude`, ffmpeg, Whisper; installs what is missing **after you say yes**; finds your private brain repository and branch; sets up the worker; on a yes keeps it running (launchd on macOS, a systemd user unit on Linux) |
| `skills/words` | `/myind:words`: lists the videos waiting for words, you paste or give them (text, `.vtt`, `.srt`), and it learns from them |
| `skills/myind-brain` | "process my Myind inbox", "what did I save about X", "why did this fail", "update my topics" |
| `hooks/` | SessionStart: records where the worker is (`~/.myind/plugin.json`), says when jobs are waiting, and when the background copy is older than the plugin |
| `worker/` | the Node worker; see [its README](../../tools/worker/README.md) |

## Video links: you bring the words

Myind never fetches a video's content (YouTube's and Instagram's terms forbid automated collection). A video link your
phone saved waits as **needs words**. Give them on the phone (Add the words), or here with `/myind:words`: paste the
transcript the site itself shows, the creator's captions, or your own notes; a `.vtt` or `.srt` keeps its times. The
worker then learns from them like any text: `transcript.md` with a heading per chapter and a time link per paragraph,
`notes.md`, `learning.json` (lessons with their moment, tags), related items and topic pages.

No token is stored anywhere: git and `gh` use your own login.
