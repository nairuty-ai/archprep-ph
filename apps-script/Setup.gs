/*****************************************************************************
 * Setup.gs — ONE-TIME Sheet builder for ArchPrep PH
 * ---------------------------------------------------------------------------
 * Paste this as a SECOND file in the same Apps Script project as Code.gs,
 * then run setupSheet() once. It creates all five tabs with the correct
 * headers and fills in the sample/seed data, so you don't have to type or
 * copy anything by hand.
 *
 * HOW TO RUN:
 *   1. In the Apps Script editor, open the function dropdown (top toolbar)
 *      and choose "setupSheet".
 *   2. Click Run. Authorise when asked (choose rehinaneel@gmail.com → Advanced
 *      → Go to project → Allow). This is normal for your own script.
 *   3. Switch back to your Google Sheet — all five tabs are now built and
 *      seeded. Done. (You can delete this Setup.gs file afterwards if you like;
 *      it is NOT part of the live website backend.)
 *
 * Running it again RESETS the tabs back to this seed data (it overwrites).
 * Don't run it again after you've added real products/codes, or you'll wipe
 * them. To be safe it will ask you to confirm via a popup the second time.
 *****************************************************************************/

function setupSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  writeTab_(ss, 'Products', PRODUCTS_SEED_());
  writeTab_(ss, 'Quizzes', QUIZZES_SEED_());
  writeTab_(ss, 'AccessCodes', ACCESSCODES_SEED_());
  writeTab_(ss, 'Settings', SETTINGS_SEED_());
  writeTab_(ss, 'Attempts', [['timestamp', 'code', 'quiz_id', 'score', 'total']]);

  // Remove the default empty "Sheet1" if it's still there and unused.
  var def = ss.getSheetByName('Sheet1');
  if (def && ss.getSheets().length > 1) {
    try { ss.deleteSheet(def); } catch (e) {}
  }

  SpreadsheetApp.getActive().toast('All 5 tabs created and seeded. You can now deploy the Web App.', 'ArchPrep setup complete', 8);
}

/** Create the tab if missing, clear it, and write the 2D array of rows. */
function writeTab_(ss, name, rows) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  sheet.clear();
  if (rows && rows.length) {
    sheet.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, rows[0].length).setFontWeight('bold');
  }
  sheet.autoResizeColumns(1, rows[0].length);
}

/* ===== Seed data (mirrors sample-data/mission-control-template.md) ===== */

function PRODUCTS_SEED_() {
  return [
    ['product_id','type','subject','title','description','price_php','hitpay_link','active','sort_order','unlock_scope','drive_note'],
    ['mat-structural','material','Structural Design','Structural Design & Construction — Review Notes','Concise PDF + slides covering loads, analysis, and concrete/steel/timber design for the ALE.',199,'REPLACE_ME_HITPAY_LINK','TRUE',10,'','Drive: Structural Design folder'],
    ['mat-history','material','History & Theory','History & Theory of Architecture — Review Notes','Key movements, Filipino architecture, and theory, summarised for fast revision.',199,'REPLACE_ME_HITPAY_LINK','TRUE',20,'','Drive: History & Theory folder'],
    ['mat-proflaws','material','Professional Practice','Professional Practice & Laws — Review Notes','RA 9266, the Architecture Act, codes of ethics, and standard contracts, made simple.',199,'REPLACE_ME_HITPAY_LINK','TRUE',30,'','Drive: Professional Practice folder'],
    ['mat-bundle','material','All Subjects','All-Subjects Review Bundle','Every subject\'s review notes in one money-saving bundle. Best value for full prep.',499,'REPLACE_ME_HITPAY_LINK','TRUE',40,'','Drive: All-Subjects bundle folder'],
    ['quiz-structural','quiz','Structural Design','Structural Design — Quiz Pack','3 practice quizzes with worked explanations for Structural Design.',149,'REPLACE_ME_HITPAY_LINK','TRUE',50,'structural',''],
    ['quiz-mock','quiz','All Subjects','Mock Test Series','3 timed, mixed-subject mock exams that simulate the real ALE.',299,'REPLACE_ME_HITPAY_LINK','TRUE',60,'mock','']
  ];
}

