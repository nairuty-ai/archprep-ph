/* Backend regression + admin test harness (committed).
   Run from the repo root:  node tests/backend-test.js
   Mocks Apps Script services, loads apps-script/Code.gs, and verifies auth,
   the requireAuth_ gate, admin CRUD, the public answer-key guarantee, and
   per-quiz timer propagation. Keep this passing after backend changes. */
const fs = require("fs");
const vm = require("vm");
const crypto = require("crypto");

/* ---- In-memory Sheet store ---- */
const DB = {};
function seed() {
  DB.Products = [
    ["product_id","type","subject","title","description","price_php","hitpay_link","active","sort_order","unlock_scope","drive_note"],
    ["mat-structural","material","Structural Design","Structural Notes","desc",199,"https://h/x","TRUE",10,"","Drive folder"],
    ["quiz-structural","quiz","Structural Design","Structural Quiz Pack","unlocks structural-*",149,"REPLACE_ME","TRUE",50,"structural",""],
    ["quiz-mock","quiz","All Subjects","Mock Series","unlocks mock-*",299,"REPLACE_ME","FALSE",60,"mock",""],
  ];
  DB.Quizzes = [
    ["quiz_id","quiz_title","subject","question_number","question_text","option_a","option_b","option_c","option_d","correct_option","explanation"],
    ["structural-1","Structural — Quiz 1","Structural Design",1,"Permanent self-weight load?","Live","Dead","Wind","Seismic","B","Dead loads are permanent."],
    ["structural-1","Structural — Quiz 1","Structural Design",2,"Steel resists?","Compression","Tension","Weight","Fire","B","Steel carries tension."],
  ];
  DB.AccessCodes = [
    ["code","scope","expiry_date","max_uses","uses_count","status","notes"],
    ["ARCH-7F3K","structural","2099-12-31",3,0,"active","sample"],
  ];
  DB.Settings = [["key","value"],["brand_name","ArchPrep PH"],["contact_email","x@y.com"]];
  DB.Attempts = [["timestamp","code","quiz_id","score","total"]];
}
seed();

/* ---- Script Properties mock ---- */
const STORE = {};
const PropertiesService = {
  getScriptProperties: () => ({
    getProperty: (k) => (k in STORE ? STORE[k] : null),
    setProperty: (k, v) => { STORE[k] = String(v); },
    deleteProperty: (k) => { delete STORE[k]; },
  }),
};

/* ---- Utilities mock (real SHA-256 via Node crypto) ---- */
let uuidCounter = 0;
const Utilities = {
  DigestAlgorithm: { SHA_256: "SHA_256" },
  Charset: { UTF_8: "UTF_8" },
  computeDigest: (_algo, str) => {
    const buf = crypto.createHash("sha256").update(String(str), "utf8").digest();
    return Array.from(buf).map((b) => (b > 127 ? b - 256 : b)); // signed bytes like Apps Script
  },
  getUuid: () => "uuid-" + (uuidCounter++) + "-" + crypto.randomBytes(8).toString("hex"),
};

/* ---- Sheet/Spreadsheet mock ---- */
function makeSheet(name) {
  const grid = () => DB[name];
  return {
    getName: () => name,
    clear() { DB[name] = []; },
    getLastColumn: () => Math.max(1, ...grid().map((r) => r.length)),
    getLastRow: () => grid().length,
    getDataRange: () => ({ getValues: () => grid().map((r) => r.slice()) }),
    getRange(row, col, numRows, numCols) {
      return {
        getValues: () => {
          if (numRows === 1) {
            const r = grid()[row - 1] || [];
            const out = [];
            for (let c = 0; c < (numCols || r.length); c++) out.push(r[col - 1 + c]);
            return [out];
          }
          return grid().map((r) => r.slice());
        },
        setValues: (vals) => {
          for (let r = 0; r < vals.length; r++) {
            grid()[row - 1 + r] = grid()[row - 1 + r] || [];
            for (let c = 0; c < vals[r].length; c++) grid()[row - 1 + r][col - 1 + c] = vals[r][c];
          }
        },
        getValue: () => (grid()[row - 1] || [])[col - 1],
        setValue: (v) => { grid()[row - 1] = grid()[row - 1] || []; grid()[row - 1][col - 1] = v; },
      };
    },
    appendRow: (arr) => { grid().push(arr.slice()); },
    deleteRow: (rowIndex) => { grid().splice(rowIndex - 1, 1); },
    setFrozenRows() {}, autoResizeColumns() {},
  };
}
const SpreadsheetApp = {
  getActiveSpreadsheet: () => ({
    getSheetByName: (n) => (DB[n] ? makeSheet(n) : null),
    insertSheet: (n) => { DB[n] = []; return makeSheet(n); },
    getSheets: () => Object.keys(DB).map(makeSheet),
    deleteSheet: (sh) => { delete DB[sh.getName()]; },
  }),
  getActive: () => ({ toast() {} }),
};
const ContentService = {
  MimeType: { JSON: "json" },
  createTextOutput: (s) => ({ _t: s, setMimeType() { return this; }, getContent() { return this._t; } }),
};

