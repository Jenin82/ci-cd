# Django deployment authentication

The Django runner authenticates with Infisical immediately before deployment,
using `INFISICAL_CLIENT_ID`, `INFISICAL_CLIENT_SECRET` and optional
`INFISICAL_DOMAIN` from GitHub Secrets. The identity must be allowed to read both
the target project's `/deploy` settings and its application secrets for the
requested `staging` or `prod` environment. No permissions are changed by the runner.

The helper is downloaded from this repository at the workflow's exact commit.
It masks the fresh access token before starting the SSH wrapper. The token is
sent through SSH standard input and exported as `INFISICAL_TOKEN` only for the
remote deployment process. The backend deployment script already prefers that
environment variable over `.infisical-token`, so an expired cached token does
not affect CI deployments. Long-lived client credentials stay in GitHub Actions;
the new access token is not written to the server or placed in command arguments.

Authentication errors stop before SSH deployment. Login response bodies are
never printed. The existing disk-full retry supplies the token again; Docker
cleanup and ordinary commands receive no token, and migrations keep their stdin.
Other deployment failures remain failures rather than falling back to cached
authentication. Direct manual deployments still need their own authentication.

Local checks use only synthetic credentials and fake HTTP/SSH commands:

```sh
python3 -m unittest discover -s tests -v
```

For an end-to-end staging check, comment `.deploy to staging` on the VKG backend
PR. Verify the central Django run's Deploy, migrations, restart and healthcheck
steps and its final PR status comment; a successful dispatch alone is not proof
that the server deployed.
