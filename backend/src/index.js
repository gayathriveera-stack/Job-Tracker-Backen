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
// Tier 1: emails from these domains are almost always about the user's application
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

// ── TIER CLASSIFIER ───────────────────────────────────────────────────────────
// The key principle:
//   Tier 1 = from a known job platform (trusted sender)
//   Tier 2 = NOT from a known platform, but subject is clearly personalised
//            Real application emails almost always say "your" or "you"
//            Job blasts and newsletters never say "your" in the subject
// Returns "tier1", "tier2", or null (skip this email)

function classifyEmail(subject, from) {
  const s = subject.toLowerCase();

  // ── TIER 1 ────────────────────────────────────────────────────────────────
  if (isFromJobPlatform(from)) {
    // Even from a trusted platform, skip newsletter/digest/alert emails
    if (/new jobs for you|jobs matching|job alert|recommended jobs|\d+ new jobs|jobs near you|top jobs/i.test(s)) {
      return null;
    }
    return "tier1";
  }

  // "Your application" — clearly about the user, not a blast
  if (/your application/i.test(s)) return "tier1";

  // "You applied to" — platform sends this when user clicks Apply
  if (/you applied/i.test(s)) return "tier1";

  // ── TIER 2 ────────────────────────────────────────────────────────────────

  // "We received your" — personalised confirmation from any company
  if (/we(?:'ve| have) received your/i.test(s)) return "tier2";

  // "Thank you for applying" — standard ATS confirmation
  if (/thank you for applying/i.test(s)) return "tier2";

  // Interview — only if personalised with "your" or "you"
  // Avoids: "Interview tips", "Mock interview", "Interview questions"
  if (/interview/i.test(s) && /\b(your|you)\b/i.test(s)) return "tier2";

  // Rejection — only if personalised
  // e.g. "Unfortunately, you have not been selected"
  if (/unfortunately/i.test(s) && /\b(you|your)\b/i.test(s)) return "tier2";

  // "Update on your application" — personalised status update
  if (/update on your/i.test(s)) return "tier2";

  // "Your candidature" / "your profile has been" — common in Indian ATS emails
  if (/your candidature|your profile has been/i.test(s)) return "tier2";

  return null; // not a job email — skip
}

// ── STATUS DETECTOR ───────────────────────────────────────────────────────────
function detectStatus(subject, body) {
  const text = (subject + " " + body).toLowerCase();

  // Offer — only detected from body content, not subject
  if (/offer letter|we(?:'d| would) like to offer|pleased to offer|selected for the role|congratulations.*(?:joining|offer)/i.test(text)) {
    return "Offer";
  }

  // Rejected
  if (/regret|not (?:moving forward|selected|progressing|shortlisted)|unfortunately|we will not be|decided to move forward with other candidates/i.test(text)) {
    return "Rejected";
  }

  // Interview
  if (/(?:schedule|invite|invited|confirm|book).*interview|interview.*(?:schedule|invite|confirm)|next (?:step|round|stage)/i.test(text)) {
    return "Interview";
  }

  // Default — email passed the tier check so it's at minimum an application
  return "Applied";
}

// ── EMAIL BODY EXTRACTOR ──────────────────────────────────────────────────────
function getEmailBody(payload) {
  if (!payload) return "";

  function extractFromParts(parts) {
    if (!parts) return "";
    // Prefer plain text
    for (const part of parts) {
      if (part.mimeType === "text/plain" && part.body?.data) {
        return Buffer.from(part.body.data, "base64").toString("utf-8");
      }
      if (part.parts) {
        const nested = extractFromParts(part.parts);
        if (nested) return nested;
      }
    }
    // Fallback to HTML, strip tags
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
  // 1. Domain-based — strip subdomains, use the main domain name
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

  // 2. "at CompanyName" in subject — e.g. "Your application at Acme"
  const atSubject = subject.match(/\bat\s+([A-Z][A-Za-z0-9\s&.]{1,30}?)(?:\s*[-|!,.]|$)/);
  if (atSubject) return atSubject[1].trim();

  // 3. "at CompanyName" in first 500 chars of body
  const snippet = body.slice(0, 500);
  const atBody = snippet.match(/\bat\s+([A-Z][A-Za-z0-9\s&.]{1,30}?)(?:\s*[,.]|\s+is|\s+we|\s+team)/);
  if (atBody) return atBody[1].trim();

  // 4. Sender display name as last resort
  const displayName = from.match(/^"?([^"<@\n]{2,40})"?\s*</);
  if (displayName) return displayName[1].trim();

  return "Unknown";
}

// ── ROLE EXTRACTOR ────────────────────────────────────────────────────────────
function extractRole(subject, body) {
  // 1. Strip platform prefixes from subject
  let cleaned = subject
    .replace(/^(re:|fwd:|fw:)\s*/gi, "")
    .replace(/^indeed\s+application[:\s]*/i, "")
    .replace(/^linkedin\s+application[:\s]*/i, "")
    .replace(/^naukri[:\s]*/i, "")
    .replace(/\b(your application(?: for)?|application for|thank you for applying|interview(?: invitation)?|update on your|we(?:'ve| have) received your)\b/gi, "")
    .replace(/[-–—]\s*(?:employment hero|linkedin|indeed|naukri|greenhouse|lever)\b.*/gi, "")
    .replace(/\[.*?\]/g, "")    // remove ticket refs like [EH-123]
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[-–—:,\s]+|[-–—:,\s]+$/g, "")
    .trim();

  if (cleaned.length > 3) return cleaned.slice(0, 80);

  // 2. Look for role mention in body
  const bodyRole = body.match(/(?:applying for|applied for|role of|position of)\s+(?:the\s+)?([A-Za-z\s\/\-]+?)(?:\s+at|\s+role|\.|,)/i);
  if (bodyRole) return bodyRole[1].trim().slice(0, 80);

  return "Unknown Role";
}

// ── MAIN PARSER ───────────────────────────────────────────────────────────────
function parseJobEmail(headers, body = "") {
  const subject = headers["subject"] || "";
  const from = headers["from"] || "";
  const date = headers["date"]
    ? new Date(headers["date"]).toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 10);

  const tier = classifyEmail(subject, from);
  if (!tier) return null; // not a job email

  const status = detectStatus(subject, body);
  const company = extractCompany(from, subject, body);
  const role = extractRole(subject, body);

  return { company, role, applied_date: date, status, source: "Gmail", tier };
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

  // Gmail search — tightly scoped to match only Tier 1 and Tier 2 subjects
  // "your application" | "you applied" | "thank you for applying" |
  // "we have received your" | from known platforms | interview + you/your |
  // "update on your" | "your candidature"
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
      'OR "update on your"',
      'OR "your candidature"',
      'OR "your profile has been"',
      'OR from:(linkedin.com OR indeed.com OR naukri.com OR greenhouse.io OR lever.co OR workday.com OR employmenthero.com OR smartrecruiters.com)',
    ")",
  ].join(" ");

  const { data } = await gmail.users.messages.list({ userId: "me", q: query, maxResults: 150 });
  if (!data.messages) return 0;

  let count = 0;
  for (const msg of data.messages) {
    // Skip already imported
    const exists = await supabase.from("applications").select("id").eq("gmail_message_id", msg.id).maybeSingle();
    if (exists.data) continue;

    const full = await gmail.users.messages.get({ userId: "me", id: msg.id, format: "full" });
    const hdrs = Object.fromEntries(full.data.payload.headers.map(h => [h.name.toLowerCase(), h.value]));
    const body = getEmailBody(full.data.payload);

    const parsed = parseJobEmail(hdrs, body);
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
