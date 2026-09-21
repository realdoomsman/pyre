import { Octokit } from "@octokit/rest";
import { prisma, type App } from "@pyre/db";
import { env } from "../env.js";
import { log } from "./logger.js";

export const octokit: Octokit = new Octokit({ auth: env.GITHUB_TOKEN, userAgent: "pyre-runner" });

let authenticatedLogin: string | null = null;

/** Split `owner/name`. */
export const repoParts = (fullName: string): { owner: string; repo: string } => {
  const [owner, repo] = fullName.split("/");
  if (!owner || !repo) throw new Error(`invalid repo name ${fullName}`);
  return { owner, repo };
};

/**
 * Ensure the app has a public MIT GitHub repo `GITHUB_OWNER/pyre-<slug>`.
 * Returns the `owner/name`. Idempotent: reuses an existing repo of that name.
 */
export const ensureAppRepo = async (
  app: Pick<App, "id" | "slug" | "repoFullName" | "spec">,
): Promise<{ fullName: string; url: string }> => {
  if (app.repoFullName) {
    return { fullName: app.repoFullName, url: `https://github.com/${app.repoFullName}` };
  }
  const owner = env.GITHUB_OWNER;
  const name = `pyre-${app.slug}`;
  const spec = app.spec && typeof app.spec === "object" && "oneLiner" in app.spec ? app.spec : null;
  const description = typeof spec?.oneLiner === "string" ? spec.oneLiner.slice(0, 300) : `Pyre app ${app.slug}`;

  let fullName = `${owner}/${name}`;
  let url = `https://github.com/${fullName}`;
  const existing = await octokit.repos.get({ owner, repo: name }).catch(() => null);
  if (existing) {
    fullName = existing.data.full_name;
    url = existing.data.html_url;
  } else {
    if (!authenticatedLogin) authenticatedLogin = (await octokit.users.getAuthenticated()).data.login;
    const body = {
      name,
      description,
      private: false,
      license_template: "mit",
      auto_init: false,
      has_wiki: false,
      has_projects: false,
    };
    const created =
      authenticatedLogin.toLowerCase() === owner.toLowerCase()
        ? await octokit.repos.createForAuthenticatedUser(body)
        : await octokit.repos.createInOrg({ org: owner, ...body });
    fullName = created.data.full_name;
    url = created.data.html_url;
    log.info({ appId: app.id, fullName }, "created app repo");
  }
  await prisma.app.update({ where: { id: app.id }, data: { repoFullName: fullName, repoUrl: url } });
  return { fullName, url };
};

/** Value for `git -c http.extraheader=...` so the token is used once and never written to disk. */
export const gitAuthHeader = (): string =>
  `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${env.GITHUB_TOKEN}`).toString("base64")}`;
