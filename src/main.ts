import { Actor, log } from 'apify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

interface Input {
    query: string;
    maxItems: number;
    dryRun: boolean;
    githubConnector: string;
}

interface HackerNewsHit {
    objectID: string;
    title?: string | null;
    story_title?: string | null;
    url?: string | null;
    story_url?: string | null;
    author?: string | null;
    created_at?: string | null;
    points?: number | null;
    num_comments?: number | null;
}

interface HackerNewsResponse {
    hits: HackerNewsHit[];
}

interface McpTextContent {
    type: string;
    text?: string;
}

interface ExistingIssue {
    number?: number;
    title?: string;
    body?: string;
    state?: string;
}

interface ExistingIssuesResponse {
    issues?: ExistingIssue[];
    totalCount?: number;
}

await Actor.init();

let client: Client | null = null;

try {
    const input = await Actor.getInput<Input>();

    if (!input) {
        throw new Error('Actor input is missing.');
    }

    const query = input.query?.trim() || 'AI developer tools';
    const maxItems = Math.min(Math.max(input.maxItems || 20, 1), 100);
    const dryRun = input.dryRun ?? true;
    const githubConnector = input.githubConnector;

    const githubOwner = 'nomadix-dev';
    const githubRepo = 'gapstr-apify-test';

    if (!githubConnector) {
        throw new Error('GitHub MCP connector is required.');
    }

    log.info('Starting Gapstr opportunity pipeline', {
        query,
        maxItems,
        dryRun,
        githubRepository: `${githubOwner}/${githubRepo}`,
    });

    const searchUrl =
        `https://hn.algolia.com/api/v1/search_by_date` +
        `?query=${encodeURIComponent(query)}` +
        `&tags=story` +
        `&hitsPerPage=${maxItems}`;

    const response = await fetch(searchUrl, {
        headers: {
            Accept: 'application/json',
            'User-Agent': 'Gapstr-Opportunity-Pipeline/0.3',
        },
    });

    if (!response.ok) {
        throw new Error(
            `Hacker News request failed: ${response.status} ${response.statusText}`,
        );
    }

    const data = (await response.json()) as HackerNewsResponse;
    const collectedAt = new Date().toISOString();

    const signals = data.hits
        .map((hit) => {
            const title = hit.title ?? hit.story_title ?? '';
            const sourceUrl =
                hit.url ??
                hit.story_url ??
                `https://news.ycombinator.com/item?id=${hit.objectID}`;

            const points = hit.points ?? 0;
            const comments = hit.num_comments ?? 0;

            return {
                signalId: `hn-${hit.objectID}`,
                source: 'Hacker News',
                query,
                title,
                sourceUrl,
                author: hit.author ?? null,
                publishedAt: hit.created_at ?? null,
                points,
                comments,
                opportunityScore: points + comments * 2,
                problemSummary: null,
                gapScore: null,
                aiVerdict: null,
                duplicateStatus: 'not_checked',
                dryRun,
                collectedAt,
            };
        })
        .filter((signal) => signal.title.length > 0)
        .sort((a, b) => b.opportunityScore - a.opportunityScore);

    if (signals.length === 0) {
        throw new Error('No Hacker News signals were collected.');
    }

    const selectedSignal = signals[0];

    const proxyBaseUrl = process.env.APIFY_MCP_PROXY_URL;
    const apifyToken = process.env.APIFY_TOKEN;

    if (!proxyBaseUrl || !apifyToken) {
        throw new Error('Apify MCP proxy environment variables are missing.');
    }

    const connectorUrl = new URL(
        `${proxyBaseUrl.replace(/\/$/, '')}/${githubConnector}`,
    );

    const transport = new StreamableHTTPClientTransport(connectorUrl, {
        requestInit: {
            headers: {
                Authorization: `Bearer ${apifyToken}`,
            },
        },
    });

    client = new Client({
        name: 'gapstr-opportunity-pipeline',
        version: '0.3.0',
    });

    await client.connect(transport);

    const toolsResponse = await client.listTools();
    const availableToolNames = toolsResponse.tools.map((tool) => tool.name);

    for (const requiredTool of ['list_issues', 'issue_write']) {
        if (!availableToolNames.includes(requiredTool)) {
            throw new Error(`Required GitHub MCP tool is missing: ${requiredTool}`);
        }
    }

    const issueListResponse = await client.callTool({
        name: 'list_issues',
        arguments: {
            owner: githubOwner,
            repo: githubRepo,
            state: 'OPEN',
            perPage: 100,
            fields: [
                'number',
                'title',
                'body',
                'state',
                'created_at',
                'updated_at',
            ],
        },
    });

    const issueTextParts = Array.isArray(issueListResponse.content)
        ? issueListResponse.content
              .filter(
                  (item): item is McpTextContent =>
                      typeof item === 'object' &&
                      item !== null &&
                      'type' in item &&
                      item.type === 'text',
              )
              .map((item) => item.text ?? '')
              .filter(Boolean)
        : [];

    const existingIssuesRaw = issueTextParts.join('\n');

    let existingIssues: ExistingIssuesResponse = {
        issues: [],
        totalCount: 0,
    };

    if (existingIssuesRaw) {
        try {
            existingIssues = JSON.parse(
                existingIssuesRaw,
            ) as ExistingIssuesResponse;
        } catch {
            log.warning('GitHub issues response was not valid JSON.');
        }
    }

    const normalizedSelectedTitle = selectedSignal.title
        .trim()
        .toLowerCase();

    const duplicateIssue = existingIssues.issues?.find(
        (issue) =>
            issue.title?.trim().toLowerCase() === normalizedSelectedTitle,
    );

    const duplicateStatus = duplicateIssue
        ? 'duplicate_found'
        : 'no_duplicate';

    const issueBody = [
        '## Gapstr opportunity signal',
        '',
        `**Source:** Hacker News`,
        `**Query:** ${query}`,
        `**Signal ID:** ${selectedSignal.signalId}`,
        `**Published:** ${selectedSignal.publishedAt ?? 'Unknown'}`,
        `**Author:** ${selectedSignal.author ?? 'Unknown'}`,
        `**Points:** ${selectedSignal.points}`,
        `**Comments:** ${selectedSignal.comments}`,
        `**Opportunity score:** ${selectedSignal.opportunityScore}`,
        '',
        '## Source link',
        '',
        selectedSignal.sourceUrl,
        '',
        '## Pipeline',
        '',
        'Collected by Gapstr Opportunity Pipeline using Apify and a GitHub MCP connector.',
    ].join('\n');

    let issueWriteResult: unknown = null;
    let wroteToGithub = false;
    let action = 'dry_run_only';

    if (duplicateIssue) {
        action = 'duplicate_skipped';
    } else if (!dryRun) {
        const writeResponse = await client.callTool({
            name: 'issue_write',
            arguments: {
                method: 'create',
                owner: githubOwner,
                repo: githubRepo,
                title: selectedSignal.title,
                body: issueBody,
            },
        });

        const writeTextParts = Array.isArray(writeResponse.content)
            ? writeResponse.content
                  .filter(
                      (item): item is McpTextContent =>
                          typeof item === 'object' &&
                          item !== null &&
                          'type' in item &&
                          item.type === 'text',
                  )
                  .map((item) => item.text ?? '')
                  .filter(Boolean)
            : [];

        const writeRaw = writeTextParts.join('\n');

        issueWriteResult = writeRaw;

        if (writeRaw) {
            try {
                issueWriteResult = JSON.parse(writeRaw);
            } catch {
                issueWriteResult = writeRaw;
            }
        }

        if (writeResponse.isError) {
    throw new Error(
        `GitHub issue creation failed: ${
            typeof issueWriteResult === 'string'
                ? issueWriteResult
                : JSON.stringify(issueWriteResult)
        }`,
    );
}

wroteToGithub = true;
action = 'issue_created';
    }

    await Actor.pushData({
        recordType: 'pipeline_summary',
        status: 'pipeline_succeeded',
        query,
        collectedSignals: signals.length,
        githubRepository: `${githubOwner}/${githubRepo}`,
        githubConnectorConnected: true,
        selectedSignal,
        duplicateStatus,
        duplicateIssue: duplicateIssue ?? null,
        dryRun,
        action,
        wroteToGithub,
        issueWriteResult,
        collectedAt: new Date().toISOString(),
    });

    await Actor.pushData(
        signals.map((signal) => ({
            ...signal,
            duplicateStatus:
                signal.signalId === selectedSignal.signalId
                    ? duplicateStatus
                    : 'not_checked',
            selectedForGithub:
                signal.signalId === selectedSignal.signalId,
        })),
    );

    log.info('Gapstr opportunity pipeline succeeded', {
        repository: `${githubOwner}/${githubRepo}`,
        signals: signals.length,
        selectedSignal: selectedSignal.signalId,
        duplicateStatus,
        dryRun,
        action,
        wroteToGithub,
    });
} catch (error) {
    const message =
        error instanceof Error ? error.message : 'Unknown error occurred';

    log.error('Gapstr pipeline failed', {
        error: message,
    });

    await Actor.pushData({
        recordType: 'pipeline_error',
        status: 'error',
        message,
        collectedAt: new Date().toISOString(),
    });

    throw error;
} finally {
    if (client) {
        try {
            await client.close();
        } catch (closeError) {
            log.warning('GitHub MCP client could not be closed cleanly', {
                error:
                    closeError instanceof Error
                        ? closeError.message
                        : 'Unknown close error',
            });
        }
    }

    await Actor.exit();
}
