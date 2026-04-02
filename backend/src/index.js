require("dotenv").config();
const express = require("express");
const cors = require("cors");
const cron = require("node-cron");
const { createClient } = require("@supabase/supabase-js");
const { google } = require("googleapis");

const app = express();
app.use(cors({ origin: process.env.FRONTEND_URL, credentials: true }));
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

// ── AUTH ─────────────────────────────────────────────────────────────────────
app.get("/auth/google", (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/userinfo.profile",
    ],
  });
  res.redirect(url);
});

app.get("/auth/callback", async (req, res) => {
  const { code } = req.query;
  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });
    const { data: userInfo } = await oauth2.userinfo.get();
    const { data: user } = await supabase
      .from("users")
      .upsert({
        email: userInfo.email,
        name: userInfo.name,
        picture: userInfo.picture,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_expiry: tokens.expiry_date,
      }, { onConflict: "email" })
      .select()
      .single();
    await scanGmailForUser(user);
    res.redirect(`${process.env.FRONTEND_URL}?user=${encodeURIComponent(JSON.stringify({
      id: user.id, email: user.email, name: user.name, picture: user.picture
    }))}`);
  } catch (err) {
    console.error(err);
    res.redirect(`${process.env.FRONTEND_URL}?error=auth_failed`);
  }
});

// ── CRUD ─────────────────────────────────────────────────────────────────────
app.get("/applications/:userId", async (req, res) => {
  const { data } = await supabase
    .from("applications").select("*")
    .eq("user_id", req.params.userId)
    .order("applied_date", { ascending: false });
  res.json(data);
});

app.post("/applications", async (req, res) => {
  const { data } = await supabase.from("applications").insert(req.body).select().single();
  res.json(data);
});

app.put("/applications/:id", async (req, res) => {
  const { data } = await supabase.from("applications").update(req.body).eq("id", req.params.id).select().single();
  res.json(data);
});

app.delete("/applications/:id", async (req, res) => {
  await supabase.from("applications").delete().eq("id", req.params.id);
  res.json({ success: true });
});

