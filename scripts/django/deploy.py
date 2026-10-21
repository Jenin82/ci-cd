"""Authenticate each Django deployment and deliver its token over SSH stdin."""

import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


class DeploymentError(Exception):
    """A safe diagnostic that never contains provider bodies or credentials."""


class NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, request, file, code, message, headers, url):
        return None


def deployment_command(branch, environment):
    if not branch or not re.fullmatch(r"[A-Za-z0-9._/-]+", branch) or branch.startswith("-"):
        raise DeploymentError("Invalid deployment branch.")
    if environment not in ("staging", "prod"):
        raise DeploymentError("Invalid deployment environment.")
    # The command is public; the token arrives separately and is never evaluated.
    script = (
        'set +x; set -euo pipefail; IFS= read -r INFISICAL_TOKEN; '
        'test -n "$INFISICAL_TOKEN"; export INFISICAL_TOKEN; exec deploy '
        f"{shlex.quote(branch)} --env {shlex.quote(environment)}"
    )
    return "bash -c " + shlex.quote(script)


def fresh_token(environment, opener=None):
    client_id = environment.get("INFISICAL_CLIENT_ID", "")
    client_secret = environment.get("INFISICAL_CLIENT_SECRET", "")
    if not client_id or not client_secret:
        raise DeploymentError("Infisical Universal Auth credentials are missing.")
    domain = environment.get("INFISICAL_DOMAIN") or "https://app.infisical.com"
    try:
        parsed = urlsplit(domain)
        valid_domain = (
            parsed.scheme == "https" and parsed.hostname and not parsed.username
            and not parsed.password and parsed.path in ("", "/")
            and not parsed.query and not parsed.fragment
        )
        # Validate malformed ports before creating the request.
        parsed.port
    except ValueError:
        valid_domain = False
    if not valid_domain:
        raise DeploymentError("Infisical domain must be an HTTPS origin.")
    request = Request(
        domain.rstrip("/") + "/api/v1/auth/universal-auth/login",
        data=urlencode({"clientId": client_id, "clientSecret": client_secret}).encode(),
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    try:
        with (opener or build_opener(NoRedirects())).open(request, timeout=30) as response:
            payload = response.read(65537)
        if len(payload) > 65536:
            raise DeploymentError("Infisical login response is too large.")
        data = json.loads(payload)
    except HTTPError as error:
        raise DeploymentError(f"Infisical login failed (HTTP {error.code}).") from None
    except (URLError, OSError, ValueError):
        raise DeploymentError("Infisical login failed or returned invalid JSON.") from None
    token = data.get("accessToken") if isinstance(data, dict) else None
    if not isinstance(token, str) or not token or len(token) > 16384 or any(
        ord(character) < 33 or ord(character) > 126 for character in token
    ):
        raise DeploymentError("Infisical login returned an invalid access token.")
    return token


def deploy(environment=None, *, opener=None, runner=None):
    environment = dict(os.environ if environment is None else environment)
    command = deployment_command(environment.get("BRANCH"), environment.get("ENV_SLUG"))
    token = fresh_token(environment, opener)
    if environment.get("GITHUB_ACTIONS") == "true":
        print("::add-mask::" + token.replace("%", "%25"), flush=True)
    # Long-lived credentials stay on the runner. Only the fresh access token is
    # passed to the local SSH wrapper, which re-sends stdin on a deploy retry.
    child_environment = {
        key: value for key, value in environment.items()
        if key not in ("INFISICAL_CLIENT_ID", "INFISICAL_CLIENT_SECRET", "INFISICAL_TOKEN")
    }
    child_environment["DEPLOY_INFISICAL_TOKEN"] = token
    return (runner or subprocess.run)(
        [str(Path("run.sh").resolve()), "deploy", command],
        env=child_environment, check=False,
    ).returncode


if __name__ == "__main__":
    try:
        sys.exit(deploy())
    except DeploymentError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
