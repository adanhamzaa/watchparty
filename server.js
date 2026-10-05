const https = require("https");
const http = require("http");
const { Client } = require("pg");

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const GOAL_API_KEY = process.env.GOAL_API_KEY;
const FOOTBALL_API_KEY = process.env.FOOTBALL_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "p0TiOqMl1M1IbvZ0ke9s";
const CHATWOOT_URL = process.env.CHATWOOT_URL || "chatwoot-production-5bb4.up.railway.app";
const CHATWOOT_TOKEN = process.env.CHATWOOT_TOKEN;
const CHATWOOT_ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID || "1";
const POLL_MS = 3 * 60 * 1000;

const ALLOWED = [
  "premier league","fa cup","carabao cup","efl cup","league cup",
  "champions league","europa league","conference league","uefa conference league"
];
const WOMEN = [
  "women","woman","womens","women's","wsl","nwsl","feminine",
  "femenina","feminin","frauen","female"
];

let polling = false;
const liveMatches = new Map();
const queues = new Map();
const nextEventPoll = new Map();
let goalBackoffUntil = 0;
let footballBackoffUntil = 0;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function norm(s) {
  return String(s || "").toLowerCase().replace(/[.''`-]/g," ").replace(/\s+/g," ").trim();
}

function allowedCompetition(name) {
  const n = norm(name);
  return !!n && !WOMEN.some(x => n.includes(x)) && ALLOWED.some(x => n === x || n.includes(x));
}

function requestJson(hostname, path, headers, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method, headers, timeout: 10000 }, res => {
      let body = "";
      res.on("data", c => body += c);
      res.on("end", () => {
        let json = null;
        try { json = body ? JSON.parse(body) : null; } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body: json });
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

async function db(sql, params = []) {
  const c = new Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 8000 });
  try {
    await c.connect();
    const r = await c.query(sql, params);
    await c.end();
    return r;
  } catch (e) {
    try { await c.end(); } catch {}
    throw e;
  }
}

// ========= API CLIENTS =========
async function goal(path) {
  if (!GOAL_API_KEY || Date.now() < goalBackoffUntil) return null;
  try {
    const r = await requestJson("api.goal-api.com", "/v1" + path, {
      "Authorization": `Bearer ${GOAL_API_KEY}`,
      "Content-Type": "application/json"
    });
    const remaining = Number(r.headers["x-ratelimit-remaining"] || r.headers["x-ratelimit-requests-remaining"]);
    if (Number.isFinite(remaining)) {
      console.log("GOAL quota remaining:", remaining);
      if (remaining <= 5) goalBackoffUntil = Date.now() + 60 * 60 * 1000;
    }
    if (r.status === 429) {
      goalBackoffUntil = Date.now() + Math.max(60, Number(r.headers["retry-after"]) || 60) * 1000;
      console.log("GOAL API 429 — backing off");
      return null;
    }
    if (r.status < 200 || r.status >= 300) { console.log("GOAL API", path, "HTTP", r.status); return null; }
    return r.body;
  } catch (e) { console.log("GOAL API error:", e.message); return null; }
}

async function football(path) {
  if (!FOOTBALL_API_KEY || Date.now() < footballBackoffUntil) return null;
  try {
    const r = await requestJson("v3.football.api-sports.io", path, { "x-apisports-key": FOOTBALL_API_KEY });
    const daily = Number(r.headers["x-ratelimit-requests-remaining"]);
    const minute = Number(r.headers["x-ratelimit-remaining"]);
    if (Number.isFinite(daily)) console.log("API-Football daily remaining:", daily);
    if (Number.isFinite(minute) && minute <= 1) footballBackoffUntil = Date.now() + 60 * 1000;
    if (r.status === 429) {
      footballBackoffUntil = Date.now() + Math.max(60, Number(r.headers["retry-after"]) || 60) * 1000;
      console.log("API-Football 429 — backing off");
      return null;
    }
    if (r.status < 200 || r.status >= 300) { console.log("API-Football", path, "HTTP", r.status); return null; }
    return r.body;
  } catch (e) { console.log("API-Football error:", e.message); return null; }
}

// ========= NORMALIZATION =========
function goalMatch(x) {
  const h = x.homeTeam || {};
  const a = x.awayTeam || {};
  const l = x.league || {};
  const id = String(x.id || x.fixtureId || x.matchId || "");
  if (!id) return null;
  return {
    fixtureId: id,
    homeId: String(h.id || h.teamId || ""),
    awayId: String(a.id || a.teamId || ""),
    home: String(h.name || x.homeTeamName || "Home"),
    away: String(a.name || x.awayTeamName || "Away"),
    leagueId: String(l.id || l.leagueId || ""),
    league: String(l.name || x.leagueName || "Football"),
    country: String(l.country?.name || l.country || x.country || ""),
    status: String(x.matchStatus || x.status || ""),
    homeScore: Number(x.homeScore ?? x.score?.home ?? 0) || 0,
    awayScore: Number(x.awayScore ?? x.score?.away ?? 0) || 0,
    kickoffUtc: x.kickoffUtc || null
  };
}

function goalEvent(x, match) {
  const type = norm(x.type || x.eventType || "");
  let eventType = null;
  if (type === "goal" || type === "score") eventType = "Goal";
  if (type === "red card" || type === "red_card") eventType = "Card";
  if (!eventType) return null;
  const home = !!x.homeScorer;
  const score = String(x.score || "0 - 0").split("-").map(v => Number(v.trim()));
  return {
    type: eventType,
    detail: x.detail || x.type,
    player: String(x.homeScorer || x.awayScorer || x.player?.name || x.player || "").replace(/\s*\(o\.g\.\)/i, "").trim(),
    playerId: String(x.playerId || x.player?.id || ""),
    team: home ? match.home : match.away,
    teamId: home ? match.homeId : match.awayId,
    minute: Number(x.time || x.elapsed || 0) || 0,
    extra: Number(x.extra || 0) || 0,
    homeAfter: Number.isFinite(score[0]) ? score[0] : null,
    awayAfter: Number.isFinite(score[1]) ? score[1] : null,
    assist: x.assist?.name || x.assist || null
  };
}

function footballEvent(x) {
  const type = norm(x.type || "");
  const detail = norm(x.detail || "");
  let eventType = null;
  if (type === "goal") eventType = "Goal";
  if (detail === "red card" || detail === "second yellow card") eventType = "Card";
  if (!eventType) return null;
  return {
    type: eventType, detail: x.detail || x.type,
    player: String(x.player?.name || ""), playerId: String(x.player?.id || ""),
    team: String(x.team?.name || ""), teamId: String(x.team?.id || ""),
    minute: Number(x.time?.elapsed || 0), extra: Number(x.time?.extra || 0),
    homeAfter: null, awayAfter: null, assist: x.assist?.name || null
  };
}

// ========= DATABASE =========
async function saveMatch(m) {
  await db(`
    INSERT INTO wp_matches (fixture_id,league_name,country,home_team,away_team,status,home_score,away_score,kickoff,kickoff_utc,home_team_id,away_team_id,last_checked)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10,$11,NOW())
    ON CONFLICT (fixture_id) DO UPDATE SET
      league_name=EXCLUDED.league_name, country=EXCLUDED.country,
      home_team=EXCLUDED.home_team, away_team=EXCLUDED.away_team,
      status=EXCLUDED.status, home_score=EXCLUDED.home_score,
      away_score=EXCLUDED.away_score, kickoff=EXCLUDED.kickoff,
      kickoff_utc=EXCLUDED.kickoff_utc, home_team_id=EXCLUDED.home_team_id,
      away_team_id=EXCLUDED.away_team_id, last_checked=NOW()
  `, [m.fixtureId, m.league, m.country, m.home, m.away, m.status,
      m.homeScore, m.awayScore, m.kickoffUtc ? new Date(m.kickoffUtc) : null,
      m.homeId || null, m.awayId || null]);
}

async function addVolume2Columns() {
  await db("ALTER TABLE wp_processed_events ADD COLUMN IF NOT EXISTS voice_script TEXT").catch(() => {});
  await db("ALTER TABLE wp_processed_events ADD COLUMN IF NOT EXISTS situation VARCHAR(40)").catch(() => {});
  console.log("Volume 2 columns ready!");
}

async function addVolume2Columns() {
  try {
    await db("ALTER TABLE wp_processed_events ADD COLUMN IF NOT EXISTS voice_script TEXT");
    await db("ALTER TABLE wp_processed_events ADD COLUMN IF NOT EXISTS situation VARCHAR(40)");
    console.log("Volume 2 columns ready!");
  } catch(e) { console.log("Volume 2 columns:", e.message); }
}

async function schemaCheck() {
  const names = ["wp_subscribers","wp_subscriber_teams","wp_subscriber_preferences",
    "wp_matches","wp_processed_events","wp_match_narrative","wp_match_context",
    "wp_derby_database","wp_teams","wp_players","wp_player_seasons",
    "wp_player_transfers","wp_predictions","wp_watchparty_iq","wp_delivery_log"];
  const r = await db(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name=ANY($1::text[])`, [names]);
  const found = new Set(r.rows.map(x => x.table_name));
  const missing = names.filter(x => !found.has(x));
  if (missing.length) throw new Error("Missing tables: " + missing.join(", "));
  console.log("V1 database: 15/15 tables OK");
}