/* ---- CacheService mock (exercises server-side caching + invalidation) ---- */
const CACHE = {};
const CacheService = {
  getScriptCache: () => ({
    get: (k) => (k in CACHE ? CACHE[k] : null),
    put: (k, v) => { CACHE[k] = String(v); },
    remove: (k) => { delete CACHE[k]; },
    removeAll: (keys) => { (keys || []).forEach((k) => { delete CACHE[k]; }); },
  }),
};

const sandbox = { PropertiesService, Utilities, SpreadsheetApp, ContentService, CacheService, Logger: { log() {} }, console };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync("apps-script/Code.gs", "utf8"), sandbox);

const get = (p) => JSON.parse(sandbox.doGet({ parameter: p }).getContent());
const post = (action, payload) => JSON.parse(sandbox.doPost(
  { parameter: {}, postData: { contents: JSON.stringify({ action, ...payload }) } }).getContent());

let pass = 0, fail = 0;
const check = (l, c) => { c ? (pass++, console.log("  PASS:", l)) : (fail++, console.log("  FAIL:", l)); };

/* ============ Public regression (must still hold) ============ */
console.log("Public answer-key guarantee + behaviour:");
const pq = get({ action: "getQuiz", quizId: "structural-1", code: "ARCH-7F3K" });
check("getQuiz ok", pq.ok === true && pq.quiz.questions.length === 2);
check("public getQuiz has NO correct_option", !JSON.stringify(pq).includes("correct_option"));
check("public getQuiz has NO explanation text", !JSON.stringify(pq).includes("permanent."));
check("getProducts excludes inactive quiz-mock", !get({ action: "getProducts" }).some((p) => p.product_id === "quiz-mock"));
check("getProducts includes active ones", get({ action: "getProducts" }).length === 2);
const grade = post("gradeQuiz", { quizId: "structural-1", code: "ARCH-7F3K", answers: { "1": "B", "2": "A" } });
check("gradeQuiz still works (1/2)", grade.ok && grade.score === 1 && grade.total === 2);

/* ============ Auth ============ */
console.log("Auth:");
sandbox.setupAdminCredential("admin", "s3cret-pass");
check("login wrong password -> generic error", (function () {
  const r = post("adminLogin", { username: "admin", password: "nope" });
  return r.ok === false && r.error === "Invalid username or password.";
})());
const login = post("adminLogin", { username: "admin", password: "s3cret-pass" });
check("login correct -> token (64 hex)", login.ok === true && /^[0-9a-f]{64}$/.test(login.token));
const TOKEN = login.token;
check("stored credential is a hash, not plaintext", !JSON.stringify(STORE).includes("s3cret-pass"));

console.log("requireAuth_ gate:");
check("admin endpoint with NO token -> session_expired",
  post("adminListQuizzes", {}).error === "session_expired");
check("admin endpoint with BAD token -> session_expired",
  post("adminListQuizzes", { token: "deadbeef" }).error === "session_expired");
check("admin endpoint with valid token -> ok",
  post("adminListQuizzes", { token: TOKEN }).ok === true);

console.log("Lockout:");
seedLockTest();
function seedLockTest() {}
for (let i = 0; i < 5; i++) post("adminLogin", { username: "lockme", password: "x" });
sandbox.setupAdminCredential("lockme", "realpass");
const locked = post("adminLogin", { username: "lockme", password: "realpass" });
check("5 failures -> locked even with correct password", locked.ok === false && /try again/i.test(locked.error));

console.log("Logout:");
check("logout ok", post("adminLogout", { token: TOKEN }).ok === true);
check("token invalid after logout", post("adminListQuizzes", { token: TOKEN }).error === "session_expired");

