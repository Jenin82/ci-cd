"""Fresh deployment authentication without real Infisical or SSH calls."""

from contextlib import redirect_stdout
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs


HELPER = Path(__file__).resolve().parents[1] / "scripts/django/deploy.py"
SPEC = importlib.util.spec_from_file_location("django_deploy", HELPER)
deployment = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(deployment)
TOKEN = "fresh-$literal;'quote%token"
ENV = {
    "BRANCH": "dev", "ENV_SLUG": "staging",
    "INFISICAL_CLIENT_ID": "client-id+value",
    "INFISICAL_CLIENT_SECRET": "private-secret&value",
    "INFISICAL_TOKEN": "expired-cached-token",
    "PATH": os.environ.get("PATH", ""),
}


def response_opener(payload=None, *, raw=None):
    response = Mock()
    response.read.return_value = raw if raw is not None else json.dumps(
        {"accessToken": TOKEN} if payload is None else payload
    ).encode()
    response.__enter__ = Mock(return_value=response)
    response.__exit__ = Mock(return_value=False)
    opener = Mock()
    opener.open.return_value = response
    return opener


class FreshAuthenticationTests(unittest.TestCase):
    def test_login_posts_encoded_credentials_to_https_origin(self):
        opener = response_opener()
        environment = {**ENV, "INFISICAL_DOMAIN": "https://secrets.example.test/"}
        self.assertEqual(deployment.fresh_token(environment, opener), TOKEN)
        request = opener.open.call_args.args[0]
        self.assertEqual(request.full_url, "https://secrets.example.test/api/v1/auth/universal-auth/login")
        self.assertEqual(request.method, "POST")
        self.assertEqual(request.get_header("Content-type"), "application/x-www-form-urlencoded")
        self.assertEqual(parse_qs(request.data.decode()), {
            "clientId": [ENV["INFISICAL_CLIENT_ID"]],
            "clientSecret": [ENV["INFISICAL_CLIENT_SECRET"]],
        })
        self.assertEqual(opener.open.call_args.kwargs, {"timeout": 30})
        opener.open.return_value.read.assert_called_once_with(65537)

    def test_empty_or_absent_domain_uses_official_https_origin(self):
        for domain in (None, ""):
            with self.subTest(domain=domain):
                opener = response_opener()
                environment = dict(ENV)
                if domain is not None:
                    environment["INFISICAL_DOMAIN"] = domain
                deployment.fresh_token(environment, opener)
                self.assertEqual(opener.open.call_args.args[0].full_url,
                                 "https://app.infisical.com/api/v1/auth/universal-auth/login")

    def test_invalid_configuration_never_contacts_provider_or_runner(self):
        invalid = [
            {"INFISICAL_CLIENT_ID": ""}, {"INFISICAL_CLIENT_SECRET": ""},
            {"BRANCH": ""}, {"BRANCH": "-dev"}, {"BRANCH": "dev;echo bad"},
            {"ENV_SLUG": "production"},
        ]
        invalid += [{"INFISICAL_DOMAIN": domain} for domain in (
            "http://secrets.example.test", "https://user:pass@example.test",
            "https://example.test/path", "https://example.test?query=value",
            "https://example.test#fragment", "https://example.test:invalid",
            "file:///tmp/secrets", "https://[invalid",
        )]
        for changes in invalid:
            with self.subTest(changes=changes):
                opener, runner = response_opener(), Mock()
                with self.assertRaises(deployment.DeploymentError):
                    deployment.deploy({**ENV, **changes}, opener=opener, runner=runner)
                opener.open.assert_not_called()
                runner.assert_not_called()

    def test_provider_failure_is_redacted_and_prevents_remote_deployment(self):
        for error in (
            HTTPError("https://private.example", 403, "private-secret expired", {},
                      io.BytesIO(b'private-secret response body')),
            URLError("private-secret network error"),
        ):
            with self.subTest(error=type(error).__name__):
                opener, runner = response_opener(), Mock()
                opener.open.side_effect = error
                with self.assertRaises(deployment.DeploymentError) as caught:
                    deployment.deploy(ENV, opener=opener, runner=runner)
                self.assertNotIn("private-secret", str(caught.exception))
                if isinstance(error, HTTPError):
                    self.assertIn("HTTP 403", str(caught.exception))
                runner.assert_not_called()

    def test_bad_provider_responses_prevent_remote_deployment(self):
        bad_payloads = [b'not json private-secret', b'x' * 65537]
        bad_payloads += [json.dumps(value).encode() for value in (
            {}, [], None, {"accessToken": ""}, {"accessToken": 123},
            {"accessToken": "has space"}, {"accessToken": "has\nnewline"},
            {"accessToken": "has\ttab"}, {"accessToken": "nonascii-\u00e9"},
            {"accessToken": "x" * 16385},
        )]
        for payload in bad_payloads:
            with self.subTest(payload_length=len(payload)):
                runner = Mock()
                with self.assertRaises(deployment.DeploymentError) as caught:
                    deployment.deploy(ENV, opener=response_opener(raw=payload), runner=runner)
                self.assertNotIn("private-secret", str(caught.exception))
                runner.assert_not_called()

    def test_authentication_disables_redirects(self):
        opener = response_opener()
        with patch.object(deployment, "build_opener", return_value=opener) as build:
            deployment.fresh_token(ENV)
        handler = build.call_args.args[0]
        self.assertIsInstance(handler, deployment.NoRedirects)
        self.assertIsNone(handler.redirect_request(None, None, 302, "redirect", {},
                                                   "https://other.example.test"))

    def test_runner_receives_only_temporary_token_and_preserves_exit_status(self):
        runner = Mock(return_value=Mock(returncode=17))
        stdout = io.StringIO()
        with redirect_stdout(stdout):
            code = deployment.deploy(ENV, opener=response_opener(), runner=runner)
        self.assertEqual(code, 17)
        self.assertEqual(stdout.getvalue(), "")
        args = runner.call_args.args[0]
        self.assertEqual(args[1], "deploy")
        self.assertNotIn(TOKEN, " ".join(args))
        self.assertNotIn(ENV["INFISICAL_CLIENT_SECRET"], " ".join(args))
        child = runner.call_args.kwargs["env"]
        self.assertEqual(child["DEPLOY_INFISICAL_TOKEN"], TOKEN)
        self.assertEqual(child["PATH"], ENV["PATH"])
        for key in ("INFISICAL_CLIENT_ID", "INFISICAL_CLIENT_SECRET", "INFISICAL_TOKEN"):
            self.assertNotIn(key, child)
        self.assertFalse(runner.call_args.kwargs["check"])

    def test_github_mask_is_escaped_and_flushed_before_runner_starts(self):
        output = Mock()
        def run(*args, **kwargs):
            output.write.assert_any_call("::add-mask::" + TOKEN.replace("%", "%25"))
            output.flush.assert_called()
            return Mock(returncode=0)
        with redirect_stdout(output):
            deployment.deploy({**ENV, "GITHUB_ACTIONS": "true"},
                              opener=response_opener(), runner=run)


