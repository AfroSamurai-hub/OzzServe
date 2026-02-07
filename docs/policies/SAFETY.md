# OzzServe Safety Policy

This document summarizes the safety protocols enforced within the OzzServe workspace to protect data integrity and secrets.

## 1. Destructive Commands
All destructive actions require explicit human confirmation. The AI will never execute these automatically without prior approval.
- **Examples**: `rm`, `mv` (globs), `git clean`, `docker system prune`, `chmod -R`.
- **Protocol**: The AI will first show the intended impact (e.g., via `ls` or `dry-run`) before asking to proceed.

## 2. Default to Dry-Runs
When proposing changes involving file deletions or system modifications, the AI will provide a "dry-run" or "ls" output first to ensure the user knows exactly what will happen.

## 3. Secret & Credential Handling
The AI is strictly prohibited from accessing or displaying sensitive information, including:
- Environment variables (`.env`).
- SSH keys and authentication tokens.
- Any files matching `secrets.*`.

## 4. Manual Execution
By default, all terminal commands suggested by the AI should be reviewed and run manually by the user unless a specific workflow has been approved for automatic execution.

---
*Policy Version: 1.0.0*