// ========= SUBSCRIBERS =========
async function followedTeams() {
  const r = await db(`
    SELECT DISTINCT st.team_id, st.team_name FROM wp_subscriber_teams st
    JOIN wp_subscribers s ON s.conversation_id = st.subscriber_id WHERE s.active=true
  `);
  return r.rows;
}

async function myTeams(conversationId) {
  const r = await db(`SELECT team_id, team_name FROM wp_subscriber_teams WHERE subscriber_id=$1 ORDER BY team_name`, [conversationId]);
  return r.rows;
}

async function activate(conversationId) {
  await db(`
    INSERT INTO wp_subscribers (conversation_id, language, active, last_active_at, last_message_at)
    VALUES ($1,'english',true,NOW(),NOW())
    ON CONFLICT (conversation_id) DO UPDATE SET active=true, last_active_at=NOW(), last_message_at=NOW()
  `, [conversationId]);
  await db(`INSERT INTO wp_subscriber_preferences (subscriber_id) VALUES ($1) ON CONFLICT DO NOTHING`, [conversationId]);
}

async function follow(conversationId, team) {
  await activate(conversationId);
  await db(`
    INSERT INTO wp_subscriber_teams (subscriber_id, team_name, team_id)
    VALUES ($1,$2,$3) ON CONFLICT (subscriber_id,team_name)
    DO UPDATE SET team_id=COALESCE(EXCLUDED.team_id, wp_subscriber_teams.team_id)
  `, [conversationId, team.name, team.id || null]);
}

