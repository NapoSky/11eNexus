# 11eNexus

11eNexus keeps active game channels visible, archives inactive games without deleting their history, and lets members manage optional game notifications. The public panel is bilingual; personal menus and modals follow each member’s Discord language (French or English).

1. Copy `.env.example` to `.env` and supply the existing Discord bot token, guild ID and RAWG key. Protect it with `chmod 600 .env`.
2. Enable **Server Members Intent** in Discord’s Developer Portal. Place the bot’s role above game roles. Grant channel/role management, history, attachments/embeds, thread management, and role mention permissions. Onboarding edits also require server management. Message content intent is unnecessary.
3. Build with `docker compose build --pull`, then run `docker compose run --rm bot node dist/cli.js doctor` for a read-only check.
4. Import existing games using a reviewed manifest and plan. See [migration instructions](migration.md); existing channels are never adopted automatically.
5. Explicitly install the panel with `docker compose run --rm bot node dist/cli.js setup`, then `docker compose up -d`.

After generating the inventory, run `pnpm admin prepare --inventory data/inventory.json --output data/import-preparation.json --rawg --locale en`. Open `data/import-preparation.html`, review the proposed matches, and download the confirmed manifest. No JSON needs to be written by hand. Preparation only examines the two specified game categories. The standby category keeps its ID and becomes the first hidden archive; up to two more archives are created as needed. This preparation does not modify Discord. Stop any previous rotation automation before applying the import.

Notification roles are listed alphabetically. If a role is missing, choose **Create a role for this game**, with a RAWG image or an existing parent role icon. The plan verifies the image and capacity before any Discord changes. Applying it creates the role with zero global permissions and no initial subscribers, preserving the existing channel and history.

Members with the configured Syndiqué role can create or revive one game per rolling 24 hours. New or revived games need a first human message within 48 hours. Established games archive after 30 days, preserving the fifteen most recently active established games. Catalogue: 150 games; archives: up to three hidden categories. Voice channels and events are outside V1.

Subscribing does not revive a game. Creating or reviving does not subscribe or ping anyone. Members can mention game notification roles directly in conversations. The private game card’s optional **Notify players** action remains available; arbitrary mentions inside its text are suppressed. Its cooldown applies only to that action, not to manual mentions.

For an existing import made with non-mentionable roles, stop the bot and run `docker compose run --rm bot node dist/cli.js role-mentions --apply`, then restart it. This changes only existing catalogue roles, preserving subscriptions and channels. Without `--apply`, the command previews the changes. It checks all roles before updating any and can be rerun after interruption. `doctor` reports any remaining non-mentionable game roles in `unmentionableImportedRoles`. Normal reconciliation still respects manual Discord changes.

Discord wins during reconciliation. Manual channel moves, deleted resources and changed role holders are observed. Ambiguous partial operations require explicit administrator repair. No automatic channel deletion or history merging occurs.

Deployment is manual: pull the private repository, make a SQLite backup, then `docker compose up -d --build`. Back up the named volume using the CLI’s online SQLite backup command. Never remove the volume with `down -v`. See the [main guide](../README.md) for restoration and administration.

[RAWG Free](https://rawg.io/apidocs) allows personal noncommercial use and requires attribution links, which Nexus displays. Nexus caps its own requests at 18,000 per UTC month and has no paid fallback or Twitch connection. GitHub workflows use your account’s included Actions allowance; keep paid budgets at zero for strict free-tier use.
