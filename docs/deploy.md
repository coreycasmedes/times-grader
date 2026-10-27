# Deploying and working on it

## Put it on GitHub

```bash
cd times-grader
# already a git repo with one commit; create an empty repo on github.com (no README), then:
git remote add origin https://github.com/<you>/times-grader.git
git push -u origin main
# or, with the GitHub CLI:
gh repo create times-grader --private --source . --push
```

## Live on a phone (GitHub Pages)
1. Push to `main` once. The **Deploy** workflow creates a `gh-pages` branch.
2. Go to **Settings → Pages → Source: Deploy from a branch**, then pick `gh-pages` and `/ (root)`.
3. Go to **Settings → Actions → General → Workflow permissions** and select **Read and write**.
4. Open `https://<you>.github.io/times-grader/` in Safari. Allow the camera, then add your Anthropic API key under **Settings**.

GitHub Pages on a private repo needs a paid GitHub plan. On a free plan, make the repo public, or host `dist/index.html` on Netlify or Vercel instead. Any HTTPS static host works.

## Pull request previews
Every PR gets its own live copy at `https://<you>.github.io/times-grader/pr-preview/pr-<number>/`. This is done by `.github/workflows/preview.yml`, which uses [rossjrw/pr-preview-action](https://github.com/rossjrw/pr-preview-action).
- The action posts the link as a PR comment and updates it on every push. You can open it on your phone and test the camera before merging.
- The preview is deleted when the PR closes.
- Merging to `main` doesn't wipe open previews, because `deploy.yml` skips the `pr-preview/` folder.
- Each preview keeps its own saved key and papers, separate from the main app (see `NS` in `src/app.js`).
- PRs from forks can't publish previews, because GitHub gives them a read-only token. Branches in this repo work.

## Inside Claude
`dist/claude-artifact.html` is the same app without the document wrapper. It can be published as a Claude artifact with the `sample` (images) and `downloads` capabilities. There, the key is read through Claude without an API key. The camera is blocked, so use video or photos.

## Before other teachers use it
- **API key:** don't ship your key in the page. Add a small proxy (for example a Cloudflare Worker or Vercel function) that holds the key and forwards only the two prompts the app sends. Point `askClaude()` in `src/app.js` at it.
- **Student data:** pages and names are stored only in the teacher's browser (IndexedDB and localStorage). Claude sees the key page, plus student pages only for names and ? answers. That can be turned off in Settings.

## Continue with Claude Code
`CLAUDE.md` at the repo root gives Claude Code the context it needs. Either:
- **Locally:** clone the repo, run `claude` in the folder, and ask for the next task.
- **In the cloud:** go to claude.ai/code, connect GitHub, pick this repo, and describe the task. For a private repo, install the Claude GitHub App on it. Claude works on a branch and you review the diff or open a PR.

No MCP server is needed. GitHub access is built into Claude Code.