async function stop(conversationId) {
  await db(`UPDATE wp_subscribers SET active=false, last_active_at=NOW() WHERE conversation_id=$1`, [conversationId]);
}

// ========= TEAM RESOLUTION =========
const COMMON = {
  "arsenal":"Arsenal","chelsea":"Chelsea","liverpool":"Liverpool",
  "manchester united":"Manchester United","man united":"Manchester United",
  "manchester city":"Manchester City","man city":"Manchester City",
  "tottenham":"Tottenham","spurs":"Tottenham","newcastle":"Newcastle United",
  "everton":"Everton","aston villa":"Aston Villa","west ham":"West Ham United",
  "fulham":"Fulham","brentford":"Brentford","brighton":"Brighton",
  "crystal palace":"Crystal Palace","palace":"Crystal Palace",
  "bournemouth":"Bournemouth","nottingham forest":"Nottingham Forest",
  "forest":"Nottingham Forest","wolves":"Wolverhampton Wanderers"
};

async function resolveTeam(text) {
  const wanted = COMMON[norm(text)] || text.trim();
  const r = await goal("/teams?search=" + encodeURIComponent(wanted));
  if (r?.data && Array.isArray(r.data)) {
    const candidates = r.data.map(t => ({
      id: String(t.id || t.teamId || ""),
      name: String(t.name || t.teamName || ""),
      country: String(t.country?.name || t.country || ""),
      fixtures: (t._count?.homeFixtures || 0) + (t._count?.awayFixtures || 0),
      hasBadge: !!t.badge
    })).filter(t => t.id && t.name)
      // Exclude women's teams
      .filter(t => !WOMEN.some(w => norm(t.name).includes(w)));

    // Prefer: exact name + has country + most fixtures
    candidates.sort((a, b) => {
      const aExact = norm(a.name) === norm(wanted) ? 1 : 0;
      const bExact = norm(b.name) === norm(wanted) ? 1 : 0;
      if (aExact !== bExact) return bExact - aExact;
      const aHasCountry = a.country ? 1 : 0;
      const bHasCountry = b.country ? 1 : 0;
      if (aHasCountry !== bHasCountry) return bHasCountry - aHasCountry;
      return b.fixtures - a.fixtures;
    });

    if (candidates[0]) return candidates[0];
  }
  if (COMMON[norm(text)]) return { id: null, name: COMMON[norm(text)], country: "England" };
  return null;
}

