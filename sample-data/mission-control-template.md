# Mission Control — Google Sheet template & seed data

This is the **single Google Sheet** that runs the whole site. It is owned by
**`rehinaneel@gmail.com`** and edited only through Google Sheets — never in code.

Create one Google Sheet named **`Mission Control`** with **five tabs**, named
**exactly** as below (capitalisation matters — the Apps Script keys off these
names and the column headers):

- `Products`
- `Quizzes`
- `AccessCodes`
- `Settings`
- `Attempts`

For each tab, the **first row must be the header row** with the exact column
names shown. Copy the example rows in to get a working site immediately, then
edit/replace them with your real content.

> ⚠️ The header names must match **character for character** (no extra spaces,
> same lower_case_with_underscores). If a header is misspelled, the site will
> show a clear error naming the missing column.

> 💵 The `hitpay_link` and any links marked **`REPLACE_ME`** are placeholders.
> The site will show a disabled "Coming soon" button until you paste a real
> HitPay payment link. See `SETUP.md` for creating HitPay links.

---

## Tab: `Products`

Headers (row 1), in this order:

`product_id` | `type` | `subject` | `title` | `description` | `price_php` | `hitpay_link` | `active` | `sort_order`

| product_id | type | subject | title | description | price_php | hitpay_link | active | sort_order |
|---|---|---|---|---|---|---|---|---|
| mat-structural | material | Structural Design | Structural Design & Construction — Review Notes | Concise PDF + slides covering loads, analysis, and concrete/steel/timber design for the ALE. | 199 | REPLACE_ME_HITPAY_LINK | TRUE | 10 |
| mat-history | material | History & Theory | History & Theory of Architecture — Review Notes | Key movements, Filipino architecture, and theory, summarised for fast revision. | 199 | REPLACE_ME_HITPAY_LINK | TRUE | 20 |
| mat-proflaws | material | Professional Practice | Professional Practice & Laws — Review Notes | RA 9266, the Architecture Act, codes of ethics, and standard contracts, made simple. | 199 | REPLACE_ME_HITPAY_LINK | TRUE | 30 |
| mat-bundle | material | All Subjects | All-Subjects Review Bundle | Every subject's review notes in one money-saving bundle. Best value for full prep. | 499 | REPLACE_ME_HITPAY_LINK | TRUE | 40 |
| quiz-structural | quiz | Structural Design | Structural Design — Quiz Pack | 3 practice quizzes with worked explanations for Structural Design. | 149 | REPLACE_ME_HITPAY_LINK | TRUE | 50 |
| quiz-mock | quiz | All Subjects | Mock Test Series | 3 timed, mixed-subject mock exams that simulate the real ALE. | 299 | REPLACE_ME_HITPAY_LINK | TRUE | 60 |

Notes:
- `type` must be exactly `material` or `quiz`.
- `active` must be `TRUE` or `FALSE` (only `TRUE` rows appear on the site).
- `price_php` is a plain number (no "₱", no commas).
- `sort_order` controls display order (smaller first).

---

## Tab: `Quizzes`  (one row per question)

Headers (row 1), in this order:

`quiz_id` | `quiz_title` | `subject` | `question_number` | `question_text` | `option_a` | `option_b` | `option_c` | `option_d` | `correct_option` | `explanation`

> 🔒 `correct_option` and `explanation` are **never sent to the browser** until a
> student submits the quiz. They live only in this Sheet and in the grading step.

### Sample quiz 1 — `structural-1` (5 questions)

