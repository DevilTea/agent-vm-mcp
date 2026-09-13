# Security policy

## Security model

`agent-vm-mcp` intentionally gives an authorized MCP client shell-equivalent control of a dedicated Linux agent VM.

The **VM is the trust boundary**. The project assumes that an authorized agent can access anything available to its Linux user or reachable from that VM, including files, mounted storage, environment variables, credentials, browser sessions, Docker, SSH material, local services, and network destinations permitted by the deployment.

This project is not intended to provide:

- sandboxing between agents, tools, bridges, or processes inside the VM;
- multi-tenant isolation;
- protection of VM-local secrets from the authorized agent;
- an authorization boundary around arbitrary shell commands;
- isolation from another process already running as the same trusted Linux user.

Operators are responsible for deciding what the VM can access. Prefer dedicated/rebuildable VMs and scoped, revocable credentials where practical.

## What is not a vulnerability by itself

The following are intentional capabilities or deployment properties and are not security vulnerabilities on their own:

- arbitrary command execution through `exec`;
- persistent process control;
- an authorized agent reading VM-local or VM-reachable credentials;
- Docker-group access granting broad host/container control inside the dedicated VM;
- Herdr workspaces, browser profiles, LSP host policies, path checks, or ownership markers not isolating processes that already share the same trusted Linux user;
- an operator deliberately exposing additional files, mounts, services, credentials, or network access to the VM.

Those mechanisms may still contain correctness bugs. A report is security-relevant when it crosses the documented trust boundary or grants capabilities to a party that was not already authorized for equivalent VM access.

## Examples of security-relevant reports

Examples include:

- an unauthenticated or unintended remote party gaining MCP/VM access because of a project defect;
- a transport/configuration bug causing credentials to be exposed outside the intended VM/client boundary;
- unsafe parsing that changes the documented trust boundary in a default or documented deployment;
- a supply-chain or release-integrity problem in distributed project artifacts;
- a project-owned service being exposed beyond its documented bind/access scope without operator action.

## Reporting

Please avoid publishing secrets, credentials, or working exploit details in a public issue.

Use GitHub private vulnerability reporting / a private security advisory for this repository when available. For ordinary correctness bugs that stay within the documented trust model, use the normal issue tracker.

## Supported versions

Until the project publishes a formal release-support policy, security fixes target the current `main` branch and the latest published release, if any.
