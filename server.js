const https = require('https');
const http = require('http'); 
const { Client } = require('pg');

const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const HIGHLIGHTLY_KEY = process.env.HIGHLIGHTLY_API_KEY;
const CHATWOOT_URL = process.env.CHATWOOT_URL || 'chatwoot-production-5bb4.up.railway.app';
const CHATWOOT_TOKEN = process.env.CHATWOOT_TOKEN;
const PORT = process.env.PORT || 3000;
const AZURE_KEY = process.env.AZURE_SPEECH_KEY;
const AZURE_REGION = process.env.AZURE_SPEECH_REGION || 'eastus';
const FOOTBALL_API_KEY = process.env.FOOTBALL_API_KEY;
const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'p0TiOqMl1M1IbvZ0ke9s';
const DATABASE_URL = process.env.DATABASE_URL;

// Per-fixture sequential queues
var matchQueues = {};

// ============= DATABASE =============
async function queryDB(sql, params) {
  var client = new Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 5000 });
  try { await client.connect(); var r = await client.query(sql, params); await client.end(); return r; }
  catch(e) { try { await client.end(); } catch(x) {} throw e; }
}

async function setupDB() {
  try {
    await queryDB(`CREATE TABLE IF NOT EXISTS wp_subscribers (
      id SERIAL PRIMARY KEY,
      conversation_id VARCHAR(50) UNIQUE NOT NULL,
      language VARCHAR(20) DEFAULT 'sheng',
      teams TEXT DEFAULT 'all',
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW(),
      last_message_at TIMESTAMP DEFAULT NOW()
    )`);

    // FIX #6: store actual commentary text not just event_type
    await queryDB(`CREATE TABLE IF NOT EXISTS wp_processed_events (
      id SERIAL PRIMARY KEY,
      event_key VARCHAR(200) UNIQUE NOT NULL,
      fixture_id BIGINT,
      minute INT,
      event_type VARCHAR(50),
      player VARCHAR(100),
      team VARCHAR(100),
      home_score INT DEFAULT 0,
      away_score INT DEFAULT 0,
      commentary_text TEXT,
      status VARCHAR(20) DEFAULT 'pending',
      processed_at TIMESTAMP DEFAULT NOW()
    )`);

    await queryDB(`CREATE TABLE IF NOT EXISTS wp_matches (
      fixture_id BIGINT PRIMARY KEY,
      league_name VARCHAR(100),
      country VARCHAR(100),
      home_team VARCHAR(100),
      away_team VARCHAR(100),
      status VARCHAR(20),
      home_score INT DEFAULT 0,
      away_score INT DEFAULT 0,
      kickoff TIMESTAMP,
      last_checked TIMESTAMP DEFAULT NOW()
    )`);

    // FIX #3: persist API request count across restarts
    await queryDB(`CREATE TABLE IF NOT EXISTS wp_api_usage (
      id SERIAL PRIMARY KEY,
      provider VARCHAR(50) NOT NULL,
      request_count INT DEFAULT 0,
      reset_at TIMESTAMP NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW()
    )`);

    // FIX #4: track video jobs per event
    await queryDB(`CREATE TABLE IF NOT EXISTS wp_video_jobs (
      id SERIAL PRIMARY KEY,
      event_key VARCHAR(200) UNIQUE NOT NULL,
      fixture_id BIGINT,
      home_team VARCHAR(100),
      away_team VARCHAR(100),
      goal_minute INT DEFAULT 0,
      status VARCHAR(20) DEFAULT 'pending',
      video_url TEXT,
      attempt INT DEFAULT 0,
      next_retry TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    await queryDB('ALTER TABLE wp_video_jobs ADD COLUMN IF NOT EXISTS goal_minute INT DEFAULT 0').catch(function(){});

    console.log('WatchParty DB ready!');
  } catch(e) { console.log('DB setup error:', e.message); }
}

// ============= FIX #3: Persistent API counter =============
async function getAPICount() {
  try {
    var now = new Date();
    var result = await queryDB("SELECT request_count, reset_at FROM wp_api_usage WHERE provider='api-football' AND reset_at > NOW() ORDER BY id DESC LIMIT 1");
    if (result.rows.length > 0) return parseInt(result.rows[0].request_count);
    // No valid row — reset at next midnight UTC (API-Football resets at 00:00 UTC)
    var resetAt = new Date();
    resetAt.setUTCHours(24, 0, 0, 0); // Next midnight UTC
    await queryDB("INSERT INTO wp_api_usage (provider, request_count, reset_at) VALUES ('api-football', 0, $1)", [resetAt]);
    return 0;
  } catch(e) { return 0; }
}

async function incrementAPICount() {
  try {
    await queryDB("UPDATE wp_api_usage SET request_count = request_count + 1, updated_at = NOW() WHERE provider='api-football' AND reset_at > NOW()");
  } catch(e) {}
}

// ============= API-FOOTBALL =============
async function footballAPI(path) {
  if (!FOOTBALL_API_KEY) return null;
  var count = await getAPICount();
  if (count >= 90) { console.log('API-Football limit approaching — conserving! Count:', count); return null; }
  await incrementAPICount();
  console.log('API-Football request #' + (count+1) + ': ' + path);
  return new Promise(function(resolve) {
    var options = { hostname: 'v3.football.api-sports.io', path: path, method: 'GET', headers: { 'x-apisports-key': FOOTBALL_API_KEY } };
    var req = https.request(options, function(res) {
      var d = '';
      res.on('data', function(c) { d += c; });
      res.on('end', function() {
        try {
          var result = JSON.parse(d);
          if (result.errors && result.errors.requests) { console.log('API-Football daily limit hit!'); resolve(null); return; }
          resolve(result);
        } catch(e) { resolve(null); }
      });
    });
    req.on('error', function() { resolve(null); });
    setTimeout(function() { req.destroy(); resolve(null); }, 10000);
    req.end();
  });
}

// ============= FIX #2: ATOMIC event insert =============
// Returns the new row ID if inserted (new event), null if already exists
async function tryInsertEvent(eventKey, fixtureId, minute, type, player, team) {
  try {
    var result = await queryDB(
      `INSERT INTO wp_processed_events (event_key, fixture_id, minute, event_type, player, team, status)
       VALUES ($1,$2,$3,$4,$5,$6,'pending')
       ON CONFLICT (event_key) DO NOTHING
       RETURNING id`,
      [eventKey, fixtureId, minute, type, player, team]
    );
    return result.rows.length > 0 ? result.rows[0].id : null;
  } catch(e) { console.log('tryInsertEvent error:', e.message); return null; }
}

async function markEventSent(eventId, commentaryText, homeScore, awayScore) {
  try {
    await queryDB('UPDATE wp_processed_events SET status=$1, commentary_text=$2, home_score=$3, away_score=$4 WHERE id=$5',
      ['sent', commentaryText, homeScore, awayScore, eventId]);
  } catch(e) {}
}

async function markEventFailed(eventId) {
  try { await queryDB("UPDATE wp_processed_events SET status='failed' WHERE id=$1", [eventId]); } catch(e) {}
}

// ============= SUBSCRIBERS =============
async function getSubscribers() {
  try {
    var r = await queryDB('SELECT conversation_id, language, teams FROM wp_subscribers WHERE active=true');
    return r.rows || [];
  } catch(e) { return []; }
}

async function saveSubscriber(conversationId, language, teams) {
  try {
    await queryDB(`INSERT INTO wp_subscribers (conversation_id, language, teams, last_message_at)
      VALUES ($1,$2,$3,NOW())
      ON CONFLICT (conversation_id) DO UPDATE SET language=$2, teams=$3, active=true, last_message_at=NOW()`,
      [conversationId, language, teams]);
  } catch(e) { console.log('Save subscriber error:', e.message); }
}

async function removeSubscriber(conversationId) {
  try { await queryDB('UPDATE wp_subscribers SET active=false WHERE conversation_id=$1', [conversationId]); } catch(e) {}
}

// ============= FIX #6: Get actual commentary history =============
async function getRecentCommentary(fixtureId) {
  try {
    var r = await queryDB(
      "SELECT commentary_text FROM wp_processed_events WHERE fixture_id=$1 AND status='sent' AND commentary_text IS NOT NULL ORDER BY processed_at DESC LIMIT 4",
      [fixtureId]
    );
    return r.rows.map(function(row) { return row.commentary_text; }).filter(Boolean);
  } catch(e) { return []; }
}

// ============= FIX #1: Reconstruct score from processed events =============
async function getScoreAfterEvent(fixtureId, homeTeam, awayTeam, untilMinute) {
  try {
    var r = await queryDB(
      "SELECT team, minute FROM wp_processed_events WHERE fixture_id=$1 AND event_type='Goal' AND status='sent' AND minute <= $2 ORDER BY minute ASC",
      [fixtureId, untilMinute]
    );
    var homeScore = 0; var awayScore = 0;
    r.rows.forEach(function(row) {
      if (row.team === homeTeam) homeScore++;
      else awayScore++;
    });
    return { homeScore: homeScore, awayScore: awayScore };
  } catch(e) { return { homeScore: 0, awayScore: 0 }; }
}

// ============= CHATWOOT =============
function sendChatwootMessage(conversationId, content) {
  return new Promise(function(resolve) {
    var body = JSON.stringify({ content: content, message_type: 'outgoing', private: false });
    var options = { hostname: CHATWOOT_URL, path: '/api/v1/accounts/1/conversations/' + conversationId + '/messages', method: 'POST', headers: { 'api_access_token': CHATWOOT_TOKEN, 'Content-Type': 'application/json', 'content-length': Buffer.byteLength(body) } };
    var req = https.request(options, function(res) {
      var d = '';
      res.on('data', function(c) { d += c; });
      res.on('end', function() {
        var ok = res.statusCode >= 200 && res.statusCode < 300;
        if (!ok) console.log('Chatwoot delivery failed:', res.statusCode, 'conv:', conversationId);
        resolve(ok);
      });
    });
    req.on('error', function(e) { console.log('Chatwoot error:', e.message); resolve(false); });
    setTimeout(function() { req.destroy(); resolve(false); }, 10000);
    req.write(body); req.end();
  });
}

function sendVoiceChatwoot(conversationId, audioBuffer) {
  return new Promise(function(resolve) {
    var boundary = 'boundary' + Date.now();
    var chatField = '--' + boundary + '\r\nContent-Disposition: form-data; name="content"\r\n\r\nVoice reaction\r\n';
    var header = '--' + boundary + '\r\nContent-Disposition: form-data; name="attachments[]"; filename="reaction.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n';
    var footer = '\r\n--' + boundary + '--\r\n';
    var body = Buffer.concat([Buffer.from(chatField), Buffer.from(header), audioBuffer, Buffer.from(footer)]);
    var options = { hostname: CHATWOOT_URL, path: '/api/v1/accounts/1/conversations/' + conversationId + '/messages', method: 'POST', headers: { 'api_access_token': CHATWOOT_TOKEN, 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': body.length } };
    var req = https.request(options, function(res) { var d = ''; res.on('data', function(c){ d+=c; }); res.on('end', function() { resolve(res.statusCode === 200 || res.statusCode === 201); }); });
    req.on('error', function() { resolve(false); });
    req.write(body); req.end();
  });
}

// ============= ELEVENLABS — FIX #7: aliases =============
var elevenLabsDictId = null;
async function setupElevenLabsAlias() {
  if (!ELEVENLABS_KEY) return null;
  try {
    // Check if dictionary already exists
    var listResult = await new Promise(function(resolve) {
      var options = { hostname: 'api.elevenlabs.io', path: '/v1/pronunciation-dictionaries', method: 'GET', headers: { 'xi-api-key': ELEVENLABS_KEY } };
      var req = https.request(options, function(res) { var d=''; res.on('data',function(c){d+=c;}); res.on('end',function(){try{resolve(JSON.parse(d));}catch(e){resolve(null);}}); });
      req.on('error', function(){resolve(null);}); req.end();
    });
    if (listResult && listResult.pronunciation_dictionaries) {
      var existing = listResult.pronunciation_dictionaries.find(function(d) { return d.name === 'watchparty_kenyan'; });
      if (existing) { elevenLabsDictId = existing.id; console.log('ElevenLabs dict reused:', elevenLabsDictId); return elevenLabsDictId; }
    }
    // Create new dictionary
    var rules = [
      { type: 'alias', string_to_replace: 'Yooo', alias: 'Yo' },
      { type: 'alias', string_to_replace: 'YOOO', alias: 'Yo' },
      { type: 'alias', string_to_replace: 'Weh', alias: 'Weh' },
      { type: 'alias', string_to_replace: 'Aii', alias: 'Ay' },
      { type: 'alias', string_to_replace: 'Bana', alias: 'Barna' },
      { type: 'alias', string_to_replace: 'Eeh', alias: 'Eeh' }
    ];
    var body = JSON.stringify({ name: 'watchparty_kenyan', description: 'WatchParty Kenyan football reactions', rules: rules });
    var createResult = await new Promise(function(resolve) {
      var options = { hostname: 'api.elevenlabs.io', path: '/v1/pronunciation-dictionaries', method: 'POST', headers: { 'xi-api-key': ELEVENLABS_KEY, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } };
      var req = https.request(options, function(res) { var d=''; res.on('data',function(c){d+=c;}); res.on('end',function(){try{resolve(JSON.parse(d));}catch(e){resolve(null);}}); });
      req.on('error', function(){resolve(null);}); req.write(body); req.end();
    });
    if (createResult && createResult.id) {
      elevenLabsDictId = createResult.id;
      console.log('ElevenLabs dict created:', elevenLabsDictId);
      return elevenLabsDictId;
    }
  } catch(e) { console.log('ElevenLabs alias error:', e.message); }
  return null;
}

function textToVoiceElevenLabs(text) {
  return new Promise(function(resolve) {
    if (!ELEVENLABS_KEY) { resolve(null); return; }
    var cleanText = text.replace(/[^\x00-\x7F]/g, '').replace(/\*\*/g, '').replace(/#\w+/g, '').trim();
    if (cleanText.length > 250) cleanText = cleanText.substring(0, 250);
    if (!cleanText || cleanText.length < 5) { resolve(null); return; }
    var ttsPayload = { text: cleanText, model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.5, similarity_boost: 0.8, style: 0.3, use_speaker_boost: true } };
    if (elevenLabsDictId) { ttsPayload.pronunciation_dictionary_locators = [{ pronunciation_dictionary_id: elevenLabsDictId, version_id: 'latest' }]; }
    var body = JSON.stringify(ttsPayload);
    var options = { hostname: 'api.elevenlabs.io', path: '/v1/text-to-speech/' + ELEVENLABS_VOICE_ID, method: 'POST', headers: { 'xi-api-key': ELEVENLABS_KEY, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg', 'Content-Length': Buffer.byteLength(body) } };
    var req = https.request(options, function(res) {
      var chunks = [];
      res.on('data', function(c) { chunks.push(c); });
      res.on('end', function() { resolve(res.statusCode === 200 ? Buffer.concat(chunks) : null); });
    });
    req.on('error', function() { resolve(null); });
    setTimeout(function() { req.destroy(); resolve(null); }, 20000);
    req.write(body); req.end();
  });
}

function textToVoiceAzure(text) {
  return new Promise(function(resolve) {
    if (!AZURE_KEY) { resolve(null); return; }
    var cleanText = text.replace(/[^\x00-\x7F]/g, '').replace(/\*\*/g, '').trim();
    if (!cleanText || cleanText.length < 5) { resolve(null); return; }
    var ssml = '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="sw-KE"><voice name="sw-KE-RafikiNeural"><prosody rate="1.1">' + cleanText + '</prosody></voice></speak>';
    var options = { hostname: AZURE_REGION + '.tts.speech.microsoft.com', path: '/cognitiveservices/v1', method: 'POST', headers: { 'Ocp-Apim-Subscription-Key': AZURE_KEY, 'Content-Type': 'application/ssml+xml', 'X-Microsoft-OutputFormat': 'audio-16khz-128kbitrate-mono-mp3', 'User-Agent': 'WatchPartyAI', 'Content-Length': Buffer.byteLength(ssml) } };
    var req = https.request(options, function(res) { var chunks = []; res.on('data', function(c) { chunks.push(c); }); res.on('end', function() { resolve(res.statusCode === 200 ? Buffer.concat(chunks) : null); }); });
    req.on('error', function() { resolve(null); });
    setTimeout(function() { req.destroy(); resolve(null); }, 15000);
    req.write(ssml); req.end();
  });
}

// ============= CLAUDE COMMENTARY =============
async function generateCommentary(eventContext, language, recentCommentary) {
  var historyNote = recentCommentary.length > 0
    ? '\n\nPrevious reactions you sent (AVOID repeating same words/style):\n' + recentCommentary.join('\n')
    : '';

  var prompt = `WATCHPARTY REACTION ENGINE — WatchParty Kenyan football commentary

VERIFIED MATCH FACTS ONLY (use these, do not invent anything else):
Competition: ${eventContext.competition}
${eventContext.home} ${eventContext.homeScore}-${eventContext.awayScore} ${eventContext.away}
Event: ${eventContext.eventType} — ${eventContext.scorer} (${eventContext.minute}')
Situation: ${eventContext.situation}
${historyNote}

YOUR RULES:
1. React to the SITUATION and SCORE, not just the goal
2. Maximum 2 short sentences — aim for 5-12 seconds when spoken
3. Vary your opening naturally: Yoh! / Weh! / Nah bro! / Eeh bana! / Aii! / Jameni! / Broooo! / Again?! / FINALLY!
4. NEVER invent: shot quality, goalkeeper, assists, tactics, what happened before or after
5. NEVER say "mchezo unaenda interesting" or "game imebadilika kabisa" or "hii game ni ya moyo"
6. Use the actual score naturally
7. Natural Kenyan English + Swahili/Sheng — do not force slang
8. 0-2 emojis only
9. Language: ${language}
10. Sound like a real fan texting a friend — NOT formal commentary

Return ONLY the reaction text. Nothing else.`;

  var body = JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 100, messages: [{ role: 'user', content: prompt }] });
  var options = { hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST', headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } };
  return new Promise(function(resolve) {
    var req = https.request(options, function(res) {
      var d = '';
      res.on('data', function(c) { d += c; });
      res.on('end', function() {
        try { var r = JSON.parse(d); resolve(r.content && r.content[0] ? r.content[0].text.trim() : ''); }
        catch(e) { resolve(''); }
      });
    });
    req.on('error', function() { resolve(''); });
    setTimeout(function() { req.destroy(); resolve(''); }, 15000);
    req.write(body); req.end();
  });
}

// ============= FIX #4+#5: ONE video job per event =============
async function createVideoJob(eventKey, fixtureId, homeTeam, awayTeam, goalMinute) {
  try {
    await queryDB(
      `INSERT INTO wp_video_jobs (event_key, fixture_id, home_team, away_team, goal_minute, status, next_retry)
       VALUES ($1,$2,$3,$4,$5,'pending',NOW())
       ON CONFLICT (event_key) DO NOTHING`,
      [eventKey, fixtureId, homeTeam, awayTeam, goalMinute || 0]
    );
  } catch(e) { console.log('createVideoJob error:', e.message); }
}

async function processVideJobs() {
  try {
    var jobs = await queryDB(
      "SELECT * FROM wp_video_jobs WHERE status='pending' AND next_retry <= NOW() AND attempt < 4"
    );
    for (var i = 0; i < jobs.rows.length; i++) {
      var job = jobs.rows[i];
      var videoUrl = null;

      // Try Highlightly
      try {
        var hlResult = await new Promise(function(resolve) {
          var options = { hostname: 'soccer.highlightly.net', path: '/matches/' + job.fixture_id + '/highlights', method: 'GET', headers: { 'x-rapidapi-key': HIGHLIGHTLY_KEY } };
          var req = https.request(options, function(res) { var d=''; res.on('data',function(c){d+=c;}); res.on('end',function(){try{resolve(JSON.parse(d));}catch(e){resolve(null);}}); });
          req.on('error', function(){resolve(null);}); setTimeout(function(){req.destroy();resolve(null);},10000); req.end();
        });
        if (hlResult && Array.isArray(hlResult) && hlResult.length > 0) {
          // Match to specific goal minute using job.goal_minute
          var candidate = hlResult.find(function(h) { return h.minute && Math.abs(h.minute - job.goal_minute) < 5; }) || hlResult[0];
          videoUrl = candidate && (candidate.url || candidate.videoUrl || candidate.embedUrl);
        }
      } catch(e) {}

      // Try ScoreBat if no video
      if (!videoUrl) {
        try {
          var q = encodeURIComponent(job.home_team + ' ' + job.away_team);
          var sbResult = await new Promise(function(resolve) {
            var options = { hostname: 'www.scorebat.com', path: '/video-api/v3/feed/?token=free&q=' + q, method: 'GET', headers: { 'Accept': 'application/json' } };
            var req = https.request(options, function(res) { var d=''; res.on('data',function(c){d+=c;}); res.on('end',function(){try{resolve(JSON.parse(d));}catch(e){resolve(null);}}); });
            req.on('error', function(){resolve(null);}); setTimeout(function(){req.destroy();resolve(null);},10000); req.end();
          });
          if (sbResult && sbResult.response && sbResult.response.length > 0) {
            videoUrl = sbResult.response[0].videos && sbResult.response[0].videos[0] && sbResult.response[0].videos[0].embed;
          }
        } catch(e) {}
      }

      if (videoUrl) {
        // Send to all subscribers
        var subs = await getSubscribers();
        for (var s = 0; s < subs.length; s++) {
          await sendChatwootMessage(subs[s].conversation_id, 'Watch the goal: ' + videoUrl);
          await new Promise(function(r) { setTimeout(r, 300); });
        }
        await queryDB("UPDATE wp_video_jobs SET status='sent', video_url=$1 WHERE id=$2", [videoUrl, job.id]);
        console.log('Video found and sent for event:', job.event_key);
      } else {
        var delays = [5*60, 10*60, 20*60, 0];
        var nextDelaySecs = delays[job.attempt] || 0;
        if (job.attempt >= 3) {
          await queryDB("UPDATE wp_video_jobs SET status='unavailable', attempt=$1 WHERE id=$2", [job.attempt + 1, job.id]);
        } else {
          var nextRetry = new Date(Date.now() + nextDelaySecs * 1000);
          await queryDB("UPDATE wp_video_jobs SET attempt=$1, next_retry=$2 WHERE id=$3", [job.attempt + 1, nextRetry, job.id]);
        }
      }
    }
  } catch(e) { console.log('Video job error:', e.message); }
}

// ============= DETERMINE SITUATION =============
function getSituation(eventType, homeScore, awayScore, scoringTeam, home, away, minute) {
  if (eventType !== 'Goal') return 'Red card! Match dynamics changed.';
  var isHome = scoringTeam === home;
  var scorerScore = isHome ? homeScore : awayScore;
  var opponentScore = isHome ? awayScore : homeScore;
  var min = parseInt(minute) || 0;
  if (scorerScore === opponentScore) return 'Equaliser — level again!';
  if (scorerScore === 1 && opponentScore === 0 && min <= 20) return 'Early opener!';
  if (scorerScore - opponentScore === 2) return 'Two goals ahead now — pulling away!';
  if (min >= 85) return 'Late drama! So late in the game!';
  if (min >= 75) return 'Late goal! Changes everything this late.';
  if (scorerScore - opponentScore === 1 && opponentScore > 0) return 'Now in front after being level!';
  return 'They take the lead!';
}

// ============= PROCESS ONE EVENT (in sequential queue) =============
async function processEvent(event, matchInfo, fixtureId, eventId) {
  var t0 = Date.now();
  var minuteNum = parseInt(event.time) || 0;

  // FIX #1: Reconstruct score from processed events — do NOT increment API score
  var scoreBeforeThisEvent = await getScoreAfterEvent(fixtureId, matchInfo.home, matchInfo.away, minuteNum - 1);
  var homeScore = scoreBeforeThisEvent.homeScore;
  var awayScore = scoreBeforeThisEvent.awayScore;
  if (event.type === 'Goal') {
    if (event.team === matchInfo.home) homeScore++;
    else awayScore++;
  }

  var flag = matchInfo.country === 'England' ? '' : matchInfo.country === 'Brazil' ? '' : matchInfo.country === 'Kenya' ? '' : '';
  var situation = getSituation(event.type, homeScore, awayScore, event.team, matchInfo.home, matchInfo.away, minuteNum);

  var eventContext = {
    competition: (matchInfo.league || 'Football') + ' ' + flag,
    home: matchInfo.home, away: matchInfo.away,
    homeScore: homeScore, awayScore: awayScore,
    scorer: event.player || 'Player',
    minute: event.time || '?',
    eventType: event.type === 'Goal' ? 'GOAL' : 'RED CARD',
    situation: situation
  };

  // Get subscribers
  var allSubs = await getSubscribers();
  var relevantSubs = allSubs.filter(function(s) {
    var teams = (s.teams || 'all').toLowerCase().trim();
    if (teams === 'all' || teams === 'all matches') return true;
    return teams.split(',').some(function(t) {
      return matchInfo.home.toLowerCase().includes(t.trim()) || matchInfo.away.toLowerCase().includes(t.trim());
    });
  });
  if (relevantSubs.length === 0) { await markEventFailed(eventId); return; }

  // Group by language
  var byLang = {};
  relevantSubs.forEach(function(s) {
    var lang = s.language || 'sheng';
    if (!byLang[lang]) byLang[lang] = [];
    byLang[lang].push(s.conversation_id);
  });

  // FIX #6: Get actual commentary text history
  var recentCommentary = await getRecentCommentary(fixtureId);

  var emoji = event.type === 'Goal' ? '' : '';
  var allCommentary = '';

  for (var lang in byLang) {
    var convIds = byLang[lang];
    var commentary = await generateCommentary(eventContext, lang, recentCommentary);
    if (!commentary) commentary = eventContext.eventType + '! ' + matchInfo.home + ' ' + homeScore + '-' + awayScore + ' ' + matchInfo.away;
    if (!allCommentary) allCommentary = commentary;

    var textMsg = flag + ' ' + (matchInfo.league || 'Football') + '\n';
    textMsg += emoji + ' ' + event.time + "' " + eventContext.eventType + '!\n';
    textMsg += matchInfo.home + ' ' + homeScore + '-' + awayScore + ' ' + matchInfo.away + '\n';
    if (event.player) textMsg += event.player + '\n';
    textMsg += '\n' + commentary;

    // STEP 1: Text first — always, verify delivery
    var atLeastOneSent = false;
    for (var i = 0; i < convIds.length; i++) {
      var sent = await sendChatwootMessage(convIds[i], textMsg);
      if (sent) atLeastOneSent = true;
      await new Promise(function(r) { setTimeout(r, 300); });
    }
    if (!atLeastOneSent) { console.log('All Chatwoot deliveries failed for lang:', lang); continue; }
    console.log('Text sent in', Date.now()-t0, 'ms for', convIds.length, lang, 'subscribers');

    // STEP 2: Voice after text — non-blocking per language
    var audioBuffer = await textToVoiceElevenLabs(commentary);
    if (!audioBuffer) audioBuffer = await textToVoiceAzure(commentary);
    if (audioBuffer) {
      for (var i = 0; i < convIds.length; i++) {
        await sendVoiceChatwoot(convIds[i], audioBuffer);
        await new Promise(function(r) { setTimeout(r, 300); });
      }
      console.log('Voice sent in', Date.now()-t0, 'ms');
    }
  }

  // FIX #2: Mark sent AFTER successful delivery
  await markEventSent(eventId, allCommentary, homeScore, awayScore);
  console.log('Event complete in', Date.now()-t0, 'ms');

  // STEP 3: FIX #4+#5 — ONE video job per event (outside language loop)
  if (event.type === 'Goal') {
    var eventKey = fixtureId + '-' + event.time + '-' + (event.team || '') + '-' + (event.player || '');
    await createVideoJob(eventKey, fixtureId, matchInfo.home, matchInfo.away, minuteNum);
  }
}

// ============= QUEUE EVENT PER MATCH =============
function queueEvent(event, matchInfo, fixtureId, eventId) {
  if (!matchQueues[fixtureId]) matchQueues[fixtureId] = Promise.resolve();
  matchQueues[fixtureId] = matchQueues[fixtureId].then(function() {
    return processEvent(event, matchInfo, fixtureId, eventId);
  }).catch(function(e) { console.log('Queue error for', fixtureId, ':', e.message); });
}

// ============= POLL LIVE MATCHES =============
var liveMatches = {};

async function pollLiveMatches() {
  try {
    var result = await footballAPI('/fixtures?live=all');
    if (!result || !result.response) return;

    var currentLiveIds = {};
    result.response.forEach(function(m) {
      var fId = String(m.fixture.id);
      currentLiveIds[fId] = true;
      if (!liveMatches[fId]) {
        liveMatches[fId] = {
          home: m.teams.home.name, away: m.teams.away.name,
          league: m.league.name, country: m.league.country,
          apiHomeScore: m.goals.home || 0, apiAwayScore: m.goals.away || 0
        };
        queryDB(`INSERT INTO wp_matches (fixture_id, league_name, country, home_team, away_team, status, home_score, away_score)
          VALUES ($1,$2,$3,$4,$5,'live',$6,$7)
          ON CONFLICT (fixture_id) DO UPDATE SET status='live', home_score=$6, away_score=$7, last_checked=NOW()`,
          [fId, m.league.name, m.league.country, m.teams.home.name, m.teams.away.name, m.goals.home || 0, m.goals.away || 0]).catch(function(){});
      }
    });

    // Clean finished matches
    Object.keys(liveMatches).forEach(function(fId) {
      if (!currentLiveIds[fId]) { delete liveMatches[fId]; delete matchQueues[fId]; }
    });

    console.log('Live matches:', Object.keys(liveMatches).length);

    // Poll events for each live match
    for (var fixtureId in liveMatches) {
      await pollMatchEvents(fixtureId);
      await new Promise(function(r) { setTimeout(r, 500); });
    }
  } catch(e) { console.log('Poll live error:', e.message); }
}

async function pollMatchEvents(fixtureId) {
  try {
    var matchInfo = liveMatches[fixtureId];
    if (!matchInfo) return;

    var eventsResult = await footballAPI('/fixtures/events?fixture=' + fixtureId);
    if (!eventsResult || !eventsResult.response) return;

    // Sort chronologically
    var events = eventsResult.response
      .filter(function(e) { return e.type === 'Goal' || (e.type === 'Card' && e.detail === 'Red Card'); })
      .sort(function(a, b) {
        var aMin = (a.time.elapsed || 0) + (a.time.extra || 0) * 0.1;
        var bMin = (b.time.elapsed || 0) + (b.time.extra || 0) * 0.1;
        return aMin - bMin;
      });

    for (var i = 0; i < events.length; i++) {
      var e = events[i];
      var playerId = (e.player && e.player.id) || 0;
      var teamId = (e.team && e.team.id) || 0;
      var extra = e.time.extra || 0;
      var eventKey = fixtureId + '-' + e.time.elapsed + '-' + extra + '-' + teamId + '-' + playerId + '-' + e.type + '-' + (e.detail || '');

      // FIX #2: Atomic insert — only queue if new
      var eventId = await tryInsertEvent(eventKey, fixtureId, e.time.elapsed, e.type, e.player && e.player.name, e.team && e.team.name);
      if (!eventId) continue; // Already processed

      var event = {
        type: e.type === 'Goal' ? 'Goal' : 'Card',
        detail: e.detail,
        player: e.player && e.player.name,
        team: e.team && e.team.name,
        time: e.time.elapsed + (extra > 0 ? '+' + extra : '')
      };

      console.log('NEW EVENT queued:', JSON.stringify(event), 'Match:', matchInfo.home, 'vs', matchInfo.away);
      queueEvent(event, matchInfo, fixtureId, eventId);
    }
  } catch(e) { console.log('Poll events error:', e.message); }
}

// ============= HANDLE WHATSAPP =============
async function handleIncomingWhatsApp(payload) {
  try {
    if (payload.event !== 'message_created' || payload.message_type !== 'incoming') return;
    var message = String(payload.content || '').trim().toLowerCase();
    var conversationId = String(payload.conversation && payload.conversation.id || '');
    var senderName = (payload.sender && payload.sender.name) || 'Fan';
    if (!message || !conversationId) return;
    console.log('WatchParty from', senderName, ':', message);

    if (message.startsWith('subscribe') || message.startsWith('watchparty')) {
      var parts = message.replace('watchparty', '').replace('subscribe', '').trim().split(' ');
      var team = parts[0] || 'all';
      var lang = (parts[1] || 'sheng').toLowerCase();
      if (!['sheng','swahili','somali','english'].includes(lang)) lang = 'sheng';
      await saveSubscriber(conversationId, lang, team);
      var teamDisplay = (team === 'all') ? 'ALL matches' : team;
      var msg = lang === 'english'
        ? 'WatchParty activated! Subscribed to ' + teamDisplay + ' in ENGLISH. Text STOP WATCHPARTY to unsubscribe.'
        : 'WatchParty imewashwa! Umejiunga na ' + teamDisplay + ' kwa lugha ya ' + lang.toUpperCase() + '. Text STOP WATCHPARTY kusimama.';
      await sendChatwootMessage(conversationId, msg);
      return;
    }

    if (message.includes('stop watchparty') || message === 'stop') {
      await removeSubscriber(conversationId);
      await sendChatwootMessage(conversationId, 'WatchParty alerts zimesimamishwa. Text SUBSCRIBE kuanza tena!');
      return;
    }

    if (message === 'status' || message === 'hali') {
      var subs = await getSubscribers();
      var mine = subs.find(function(s) { return s.conversation_id === conversationId; });
      var count = await getAPICount();
      if (!mine) { await sendChatwootMessage(conversationId, 'Bado hujajiunga! Text: SUBSCRIBE ARSENAL SHENG'); }
      else { await sendChatwootMessage(conversationId, 'Umejiunga! Timu: ' + mine.teams + ' | Lugha: ' + mine.language + ' | Live sasa: ' + Object.keys(liveMatches).length + ' | API: ' + count + '/90'); }
      return;
    }
  } catch(e) { console.log('Handler error:', e.message); }
}

// ============= HTTP SERVER =============
var server = http.createServer(function(req, res) {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200);
    res.end('WatchParty Running!\nLive: ' + Object.keys(liveMatches).length + ' matches');
    return;
  }
  if (req.method === 'GET' && req.url === '/poll-now') { res.writeHead(200); res.end('Polling!'); pollLiveMatches(); return; }
  if (req.method === 'POST' && req.url === '/webhook') {
    var body = '';
    req.on('data', function(c) { body += c; });
    req.on('end', async function() {
      res.writeHead(200); res.end('OK');
      try { await handleIncomingWhatsApp(JSON.parse(body)); } catch(e) {}
    });
    return;
  }
  res.writeHead(200); res.end('WatchParty AI');
});

server.listen(PORT, async function() {
  console.log('WatchParty starting on port ' + PORT);
  await setupDB();
  var dictId = await setupElevenLabsAlias();
  // FIX 1: Recover pending events from before crash
  setTimeout(async function() {
    try {
      var pending = await queryDB("SELECT * FROM wp_processed_events WHERE status='pending' AND processed_at > NOW() - INTERVAL '2 hours'");
      if (pending.rows.length > 0) {
        console.log('Recovering', pending.rows.length, 'pending events from crash...');
        for (var i = 0; i < pending.rows.length; i++) {
          var ev = pending.rows[i];
          // Get match info from DB
          var matchRow = await queryDB('SELECT * FROM wp_matches WHERE fixture_id=$1', [ev.fixture_id]).catch(function(){return {rows:[]};});
          if (matchRow.rows.length === 0) { await queryDB("UPDATE wp_processed_events SET status='failed' WHERE id=$1", [ev.id]); continue; }
          var m = matchRow.rows[0];
          var matchInfo = { home: m.home_team, away: m.away_team, league: m.league_name, country: m.country };
          var event = { type: ev.event_type, player: ev.player, team: ev.team, time: String(ev.minute) };
          console.log('Retrying event:', ev.event_key);
          queueEvent(event, matchInfo, String(ev.fixture_id), ev.id);
        }
      }
    } catch(e) { console.log('Pending recovery error:', e.message); }
  }, 5000);
  console.log('Voice:', ELEVENLABS_KEY ? 'ElevenLabs' : AZURE_KEY ? 'Azure' : 'None');
  console.log('Football API:', FOOTBALL_API_KEY ? 'Ready' : 'Missing');

  // Poll every 3 minutes — conserve API budget
  setInterval(pollLiveMatches, 3 * 60 * 1000);
  // Process video jobs every 5 minutes
  setInterval(processVideJobs, 5 * 60 * 1000);
  await pollLiveMatches();

  console.log('WatchParty Ready!');
});