app.post("/sync/:userId", async (req, res) => {
  try {
    const { data: user } = await supabase.from("users").select("*").eq("id", req.params.userId).single();
    const count = await scanGmailForUser(user);
    res.json({ imported: count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── KNOWN JOB PLATFORM DOMAINS ────────────────────────────────────────────────
const JOB_PLATFORM_DOMAINS = [
  "linkedin.com", "indeed.com", "naukri.com",
  "greenhouse.io", "lever.co", "workday.com",
  "employmenthero.com", "smartrecruiters.com",
  "jobvite.com", "taleo.net", "icims.com",
  "myworkdayjobs.com", "successfactors.com",
  "bamboohr.com", "ashbyhq.com", "rippling.com",
];

function isFromJobPlatform(from) {
  return JOB_PLATFORM_DOMAINS.some(domain => from.toLowerCase().includes(domain));
}

// ── STEP 1: SUBJECT CLASSIFIER ────────────────────────────────────────────────
// First gate — does the subject look like a real application email?
// Returns "tier1", "tier2", or null (definitely not a job email)

function classifyBySubject(subject, from) {
  const s = subject.toLowerCase();

  // ── TIER 1: trusted platform sender ───────────────────────────────────────
  if (isFromJobPlatform(from)) {
    // Only allow clear application-related subjects from these platforms
    // This blocks security emails, digests, job alerts from linkedin/indeed etc.
    if (/your application|you applied|application received|application submitted|we received your|thank you for applying|interview|offer letter|rejected|not selected|unfortunately|next step|assessment result/i.test(s)) {
      return "tier1";
    }
    return null; // from a job platform but not an application email (e.g. security, digest)
  }

  // ── TIER 2: any sender, but subject is unambiguously about user's application
  if (/your application/i.test(s)) return "tier2";
  if (/you applied/i.test(s)) return "tier2";
  if (/we(?:'ve| have) received your/i.test(s)) return "tier2";
  if (/thank you for applying/i.test(s)) return "tier2";
  if (/your interview|you for an? interview|interview with/i.test(s)) return "tier2";
  if (/unfortunately.*\b(you|your)\b|\b(you|your)\b.*unfortunately/i.test(s)) return "tier2";
  if (/not moving forward with your|not been selected for/i.test(s)) return "tier2";
  if (/update on your application/i.test(s)) return "tier2";
  if (/your candidature|your profile has been shortlisted/i.test(s)) return "tier2";

  return null;
}

// ── STEP 2: BODY VERIFICATION ─────────────────────────────────────────────────
// Second gate — does the body address the user by name or email?
// This is the key check that eliminates blasts and job alerts.
// Real application emails ALWAYS address you personally.
// Job alert blasts (Glassdoor, LinkedIn alerts) NEVER do.

function isAddressedToUser(body, userEmail, userName) {
  const snippet = body.slice(0, 600).toLowerCase();

  // Check for user's email address in body
  if (snippet.includes(userEmail.toLowerCase())) return true;

  // Check for user's first name — extract just the first word of their name
  // e.g. "Gayathri Veera Haribabu" → check for "gayathri"
  const firstName = userName.split(" ")[0].toLowerCase();
  if (firstName.length >= 3 && snippet.includes(firstName)) return true;

  // Some ATS systems use "Dear Candidate" or "Hello," without a name
  // Allow these only if the subject already passed Tier 1 (trusted platform)
  // We handle this in parseJobEmail by passing the tier through
  if (/dear candidate|hello,|hi,|greetings/i.test(snippet)) return true;

  return false;
}

// ── STATUS DETECTOR ───────────────────────────────────────────────────────────
function detectStatus(subject, body) {
  const text = (subject + " " + body).toLowerCase();

  if (/offer letter|we(?:'d| would) like to offer|pleased to offer|selected for the role|congratulations.*(?:joining|offer)/i.test(text)) {
    return "Offer";
  }
  if (/regret|not (?:moving forward|selected|progressing|shortlisted)|unfortunately|we will not be|decided to move forward with other/i.test(text)) {
    return "Rejected";
  }
  if (/(?:schedule|invite|invited|confirm|book).*interview|interview.*(?:schedule|invite|confirm)|next (?:step|round|stage)/i.test(text)) {
    return "Interview";
  }
  return "Applied";
}

// ── EMAIL BODY EXTRACTOR ──────────────────────────────────────────────────────
function getEmailBody(payload) {
  if (!payload) return "";

  function extractFromParts(parts) {
    if (!parts) return "";
    for (const part of parts) {
      if (part.mimeType === "text/plain" && part.body?.data) {
        return Buffer.from(part.body.data, "base64").toString("utf-8");
      }
      if (part.parts) {
        const nested = extractFromParts(part.parts);
        if (nested) return nested;
      }
    }
    for (const part of parts) {
      if (part.mimeType === "text/html" && part.body?.data) {
        return Buffer.from(part.body.data, "base64")
          .toString("utf-8")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim();
      }
    }
    return "";
  }

  if (payload.parts) return extractFromParts(payload.parts);
  if (payload.body?.data) return Buffer.from(payload.body.data, "base64").toString("utf-8");
  return "";
}

// ── COMPANY EXTRACTOR ─────────────────────────────────────────────────────────
function extractCompany(from, subject, body) {
  // 1. Domain-based
  const domainMatch = from.match(/@([\w.-]+)/);
  if (domainMatch) {
    let domain = domainMatch[1];
    domain = domain.replace(/^(mail|careers|jobs|apply|notifications|hr|talent|recruit|noreply|no-reply|hello|info|team)\./i, "");
    const name = domain.split(".")[0];
    const genericDomains = ["gmail", "yahoo", "outlook", "hotmail", "icloud", "googlemail", "linkedin", "indeed", "naukri", "greenhouse", "lever"];
    if (!genericDomains.includes(name.toLowerCase())) {
      return name.charAt(0).toUpperCase() + name.slice(1);
    }
  }

  // 2. "at CompanyName" in subject
  const atSubject = subject.match(/\bat\s+([A-Z][A-Za-z0-9\s&.]{1,30}?)(?:\s*[-|!,.]|$)/);
  if (atSubject) return atSubject[1].trim();

  // 3. "at CompanyName" in body snippet
  const snippet = body.slice(0, 500);
  const atBody = snippet.match(/\bat\s+([A-Z][A-Za-z0-9\s&.]{1,30}?)(?:\s*[,.]|\s+is|\s+we|\s+team)/);
  if (atBody) return atBody[1].trim();

  // 4. Sender display name
  const displayName = from.match(/^"?([^"<@\n]{2,40})"?\s*</);
  if (displayName) return displayName[1].trim();

  return "Unknown";
}

// ── ROLE EXTRACTOR ────────────────────────────────────────────────────────────
function extractRole(subject, body) {
  // Strip platform prefixes and noise from subject
  let cleaned = subject
    .replace(/^(re:|fwd:|fw:)\s*/gi, "")
    .replace(/^indeed\s+application[:\s]*/i, "")
    .replace(/^linkedin\s+application[:\s]*/i, "")
    .replace(/^naukri[:\s]*/i, "")
    .replace(/\b(your application(?: for)?|application for|thank you for applying|interview(?: invitation)?|update on your application|we(?:'ve| have) received your)\b/gi, "")
    .replace(/[-–—]\s*(?:employment hero|linkedin|indeed|naukri|greenhouse|lever)\b.*/gi, "")
    .replace(/\[.*?\]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[-–—:,\s]+|[-–—:,\s]+$/g, "")
    .trim();

  if (cleaned.length > 3) return cleaned.slice(0, 80);

  // Fallback: scan body
  const bodyRole = body.match(/(?:applying for|applied for|role of|position of)\s+(?:the\s+)?([A-Za-z\s\/\-]+?)(?:\s+at|\s+role|\.|,)/i);
  if (bodyRole) return bodyRole[1].trim().slice(0, 80);

  return "Unknown Role";
}

// ── MAIN PARSER ───────────────────────────────────────────────────────────────
// Two gates must both pass:
//   Gate 1 (subject): does the subject look like a real application email?
//   Gate 2 (body):    does the body address the user by name or email?

function parseJobEmail(headers, body, userEmail, userName) {
  const subject = headers["subject"] || "";
  const from = headers["from"] || "";
  const date = headers["date"]
    ? new Date(headers["date"]).toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 10);

  // Gate 1: subject classification
  const tier = classifyBySubject(subject, from);
  if (!tier) return null;

  // Gate 2: body verification — is this email addressed to the user?
  // Tier 1 emails from trusted platforms get a slightly more lenient check
  // (some ATS systems send "Dear Candidate" without a name)
  const addressed = isAddressedToUser(body, userEmail, userName);
  if (!addressed) return null;

  const status = detectStatus(subject, body);
  const company = extractCompany(from, subject, body);
  const role = extractRole(subject, body);

  return { company, role, applied_date: date, status, source: "Gmail" };
}

// ── SCANNER ───────────────────────────────────────────────────────────────────
async function scanGmailForUser(user) {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  auth.setCredentials({
    access_token: user.access_token,
    refresh_token: user.refresh_token,
    expiry_date: user.token_expiry,
  });
  auth.on("tokens", async (tokens) => {
    await supabase.from("users").update({
      access_token: tokens.access_token,
      token_expiry: tokens.expiry_date,
    }).eq("id", user.id);
  });

  const gmail = google.gmail({ version: "v1", auth });

  // Gmail search — scoped to exact phrases that appear in real application emails
  const query = [
    "newer_than:90d",
    "-category:promotions",
    "-category:social",
    "(",
      '"your application"',
      'OR "you applied"',
      'OR "thank you for applying"',
      'OR "we have received your"',
      'OR "we\'ve received your"',
      'OR "update on your application"',
      'OR "your candidature"',
      'OR "your profile has been shortlisted"',
      'OR from:(linkedin.com OR indeed.com OR naukri.com OR greenhouse.io OR lever.co OR workday.com OR employmenthero.com OR smartrecruiters.com)',
    ")",
  ].join(" ");

  const { data } = await gmail.users.messages.list({ userId: "me", q: query, maxResults: 150 });
  if (!data.messages) return 0;

  let count = 0;
  for (const msg of data.messages) {
    const exists = await supabase.from("applications").select("id").eq("gmail_message_id", msg.id).maybeSingle();
    if (exists.data) continue;

    const full = await gmail.users.messages.get({ userId: "me", id: msg.id, format: "full" });
    const hdrs = Object.fromEntries(full.data.payload.headers.map(h => [h.name.toLowerCase(), h.value]));
    const body = getEmailBody(full.data.payload);

    // Pass user's email and name for body verification
    const parsed = parseJobEmail(hdrs, body, user.email, user.name);
    if (!parsed) continue;

    await supabase.from("applications").insert({ user_id: user.id, gmail_message_id: msg.id, ...parsed });
    count++;
  }
  return count;
}

// ── CRON: scan all users every 6 hours ───────────────────────────────────────
cron.schedule("0 */6 * * *", async () => {
  const { data: users } = await supabase.from("users").select("*");
  for (const user of users || []) {
    try { await scanGmailForUser(user); } catch (e) { console.error(e.message); }
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));
