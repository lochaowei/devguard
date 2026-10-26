# AGENTS.md

## Agent skills

### Issue tracker

Issues live in GitHub Issues on lochaowei/devguard (via `gh`). See `docs/agents/issue-tracker.md`.

### Triage labels

Default labels: needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Wiki

`docs/wiki/` is the source of truth for the GitHub Wiki; `.github/workflows/wiki.yml` publishes it on every push to main, overwriting edits made on the wiki itself. Link pages as `Page.md` and repo files as `../../path` — the sync rewrites both for the wiki. When a change alters a command's behaviour, flags or exit codes, update the matching `docs/wiki/` page in the same PR.
