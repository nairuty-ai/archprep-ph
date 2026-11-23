# ArchPrep PH

Business rules live in design_handoff_archprep_v2/BACKEND_RULES.md and override older specs (platform_v2_supabase_spec.md, ADMIN_GUIDE.md).

- v2 work runs in phases (see design_handoff_archprep_v2/CLAUDE_CODE_PROMPT.md); the gap report is docs/v2-gap-report.md.
- Never edit migrations 0001–0012; add new numbered migrations.
- Test migrations against Docker `supabase/postgres:15.8.1.085`: `supabase/scripts/01_reset.sql`, then `bash supabase/scripts/build_all.sh` and `02_all_migrations.sql`, then `supabase/verify-schema.sql`.
- Unit tests: `npm test`.
