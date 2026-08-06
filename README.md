# Gapstr Opportunity Pipeline

An Apify Actor that collects public opportunity signals from Hacker News and uses a GitHub MCP connector to create deduplicated GitHub issues.

## What it does

The Actor:

1. Searches Hacker News through the Algolia API
2. Collects recent opportunity signals
3. Scores signals using points and comment activity
4. Selects the highest-ranked signal
5. Connects to GitHub through an Apify MCP connector
6. Checks existing repository issues
7. Creates one GitHub issue when no duplicate exists
8. Skips creation when the same issue title already exists

## MCP workflow

The Actor connects to GitHub through the Apify MCP proxy.

It uses these GitHub MCP tools:

- `list_issues`
- `issue_write`

The GitHub access token is stored in the Apify MCP connector and is not included in the Actor source code or input.

## Input

| Field | Type | Description |
|---|---|---|
| `query` | string | Hacker News search query |
| `maxItems` | integer | Maximum number of signals to collect |
| `dryRun` | boolean | Prevents GitHub writes when enabled |
| `githubConnector` | MCP connector | GitHub MCP connector selected in Apify |

## Dry-run behavior

When `dryRun` is enabled:

- Hacker News signals are collected
- Existing GitHub issues are checked
- A candidate issue is selected
- No GitHub issue is created

When `dryRun` is disabled:

- The Actor checks for an existing issue with the same title
- If no duplicate exists, one GitHub issue is created
- If a duplicate exists, creation is skipped

## Opportunity score

Signals are ranked with:

```text
opportunityScore = points + (comments × 2)
````

This simple score prioritizes discussions with stronger visible engagement.

## Example result

The Actor created the following test issue:

```text
Launch HN: Hoplite (YC S26) – Effortlessly deploy cloud coding agents
```

On a second run, the Actor detected the existing title and returned:

```json
{
  "action": "duplicate_skipped",
  "wroteToGithub": false
}
```

## Test repository

The GitHub write workflow was tested using:

```text
nomadix-dev/gapstr-apify-test
```

## Security

* GitHub credentials are stored in the Apify MCP connector
* No GitHub token is committed to this repository
* Dry-run mode is enabled by default
* The Actor creates no more than one issue per run
* Duplicate titles are skipped

## Technology

* Apify Actor
* TypeScript
* Apify SDK
* Model Context Protocol SDK
* GitHub MCP connector
* Hacker News Algolia API

## Run on Apify

1. Create or select a compatible GitHub MCP connector
2. Enter a Hacker News search query
3. Set the maximum number of results
4. Keep `dryRun` enabled for the first run
5. Start the Actor
6. Review the selected opportunity
7. Disable `dryRun` only when GitHub issue creation is intended

## License

MIT

