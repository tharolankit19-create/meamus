# Deploying the generation reliability fixes

1. In the existing Supabase project, run `supabase/migrations/20260905_build_coordination.sql` before deploying this branch. This adds the private build-plan table and an independent stop flag; it does not delete existing games or accounts. Fresh installations can run `supabase/schema.sql` instead.
2. Keep `OPENROUTER_API_KEY` in the server environment. Set `OPENROUTER_MODEL` to the exact NVIDIA/free model ID available in the account. Set `AGENT_CREW=false` for testing on free models, especially if the deployed environment previously forced it to `true`. Keep the existing Supabase credentials and stable `JWT_SECRET`.
3. Deploy after the migration. With the same environment, run `npm run llm:check` and `npm run db:persist-check`. These use real provider/database access; the repair PR was verified with local provider and storage stand-ins, not production secrets.
4. Try a small runner or shooter, play it, request one modification, and reload the project. Check a failed/rate-limited build leaves the original game and credits intact. Try Stop during a build and confirm that it is not charged.

The UI keeps the existing white/orange design. A free model now normally needs one generation request, followed by up to two repair attempts when its output is invalid. Provider retries respect Retry-After and share the build time budget. Failed AI requests are no longer substituted with an unrelated template in either generation endpoint.

The automated suites validate API behavior, provider responses, serverless initialization, storage coordination, scene boot checks, and composer/watcher interactions. They do not establish real-browser gameplay quality for arbitrary model output or measure production model availability. The repository's existing billing/authentication limitations still apply; this patch does not replace those systems.

Provider reference: [OpenRouter error and retry handling](https://openrouter.ai/docs/api_reference/errors-and-debugging).
