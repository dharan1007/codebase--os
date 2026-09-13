# Security Policy

## Supported versions

Security fixes are maintained on the latest supported release line and on the current production-hardening branch before release.

| Version | Security support |
|---|---|
| latest release | yes |
| older releases | best effort only |

## Reporting a vulnerability

Do not open a public issue for an unpatched vulnerability that could expose credentials, escape the project sandbox, execute unintended host commands, corrupt repositories, bypass approval/verification gates, or access the local dashboard from outside its intended boundary.

Report privately to **dharan.poduvu@gmail.com** and include, when possible:

- affected commit/version;
- operating system and Node/Docker versions;
- minimal reproduction;
- expected vs observed behavior;
- whether credentials or arbitrary code execution were involved;
- logs with secrets removed.

Do not include active API keys, access tokens, private keys, production credentials, or user data in the report.

## Security boundary

Codebase OS is a local engineering runtime that reads and modifies source repositories and can execute repository build/test commands. Treat every repository, source comment, dependency, generated file, build script and model response as potentially untrusted.

### File mutation

Autonomous existing-file changes use the transactional patch path:

1. project-root/symlink containment check;
2. runtime-controlled single-file patch target;
3. `git apply --check` preflight;
4. concurrent content-hash recheck;
5. apply;
6. durable change transaction;
7. independent verification before successful completion.

`write_file` cannot silently overwrite an existing file.

### Command execution

Docker is the default security boundary for autonomous shell commands. The sandbox uses a disposable writable workspace, read-only source mount/container root, resource limits, dropped capabilities, `no-new-privileges`, credential-file masking and network-off defaults.

If Docker is unavailable, native command execution is **blocked by default**. `COS_ALLOW_NATIVE_SANDBOX=1` is an explicit reduced-isolation override and should not be used for untrusted repositories.

### Credentials

The Docker sandbox does not inherit the parent process environment by default. Environment forwarding is explicit through `COS_SANDBOX_ENV_ALLOW`.

Credential-shaped repository files such as `.env`, registry credential files, PEM/private-key files and service-account/credential JSON patterns are masked before repository contents are copied into the disposable workspace. Example/template env files are not treated as secrets unless they match another credential rule.

This is defense in depth, not a secret-detection completeness guarantee. Do not store production credentials in source repositories.

### Network

Container networking is disabled for normal build/test commands. It is enabled only for recognized dependency installation/fetch operations (or explicit internal calls that require network). A network-enabled package installation may execute third-party lifecycle code inside the container; it should not be treated as trusted merely because it runs in Docker.

### Dashboard

The local dashboard binds to `127.0.0.1`. Static file serving is constrained to the packaged UI root, and mutation endpoints reject non-local/cross-origin requests. Do not expose the dashboard through a reverse proxy or port-forward without adding authentication and transport security appropriate to that environment.

### Model/source prompt injection

Repository text included in retrieval/propagation context is labeled as untrusted data. Scanner ingestion also removes several common prompt-instruction marker patterns before embedding. Pattern scrubbing is not a complete prompt-injection defense; tool policy, path isolation, transactional mutation and independent verification are the authoritative safety boundaries.

## Verification boundary

A model cannot certify its own mutation. After changes, the independent verification kernel discovers applicable project gates and executes them separately. If code changed and no supported verification strategy exists, completion fails closed.

A green verification result proves only the checks that actually ran. It does not mathematically prove absence of security vulnerabilities, logic errors or missing tests.

## Rollback boundary

Rollback is conflict-aware. A transaction is reversed only if the filesystem still matches the recorded post-change state. If a developer or later automation changed the same file, rollback stops rather than overwriting newer work.

## Recommended operating practice

- Use a clean Git worktree/branch for autonomous changes.
- Keep Docker running and leave native execution disabled.
- Use least-privilege, short-lived development credentials only when a task genuinely requires them.
- Keep sensitive `.env` and credential material outside source control.
- Review generated diffs and verification evidence before merging.
- Protect `main` with CI/branch rules in repositories where Codebase OS is used autonomously.
