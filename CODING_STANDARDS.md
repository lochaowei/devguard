# Coding standards

Judgement calls for the reviewer. Mechanical rules live in the tools (`devguard check`: ESLint, Prettier, tsc, the generated `.claude/rules/`); a rule that a check could enforce belongs there instead.

## Recognising another tool's output

Code that recognises a file another tool wrote (a generated hook script, a config file, a report) matches **every format the tool has shipped**, not just the installed version's.

- Check the format against the tool's upstream source at several releases (for example `gh api repos/<owner>/<repo>/contents/<template>?ref=<tag>`), and name the range in a comment.
- Each format has a fixture or test. Prefer real output saved under `test/fixtures/<tool>/`, with machine-specific paths made generic.

Why: #93 first matched only lefthook 2.x's hook script, so hooks written by lefthook before 1.5 would have been reported as not installed.