| quiz_id | quiz_title | subject | question_number | question_text | option_a | option_b | option_c | option_d | correct_option | explanation |
|---|---|---|---|---|---|---|---|---|---|---|
| structural-1 | Structural Design — Quiz 1 | Structural Design | 1 | Which load is a permanent, static load due to the self-weight of structural and non-structural elements? | Live load | Dead load | Wind load | Seismic load | B | Dead loads are permanent/static and include the self-weight of the structure and fixed components. |
| structural-1 | Structural Design — Quiz 1 | Structural Design | 2 | In reinforced concrete, what is the main purpose of steel reinforcement? | To resist compression only | To resist tension | To reduce the concrete's weight | To improve fire rating | B | Concrete is strong in compression but weak in tension; steel reinforcement carries the tensile stresses. |
| structural-1 | Structural Design — Quiz 1 | Structural Design | 3 | A simply supported beam carries a central point load. Where is the maximum bending moment? | At the supports | At the quarter span | At mid-span | Uniformly along the beam | C | For a central point load on a simply supported beam, the bending moment is maximum at mid-span. |
| structural-1 | Structural Design — Quiz 1 | Structural Design | 4 | Which material property describes resistance to deformation under load (stiffness)? | Ductility | Modulus of elasticity | Hardness | Toughness | B | The modulus of elasticity (Young's modulus) relates stress to strain and represents stiffness. |
| structural-1 | Structural Design — Quiz 1 | Structural Design | 5 | What is the primary function of a footing in a foundation system? | To resist wind uplift on the roof | To spread structural loads to the soil | To provide lateral bracing to columns | To waterproof the basement | B | Footings spread (distribute) loads from columns/walls to the supporting soil at a safe bearing pressure. |

### Sample quiz 2 — `mock-1` (5 mixed-subject questions)

> Because this `quiz_id` starts with `mock`, the quiz page shows a countdown
> timer (default 60 minutes, set in `config.js` via `MOCK_TEST_MINUTES`).

| quiz_id | quiz_title | subject | question_number | question_text | option_a | option_b | option_c | option_d | correct_option | explanation |
|---|---|---|---|---|---|---|---|---|---|---|
| mock-1 | Mock Test 1 | All Subjects | 1 | Which Republic Act is known as "The Architecture Act of 2004"? | RA 1378 | RA 9266 | RA 9514 | RA 386 | B | RA 9266 is the Architecture Act of 2004, governing the practice of architecture in the Philippines. |
| mock-1 | Mock Test 1 | All Subjects | 2 | The "Bahay na Bato" is most associated with which period of Philippine architecture? | Pre-colonial | Spanish colonial | American colonial | Contemporary | B | The Bahay na Bato developed during the Spanish colonial period, combining stone and wood construction. |
| mock-1 | Mock Test 1 | All Subjects | 3 | In the National Building Code, what does "setback" primarily regulate? | Building height | Distance of a building from property lines | Allowed occupancy load | Fire-resistance rating | B | Setbacks regulate the required distance between a building and its property lines/road. |
| mock-1 | Mock Test 1 | All Subjects | 4 | Which drawing shows a horizontal cut through a building at about window height? | Elevation | Section | Floor plan | Site plan | C | A floor plan is a horizontal cut (typically ~1.0–1.2 m above the floor) viewed from above. |
| mock-1 | Mock Test 1 | All Subjects | 5 | Vitruvius described good architecture as having firmitas, utilitas, and which third quality? | Economy | Venustas (beauty) | Symmetry | Sustainability | B | Vitruvius' triad is firmitas (strength), utilitas (utility), and venustas (beauty/delight). |

---

## Tab: `AccessCodes`

Headers (row 1), in this order:

`code` | `scope` | `expiry_date` | `max_uses` | `uses_count` | `status` | `notes`

| code | scope | expiry_date | max_uses | uses_count | status | notes |
|---|---|---|---|---|---|---|
| ARCH-7F3K | structural-1 | 2027-12-31 | 3 | 0 | active | Sample code — unlocks only structural-1 |
| ARCH-MOCK1 | mock-1 | 2027-12-31 |  | 0 | active | Sample code — unlocks mock-1, unlimited uses (max_uses blank) |
| ARCH-ALL9 | all | 2027-12-31 | 10 | 0 | active | Sample code — unlocks every quiz, up to 10 attempts |

How `scope` works:
- `all` → unlocks every quiz.
- an exact quiz id (e.g. `structural-1`) → unlocks just that quiz.
- a subject prefix (e.g. `structural`) → unlocks `structural-1`, `structural-2`, …
- `expiry_date` is `YYYY-MM-DD`; the code works through the end of that day.
- `max_uses` blank = unlimited. `uses_count` starts at `0`; the script increments
  it on each graded submission.
- `status` is `active` or `disabled`.

---

## Tab: `Settings`  (simple key / value rows)

Put `key` in column A and `value` in column B. A header row (`key | value`) is
optional — the script skips it if present.

| key | value |
|---|---|
| brand_name | ArchPrep PH |
| contact_email | rehinaneel@gmail.com |
| announcement_banner |  |
| hero_headline | Pass the Architect Licensure Exam with confidence. |
| hero_subhead | Focused review materials and exam-style practice quizzes for Filipino architecture graduates — affordable, mobile-friendly, and built for the PRC ALE. |

Notes:
- Leave `announcement_banner` blank to hide the site-wide banner. Put any text in
  it to show a banner across the top of every page (e.g. a sale or a notice).
- Anything left blank falls back to the defaults in `config.js`.

---

## Tab: `Attempts`  (write-only usage log)

Headers (row 1), in this order:

`timestamp` | `code` | `quiz_id` | `score` | `total`

Leave this tab empty (just the header row). The script appends one row each time
a quiz is graded, so you can see usage. If you forget to create this tab, the
script will create it automatically on the first submission.

| timestamp | code | quiz_id | score | total |
|---|---|---|---|---|
| _(auto-filled by the script)_ |  |  |  |  |
