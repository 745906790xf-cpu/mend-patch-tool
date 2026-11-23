# mend

One patch tool for every AI edit format. mend applies edits that AI models write — unified diffs (often with wrong line numbers), SEARCH/REPLACE blocks, V4A patches, and text-editor tool calls as JSON — to a tree of text files, changing every file or none.

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- `--format=NAME`: `unified`, `search-replace`, `v4a` or `json`; `auto` (the default) detects it.
- `--check`: same output and exit code, but nothing is written.
- `--strict`: match lines exactly (tier 0 only).
- PATCH absent or `-`: the patch is read from standard input.

Lines are matched at three tiers: exact, ignoring trailing whitespace, then ignoring leading and trailing whitespace (with re-indentation of new lines at the last tier). Exit 0 prints the changed paths and `ok: <n> files`; exit 1 prints one error line per failed edit; exit 2 is a usage, no-patch, format or parse error.

Node 22 and its standard library alone. MIT licence.
