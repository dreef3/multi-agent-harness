import { Router } from "express";

export function createSettingsRouter(): Router {
  const router = Router();

  router.get("/providers", (_req, res) => {
    const githubToken = process.env.GITHUB_TOKEN;
    const bitbucketToken = process.env.BITBUCKET_TOKEN;
    const bitbucketBaseUrl = process.env.BITBUCKET_BASE_URL;

    res.json({
      providers: [
        {
          name: "github",
          configured: !!githubToken,
        },
        {
          name: "bitbucket-server",
          configured: !!(bitbucketToken && bitbucketBaseUrl),
        },
      ],
    });
  });

  return router;
}""
