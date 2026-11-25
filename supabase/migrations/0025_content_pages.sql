-- 0025_content_pages.sql
-- Public content pages (CONTENT_PROMPT.md): the ALE guide and the ALE cheat
-- sheet, stored as JSON so admins can edit them in Admin → Content.
--
-- Additive only: two new tables, two new settings rows and two functions. No
-- existing table is changed. supabase/scripts/down_0025_content_pages.sql
-- reverses it.
--
-- - content_pages: the live JSON per page. Readable by anyone, but only while
--   the setting content_pages_enabled is 'on'; otherwise no client sees a row.
-- - content_page_versions: the previous 10 versions per page, for restore.
--   Service role only.
-- - content_page_save / content_page_restore: the only write path (called by
--   the admin-content Edge Function as the service role). Each one archives
--   the current JSON, writes the new one and an audit_log row, in one
--   transaction.

-- ---------------------------------------------------------------------------
-- Settings: the feature flag (default off) and the site domain used for
-- canonical links. Both display-safe: the header and the page renderer read
-- them with the anon key.
-- ---------------------------------------------------------------------------
insert into public.settings (key, value, display_safe) values
  ('content_pages_enabled', 'off', true),
  ('site_domain',           '',    true)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.content_pages (
  slug       text primary key check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  json       jsonb not null check (jsonb_typeof(json) = 'object'),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null
);

create table public.content_page_versions (
  id         bigserial primary key,
  slug       text not null references public.content_pages(slug) on delete cascade,
  json       jsonb not null,
  saved_at   timestamptz not null,
  saved_by   uuid references public.profiles(id) on delete set null,
  archived_at timestamptz not null default now()
);
create index content_page_versions_slug_idx on public.content_page_versions (slug, id desc);

alter table public.content_pages enable row level security;
alter table public.content_pages force row level security;
alter table public.content_page_versions enable row level security;
alter table public.content_page_versions force row level security;

-- Clients may read the live pages, and only while the flag is on. No write
-- grant or policy for any client role.
grant select on public.content_pages to anon, authenticated;
revoke insert, update, delete, truncate, references, trigger
  on public.content_pages from anon, authenticated;
revoke all on public.content_page_versions from anon, authenticated;

create policy content_pages_select_enabled on public.content_pages
  for select to anon, authenticated
  using (exists (select 1 from public.settings
                  where key = 'content_pages_enabled' and lower(btrim(value)) = 'on'));

-- ---------------------------------------------------------------------------
-- Functions
-- ---------------------------------------------------------------------------

