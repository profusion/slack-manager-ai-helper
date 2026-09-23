---
name: portfolio-resource
description: Manage monitored Slack users in pf-slack-plan-reviews-style portfolio.json manifests. Use when listing, adding, removing, or moving target members, including pausing empty active targets and resuming paused targets when their first member is added.
license: GPL-3.0-or-later
---

# Portfolio resourcing

1. Locate the consuming repository and its portfolio manifest.
   - Read its AGENTS.md and repository instructions before acting.
   - Confirm the helper is available as slack-manager-ai-helper or through the consuming repository's package script.
   - Read [references/manifest.md](references/manifest.md) before editing an unfamiliar manifest.
   - **Done when:** the manifest path, analysis ID when needed, and requested member change are unambiguous.

2. Inspect current membership non-interactively.
   - Run: slack-manager-ai-helper portfolio-resource list --manifest portfolio.json
   - Add --analysis <id> when the manifest has multiple analyses and --target <id> to narrow the output.
   - Resolve people by Slack user ID when possible; exact case-insensitive full names are also accepted when unique.
   - **Done when:** source and destination memberships and current target statuses are known.

3. Preview the requested mutation.
   - Add: slack-manager-ai-helper portfolio-resource add --manifest portfolio.json --target <target-id> --user <id-or-name> --channel <channel-id> [--role <role>] --dry-run
   - Remove from every override channel: slack-manager-ai-helper portfolio-resource remove --manifest portfolio.json --target <target-id> --user <id-or-name> --dry-run
   - Remove from one override channel by adding --channel <channel-id>.
   - Move: slack-manager-ai-helper portfolio-resource move --manifest portfolio.json --from <source-id> --to <destination-id> --user <id-or-name> --dry-run
   - By default, an active target that becomes empty is paused, and a paused target receiving its first member becomes active. Archived targets are untouched. Add --no-auto-status only when the operator explicitly wants statuses preserved.
   - Inspect detail.statusChanges in the JSON output.
   - **Done when:** the dry-run reports the intended channels, user, and status transitions without an error.

4. Apply the same command without --dry-run.
   - Preserve every argument from the approved preview.
   - Note the timestamped backup path from the JSON output.
   - **Done when:** the command reports ok: true, changed: true, and the expected detail.statusChanges.

5. Verify and deliver the consuming-repository change.
   - Re-run portfolio-resource list for every affected target.
   - Run git diff -- portfolio.json and confirm only intended membership/status changes.
   - Follow the consuming repository's checks and push workflow.
   - Use a short imperative commit subject such as move <name> from <a> to <b> or add <name> to <target>.
   - When the operator configures a BOT runner wrapper for Git and GitHub commands, run every agent-initiated Git or GitHub command through that wrapper; never use personal credentials.
   - **Done when:** list output and the diff agree, required checks pass, and any requested commit/push uses BOT identity.
