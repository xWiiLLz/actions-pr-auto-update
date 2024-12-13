/* eslint-disable @typescript-eslint/no-non-null-assertion */
import type { RestEndpointMethods } from '@actions/github/node_modules/@octokit/plugin-rest-endpoint-methods/dist-types/generated/method-types';
import type * as GitHub from '@actions/github';
import type * as Core from '@actions/core';

import 'colors';

type PRListPromise = ReturnType<RestEndpointMethods['pulls']['list']>;
type ReturnPullData = Awaited<PRListPromise>['data'];
type PRUpdateRun = Awaited<
  ReturnType<RestEndpointMethods['pulls']['updateBranch']>
>;

export default async function run(
  core: typeof Core,
  github: typeof GitHub,
): Promise<void> {
  async function fetchPullRequests(
    endpoint: RestEndpointMethods,
    limit = 100,
    repository = github.context.repo,
  ): Promise<Awaited<PRListPromise> | void> {
    try {
      const result = await endpoint.pulls.list({
        // Pass along the context for the repo
        ...repository,
        base: github.context.payload.ref ?? 'main',
        /* fetch the most recently updated PRs to keep them maintained first */
        /* we're assuming these PRs are higher priority and/or closer to being merged */
        sort: 'updated',
        direction: 'desc',
        state: 'open',
        per_page: limit,
      });

      if (result.data.length > 0) {
        core.info(
          `${result.data.length} open pull requests returned; sorted by most recently updated.`,
        );
      } else {
        core.info(
          `No open pull requests returned where ${
            github.context.payload.ref ?? 'main'
          } is the base branch.`,
        );
      }

      return result;
    } catch (error: unknown) {
      if (error instanceof Error) {
        core.error(error);
        core.setFailed(error.message);
      } else {
        core.error('An unknown error occurred while fetching pull requests.');
      }
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
      if (prs.length !== initialCount)
        core.info(`Excluded ${initialCount - prs.length} bot PRs.`);

      const includeDrafts: boolean | undefined =
        core.getInput('include_drafts') === 'true' ? true : false;

      let strhold = core.getInput('include_labels');
      const allowLabels: string[] | undefined =
        typeof strhold !== 'undefined' && strhold.length !== 0
          ? strhold.split(',').map((i) => i.trim())
          : undefined;

      strhold = core.getInput('exclude_labels');
      const denyLabels: string[] | undefined =
        typeof strhold !== 'undefined' && strhold.length !== 0
          ? strhold.split(',').map((i) => i.trim())
          : undefined;

      if (
        typeof allowLabels === 'undefined' &&
        typeof denyLabels === 'undefined' &&
        includeDrafts
      ) {
        core.info(
          `No limiting filters were provided, returning all ${prs.length} PRs, including drafts.`,
        );
        return prs;
      }

      return prs.filter((pr) => {
        let allow = true;
        const print = `Excluding ${`#${pr.number}`.yellow} ${pr.title} | ${
          `${pr.url}`.cyan.underline
        }`;
        if (!includeDrafts && isDraft(pr)) {
          core.info(`${print} due to draft status.`);
          return false;
        }

        if (typeof allowLabels !== 'undefined' && allowLabels.length !== 0) {
          allow =
            allow &&
            pr.labels.some((label) => allowLabels.includes(label.name));
          if (!allow)
            core.info(
              `${print} as none of the required labels (${allowLabels.join(
                ', ',
              )}) were present.`,
            );
        }

        if (typeof denyLabels !== 'undefined' && denyLabels.length !== 0) {
          allow =
            allow &&
            pr.labels.every((label) => !denyLabels.includes(label.name));
          if (!allow)
            core.info(
              `${print} because one of the blocking labels (${denyLabels.join(
                ', ',
              )}) was present.`,
            );
        }

        return allow;
      });
    } catch (error: unknown) {
      if (error instanceof Error) {
        core.error(error);
        core.setFailed(error.message);
      } else {
        core.error('An unknown error occurred while filtering pull requests.');
      }
    }
  }

  // Attempt to connect to the GitHub REST API
  let token: string | undefined = core.getInput('token', { required: false });
  if (!token || token === '') {
    token = process.env.GITHUB_TOKEN;
  }
  if (typeof token === 'undefined') {
    core.error('No token was provided.');
    core.setFailed('No token was provided.');
    return;
  }

  const client = github.getOctokit(token);
  if (!client) {
    core.error('Unable to create an authenticated client.');
    core.setFailed('Unable to create an authenticated client.');
    return;
  }

  /* Check if the token is valid */
  try {
    await client.rest.pulls.list({
      ...github.context.repo,
      base: github.context.payload.ref ?? 'main',
      sort: 'updated',
      direction: 'desc',
      state: 'open',
      per_page: 0,
      page: 0,
    });
  } catch (error: unknown) {
    if (error instanceof Error) {
      core.error(error);
      core.setFailed(error.message);
    } else {
      core.error(
        'An unknown error occurred while authenticating with the GitHub API.',
      );
    }
    return process.exit(1);
  }

  core.info('Successfully authenticated with the GitHub API.');

  if (github.context.payload.action === 'deleted') {
    core.info(
      'The ref was deleted, so there is no need to update any pull requests.',
    );
    return;
  }

  const strhold = core.getInput('limit');
  const limit: number | undefined =
    typeof strhold !== 'undefined' && strhold.length !== 0
      ? parseInt(strhold, 10)
      : undefined;

  /* Find out which pull requests exist to meet these requirements */
  const prs = new Map<number, ReturnPullData[number]>();
  if (typeof limit !== 'undefined' && limit > 100) {
    let pages = Math.ceil(limit / 100); // limit = 10, pages = 1; limit = 101, pages = 2
    do {
      if (prs.size >= limit) break;

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const nextPage = await fetchPullRequests(
        client!.rest,
        pages === 1 ? limit : 100,
      );
      if (
        !nextPage ||
        nextPage.status !== 200 ||
        !nextPage.data ||
        nextPage.data.length === 0
      )
        break;

      // if we have a result, filter out the PRs that don't meet the requirements
      // this must be done here so we know if we need to fetch another page
      const filtered = filterPullRequests(nextPage.data) ?? [];
      for (const pr of filtered) {
        if (prs.size >= limit) break;
        prs.set(pr.number, pr);
      }
    } while (prs.size < limit && --pages > 0);
  } else {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const page = await fetchPullRequests(client!.rest);
    if (page && page.status === 200 && page.data && page.data.length > 0) {
      for (const pr of filterPullRequests(page.data) ?? []) {
        prs.set(pr.number, pr);
      }
    }
  }

  /* No PRs? No problem! */
  if (prs.size === 0) {
    core.info('No pull requests found that meet the requirements.');
    core.setOutput('updated', 0);
    core.setOutput('failed', 0);
    return;
  }

  if (typeof limit !== 'undefined' && prs.size > limit) {
    core.info(
      `Limiting the PRs being updated to the first ${limit} to have been most recently updated, any remaining will be skipped.`,
    );
  }

  core.info(`Found ${prs.size} pull requests to update.\n\n`);
  await Promise.all(
    [...prs.values()].map(async (pr) => {
      core.debug(
        `Attempting to update ${`#${pr.number}`.yellow} ${pr.title} ${
          `${pr.url}`.underline.cyan
        }...`,
      );

      let result: PRUpdateRun | undefined;
      /* @todo Figure out how to configure rebase updates */
      try {
        result = await client.rest.pulls.updateBranch({
          ...github.context.repo,
          expected_head_sha: pr.head.sha,
          pull_number: pr.number,
        });
      } catch (err) {
        core.info(
          `Failed to update ${`#${pr.number}`.yellow} ${pr.title} ${
            `${pr.url}`.underline.cyan
          }`,
        );
        const error = err as Error;
        core.info(error.message);
      }

      if (!result) return { result, pr };

      core.debug(
        `Result: ${result.status} ${
          result.status >= 300
            ? `${result.data.message}\n${`${result.url}`.underline.cyan}`
            : ''
        }`,
      );
      return { result, pr };
    }),
  ).then((results): void => {
    if (!results) return;

    const isSuccessful = (r: PRUpdateRun): boolean =>
      r.status >= 200 && r.status < 300;

    const passed = results.filter((r) => r.result && isSuccessful(r.result));
    const failed = results!.filter((r) => !r.result || !isSuccessful(r.result));

    results = results.sort((a, b) => a!.pr.number - b!.pr.number);

    core.info(
      `\n\n-------------------------\nAttempted to update ${
        results.length
      } pull request${results.length === 1 ? '' : 's'}:\n${results
        .map(
          (r) =>
            `  ${r.result && isSuccessful(r.result) ? '✅' : '❌'}  ${
              `#${r!.pr.number}`.yellow
            } ${r!.pr.title}\t${`${r!.pr.number}`.underline.cyan}`,
        )
        .join('\n')}\n-------------------------\n\n${
        'Summary'.underline
      }\n---\n  ${`${passed.length}`.green} succeeded.\n  ${
        `${failed.length}`.red
      } failed.`,
    );

    core.setOutput('updated', passed.length);
    core.setOutput('failed', failed.length);
  });
}
