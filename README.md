# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/745906790xf-cpu/mend-patch-tool/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/745906790xf-cpu/mend-patch-tool/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

One patch tool for every AI edit format. mend applies edits that AI models write — unified diffs (often with wrong line numbers), SEARCH/REPLACE blocks, V4A patches, and text-editor tool calls as JSON — to a tree of text files, changing every file or none.

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- `--format=NAME`: `unified`, `search-replace`, `v4a` or `json`; `auto` (the default) detects it.
- `--check`: same output and exit code, but nothing is written.
- `--strict`: match lines exactly (tier 0 only).
- PATCH absent or `-`: the patch is read from standard input.

Lines are matched at three tiers: exact, ignoring trailing whitespace, then ignoring leading and trailing whitespace (with re-indentation of new lines at the last tier). Exit 0 prints the changed paths and `ok: <n> files`; exit 1 prints one error line per failed edit; exit 2 is a usage, no-patch, format or parse error.

Node 22 and its standard library alone. MIT licence.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=zcyayerd&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
