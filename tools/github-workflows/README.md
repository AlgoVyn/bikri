# GitHub Actions workflows (staged here — move to `.github/workflows/`)

`ci.yml`, `deploy.yml` and `website-guard.yml` belong in `.github/workflows/` (docs/01-architecture.md §4, §7.2; roadmap T-004).
They are staged in this folder because the token used to push the M0 branch had no GitHub `workflow` scope, and GitHub refuses
pushes that create files under `.github/workflows/` without it (D-063).

To activate them (from an account/token with the `workflow` scope):

```sh
git mv tools/github-workflows/*.yml .github/workflows/   # mkdir -p .github/workflows first
git rm tools/github-workflows/README.md
git commit -m "ci: T-004 activate workflows"
```

Then make the `ci` check required on `main` and, after the one-time Cloudflare setup (01 §7.1), set the repository variable `DEPLOY_ENABLED=true` (D-060).