// ========= UPCOMING FIXTURES =========
async function upcomingForTeam(team) {
  if (!team.team_id) return [];
  const r = await goal(`/teams/${encodeURIComponent(team.team_id)}/upcoming`);
  if (r?.data && Array.isArray(r.data)) {
    return r.data.map(goalMatch).filter(Boolean).filter(m => allowedCompetition(m.league)).slice(0,5);
  }
  return [];
}

async function showUpcoming(conversationId) {
  const teams = await myTeams(conversationId);
  if (!teams.length) {
    return sendChatwoot(conversationId, "You are not following a team yet.\n\nTry: WATCH ARSENAL");
  }
  const all = [];
  for (const t of teams) {
    const fixtures = await upcomingForTeam(t);
    for (const m of fixtures) all.push(m);
  }
  const unique = [...new Map(all.map(m => [m.fixtureId, m])).values()]
    .sort((a,b) => new Date(a.kickoffUtc || 0) - new Date(b.kickoffUtc || 0))
    .slice(0,5);
  if (!unique.length) {
    return sendChatwoot(conversationId, "I couldn't find upcoming fixtures right now. Try MATCHES again shortly.");
  }
  let msg = "⚽ YOUR UPCOMING MATCHES\n\n";
  for (const m of unique) {
    await saveMatch(m);
    const time = m.kickoffUtc ? new Date(m.kickoffUtc).toLocaleString("en-KE", {
      timeZone:"Africa/Nairobi", weekday:"short", day:"numeric", month:"short", hour:"numeric", minute:"2-digit"
    }) : "Kickoff TBC";
    msg += `${m.home} vs ${m.away}\n${time} Nairobi\n${m.league}\n\n`;
  }
  await sendChatwoot(conversationId, msg.trim());
}

// ========= LIVE DISCOVERY =========
async function liveFixturesForTeam(team) {
  if (!team.team_id) return [];
  const r = await goal(`/teams/${encodeURIComponent(team.team_id)}/fixtures`);
  if (!r?.data || !Array.isArray(r.data)) return [];
  return r.data.map(goalMatch).filter(Boolean).filter(m => allowedCompetition(m.league)).filter(m => {
    const s = norm(m.status);
    return s.includes("live") || s.includes("half") || s.includes("1h") || s.includes("2h") || s === "ht" || s === "et";
  });
}

async function discoverLive() {
  const teams = await followedTeams();
  if (!teams.length) {
    console.log("No subscribers -> ZERO live football API polling");
    liveMatches.clear();
    return [];
  }
  const unique = new Map();
  for (const t of teams) {
    const matches = await liveFixturesForTeam(t);
    for (const m of matches) unique.set(m.fixtureId, m);
  }
  const matches = [...unique.values()];
  for (const m of matches) {
    await saveMatch(m);
    liveMatches.set(m.fixtureId, m);
    if (!nextEventPoll.has(m.fixtureId)) nextEventPoll.set(m.fixtureId, 0);
  }
  const ids = new Set(matches.map(m => m.fixtureId));
  for (const id of liveMatches.keys()) {
    if (!ids.has(id)) { liveMatches.delete(id); nextEventPoll.delete(id); queues.delete(id); }
  }
  console.log("Live discovery:", matches.length, "followed match(es) monitored");
  return matches;
}

// ========= EVENT INGESTION =========
function eventKey(fixtureId, e) {
  return [fixtureId, e.type, e.minute, e.extra, e.teamId || norm(e.team), e.playerId || norm(e.player), norm(e.detail)].join("|");
}

async function insertNewEvent(match, e) {
  const key = eventKey(match.fixtureId, e);
  const r = await db(`
    INSERT INTO wp_processed_events (event_key,fixture_id,minute,extra_minute,event_type,player,player_id,team,team_id,assist,status,processed_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',NOW())
    ON CONFLICT (event_key) DO NOTHING RETURNING id
  `, [key, match.fixtureId, e.minute, e.extra, e.type, e.player||null, e.playerId||null, e.team||null, e.teamId||null, e.assist||null]);
  return r.rows[0] ? { id: r.rows[0].id, key } : null;
}

// ========= VOLUME 2 HELPERS =========
async function getRecentCommentary(fixtureId) {
  const r = await db(`
    SELECT commentary_text FROM wp_processed_events
    WHERE fixture_id=$1 AND status='sent'
    AND commentary_text IS NOT NULL AND commentary_text <> ''
    ORDER BY id DESC LIMIT 5
  `, [fixtureId]);
  return r.rows.map(r => r.commentary_text);
}

