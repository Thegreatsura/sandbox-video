# Security policy

## Reporting a vulnerability

Please report security issues privately through GitHub Security Advisories for
`curtis-arch/sandbox-video`. Do not open a public issue containing credentials,
private recording URLs, or a working exploit.

Include the affected commit or version, reproduction conditions, impact, and
any suggested mitigation. Public disclosure should wait until a fix is
available.

## Security boundaries

`sandbox-video` runs alongside the coding agent as the same operating-system
user. The uploads.sh credential is therefore not isolated from untrusted code
inside that Sandbox. Use the CLI only with trusted repositories and agent
workloads.

The current design uploads only after explicit `stop`; abrupt Sandbox loss can
destroy the local recording. A future remote chunk service would change this
boundary and requires a separate security review.
