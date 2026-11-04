#!/usr/bin/env node
// The worker lives in the Claude Code plugin now (plugins/myind/worker/), so installing the plugin installs the worker.
// This path is kept so `node tools/worker/myind-worker.mjs …` from a checkout of the app still works. One copy, no sync.
import '../../plugins/myind/worker/myind-worker.mjs'