function parseClaudeJSON(text) {
  try {
    const cleaned = String(text || "")
      .replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
    const parsed = JSON.parse(cleaned);
    return { text_script: String(parsed.text_script || "").trim(), voice_script: String(parsed.voice_script || "").trim() };
  } catch (e) { console.log("Claude JSON parse error:", e.message); return null; }
}

async function generateCommentary(context) {
  if (!process.env.ANTHROPIC_KEY) { console.log("ANTHROPIC_KEY missing"); return null; }
  const history = context.history.length ? context.history.map((x,i) => `${i+1}. ${x}`).join("\n") : "No previous reactions.";
  const prompt = `You are WatchParty AI — a passionate Nairobi football fan reacting to a LIVE football event.
You are NOT a TV commentator. You are reacting immediately as the event happens.
STYLE: Natural Kenyan football-fan energy. Short. Spontaneous. Emotional. Never robotic. Never invent facts.
TEXT SCRIPT: 1-2 short sentences. Useful football information plus personality.
VOICE SCRIPT: Completely separate spoken reaction. Sound like a Kenyan football fan sending a WhatsApp voice note. Normal: 7-9 seconds. Late goals/derby: 12-15 seconds.
SITUATION: ${context.situation}
MATCH: ${context.home} ${context.homeScore}-${context.awayScore} ${context.away}
COMPETITION: ${context.competition}
MINUTE: ${context.minute}
SCORER: ${context.scorer}
DERBY: ${context.derby || "None"}
PREVIOUS REACTIONS:\n${history}
IMPORTANT: Do not repeat the wording, opening phrase or emotional pattern of previous reactions.
Return ONLY valid JSON: {"text_script": "...", "voice_script": "..."}`;

  return new Promise(resolve => {
    const body = JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 300, messages: [{ role: "user", content: prompt }] });
    const req = https.request({
      hostname: "api.anthropic.com", path: "/v1/messages", method: "POST",
      headers: { "x-api-key": process.env.ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json", "content-length": Buffer.byteLength(body) }
    }, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try {
          if (res.statusCode < 200 || res.statusCode >= 300) { console.log("Claude HTTP", res.statusCode); return resolve(null); }
          const json = JSON.parse(data);
          resolve(parseClaudeJSON(json.content?.[0]?.text || ""));
        } catch (e) { console.log("Claude error:", e.message); resolve(null); }
      });
    });
    req.on("error", e => { console.log("Claude request error:", e.message); resolve(null); });
    req.setTimeout(15000, () => { req.destroy(); resolve(null); });
    req.write(body); req.end();
  });
}

function textToVoiceElevenLabs(text, sit) {
  return new Promise(resolve => {
    if (!ELEVENLABS_API_KEY) return resolve(null);
    let clean = String(text || "").replace(/[^\x00-\x7F]/g, "").replace(/\*\*/g, "").replace(/#/g, "").trim();
    if (!clean) return resolve(null);
    const maxChars = (sit === "LATE_GOAL" || sit === "EQUALIZER" || sit === "OPENING_GOAL") ? 260 : 190;
    if (clean.length > maxChars) clean = clean.substring(0, maxChars);
    const body = JSON.stringify({
      text: clean, model_id: "eleven_multilingual_v2",
      voice_settings: { stability: 0.45, similarity_boost: 0.80, style: 0.00, speed: 0.88, use_speaker_boost: true }
    });
    const req = https.request({
      hostname: "api.elevenlabs.io",
      path: `/v1/text-to-speech/${encodeURIComponent(ELEVENLABS_VOICE_ID)}?output_format=mp3_44100_128`,
      method: "POST",
      headers: { "xi-api-key": ELEVENLABS_API_KEY, "Content-Type": "application/json", "Accept": "audio/mpeg", "Content-Length": Buffer.byteLength(body) }
    }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) { console.log("ElevenLabs voice OK"); return resolve(Buffer.concat(chunks)); }
        console.log("ElevenLabs HTTP", res.statusCode); resolve(null);
      });
    });
    req.on("error", err => { console.log("ElevenLabs error:", err.message); resolve(null); });
    req.setTimeout(20000, () => { req.destroy(); resolve(null); });
    req.write(body); req.end();
  });
}