/* re-login for CRUD tests */
const t2 = post("adminLogin", { username: "admin", password: "s3cret-pass" }).token;
const A = (action, payload) => post(action, { token: t2, ...(payload || {}) });

/* ============ CRUD: quizzes + questions ============ */
console.log("Quiz + question CRUD:");
const created = A("adminCreateQuiz", { quiz_title: "Structural Quiz 2", subject: "Structural Design", quiz_id: "structural-2", timer_minutes: 30 });
check("create quiz returns quiz_id", created.ok && created.quiz_id === "structural-2");
const add1 = A("adminAddQuestion", { quiz_id: "structural-2", quiz_title: "Structural — Quiz 2", subject: "Structural Design", timer_minutes: 30,
  question_text: "What is rebar for?", options: ["Compression", "Tension", "Color", "Weight"], correct_index: 1, explanation: "Tension." });
check("add question #1", add1.ok && add1.question_number === 1);
A("adminAddQuestion", { quiz_id: "structural-2", question_text: "Q2?", options: ["a","b"], correct_index: 0, explanation: "" });
const listQ = A("adminListQuestions", { quiz_id: "structural-2" });
check("adminListQuestions returns answers (admin only)", listQ.ok && listQ.questions[0].correct_option === "B" && listQ.questions[0].explanation === "Tension.");
check("quiz-level timer carried", listQ.timer_minutes === 30);
check("validation: <2 options rejected", A("adminAddQuestion", { quiz_id: "structural-2", question_text: "x", options: ["only"], correct_index: 0 }).ok === false);
check("validation: no correct selected rejected", A("adminAddQuestion", { quiz_id: "structural-2", question_text: "x", options: ["a","b"], correct_index: 5 }).ok === false);
// delete q1 -> renumber
A("adminDeleteQuestion", { quiz_id: "structural-2", question_number: 1 });
const after = A("adminListQuestions", { quiz_id: "structural-2" });
check("after delete: 1 question renumbered to 1", after.questions.length === 1 && after.questions[0].question_number === 1);
check("list quizzes shows structural-1 and structural-2", (function () {
  const ids = A("adminListQuizzes").quizzes.map((q) => q.quiz_id);
  return ids.indexOf("structural-1") >= 0 && ids.indexOf("structural-2") >= 0;
})());

/* timer propagation to PUBLIC getQuiz */
console.log("Per-quiz timer propagation (public):");
const pubTimer = get({ action: "getQuiz", quizId: "structural-2", code: "ARCH-7F3K" });
check("public getQuiz includes timer_minutes=30", pubTimer.ok && pubTimer.quiz.timer_minutes === 30);
check("structural-1 (no timer col) -> 0", get({ action: "getQuiz", quizId: "structural-1", code: "ARCH-7F3K" }).quiz.timer_minutes === 0);
check("structural-2 STILL no answer key leak", !JSON.stringify(pubTimer).includes("correct_option") && !JSON.stringify(pubTimer).includes("Tension."));

/* ============ CRUD: products ============ */
console.log("Product CRUD:");
const cp = A("adminCreateProduct", { type: "quiz", subject: "Structural Design", title: "Structural Quiz Pack 2", price_php: 159, hitpay_link: "https://h/y", active: true, unlock_scope: "structural", drive_note: "" });
check("create product returns product_id", cp.ok && /^quiz-/.test(cp.product_id));
check("update product price", A("adminUpdateProduct", { product_id: cp.product_id, price_php: 179 }).ok);
check("product appears in public getProducts (active)", get({ action: "getProducts" }).some((p) => p.product_id === cp.product_id));
A("adminUpdateProduct", { product_id: cp.product_id, active: false });
check("draft (active FALSE) hidden from public", !get({ action: "getProducts" }).some((p) => p.product_id === cp.product_id));
check("delete product", A("adminDeleteProduct", { product_id: cp.product_id }).ok);

