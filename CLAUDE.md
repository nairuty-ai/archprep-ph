# ArkiPrep (formerly ArchPrep PH)

Business rules live in design_handoff_archprep_v2/BACKEND_RULES.md and override older specs (platform_v2_supabase_spec.md, ADMIN_GUIDE.md).

- v2 work runs in phases (see design_handoff_archprep_v2/CLAUDE_CODE_PROMPT.md); the gap report is docs/v2-gap-report.md.
- Brand is **ArkiPrep** (renamed from ArchPrep PH). Internal keys/ids (repo name, `archprep_*` storage keys, `AP-` order numbers) stay.
- Never edit an applied migration; add the next numbered one. After any migration change run `bash supabase/scripts/build_all.sh`.
- DB tests (Docker): `bash supabase/tests/run.sh` — v1→v2 data transform, reset/apply twice, verify-schema (130 checks), acceptance (BACKEND_RULES §14), real concurrency.
- SQL functions raise short error codes (ALREADY_OWNED, COUPON_UNAVAILABLE, …) that Edge Functions map to HTTP responses.
- Unit tests: `npm test`.