function sendVoiceChatwoot(conversationId, audioBuffer) {
  return new Promise(resolve => {
    const boundary = "----WatchParty" + Date.now();
    const header = `--${boundary}\r\nContent-Disposition: form-data; name="attachments[]"; filename="reaction.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n`;
    const footer = `\r\n--${boundary}--\r\n`;
    const body = Buffer.concat([Buffer.from(header), audioBuffer, Buffer.from(footer)]);
    const req = https.request({
      hostname: CHATWOOT_URL,
      path: `/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${encodeURIComponent(conversationId)}/messages`,
      method: "POST",
      headers: { "api_access_token": CHATWOOT_TOKEN, "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": body.length }
    }, res => {
      res.on("data", () => {});
      res.on("end", () => { const ok = res.statusCode >= 200 && res.statusCode < 300; if (!ok) console.log("Chatwoot voice failed:", res.statusCode); resolve(ok); });
    });
    req.on("error", err => { console.log("Chatwoot voice error:", err.message); resolve(false); });
    req.write(body); req.end();
  });
}

// ========= SCORE RECONSTRUCTION =========
async function matchScoreFromEvents(match) {
  const r = await db(`
    SELECT event_type, team, team_id FROM wp_processed_events
    WHERE fixture_id=$1 AND status IN ('pending','sent') AND event_type='Goal'
    ORDER BY minute, extra_minute, id
  `, [match.fixtureId]);
  let home = 0, away = 0;
  for (const e of r.rows) {
    if ((e.team_id && match.homeId && String(e.team_id) === String(match.homeId)) || norm(e.team) === norm(match.home)) home++;
    else away++;
  }
  return { home, away };
}

// ========= MATCH SITUATION =========
function situation(before, after, e) {
  if (after.home + after.away === 1) return "OPENING_GOAL";
  if ((before.home > before.away && after.home === after.away) || (before.away > before.home && after.home === after.away)) return "EQUALIZER";
  if (before.home === before.away && after.home !== after.away) return "GO_AHEAD_GOAL";
  if (e.minute >= 75) return "LATE_GOAL";
  if (Math.abs(after.home - after.away) >= 2) return "TWO_GOAL_LEAD";
  return e.type === "Card" ? "RED_CARD" : "GOAL";
}

// ========= DERBY =========
async function derby(match) {
  const r = await db(`
    SELECT derby_name FROM wp_derby_database
    WHERE (LOWER(team1)=LOWER($1) AND LOWER(team2)=LOWER($2))
       OR (LOWER(team1)=LOWER($2) AND LOWER(team2)=LOWER($1)) LIMIT 1
  `, [match.home, match.away]);
  return r.rows[0]?.derby_name || null;
}

