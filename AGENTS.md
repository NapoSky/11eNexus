# 11eNexus

- Node 24 (minimum 24.22.1), TypeScript 7, pnpm 12.14.0. Run `pnpm check` and `pnpm format:check` after changes. Tests use Jest with SWC.
- Keep the domain independent from Discord, SQLite and localization libraries. Application code depends on ports; infrastructure implements them.
- Update both `src/locales/fr.json` and `en.json` for user-visible copy. Public panel copy is short and bilingual; subsequent interactions are ephemeral and localized.
- Preserve channel history. Discord wins reconciliation. Never replay subscription assignments or recreate manually deleted resources without an explicit administrative operation.
- Creation and revival share one member quota per rolling 24 hours. Provisional activation expires after 48 hours without human activity. Established inactivity is 30 days, with a baseline of 15 established games. Catalogue cap 150; archive cap 3 categories.
- Keep notification subscriptions independent from visibility. All outbound messages must explicitly restrict allowed mentions. Roles are not freely mentionable; use the controlled notification action.
- Treat `.env`, SQLite, backups, member exports and legacy operational scripts as private. Never print credentials. Do not change deployed SQL migration checksums; add migrations for future schema changes.
- GitHub CI validates the code and image; deployment is manual. Keep integrations within free-tier allowances. Do not introduce Twitch authentication.
- Server mutations belong to explicit setup, reviewed import/application or authorized member/admin interactions. Tests and read-only diagnostics must not publish anything.