function QUIZZES_SEED_() {
  return [
    ['quiz_id','quiz_title','subject','question_number','question_text','option_a','option_b','option_c','option_d','correct_option','explanation','timer_minutes'],
    ['structural-1','Structural Design — Quiz 1','Structural Design',1,'Which load is a permanent, static load due to the self-weight of structural and non-structural elements?','Live load','Dead load','Wind load','Seismic load','B','Dead loads are permanent/static and include the self-weight of the structure and fixed components.',0],
    ['structural-1','Structural Design — Quiz 1','Structural Design',2,'In reinforced concrete, what is the main purpose of steel reinforcement?','To resist compression only','To resist tension','To reduce the concrete\'s weight','To improve fire rating','B','Concrete is strong in compression but weak in tension; steel reinforcement carries the tensile stresses.',0],
    ['structural-1','Structural Design — Quiz 1','Structural Design',3,'A simply supported beam carries a central point load. Where is the maximum bending moment?','At the supports','At the quarter span','At mid-span','Uniformly along the beam','C','For a central point load on a simply supported beam, the bending moment is maximum at mid-span.',0],
    ['structural-1','Structural Design — Quiz 1','Structural Design',4,'Which material property describes resistance to deformation under load (stiffness)?','Ductility','Modulus of elasticity','Hardness','Toughness','B','The modulus of elasticity (Young\'s modulus) relates stress to strain and represents stiffness.',0],
    ['structural-1','Structural Design — Quiz 1','Structural Design',5,'What is the primary function of a footing in a foundation system?','To resist wind uplift on the roof','To spread structural loads to the soil','To provide lateral bracing to columns','To waterproof the basement','B','Footings spread (distribute) loads from columns/walls to the supporting soil at a safe bearing pressure.',0],
    ['mock-1','Mock Test 1','All Subjects',1,'Which Republic Act is known as "The Architecture Act of 2004"?','RA 1378','RA 9266','RA 9514','RA 386','B','RA 9266 is the Architecture Act of 2004, governing the practice of architecture in the Philippines.',60],
    ['mock-1','Mock Test 1','All Subjects',2,'The "Bahay na Bato" is most associated with which period of Philippine architecture?','Pre-colonial','Spanish colonial','American colonial','Contemporary','B','The Bahay na Bato developed during the Spanish colonial period, combining stone and wood construction.',60],
    ['mock-1','Mock Test 1','All Subjects',3,'In the National Building Code, what does "setback" primarily regulate?','Building height','Distance of a building from property lines','Allowed occupancy load','Fire-resistance rating','B','Setbacks regulate the required distance between a building and its property lines/road.',60],
    ['mock-1','Mock Test 1','All Subjects',4,'Which drawing shows a horizontal cut through a building at about window height?','Elevation','Section','Floor plan','Site plan','C','A floor plan is a horizontal cut (typically ~1.0–1.2 m above the floor) viewed from above.',60],
    ['mock-1','Mock Test 1','All Subjects',5,'Vitruvius described good architecture as having firmitas, utilitas, and which third quality?','Economy','Venustas (beauty)','Symmetry','Sustainability','B','Vitruvius\' triad is firmitas (strength), utilitas (utility), and venustas (beauty/delight).',60]
  ];
}

function ACCESSCODES_SEED_() {
  return [
    ['code','scope','expiry_date','max_uses','uses_count','status','notes'],
    ['ARCH-7F3K','structural-1','2027-12-31',3,0,'active','Sample code — unlocks only structural-1'],
    ['ARCH-MOCK1','mock-1','2027-12-31','',0,'active','Sample code — unlocks mock-1, unlimited uses (max_uses blank)'],
    ['ARCH-ALL9','all','2027-12-31',10,0,'active','Sample code — unlocks every quiz, up to 10 attempts']
  ];
}

function SETTINGS_SEED_() {
  return [
    ['key','value'],
    ['brand_name','ArchPrep PH'],
    ['contact_email','rehinaneel@gmail.com'],
    ['announcement_banner',''],
    ['hero_headline','Pass the Architect Licensure Exam with confidence.'],
    ['hero_subhead','Focused review materials and exam-style practice quizzes for Filipino architecture graduates — affordable, mobile-friendly, and built for the PRC ALE.']
  ];
}