// ========= PROCESS EVENT — VOLUME 2 =========
async function processEvent(match, e, row) {
  const t0 = Date.now();

  // Score
  const before = await matchScoreFromEvents(match);
  let after = { ...before };
  if (e.type === "Goal") {
    if (e.teamId && match.homeId && String(e.teamId) === String(match.homeId)) after.home++;
    else after.away++;
    if (e.homeAfter !== null && e.awayAfter !== null) { after.home = e.homeAfter; after.away = e.awayAfter; }
  }

  // Situation + Derby
  const sit = situation(before, after, e);
  const derbyName = await derby(match);

  // Subscribers
  const r = await db(`
    SELECT s.conversation_id FROM wp_subscribers s
    JOIN wp_subscriber_teams st ON st.subscriber_id = s.conversation_id
    WHERE s.active=true AND (
      (st.team_id IS NOT NULL AND st.team_id IN ($1,$2)) OR
      (st.team_id IS NULL AND LOWER(st.team_name) IN (LOWER($3),LOWER($4)))
    )
  `, [match.homeId||"", match.awayId||"", match.home, match.away]);

  if (!r.rows.length) {
    await db("UPDATE wp_processed_events SET status='failed' WHERE id=$1", [row.id]);
    return;
  }

  // Commentary history
  const history = await getRecentCommentary(match.fixtureId);

  // Claude AI commentary
  const ai = await generateCommentary({
    competition: match.league || "Football",
    home: match.home, away: match.away,
    homeScore: after.home, awayScore: after.away,
    scorer: e.player || "Unknown",
    minute: `${e.minute}${e.extra ? "+" + e.extra : ""}`,
    situation: sit, derby: derbyName, history
  });

  // Fallback if Claude fails
  const textScript = ai?.text_script ||
    `${e.type === "Goal" ? "⚽ GOAL!" : "🟥 RED CARD!"} ${e.player ? e.player + " — " : ""}${match.home} ${after.home}-${after.away} ${match.away}`;
  const voiceScript = ai?.voice_script || textScript;

  // Build full text message
  const textMessage =
    `${e.type === "Goal" ? "⚽" : "🟥"} ${match.league}\n` +
    `${match.home} ${after.home}-${after.away} ${match.away}\n` +
    `${e.minute}${e.extra ? "+" + e.extra : ""}\'` +
    `${e.player ? " — " + e.player : ""}` +
    `${derbyName ? "\n🔥 " + derbyName : ""}` +
    `\n\n${textScript}`;

  // Send text first — always immediate
  let sent = 0;
  for (const sub of r.rows) {
    const ok = await sendChatwoot(sub.conversation_id, textMessage);
    await db("INSERT INTO wp_delivery_log (subscriber_id,fixture_id,event_key,text_sent,text_delivered) VALUES ($1,$2,$3,true,$4)",
      [sub.conversation_id, match.fixtureId, row.key, ok]).catch(() => {});
    if (ok) sent++;
    await sleep(200);
  }

  if (sent > 0) {
    await db(`UPDATE wp_processed_events SET status='sent', commentary_text=$1, voice_script=$2, situation=$3, home_score=$4, away_score=$5, score_home_before=$6, score_away_before=$7, score_home_after=$8, score_away_after=$9, emotion_level=$10, processed_at=NOW() WHERE id=$11`,
      [textScript, voiceScript, sit, after.home, after.away, before.home, before.away, after.home, after.away,
       e.minute >= 75 ? 0.95 : sit === "EQUALIZER" ? 0.85 : 0.65, row.id]);
  } else {
    await db("UPDATE wp_processed_events SET status='failed' WHERE id=$1", [row.id]);
    return;
  }

  // Voice — non-blocking, does not delay next event
  if (ELEVENLABS_API_KEY && voiceScript) {
    Promise.resolve().then(async () => {
      console.log("Generating voice:", sit, "for", match.home, "vs", match.away);
      const audio = await textToVoiceElevenLabs(voiceScript, sit);
      if (!audio) { console.log("Voice generation failed"); return; }
      for (const sub of r.rows) {
        await sendVoiceChatwoot(sub.conversation_id, audio);
        await sleep(200);
      }
      console.log("Voice delivery complete:", Date.now() - t0, "ms");
    }).catch(err => console.log("Non-blocking voice error:", err.message));
  }

  console.log("Event complete:", match.home, "vs", match.away, sit, Date.now() - t0, "ms");
}

// ========= EVENT QUEUE =========
function queueEvent(match, e, row) {
  const id = match.fixtureId;
  const previous = queues.get(id) || Promise.resolve();
  const next = previous.then(() => processEvent(match, e, row)).catch(async err => {
    console.log("Event processing error:", err.message);
    await db(`UPDATE wp_processed_events SET status='failed' WHERE id=$1`, [row.id]).catch(() => {});
  });
  queues.set(id, next);
}

// ========= POLL EVENTS =========
async function pollEvents(match) {
  if (Date.now() < (nextEventPoll.get(match.fixtureId) || 0)) return;
  let events = [];
  const r = await goal(`/fixtures/${encodeURIComponent(match.fixtureId)}/events`);
  if (r?.data && Array.isArray(r.data)) {
    events = r.data.map(x => goalEvent(x, match)).filter(Boolean);
  }
  if (!events.length && FOOTBALL_API_KEY) {
    const f = await football(`/fixtures/events?fixture=${encodeURIComponent(match.fixtureId)}`);
    if (f?.response && Array.isArray(f.response)) {
      events = f.response.map(x => footballEvent(x)).filter(Boolean);
    }
  }
  events.sort((a,b) => (a.minute + a.extra/100) - (b.minute + b.extra/100));
  for (const e of events) {
    const row = await insertNewEvent(match, e);
    if (row) {
      console.log("NEW EVENT", match.home, "vs", match.away, e.type, e.minute, e.player);
      queueEvent(match, e, row);
    }
  }
  nextEventPoll.set(match.fixtureId, Date.now() + 45 * 1000);
}

// ========= MAIN POLLER =========
async function poll() {
  if (polling) return;
  polling = true;
  try {
    const matches = await discoverLive();
    for (const m of matches) { await pollEvents(m); await sleep(250); }
  } catch (e) { console.log("Poll error:", e.message); }
  finally { polling = false; }
}

