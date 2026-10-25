# Evidence Research Reference

## Objective
Verify external assumptions (third-party API semantics, HTTP protocol standards, library defaults, OS socket behaviors) using primary, authoritative sources.

## Source Hierarchy
1. Primary: Official vendor documentation, source code repositories, upstream test suites.
2. Secondary: Upstream issues, pull requests, RFC specifications.
3. Untrusted / Leads only: Blog posts, forum discussions, Q&A threads.

## Research Contract
For every investigated assumption, the output must report:
- `claim`: the exact technical assumption being checked.
- `sources`: URL list of primary documentation or code references.
- `sourceQuality`: "primary" | "secondary" | "unverified".
- `versionScope`: target library or runtime version tested (e.g. Node 22, Next 16).
- `verdict`: "supports" | "contradicts" | "unresolved".
- `remainingGap`: details that cannot be resolved via documentation alone.

## Fundamental Rule
Web research verifies whether a behavior is possible, standard, or documented. Web evidence alone CANNOT promote an unobserved local hypothesis to "confirmed". Local code reproduction remains mandatory.
