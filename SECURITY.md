# Security Policy

## Supported Versions

**COPC Cesium PointCloud Provider** (`copc-cesium`) is currently a pre-1.0
project. Until the first tagged release,
security fixes target the current `main` branch. After publishing begins, fixes
are provided for the latest released `0.x` version only.

| Version | Supported |
| --- | --- |
| Current `main` before the first tag | Yes |
| Latest `0.x` release after publishing begins | Yes |
| Earlier `0.x` releases | No |

Users should upgrade to the latest release before reporting a problem that may
already have been fixed.

## Reporting a Vulnerability

Do not open a public issue for a suspected vulnerability. Report it privately
through the repository's [GitHub security advisory form](https://github.com/KimDDong03/COPC-Cesium-PointCloud-Provider/security/advisories/new).

If that form is unavailable, private vulnerability reporting has not yet been
enabled. Do not disclose technical details publicly. Open only a non-sensitive
[private-channel request](https://github.com/KimDDong03/COPC-Cesium-PointCloud-Provider/issues/new?template=security_channel_request.yml)
asking the maintainer to enable a private reporting channel, then wait for that
channel before sharing the report. The request form deliberately forbids all
technical vulnerability details.

Include as much of the following as is safe to share:

- The affected version, commit, and environment.
- A clear description of the impact and attack scenario.
- Reproduction steps or a minimal proof of concept.
- Relevant logs with credentials, tokens, private URLs, and sensitive COPC
  data removed.
- Any known workaround or mitigation.
- Your preferred disclosure timeline, if applicable.

The project aims to acknowledge a report within five business days and provide
an initial assessment within ten business days. Complex reports may take
longer; updates will be posted in the private advisory while investigation or
remediation continues.

Please allow time for a fix and release before public disclosure. The project
will coordinate attribution and disclosure timing with the reporter when
practical.