// ========= NO OLD EVENT FLOOD =========
async function closeOldPending() {
  await db(`UPDATE wp_processed_events SET status='failed' WHERE status='pending' AND processed_at < NOW() - INTERVAL '5 minutes'`);
  console.log("Old pending events closed; none will be replayed on restart.");
}

// ========= CHATWOOT =========
function sendChatwoot(conversationId, content) {
  return new Promise(resolve => {
    const body = JSON.stringify({ content, message_type: "outgoing", private: false });
    const req = https.request({
      hostname: CHATWOOT_URL,
      path: `/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${encodeURIComponent(conversationId)}/messages`,
      method: "POST",
      headers: { "api_access_token": CHATWOOT_TOKEN, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
    }, res => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        if (!ok) console.log("Chatwoot", res.statusCode, d.slice(0,200));
        resolve(ok);
      });
    });
    req.on("error", e => { console.log("Chatwoot error:", e.message); resolve(false); });
    req.write(body);
    req.end();
  });
}

// ========= WHATSAPP COMMANDS =========
async function handleWatch(conversationId, text) {
  const team = await resolveTeam(text);
  if (!team) {
    return sendChatwoot(conversationId, `I couldn't identify "${text}".\n\nTry:\nWATCH ARSENAL\nWATCH CHELSEA\nWATCH LIVERPOOL`);
  }
  await follow(conversationId, team);
  await sendChatwoot(conversationId, `🔴 ${team.name} selected!\n\nI'll watch their matches for you.`);
  await showUpcoming(conversationId);
}

async function webhook(payload) {
  if (payload.event !== "message_created" || payload.message_type !== "incoming" || payload.sender?.type === "agent_bot") return;
  const conversationId = String(payload.conversation?.id || "");
  const text = String(payload.content || "").trim();
  if (!conversationId || !text) return;
  await db(`UPDATE wp_subscribers SET last_message_at=NOW(), last_active_at=NOW() WHERE conversation_id=$1`, [conversationId]).catch(() => {});
  const watch = text.match(/^watch(?:party)?\s+(.+)$/i);
  if (watch) return handleWatch(conversationId, watch[1].trim());
  const n = norm(text);
  if (n === "matches" || n === "my matches" || n === "fixtures") return showUpcoming(conversationId);
  if (n === "stop" || n === "stop watchparty" || n === "stop watch") {
    await stop(conversationId);
    return sendChatwoot(conversationId, "WatchParty alerts stopped. Text WATCH ARSENAL to start again.");
  }
  if (n === "status") {
    const s = await db(`SELECT active FROM wp_subscribers WHERE conversation_id=$1`, [conversationId]);
    const teams = await myTeams(conversationId);
    return sendChatwoot(conversationId, s.rows[0]?.active ?
      `⚽ WatchParty active\nFollowing: ${teams.map(t => t.team_name).join(", ") || "none"}\nLive monitored: ${liveMatches.size}` :
      "WatchParty is not active.\n\nTry: WATCH ARSENAL");
  }
  if (n === "help" || n === "watchparty") {
    return sendChatwoot(conversationId, "⚽ WATCHPARTY\n\nWATCH ARSENAL — follow a team\nMATCHES — upcoming fixtures\nSTATUS — your status\nSTOP — stop alerts");
  }
}

// ========= HTTP SERVER =========
const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, liveMatches: liveMatches.size, polling, time: new Date().toISOString() }));
  }
  if (req.method === "GET" && req.url === "/poll-now") { res.writeHead(200); res.end("Polling started"); poll(); return; }
  if (req.method === "POST" && req.url === "/webhook") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", async () => {
      res.writeHead(200); res.end("OK");
      try { await webhook(JSON.parse(body)); } catch (e) { console.log("Webhook error:", e.message); }
    });
    return;
  }
  res.writeHead(200); res.end("WatchParty V1");
});

// ========= STARTUP =========
server.listen(PORT, async () => {
  console.log("WatchParty V1 starting on port", PORT);
  try {
    await schemaCheck();
    await addVolume2Columns();
    await closeOldPending();
    console.log("GOAL API:", GOAL_API_KEY ? "Ready" : "Missing");
    console.log("API-Football fallback:", FOOTBALL_API_KEY ? "Ready" : "Missing");
    console.log("Chatwoot:", CHATWOOT_TOKEN ? "Ready" : "Missing");
    await poll();
    setInterval(poll, POLL_MS);
    console.log("WatchParty V1 Ready!");
  } catch (e) {
    console.error("STARTUP FAILED:", e.message);
    process.exit(1);
  }
});