class RemoteTokenCommandTests(unittest.TestCase):
    def invoke(self, stdin):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            stub = root / "deploy"
            stub.write_text("#!/bin/bash\nprintf '%s\\n' \"$INFISICAL_TOKEN\" > \"$RESULT\"\nprintf '%s\\n' \"$@\" >> \"$RESULT\"\n")
            stub.chmod(0o755)
            result_path = root / "result"
            environment = {**os.environ, "PATH": directory + ":" + os.environ["PATH"],
                           "RESULT": str(result_path)}
            command = deployment.deployment_command("feature/fresh-token", "staging")
            result = subprocess.run(command, shell=True, input=stdin, text=True,
                                    capture_output=True, env=environment, cwd=root)
            return result, result_path.read_text() if result_path.exists() else None, (root / "injected").exists()

    def test_token_shell_metacharacters_remain_literal_and_hidden(self):
        token = "literal$(touch${IFS}injected);'quote\\backslash%"
        result, received, injected = self.invoke(token + "\n")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(received, token + "\nfeature/fresh-token\n--env\nstaging\n")
        self.assertEqual(result.stdout + result.stderr, "")
        self.assertFalse(injected)

    def test_eof_empty_or_unterminated_token_prevents_deploy(self):
        for stdin in ("", "\n", "unterminated-token"):
            with self.subTest(stdin=stdin):
                result, received, _ = self.invoke(stdin)
                self.assertNotEqual(result.returncode, 0)
                self.assertIsNone(received)


if __name__ == "__main__":
    unittest.main()
