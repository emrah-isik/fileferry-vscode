# Security Policy

## Reporting a Vulnerability

If you believe you have found a security issue in FileFerry, please report it responsibly instead of disclosing it publicly right away.

**Report via GitHub:**
https://github.com/emrah-isik/fileferry-vscode/security/advisories/new

Please include as much detail as possible, such as:

- a clear description of the issue
- steps to reproduce it
- the affected version
- any logs, screenshots, or proof of concept that help explain the problem
- the potential impact

## What to Expect

I will review reports in good faith and try to assess:

- whether the issue is reproducible
- how severe it is
- what the safest fix path is

Please understand that this is an independent project and response times may vary.

## Scope

This policy is intended for security-related issues such as:

- credential exposure
- unintended remote access
- insecure secret handling
- command execution risks
- path traversal or file access issues
- vulnerabilities that could affect user systems or servers

General bugs, usability issues, and feature requests should be reported through the normal issue tracker unless they have a security impact.

## Supported Versions

Security fixes are generally provided for the latest published version of the extension.

## Notes

FileFerry is a developer tool that can connect to remote servers and perform file operations. Users should always:

- prefer SFTP over FTP
- test configurations carefully
- avoid storing secrets in project files
- verify remote targets before upload or delete operations
- maintain backups of important systems and files
