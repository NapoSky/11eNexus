# 11eNexus

- Node 24 (minimum 24.22.1), TypeScript 7, pnpm 12.14.0. Run `pnpm check` and `pnpm format:check` after changes. Tests use Jest with SWC.
- Keep the domain independent from Discord, SQLite and localization libraries. Application code depends on ports; infrastructure implements them.
- Update both `src/locales/fr.json` and `en.json` for user-visible copy. Public panel copy is short and bilingual; subsequent interactions are ephemeral and localized.
- Preserve channel history. Discord wins reconciliation. Never replay subscription assignments or recreate manually deleted resources without an explicit administrative operation.
- Expire open requests after 30 inactive days; retain closed requests for 30 days after closure, audit entries and terminal operations for 30 days. Preserve unresolved operations, game correlations and import receipts. Legacy records without lifecycle timestamps receive a 30-day rollout grace period.
- Admins are exempt from member creation, revival, proposal and search quotas; resource capacities, uniqueness and per-game safety checks still apply. Creation and revival share one member quota per rolling 24 hours. Provisional activation expires after 48 hours without human activity. Established inactivity is 30 days, with a baseline of 15 established games. Catalogue cap 150; archive cap 3 categories.
- Keep notification subscriptions independent from visibility. Game notification roles are mentionable so members can notify one another directly. All bot outbound messages must still explicitly restrict allowed mentions; the optional notification action may mention only its selected role.
- Treat `.env`, SQLite, backups, member exports and legacy operational scripts as private. Never print credentials. Do not change deployed SQL migration checksums; add migrations for future schema changes.
- Use the shared Pino logger for operational logs. Its error serializer and callback hook keep raw exception messages, request bodies and interaction tokens out of logs. Keep CLI results on stdout; logging goes to stderr.
- GitHub CI validates the code and image; deployment is manual. Keep integrations within free-tier allowances. Do not introduce Twitch authentication.
- Server mutations belong to explicit setup, reviewed import/application or authorized member/admin interactions. Tests and read-only diagnostics must not publish anything.
