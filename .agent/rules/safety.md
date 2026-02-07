# Safety Rules

To ensure a safe and secure development environment, the following rules apply to all AI interactions in this workspace:

## Terminal Command Safety
- **Destructive Commands**: Any command that could result in data loss or significant state changes requires explicit user confirmation. This includes:
  - `rm`, `rm -rf`
  - `mv` on broad globs or sensitive directories
  - `git clean`
  - `docker system prune`
  - `chmod -R`, `chown -R`
  - Wiping or resetting directories.
- **Dry-Run First**: Always default to suggesting "dry-run" alternatives before destructive actions. For example:
  - Use `ls` or `git status` before `rm` or `git clean`.
  - Use `git clean -n` before `git clean -f`.
- **Auto-Run Policy**: Terminal commands should be suggested to the user for manual execution. Do not use `SafeToAutoRun: true` for any command that has not been explicitly approved for automation.

## Secret Protection
- **Never Read Secrets**: Do not read, print, or expose secrets from the following file types or patterns:
  - `.env` files
  - `secrets.*` files
  - SSH keys (e.g., in `~/.ssh`)
  - API tokens or credential files
  - Hidden files known to contain credentials.

## Confirmation
- Always ask for explicit confirmation before proceeding with any action flagged as destructive.