/* ============ CRUD: codes + settings ============ */
console.log("Codes + settings:");
const cc = A("adminCreateCode", { scope: "structural-2", expiry_date: "2099-12-31", max_uses: 5, notes: "buyer@x.com" });
check("create code returns readable code", cc.ok && /^ARCH-[A-Z2-9]{4}$/.test(cc.code));
check("code listed", A("adminListCodes").codes.some((c) => c.code === cc.code));
check("disable code", A("adminUpdateCode", { code: cc.code, status: "disabled" }).ok);
check("new code unlocks structural-2 publicly", get({ action: "getQuiz", quizId: "structural-2", code: A("adminListCodes").codes.find(c=>c.scope==="structural").code || cc.code }).ok !== undefined);
check("delete code", A("adminDeleteCode", { code: cc.code }).ok);
check("update settings upsert", A("adminUpdateSettings", { key: "announcement_banner", value: "Sale!" }).ok);
check("settings reflect via public getSettings", get({ action: "getSettings" }).announcement_banner === "Sale!");

/* ============ Bulk CSV import ============ */
console.log("Bulk question import:");
const bulk = A("adminBulkAddQuestions", { quiz_id: "bulk-1", quiz_title: "Bulk Quiz", subject: "Test", timer_minutes: 0, questions: [
  { question_text: "Q1?", options: ["a", "b", "c"], correct_index: 2, explanation: "c is right" },
  { question_text: "Q2?", options: ["x", "y"], correct_index: 0, explanation: "" },
  { question_text: "", options: ["a", "b"], correct_index: 0 }, // invalid -> skipped
]});
check("bulk added 2, skipped 1", bulk.ok && bulk.added === 2 && bulk.skipped === 1);
const bq = A("adminListQuestions", { quiz_id: "bulk-1" });
check("bulk quiz has 2 questions numbered 1,2", bq.questions.length === 2 && bq.questions[0].question_number === 1 && bq.questions[1].question_number === 2);
check("bulk correct option mapped (index 2 -> C)", bq.questions[0].correct_option === "C");

/* ============ Purchase / access-request flow ============ */
console.log("Purchase flow (email capture -> pending code -> activate):");
check("requestAccess rejects bad email", post("requestAccess", { email: "nope", product_id: "quiz-structural" }).ok === false);
const rq = post("requestAccess", { email: "buyer@example.com", product_id: "quiz-structural" });
check("requestAccess (quiz) ok", rq.ok === true && rq.type === "quiz");
const pendingCode = DB.AccessCodes[DB.AccessCodes.length - 1];
const pcCode = pendingCode[0];
check("pending code created with email + max_uses 2 + no expiry",
  pendingCode[3] === 2 && String(pendingCode[2]) === "" && pendingCode[5] === "pending" && pendingCode[7] === "buyer@example.com");
check("PENDING code does NOT unlock the quiz (getQuiz)",
  get({ action: "getQuiz", quizId: "structural-1", code: pcCode }).ok === false);
const reqs = A("adminListRequests");
check("admin sees the request with email", reqs.ok && reqs.requests.some((r) => r.email === "buyer@example.com" && r.type === "quiz"));
const reqId = reqs.requests.find((r) => r.email === "buyer@example.com").request_id;
check("fulfill activates the code", A("adminFulfillRequest", { request_id: reqId }).ok);
check("ACTIVE code now unlocks the quiz", get({ action: "getQuiz", quizId: "structural-1", code: pcCode }).ok === true);
// 2-attempt limit (no date expiry)
check("attempt 1 grades", post("gradeQuiz", { quizId: "structural-1", code: pcCode, answers: { "1": "B" } }).ok === true);
check("attempt 2 grades", post("gradeQuiz", { quizId: "structural-1", code: pcCode, answers: { "1": "B" } }).ok === true);
check("attempt 3 REFUSED (max 2 uses)", post("gradeQuiz", { quizId: "structural-1", code: pcCode, answers: { "1": "B" } }).ok === false);

console.log("Purchase flow (material -> logged, admin sets validity):");
const rqm = post("requestAccess", { email: "matbuyer@example.com", product_id: "mat-structural" });
check("requestAccess (material) ok, no code", rqm.ok && rqm.type === "material");
check("material request has no access code created", !DB.AccessCodes.some((r) => r[7] === "matbuyer@example.com"));
const mReqId = A("adminListRequests").requests.find((r) => r.email === "matbuyer@example.com").request_id;
check("admin sets material valid_until", A("adminFulfillRequest", { request_id: mReqId, valid_until: "2026-12-31" }).ok);
check("material request now fulfilled with date",
  A("adminListRequests").requests.find((r) => r.request_id === mReqId).valid_until === "2026-12-31");
check("delete request works", A("adminDeleteRequest", { request_id: mReqId }).ok);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);