-- Save a page. Archives the current JSON, writes the new one, keeps the 10
-- newest versions, and logs to audit_log. p_expected_updated_at, when given,
-- refuses the save if someone else saved in the meantime (STALE_CONTENT).
create or replace function public.content_page_save(
  p_slug text, p_json jsonb, p_actor uuid, p_actor_email text,
  p_expected_updated_at timestamptz default null, p_action text default 'content_page_saved',
  p_details jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cur public.content_pages%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  if p_json is null or jsonb_typeof(p_json) <> 'object' then
    raise exception 'CONTENT_INVALID';
  end if;

  select * into v_cur from public.content_pages where slug = p_slug for update;
  if not found then
    raise exception 'CONTENT_NOT_FOUND';
  end if;
  if p_expected_updated_at is not null
     and date_trunc('milliseconds', v_cur.updated_at) <> date_trunc('milliseconds', p_expected_updated_at) then
    raise exception 'STALE_CONTENT';
  end if;

  insert into public.content_page_versions (slug, json, saved_at, saved_by)
  values (v_cur.slug, v_cur.json, v_cur.updated_at, v_cur.updated_by);

  delete from public.content_page_versions
   where slug = p_slug
     and id not in (select id from public.content_page_versions
                     where slug = p_slug order by id desc limit 10);

  update public.content_pages
     set json = p_json, updated_at = v_now, updated_by = p_actor
   where slug = p_slug;

  insert into public.audit_log (actor_id, actor_email, area, action, target, details)
  values (p_actor, p_actor_email, 'content', p_action, p_slug,
          coalesce(p_details, '{}'::jsonb)
            || jsonb_build_object('bytes', octet_length(p_json::text),
                                  'previous_updated_at', v_cur.updated_at));

  return jsonb_build_object('slug', p_slug, 'updated_at', v_now);
end $$;

-- Restore an archived version: saved as a new current version (so the page
-- being replaced is archived too, and the restore itself can be undone).
create or replace function public.content_page_restore(
  p_version_id bigint, p_actor uuid, p_actor_email text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ver public.content_page_versions%rowtype;
begin
  select * into v_ver from public.content_page_versions where id = p_version_id;
  if not found then
    raise exception 'VERSION_NOT_FOUND';
  end if;
  return public.content_page_save(v_ver.slug, v_ver.json, p_actor, p_actor_email, null,
    'content_page_restored', jsonb_build_object('version_id', v_ver.id, 'version_saved_at', v_ver.saved_at));
end $$;

revoke execute on function public.content_page_save(text, jsonb, uuid, text, timestamptz, text, jsonb)
  from public, anon, authenticated;
revoke execute on function public.content_page_restore(bigint, uuid, text)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Seed: generated from content/*.json. Existing rows are left alone.
-- ---------------------------------------------------------------------------
-- BEGIN GENERATED SEED (supabase/scripts/gen_content_seed.mjs)
insert into public.content_pages (slug, json) values
  ('ale-guide', $seed${"updated":"2026-11","sources":[{"label":"PRC exam programs & Board of Architecture syllabi","url":"https://www.prc.gov.ph"},{"label":"Republic Act No. 9266","url":"https://lawphil.net/statutes/repacts/ra2004/ra_9266_2004.html"}],"toc":[{"id":"g-glance","label":"At a glance"},{"id":"g-schedule","label":"Schedule"},{"id":"g-passing","label":"How you pass"},{"id":"g-syllabus","label":"Syllabus"},{"id":"g-eligible","label":"Who can take it"},{"id":"g-strategy","label":"Study plan"},{"id":"g-day","label":"Exam day"},{"id":"g-myths","label":"Common mistakes"},{"id":"g-final","label":"Final 7 days"}],"glance":[{"label":"EXAM","value":"Architect Licensure Examination (ALE)"},{"label":"GIVEN BY","value":"PRC, through the Board of Architecture"},{"label":"HELD","value":"Twice a year, on PRC-set dates"},{"label":"LENGTH","value":"2 consecutive exam days"},{"label":"SUBJECTS","value":"3, weighted 30 / 30 / 40"},{"label":"FORMAT","value":"Multiple choice, incl. situational design problems"},{"label":"TO PASS","value":"70% weighted average"},{"label":"SUBJECT FLOOR","value":"No subject below 50%"},{"label":"DEGREE","value":"BS Architecture from a recognized school"},{"label":"EXPERIENCE","value":"2 years diversified, certified by an architect"},{"label":"MASTER'S DEGREE","value":"Credits 1 of the 2 years"},{"label":"GOVERNING LAW","value":"RA 9266, Architecture Act of 2004"}],"sessions":[{"day":"DAY 1 · MORNING","time":"About 8:00 AM – 1:00 PM","length":"≈ 5 hours","code":"SUBJECT A","name":"History & Theory of Architecture, Principles of Planning & Architectural Practice","format":"Multiple choice. Recall plus applied items on laws, ethics, contracts and planning standards.","weight":"30%","color":"#2f5fae"},{"day":"DAY 1 · AFTERNOON","time":"About 2:00 PM – 7:00 PM","length":"≈ 5 hours","code":"SUBJECT B","name":"Structural Conceptualization, Building Materials & Technology, and Utilities","format":"Multiple choice. Concept and code-limit items; light computation, so bring your calculator.","weight":"30%","color":"#7fa6e6"},{"day":"DAY 2 · FULL DAY","time":"About 8:00 AM – 6:00 PM","length":"≈ 10 hours","code":"SUBJECT C","name":"Architectural Design & Site Planning","format":"Several situational design and site problems, each with multiple-choice answers. You sketch on scratch paper to test layouts, then shade the answer sheet. This replaced the old single drafting plate.","weight":"40%","color":"#e59819"}],"syllabus":{"A":{"weight":"30%","when":"DAY 1 · MORNING · 30%","name":"History & Theory of Architecture, Principles of Planning & Architectural Practice","courseId":1,"cta":"Subject A Reviewer · ₱49","note":"Covered by our Subject A Reviewer and 300-item Quiz Pack.","groups":[{"title":"History of architecture","items":["Prehistoric and ancient works","Western styles, classical to modern","Asian and Pacific traditions","Philippine architecture, pre-colonial to contemporary","Heritage conservation and restoration"]},{"title":"Theory of architecture","items":["Principles and elements of design","Space, form, order and proportion","Anthropometrics and proxemics","Tropical, climate-responsive design","Master architects and their ideas"]},{"title":"Planning","items":["Urban and regional planning","Land use and zoning","Human settlements and housing","Urban design and public space","Site planning and landscape"]},{"title":"Professional practice","items":["RA 9266 and the role of the PRBoA","UAP standards of professional practice","Code of ethics and conduct","Services, fees and agreements","Contract documents and specifications"]},{"title":"Building laws","items":["PD 1096 National Building Code","BP 344 Accessibility Law","RA 9514 Fire Code","Related referral codes"]}]},"B":{"weight":"30%","when":"DAY 1 · AFTERNOON · 30%","name":"Structural Conceptualization, Building Materials & Technology, and Utilities","courseId":2,"cta":"Subject B Reviewer · ₱49","note":"Covered by our Subject B Reviewer and 300-item Quiz Pack.","groups":[{"title":"Structural conceptualization","items":["Loads, forces and equilibrium","Stress, strain and material behaviour","Structural systems and framing","Seismic principles and the NSCP","Timber, concrete, steel and composite"]},{"title":"Building materials","items":["Concrete, masonry and finishes","Wood, carpentry and joinery","Metals and sheet metal","Waterproofing, dampproofing, insulation","Glass, glazing, doors, windows, hardware"]},{"title":"Construction & technology","items":["Construction methods and sequencing","Specifications","Quality control and site safety","Quantity estimates","Prefabricated and emerging systems"]},{"title":"Building utilities","items":["Water supply, plumbing and sanitary","Storm drainage and waste systems","Electrical power and lighting","HVAC and acoustics","Fire protection, conveyors, security, communications"]}]},"C":{"weight":"40%","when":"DAY 2 · FULL DAY · 40%","name":"Architectural Design & Site Planning","courseId":null,"cta":null,"note":"Subject C materials are not on ArkiPrep yet. Use this list to plan your own timed design practice.","groups":[{"title":"Design method","items":["Reading the problem statement","Programming and space schedules","Adjacency and functional relationships","Circulation and zoning of spaces","Form, massing and systems coordination"]},{"title":"Site analysis & planning","items":["Topography and contours","Sun path, wind and rainfall","Context, access and views","Vehicle and pedestrian circulation","Open space and landscape"]},{"title":"Development controls","items":["Setbacks, yards and easements","Percentage of site occupancy","Floor area and height limits","Parking and loading","Accessibility and egress in layouts"]},{"title":"Building types","items":["Residential and mixed-use","Commercial and institutional","Educational and healthcare","Recreation, religious and government","Transport, industrial and complex projects"]}]}},"eligibility":["Filipino citizen, or a foreign national whose country allows Filipino architects to practise there (reciprocity)","Of good moral character","Graduate of BS Architecture from a school recognized by the government","At least 2 years of diversified architectural experience, certified by a registered and licensed architect","A Master's in Architecture can credit 1 of those 2 years"],"retakeNote":"You can apply for the next scheduled exam. Repeaters submit updated requirements, including a current NBI clearance. Check PRC's checklist when you file.","studyPlan":{"totalHours":200,"split":{"A":55,"B":55,"C":90},"phases":[{"weeks":"WEEKS 1–2","title":"Diagnose","items":["Take a baseline test in every subject","Mark weak topics on the syllabus list above","Fix one daily study block and protect it"],"useLabel":"Free 25-item diagnostic","courseId":6},{"weeks":"WEEKS 3–6","title":"Build","items":["Rotate Subject A and B reading by day","Turn each law into a one-page table","Start one design problem a week"],"useLabel":"Subject A & B reviewers","courseId":1},{"weeks":"WEEKS 7–10","title":"Apply","items":["Timed quizzes, 50–100 items a sitting","Keep an error log: why you missed it","Two timed design problems a week"],"useLabel":"300-item quiz packs","courseId":4},{"weeks":"WEEKS 11–12","title":"Simulate","items":["Full sittings at real length: 5 h, 5 h, full day","Review only your error log and tables","No new topics in the last 3 days"],"useLabel":"Full mock board","courseId":3}],"week":[{"day":"MON","task":"Subject A · read + 50 items","kind":"a"},{"day":"TUE","task":"Design problem · timed","kind":"c"},{"day":"WED","task":"Subject B · read + 50 items","kind":"a"},{"day":"THU","task":"Design problem · timed","kind":"c"},{"day":"FRI","task":"Weak topics from error log","kind":"a"},{"day":"SAT","task":"Mixed timed set · 100 items","kind":"a"},{"day":"SUN","task":"Rest + 30 min error-log review","kind":"r"}]},"examDayKit":[{"title":"Both days","items":["Notice of Admission and a valid ID","Two or more No. 2 pencils","Black-ink ballpens","One non-programmable calculator (it is checked and reset)"]},{"title":"Design day adds","items":["Architect's scales","30°–60° and 45° triangles, protractor","Sketching pencils, pens and erasers","Graphing or bond scratch paper","NBCP excerpt, Rules VII & VIII, clean and unmarked"]},{"title":"Leave at home","items":["Programmable calculators","Annotated or highlighted code copies","Phones and smart devices in the exam room","Plans to keep scratch paper: all papers are surrendered"]}],"myths":[{"myth":"“My average is 72%, so I passed.”","fact":"You also need at least 50% in every subject. One weak subject fails the whole exam."},{"myth":"“Two days means two subjects.”","fact":"There are three. Day 1 has two 5-hour sessions; Day 2 is all design."},{"myth":"“Design day is one big drafting plate.”","fact":"It is now a set of situational design and site problems with multiple-choice answers. Sketch to test, then shade."},{"myth":"“My master's replaces work experience.”","fact":"It credits one year. You still need the other year of diversified experience."},{"myth":"“Any calculator will do.”","fact":"Only one non-programmable calculator, and it is inspected at the door."},{"myth":"“I'll highlight my NBCP copy.”","fact":"Bring a clean, unmarked copy of Rules VII and VIII. Marked copies can be taken."},{"myth":"“Review questions are leaked board items.”","fact":"Legitimate reviewers write original questions that follow the syllabus. Ours do too."}],"finalWeek":["Check your venue, room and reporting time on your Notice of Admission","Pack both kits the night before; test your calculator battery","Read your one-page tables, not new chapters","Do one design problem to keep your speed up","Take a last full sitting only if you are 5+ days out","Sleep 7–8 hours, especially before Day 2","Eat before each session; Day 2 runs close to 10 hours"],"calculatorPresets":[{"label":"Passes","A":74,"B":71,"C":77},{"label":"Fails on floor","A":88,"B":86,"C":46},{"label":"Fails on average","A":68,"B":66,"C":70}]}$seed$::jsonb),
  ('ale-cheatsheet', $seed${"updated":"2026-11","keyNumbers":[{"value":"70%","label":"minimum weighted average"},{"value":"50%","label":"minimum in every subject"},{"value":"30 · 30 · 40","label":"weights of A · B · C"},{"value":"5 · 5 · 10 h","label":"session lengths"},{"value":"2 yrs","label":"diversified experience"},{"value":"RA 9266","label":"Architecture Act of 2004"}],"tags":{"A":{"label":"SUBJ A","bg":"#e8ebf2","fg":"#1d2b4a"},"B":{"label":"SUBJ B","bg":"#e3eefc","fg":"#1f4686"},"C":{"label":"SUBJ C","bg":"#fdf1d8","fg":"#7a4b00"},"X":{"label":"EXAM","bg":"#dcf2e6","fg":"#1f7a4f"}},"cards":[{"tag":"X","type":"terms","title":"Passing & scoring","rows":[{"term":"Rule 1","meaning":"Weighted average ≥ 70%"},{"term":"Rule 2","meaning":"Every subject ≥ 50%"},{"term":"Formula","meaning":"A×.30 + B×.30 + C×.40"},{"term":"Both rules","meaning":"Must be met together"},{"term":"Weakest link","meaning":"A subject under 50% fails the exam outright"}]},{"tag":"X","type":"terms","title":"Schedule","rows":[{"term":"Day 1 AM","meaning":"Subject A · about 5 h"},{"term":"Day 1 PM","meaning":"Subject B · about 5 h"},{"term":"Day 2","meaning":"Subject C · about 10 h"},{"term":"Day 2 format","meaning":"Situational design problems, multiple choice"},{"term":"Official times","meaning":"PRC program, released per exam"}]},{"tag":"A","type":"terms","title":"Architectural history","rows":[{"term":"Prehistoric","meaning":"Dolmen, menhir, cromlech"},{"term":"Greek","meaning":"Doric, Ionic, Corinthian orders"},{"term":"Roman","meaning":"Arch, vault, dome, concrete"},{"term":"Gothic","meaning":"Pointed arch, rib vault, flying buttress"},{"term":"Renaissance","meaning":"Proportion and classical revival"},{"term":"Modern","meaning":"Form follows function, new materials"},{"term":"Philippine","meaning":"Bahay kubo, bahay na bato, Earthquake Baroque"},{"term":"Heritage","meaning":"Preserve, conserve, restore, adapt"}]},{"tag":"A","type":"terms","title":"Design theory","rows":[{"term":"Vitruvian triad","meaning":"Firmness, commodity, delight"},{"term":"Anthropometrics","meaning":"Body sizes, reach, clearances"},{"term":"Proxemics","meaning":"Social distance; varies by culture"},{"term":"Circulation","meaning":"Organizes how people move"},{"term":"Tropical design","meaning":"Shade, cross-ventilation, rain cover"},{"term":"Design process","meaning":"Turns user needs into form"}]},{"tag":"A","type":"compare","title":"Preservation vs restoration","left":{"title":"Preservation","items":["Keeps what exists","Stops further decay","Minimal intervention"]},"right":{"title":"Restoration","items":["Returns to a chosen period","May remove later additions","Needs strong evidence"]},"tagline":"Keep as is vs bring back as it was"},{"tag":"A","type":"terms","title":"Planning","rows":[{"term":"CLUP","meaning":"Long-term land-use plan of an LGU"},{"term":"Zoning ordinance","meaning":"Legal tool that enforces the CLUP"},{"term":"Regional planning","meaning":"Development across several LGUs"},{"term":"Urban design","meaning":"Shapes streets and public space"},{"term":"Human settlements","meaning":"Housing and community services"},{"term":"Site planning","meaning":"Arranges one property in detail"}]},{"tag":"A","type":"terms","title":"RA 9266 roles & terms","rows":[{"term":"PRBoA","meaning":"Regulates the practice of architecture"},{"term":"Architect-of-record","meaning":"Responsible for the total design; signs documents"},{"term":"Architect-in-charge of construction","meaning":"Directs and supervises construction"},{"term":"Consulting architect","meaning":"Recognized specialist adviser"},{"term":"Seal","meaning":"Marks professional responsibility"},{"term":"Instruments of service","meaning":"Drawings and specs stay the architect's intellectual property"},{"term":"Service agreement","meaning":"Written scope and fees"}]},{"tag":"A","type":"picker","title":"Which document do you need?","header":"IF YOU NEED…  →  USE","rows":[{"need":"Scope and fee in writing","use":"Service agreement"},{"need":"Owner's requirements listed","use":"Architectural program"},{"need":"A first design direction","use":"Schematic design"},{"need":"A refined, coordinated design","use":"Design development"},{"need":"Size, shape and location","use":"Drawings"},{"need":"Quality of materials and work","use":"Specifications"},{"need":"Binding construction terms","use":"Contract documents"}]},{"tag":"A","type":"compare","title":"Drawings vs specifications","left":{"title":"Drawings","items":["Graphic","Size, shape, location","Quantities and relationships"]},"right":{"title":"Specifications","items":["Written","Quality and standards","Materials and workmanship"]},"tagline":"Drawings show; specs describe"},{"tag":"A","type":"terms","title":"Laws to know by number","rows":[{"term":"PD 1096","meaning":"National Building Code"},{"term":"BP 344","meaning":"Accessibility Law"},{"term":"RA 9514","meaning":"Fire Code of 2008"},{"term":"RA 9266","meaning":"Architecture Act of 2004"},{"term":"PD 957","meaning":"Subdivision & condominium buyers' protection"},{"term":"BP 220","meaning":"Economic & socialized housing standards"},{"term":"RA 7279","meaning":"Urban Development & Housing Act"}]},{"tag":"B","type":"terms","title":"Structures","rows":[{"term":"Equilibrium","meaning":"ΣF = 0 and ΣM = 0"},{"term":"Stress","meaning":"Force ÷ area"},{"term":"Strain","meaning":"Change in length ÷ original length"},{"term":"Modulus of elasticity","meaning":"Stress ÷ strain (elastic range)"},{"term":"Factor of safety","meaning":"Capacity ÷ working load"},{"term":"Seismic design","meaning":"Lateral loads, ductility, regular plans"},{"term":"NSCP","meaning":"National Structural Code of the Philippines"}]},{"tag":"B","type":"terms","title":"Materials","rows":[{"term":"Concrete","meaning":"Strong in compression, weak in tension"},{"term":"Rebar","meaning":"Carries the tension in RC"},{"term":"Structural steel","meaning":"High strength; needs fire and rust protection"},{"term":"Timber","meaning":"Light; strength follows the grain"},{"term":"Masonry","meaning":"Good in compression, needs reinforcement for quakes"},{"term":"Glazing","meaning":"Light and views; watch heat gain"}]},{"tag":"B","type":"compare","title":"Waterproofing vs dampproofing","left":{"title":"Waterproofing","items":["Resists water under pressure","Basements, roofs, wet areas","Membranes, coatings"]},"right":{"title":"Dampproofing","items":["Resists moisture and vapour","Walls and slabs on grade","No hydrostatic pressure"]},"tagline":"Liquid water vs moisture"},{"tag":"B","type":"terms","title":"Building utilities","rows":[{"term":"Plumbing","meaning":"Supply, fixtures, traps, vents"},{"term":"Trap seal","meaning":"50–100 mm deep"},{"term":"Sanitary drainage","meaning":"Wastewater from fixtures"},{"term":"Storm drainage","meaning":"Rainwater from roofs and paving"},{"term":"HVAC","meaning":"Cools, ventilates, moves air"},{"term":"Electrical","meaning":"Service, panels, branch circuits"},{"term":"Acoustics","meaning":"Absorption, isolation, reverberation"},{"term":"Fire protection","meaning":"Detection, alarm, suppression"}]},{"tag":"B","type":"picker","title":"Which system handles it?","header":"PROBLEM  →  SYSTEM","rows":[{"need":"Fixture wastewater","use":"Sanitary drainage"},{"need":"Roof rainwater","use":"Storm drainage"},{"need":"Fresh air and cooling","use":"HVAC"},{"need":"Noise between rooms","use":"Sound isolation"},{"need":"Early smoke warning","use":"Fire detection & alarm"},{"need":"Moving people up floors","use":"Elevators & escalators"}]},{"tag":"C","type":"picker","title":"Design-day toolkit","header":"TO FIND…  →  USE","rows":[{"need":"Total floor areas","use":"Space schedule"},{"need":"Which rooms sit together","use":"Adjacency matrix"},{"need":"How users move","use":"Bubble or flow diagram"},{"need":"Site limits at a glance","use":"Site analysis overlay"},{"need":"Slope and grades","use":"Contour map"},{"need":"Sun on each facade","use":"Sun-path diagram"},{"need":"Prevailing breeze","use":"Wind rose"},{"need":"Solid vs open pattern","use":"Figure-ground"}]},{"tag":"C","type":"terms","title":"Development controls (PD 1096)","rows":[{"term":"PSO","meaning":"Percentage of site occupancy"},{"term":"ISA","meaning":"Impervious surface area"},{"term":"USA","meaning":"Unpaved surface area"},{"term":"TGFA","meaning":"Total gross floor area"},{"term":"FLAR","meaning":"Floor-lot area ratio"},{"term":"BHL","meaning":"Building height limit"},{"term":"Setbacks / yards","meaning":"Required open space at lot lines"}]},{"tag":"C","type":"terms","title":"Site & climate (PH)","rows":[{"term":"Climate","meaning":"Hot-humid tropical"},{"term":"Amihan","meaning":"Northeast monsoon, cooler and drier"},{"term":"Habagat","meaning":"Southwest monsoon, rainy"},{"term":"Orientation","meaning":"Long axis east–west cuts sun on long walls"},{"term":"Openings","meaning":"Face prevailing breeze for cross-ventilation"},{"term":"Drainage","meaning":"Follow natural slope away from buildings"}]},{"tag":"C","type":"terms","title":"Solving a design problem","rows":[{"term":"1 · Read","meaning":"List requirements and constraints"},{"term":"2 · Program","meaning":"Spaces with target areas"},{"term":"3 · Relate","meaning":"Adjacencies and separations"},{"term":"4 · Zone","meaning":"Public, private, service"},{"term":"5 · Test","meaning":"Sketch quick options"},{"term":"6 · Check","meaning":"Setbacks, PSO, egress, access"},{"term":"7 · Answer","meaning":"Pick the option that meets all"}]},{"tag":"C","type":"compare","title":"Planning vs site planning","left":{"title":"Planning","items":["City or region","Land-use frameworks","Policy and settlements"]},"right":{"title":"Site planning","items":["One property","Buildings and open space","Access, parking, landscape"]},"tagline":"Big framework vs one site"},{"tag":"X","type":"terms","title":"Eligibility","rows":[{"term":"Citizenship","meaning":"Filipino, or reciprocity country"},{"term":"Character","meaning":"Good moral character"},{"term":"Degree","meaning":"BS Architecture, recognized school"},{"term":"Experience","meaning":"2 years diversified, certified"},{"term":"Master's","meaning":"Credits 1 of the 2 years"}]},{"tag":"X","type":"terms","title":"Exam-day kit","rows":[{"term":"Documents","meaning":"Notice of Admission + valid ID"},{"term":"Writing","meaning":"No. 2 pencils, black ballpens"},{"term":"Calculator","meaning":"One, non-programmable, inspected"},{"term":"Design day","meaning":"Scales, triangles, protractor"},{"term":"Scratch","meaning":"Graphing or bond paper"},{"term":"NBCP excerpt","meaning":"Rules VII & VIII, unmarked"},{"term":"After","meaning":"All papers are surrendered"}]}],"traps":[{"a":"Average ≥ 70%","b":"Each subject ≥ 50%"},{"a":"2 exam days","b":"3 graded subjects"},{"a":"Architect-of-record","b":"Architect-in-charge of construction"},{"a":"Sanitary drainage","b":"Storm drainage"},{"a":"PSO (ground coverage)","b":"FLAR (total floor area)"},{"a":"Amihan (NE, dry)","b":"Habagat (SW, rainy)"},{"a":"Master's credits 1 year","b":"Experience still required"}],"recap":["Pass = 70% average AND 50% per subject","Weights 30 / 30 / 40","Day 1: A morning, B afternoon","Day 2: design, about 10 hours","Design answers are multiple choice","Sketch to test, then shade","One non-programmable calculator","NBCP excerpt stays unmarked","Bring Notice of Admission + ID","PSO, TGFA, FLAR: know the difference","Drawings show, specs describe","Sleep well before Day 2"]}$seed$::jsonb)
on conflict (slug) do nothing;
-- END GENERATED SEED
