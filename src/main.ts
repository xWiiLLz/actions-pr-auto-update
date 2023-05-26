import type { RestEndpointMethods } from '@octokit/plugin-rest-endpoint-methods/dist-types/generated/method-types';
import type * as GitHub from '@actions/github';
import type * as Core from '@actions/core';

type PRListPromise = ReturnType<RestEndpointMethods['pulls']['list']>;
type ReturnPullData = Awaited<PRListPromise>['data'];
type PRUpdateRun = Awaited<
  ReturnType<RestEndpointMethods['pulls']['updateBranch']>
>;

export default async function run(core: typeof Core, github: typeof GitHub): Promise<void> {
  function fetchInput(
    key: string,
    required: boolean = false,
    fallback: string | undefined = undefined,
  ): string | undefined {
    let value: string | undefined;
    try {
      value = core.getInput(key, { required }) ?? fallback;
    } catch (error: any) {
      core.error(error);
      core.setFailed(error.message);
    }

    return value;
  }

  async function fetchPullRequests(
    endpoint: RestEndpointMethods,
    limit: number = 100,
  ): Promise<Awaited<PRListPromise> | void> {
    try {
      const result = await endpoint.pulls.list({
        // Pass along the context for the repo
        ...github.context.repo,
        base: github.context.payload.ref ?? 'main',
        /* fetch the most recently updated PRs to keep them maintained first */
        /* we're assuming these PRs are higher priority and/or closer to being merged */
        sort: 'updated',
        direction: 'desc',
        state: 'open',
        per_page: limit,
      });

      if (result.data.length > 0) {
        core.info(`${result.data.length} open pull requests returned; sorted by most recently updated.`);
      } else {
        core.info(`No open pull requests returned where ${github.context.payload.ref ?? 'main'} is the base branch.`);
      }

      return result;
    } catch (error: any) {
      core.error(error);
      core.setFailed(error.message);
    }
  }

  function filterPullRequests(prs: ReturnPullData): ReturnPullData | void {
    const initialCount = prs.length;
    if (initialCount === 0) return prs;

    const isBot = (pr: ReturnPullData[number]): boolean => {
      return pr.user?.name === 'dependabot[bot]' || pr.user?.type === 'Bot';
    };

    const isDraft = (pr: ReturnPullData[number]): boolean => {
      return pr.draft === true;
    };

    try {
      // Always exclude dependabot and other bot PRs
      prs = prs.filter((pr) => {
        if (isBot(pr)) core.info(`Excluding bot PR: ${pr.title}`);
        return !isBot(pr);
      });
      if (prs.length !== initialCount) core.info(`Excluded ${initialCount - prs.length} bot PRs.`);

      const includeDrafts: boolean | undefined =
        fetchInput('include_drafts') === 'true' ? true : false;

      let strhold = fetchInput('include_labels');
      const allowLabels: string[] | undefined =
        typeof strhold !== 'undefined' && strhold.length !== 0
          ? strhold.split(',').map((i) => i.trim())
          : undefined;

      strhold = fetchInput('exclude_labels');
      const denyLabels: string[] | undefined =
        typeof strhold !== 'undefined' && strhold.length !== 0
          ? strhold.split(',').map((i) => i.trim())
          : undefined;

      if (
        typeof allowLabels === 'undefined' &&
        typeof denyLabels === 'undefined' &&
        includeDrafts
      ) {
        core.info(`No limiting filters were provided, returning all ${prs.length} PRs, including drafts.`);
        return prs;
      }

      return prs.filter((pr) => {
        let allow = true;
        const print = `Excluding [#${pr.number} ${pr.title}](${pr.url})`;
        if (!includeDrafts && isDraft(pr)) {
          core.info(`${print} due to draft status.`);
          return false;
        }

        if (typeof allowLabels !== 'undefined' && allowLabels.length !== 0) {
          allow = pr.labels.some((label) => allowLabels.includes(label.name));
          if (!allow) core.info(`${print} as none of the required labels (${allowLabels.join(', ')}) were present.`);
        }

        if (typeof denyLabels !== 'undefined' && denyLabels.length !== 0) {
          allow = pr.labels.every((label) => !denyLabels.includes(label.name));
          if (!allow) core.info(`${print} because one of the blocking labels (${denyLabels.join(', ')}) was present.`);
        }

        return allow;
      });
    } catch (error: any) {
      core.error(error);
      core.setFailed(error.message);
    }
  }

  try {
    /* Fetch the token value */
    const token: string | undefined = process.env.GITHUB_TOKEN;

    if (typeof token === 'undefined' || token.length === 0) {
      core.error(new Error('No token could be found. Please provide a token to use this action or use the GITHUB_TOKEN environment variable.'));
      core.setFailed('No token could be found. Please provide a token to use this action or use the GITHUB_TOKEN environment variable.');
      return;
    }

    let client: ReturnType<typeof github.getOctokit> = github.getOctokit(token);

    if (typeof client === 'undefined') {
      core.error(new Error('Access was not granted. Please ensure the provided github token has the necessary access to the repository.'));
      core.setFailed('Access was not granted. Please ensure the provided github token has the necessary access to the repository.');
      return;
    }

    const strhold = fetchInput('limit');
    const limit: number | undefined =
      typeof strhold !== 'undefined' && strhold.length !== 0
        ? parseInt(strhold, 10)
        : undefined;

    /* Find out which pull requests exist to meet these requirements */
    const prs: ReturnPullData = [];
    if (typeof limit !== 'undefined') {
      const pages = Math.ceil(limit / 100);
      do {
        const nextPage = await fetchPullRequests(client.rest as any, pages === 1 ? limit : 100);
        if (!nextPage) break;

        const cleaned = filterPullRequests(nextPage.data) ?? [];
        prs.push(...cleaned);
      } while (prs.length < limit && prs.length < 100 * pages);
    } else {
      const page = await fetchPullRequests(client.rest as any);
      if (page) prs.push(...(filterPullRequests(page.data) ?? []));
    }

    /* No PRs? No problem! */
    if (prs.length === 0) {
      core.info('No pull requests found that meet the requirements.');
      return core.setOutput('updated', 0);
    }

    if (typeof limit !== 'undefined' && prs.length > limit) {
      core.info(
        `Limiting the PRs being updated to the first ${limit} to have been most recently updated, any remaining will be skipped.`,
      );
    }

    core.info(`Found ${prs.length} pull requests to update:`);
    await Promise.all(
      prs.map(async (pr) => {
        core.info(`- #${pr.number} [${pr.title}](${pr.url}})`);
        /* @todo Figure out how to configure rebase updates */
        const result = await client.rest.pulls.updateBranch({
          ...github.context.repo,
          pull_number: pr.number,
        });
        return { result, pr };
      })
    ).then((results): void => {
      const passed = results.filter(
        (r) => r.result.status === (200 as PRUpdateRun['status']),
      );
      const failed = results.filter(
        (r) => r.result.status !== (200 as PRUpdateRun['status']),
      );

      results = results.sort((a, b) => a.pr.number - b.pr.number);

      core.info(
        `\n\n|-------------------------|\nAttempted to update ${results.length} pull requests:\n${results.map(r => `${r.result.status !== 200 as any ? '❌' : '✅'}  #${r.pr.number} [${r.pr.title}](${r.pr.url})`).join('\n')}\n|-------------------------|\n✅ ${passed.length} succeeded.\n❌ ${failed.length} failed.`,
      );

      if (failed.length > 0) {
        core.warning(
          failed
            .map((r) => `${r.result.data.message}\n[${r.result.data.url}](${r.result.data.url})\n`)
            .join('\n'),
        );
      }

      core.setOutput('updated', passed.length);
      core.setOutput('failed', failed.length);
    });
  } catch (error: any) {
    core.error(error);
    core.setFailed(error.message);
  }
}
