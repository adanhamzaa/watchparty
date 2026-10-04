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
const GOAL_API_KEY = process.env.GOAL_API_KEY;
const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'p0TiOqMl1M1IbvZ0ke9s';
const DATABASE_URL = process.env.DATABASE_URL;

// Per-fixture sequential queues
var matchQueues = {};
var isPolling = false; // Single polling controller

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
      provider VARCHAR(50) PRIMARY KEY,
      request_count INT NOT NULL DEFAULT 0,
      reset_at TIMESTAMP NOT NULL,
      remaining INT DEFAULT 100,
      updated_at TIMESTAMP DEFAULT NOW()
    )`);
    await queryDB('ALTER TABLE wp_api_usage ADD COLUMN IF NOT EXISTS remaining INT DEFAULT 100').catch(function(){});
    // Ensure today's row exists
    await initAPICounter();

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

// ============= GOAL API (1000 requests/day free) =============
function goalAPI(path) {
  return new Promise(function(resolve) {
    if (!GOAL_API_KEY) { resolve(null); return; }
    var options = {
      hostname: 'api.goal-api.com',
      path: '/v1' + path,
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + GOAL_API_KEY, 'Content-Type': 'application/json' }
    };
    var req = https.request(options, function(res) {
      var d = '';
      res.on('data', function(c) { d += c; });
      res.on('end', function() {
        try {
          var result = JSON.parse(d);
          console.log('GOAL API:', path, '| Status:', res.statusCode);
          resolve(result);
        } catch(e) { resolve(null); }
      });
    });
    req.on('error', function(e) { console.log('GOAL API error:', e.message); resolve(null); });
    setTimeout(function() { req.destroy(); resolve(null); }, 10000);
    req.end();
  });
}

// ============= FIX #3: Persistent API counter =============
// Get next midnight UTC
function nextMidnightUTC() {
  var d = new Date();
  d.setUTCHours(24, 0, 0, 0);
  return d;
}

// Init or reset counter if past reset_at
async function initAPICounter() {
  try {
    var resetAt = nextMidnightUTC();
    await queryDB(
      `INSERT INTO wp_api_usage (provider, request_count, remaining, reset_at)
       VALUES ('api-football', 0, 100, $1)
       ON CONFLICT (provider) DO UPDATE SET
         request_count = CASE WHEN wp_api_usage.reset_at <= NOW() THEN 0 ELSE wp_api_usage.request_count END,
         remaining = CASE WHEN wp_api_usage.reset_at <= NOW() THEN 100 ELSE wp_api_usage.remaining END,
         reset_at = CASE WHEN wp_api_usage.reset_at <= NOW() THEN $1 ELSE wp_api_usage.reset_at END,
         updated_at = NOW()`,
      [resetAt]
    );
    var row = await queryDB("SELECT request_count, remaining, reset_at FROM wp_api_usage WHERE provider='api-football'");
    if (row.rows.length > 0) {
      console.log('API counter: ' + row.rows[0].request_count + ' used, ' + row.rows[0].remaining + ' remaining, resets at ' + row.rows[0].reset_at);
    }
  } catch(e) { console.log('initAPICounter error:', e.message); }
}

async function getAPICount() {
  try {
    await initAPICounter(); // Auto-reset if new day
    var result = await queryDB("SELECT request_count, remaining FROM wp_api_usage WHERE provider='api-football'");
    if (result.rows.length > 0) return parseInt(result.rows[0].request_count) || 0;
    return 0;
  } catch(e) { console.log('getAPICount error:', e.message); return 0; }
}

async function incrementAPICount(remainingFromHeader) {
  try {
    var updateRemaining = remainingFromHeader !== undefined ? ', remaining = $1' : '';
    if (remainingFromHeader !== undefined) {
      await queryDB(
        "UPDATE wp_api_usage SET request_count = request_count + 1, remaining = $1, updated_at = NOW() WHERE provider='api-football'",
        [remainingFromHeader]
      );
    } else {
      await queryDB(
        "UPDATE wp_api_usage SET request_count = request_count + 1, remaining = GREATEST(remaining - 1, 0), updated_at = NOW() WHERE provider='api-football'"
      );
    }
  } catch(e) { console.log('incrementAPICount error:', e.message); }
}

async function resetAPICount() {
  try {
    var resetAt = nextMidnightUTC();
    await queryDB(
      "UPDATE wp_api_usage SET request_count=0, remaining=100, reset_at=$1, updated_at=NOW() WHERE provider='api-football'",
      [resetAt]
    );
    console.log('API counter manually reset!');
  } catch(e) { console.log('resetAPICount error:', e.message); }
}

// ============= API-FOOTBALL =============
async function footballAPI(path) {
  if (!FOOTBALL_API_KEY) return null;
  var count = await getAPICount();
  // Use actual remaining from API-Football headers (stored in DB)
  var usageRow = null;
  try { usageRow = await queryDB("SELECT remaining, request_count FROM wp_api_usage WHERE provider='api-football'"); } catch(e) {}
  var remaining = usageRow && usageRow.rows.length > 0 ? parseInt(usageRow.rows[0].remaining) : (100 - count);
  if (remaining <= 5) { console.log('API-Football limit approaching — conserving! Remaining:', remaining); return null; }
  console.log('API-Football request #' + (count+1) + ' (' + remaining + ' remaining): ' + path);
  return new Promise(function(resolve) {
    var options = { hostname: 'v3.football.api-sports.io', path: path, method: 'GET', headers: { 'x-apisports-key': FOOTBALL_API_KEY } };
    var req = https.request(options, function(res) {
      var d = '';
      res.on('data', function(c) { d += c; });
      res.on('end', function() {
        try {
          // Read actual remaining quota from API-Football headers
          var remaining = res.headers['x-ratelimit-requests-remaining'];
          var limit = res.headers['x-ratelimit-requests-limit'];
          if (remaining !== undefined) {
            console.log('API-Football quota: ' + remaining + ' remaining of ' + limit);
            incrementAPICount(parseInt(remaining));
          } else {
            incrementAPICount();
          }
          var result = JSON.parse(d);
          if (result.errors && result.errors.requests) {
            console.log('API-Football daily limit hit!');
            incrementAPICount(0); // Mark as exhausted
            resolve(null); return;
          }
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

// ============= SCOREBOARD SVG GENERATOR =============
function generateScoreboardSVG(event, matchInfo, homeScore, awayScore) {
  try {
    var league = (matchInfo.league || 'Football').toUpperCase();
    var home = (matchInfo.home || '').toUpperCase();
    var away = (matchInfo.away || '').toUpperCase();
    var score = homeScore + ' - ' + awayScore;
    var player = event.player || '';
    var minute = event.time || '?';
    var eventEmoji = event.type === 'Goal' ? 'GOAL' : 'RED CARD';

    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="400">' +
      '<defs>' +
      '<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="#0a0a1a"/>' +
      '<stop offset="100%" stop-color="#1a1a3e"/>' +
      '</linearGradient>' +
      '</defs>' +
      '<rect width="800" height="400" fill="url(#bg)"/>' +
      '<rect y="340" width="800" height="60" fill="#1a5c2e"/>' +
      '<rect x="0" y="340" width="80" height="60" fill="#1e6b35"/>' +
      '<rect x="160" y="340" width="80" height="60" fill="#1e6b35"/>' +
      '<rect x="320" y="340" width="80" height="60" fill="#1e6b35"/>' +
      '<rect x="480" y="340" width="80" height="60" fill="#1e6b35"/>' +
      '<rect x="640" y="340" width="80" height="60" fill="#1e6b35"/>' +
      '<text x="400" y="45" text-anchor="middle" font-family="Arial" font-size="20" font-weight="bold" fill="rgba(255,255,255,0.6)">' + league + '</text>' +
      '<text x="270" y="155" text-anchor="end" font-family="Arial" font-size="40" font-weight="bold" fill="white">' + home + '</text>' +
      '<text x="530" y="155" text-anchor="start" font-family="Arial" font-size="40" font-weight="bold" fill="white">' + away + '</text>' +
      '<rect x="310" y="100" width="180" height="80" rx="12" fill="rgba(255,255,255,0.1)"/>' +
      '<text x="400" y="165" text-anchor="middle" font-family="Arial" font-size="56" font-weight="bold" fill="#FFD700">' + score + '</text>' +
      '<text x="400" y="220" text-anchor="middle" font-family="Arial" font-size="22" fill="#25D366">⚽ ' + minute + "' " + player + '</text>' +
      '<line x1="100" y1="245" x2="700" y2="245" stroke="rgba(255,255,255,0.2)" stroke-width="1"/>' +
      '<text x="400" y="285" text-anchor="middle" font-family="Arial" font-size="18" font-weight="bold" fill="#25D366">⚡ WatchParty AI</text>' +
      '<text x="400" y="315" text-anchor="middle" font-family="Arial" font-size="14" fill="rgba(255,255,255,0.4)">Football kwa East Africa</text>' +
      '</svg>';

    return Buffer.from(svg);
  } catch(e) {
    console.log('SVG error:', e.message);
    return null;
  }
}

async function sendSVGChatwoot(conversationId, svgBuffer, caption) {
  return new Promise(function(resolve) {
    var boundary = 'boundary' + Date.now();
    var CRLF = '\r\n';
    var captionPart = '--' + boundary + CRLF + 'Content-Disposition: form-data; name="content"' + CRLF + CRLF + (caption || '') + CRLF;
    var filePart = '--' + boundary + CRLF + 'Content-Disposition: form-data; name="attachments[]"; filename="scoreboard.svg"' + CRLF + 'Content-Type: image/svg+xml' + CRLF + CRLF;
    var endPart = CRLF + '--' + boundary + '--' + CRLF;
    var body = Buffer.concat([Buffer.from(captionPart), Buffer.from(filePart), svgBuffer, Buffer.from(endPart)]);
    var options = {
      hostname: CHATWOOT_URL, path: '/api/v1/accounts/1/conversations/' + conversationId + '/messages', method: 'POST',
      headers: { 'api_access_token': CHATWOOT_TOKEN, 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': body.length }
    };
    var req = https.request(options, function(res) {
      var d = ''; res.on('data', function(c) { d += c; });
      res.on('end', function() { resolve(res.statusCode >= 200 && res.statusCode < 300); });
    });
    req.on('error', function() { resolve(false); });
    req.write(body); req.end();
  });
}

async function sendSVGChatwoot(conversationId, imageBuffer, caption) {
  return new Promise(function(resolve) {
    var boundary = 'boundary' + Date.now();
    var captionField = '--' + boundary + '\r\nContent-Disposition: form-data; name="content"\r\n\r\n' + (caption || '') + '\r\n';
    var header = '--' + boundary + '\r\nContent-Disposition: form-data; name="attachments[]"; filename="scoreboard.png"\r\nContent-Type: image/png\r\n\r\n';
    var footer = '\r\n--' + boundary + '--\r\n';
    var body = Buffer.concat([Buffer.from(captionField), Buffer.from(header), imageBuffer, Buffer.from(footer)]);
    var options = {
      hostname: CHATWOOT_URL, path: '/api/v1/accounts/1/conversations/' + conversationId + '/messages', method: 'POST',
      headers: { 'api_access_token': CHATWOOT_TOKEN, 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': body.length }
    };
    var req = https.request(options, function(res) {
      var d = '';
      res.on('data', function(c) { d += c; });
      res.on('end', function() {
        var ok = res.statusCode >= 200 && res.statusCode < 300;
        console.log('Scoreboard image sent:', res.statusCode);
        resolve(ok);
      });
    });
    req.on('error', function(e) { console.log('Image send error:', e.message); resolve(false); });
    req.write(body); req.end();
  });
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
    var ttsPayload = { text: cleanText, model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.45, similarity_boost: 0.80, style: 0.00, speed: 0.88, use_speaker_boost: true } };
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

  var prompt = 'WATCHPARTY REACTION ENGINE\n\n' +
    'MATCH FACTS:\n' +
    'Competition: ' + eventContext.competition + '\n' +
    eventContext.home + ' ' + eventContext.homeScore + '-' + eventContext.awayScore + ' ' + eventContext.away + '\n' +
    'Event: ' + eventContext.eventType + ' - ' + eventContext.scorer + ' (' + eventContext.minute + 'min)\n' +
    'Situation: ' + eventContext.situation + '\n' +
    historyNote + '\n\n' +
    'Generate TWO versions:\n' +
    'TEXT: [1-2 sentences, include score, 0-2 emojis, natural Sheng/Swahili/English mix]\n' +
    'VOICE: [7-9 seconds spoken, REACTION only - text already shows score, write numbers as words like one-nil, add SSML breaks like <break time=\"0.35s\" /> between sentences, no emojis]\n\n' +
    'RULES: Vary opening: Yo! Weh! Aii! Nah bro! NEVER invent goalkeeper/tactics. Language: ' + language;

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

    // STEP 1: Generate scoreboard image + send with text
    var scoreboardSvg = await generateScoreboardSVG(event, matchInfo, homeScore, awayScore);
    var textMsg2 = flag + ' ' + (matchInfo.league || 'Football') + '\n' + emoji + ' ' + event.time + "' " + eventContext.eventType + '!\n' + matchInfo.home + ' ' + homeScore + '-' + awayScore + ' ' + matchInfo.away + '\n' + (event.player ? event.player + '\n' : '') + '\n' + textCommentary;
    var atLeastOneSent = false;
    for (var i = 0; i < convIds.length; i++) {
      var sent = false;
      if (scoreboardSvg) {
        sent = await sendSVGChatwoot(convIds[i], scoreboardSvg, textMsg2);
      }
      if (!sent) {
        sent = await sendChatwootMessage(convIds[i], textMsg2);
      }
      if (sent) atLeastOneSent = true;
      await new Promise(function(r) { setTimeout(r, 300); });
    }
    if (!atLeastOneSent) { console.log('All Chatwoot deliveries failed for lang:', lang); continue; }
    console.log('Scoreboard + text sent in', Date.now()-t0, 'ms for', convIds.length, lang, 'subscribers');

    // STEP 2: Voice after text — use VOICE script not text script
    var audioBuffer = await textToVoiceElevenLabs(voiceCommentary);
    if (!audioBuffer) audioBuffer = await textToVoiceAzure(voiceCommentary);
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
  if (isPolling) { console.log('Poll already running — skipping'); return; }
  isPolling = true;
  try {
    var currentLiveIds = {};

    // GOAL API first — 1000 requests/day free
    if (GOAL_API_KEY) {
      var goalResult = await goalAPI('/fixtures/live');
      if (goalResult && goalResult.data && Array.isArray(goalResult.data)) {
        // Filter to popular leagues only — save API quota!
        var popularLeagues = [
          'premier league', 'champions league', 'la liga', 'serie a', 'bundesliga',
          'ligue 1', 'eredivisie', 'primeira liga', 'super lig', 'nations league',
          'world cup', 'euro', 'copa america', 'africa cup', 'premier league 2',
          'kenyan premier league', 'tanzanian premier league', 'ugandan premier league'
        ];
        var filtered = goalResult.data.filter(function(m) {
          var league = ((m.league && m.league.name) || '').toLowerCase();
          return popularLeagues.some(function(pl) { return league.includes(pl); });
        });
        // If no popular leagues found use all — but limit to 10
        var matchesToPoll = filtered.length > 0 ? filtered : goalResult.data.slice(0, 10);
        console.log('Filtered to', matchesToPoll.length, 'matches from', goalResult.data.length, 'total');

        matchesToPoll.forEach(function(m) {
          var fId = String(m.id);
          currentLiveIds[fId] = true;
          if (!liveMatches[fId]) {
            liveMatches[fId] = {
              home: (m.homeTeam && m.homeTeam.name) || 'Home',
              away: (m.awayTeam && m.awayTeam.name) || 'Away',
              league: (m.league && m.league.name) || 'Football',
              country: (m.league && m.league.country) || '',
              source: 'goal-api'
            };
            queryDB('INSERT INTO wp_matches (fixture_id, league_name, country, home_team, away_team, status, home_score, away_score) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (fixture_id) DO UPDATE SET status=$6, home_score=$7, away_score=$8, last_checked=NOW()',
              [fId, liveMatches[fId].league, liveMatches[fId].country, liveMatches[fId].home, liveMatches[fId].away, 'live',
               (m.score && m.score.home) || 0, (m.score && m.score.away) || 0]).catch(function(){});
          }
        });
        console.log('GOAL API live matches:', Object.keys(currentLiveIds).length);
      }
    }

    // API-Football fallback — only if GOAL API returns nothing
    if (Object.keys(currentLiveIds).length === 0 && FOOTBALL_API_KEY) {
      var afResult = await footballAPI('/fixtures?live=all');
      if (afResult && afResult.response) {
        afResult.response.forEach(function(m) {
          var fId = String(m.fixture.id);
          currentLiveIds[fId] = true;
          if (!liveMatches[fId]) {
            liveMatches[fId] = {
              home: m.teams.home.name, away: m.teams.away.name,
              league: m.league.name, country: m.league.country,
              source: 'api-football'
            };
            queryDB('INSERT INTO wp_matches (fixture_id, league_name, country, home_team, away_team, status, home_score, away_score) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (fixture_id) DO UPDATE SET status=$6, home_score=$7, away_score=$8, last_checked=NOW()',
              [fId, m.league.name, m.league.country, m.teams.home.name, m.teams.away.name, 'live', m.goals.home || 0, m.goals.away || 0]).catch(function(){});
          }
        });
        console.log('API-Football fallback live matches:', Object.keys(currentLiveIds).length);
      }
    }

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
  finally { isPolling = false; }
}

async function pollMatchEvents(fixtureId) {
  try {
    var matchInfo = liveMatches[fixtureId];
    if (!matchInfo) return;

    var rawEvents = [];
    var source = matchInfo.source || 'goal-api';

    // Try GOAL API events first
    if (GOAL_API_KEY && source !== 'api-football') {
      var goalFixture = await goalAPI('/fixtures/' + fixtureId);
      if (goalFixture && goalFixture.data) {
        var fd = goalFixture.data;
        // Check if match finished
        if (fd.matchStatus === 'FINISHED' || fd.matchStatus === 'FT' || fd.matchStatus === 'ENDED') {
          console.log('Match', fixtureId, 'finished (GOAL API) — stopping');
          delete liveMatches[fixtureId]; delete matchQueues[fixtureId];
          return;
        }
        // Parse events — GOAL API format
        var goalApiEvents = fd.events || [];
        rawEvents = goalApiEvents.map(function(e) {
          // Determine scorer and team
          var player = e.homeScorer || e.awayScorer || '';
          var isHome = !!e.homeScorer;
          var matchInfoLocal = liveMatches[fixtureId] || {};
          var team = isHome ? matchInfoLocal.home : matchInfoLocal.away;
          // Parse score from "1 - 1" format
          var scoreParts = (e.score || '0 - 0').split(' - ');
          var homeScore = parseInt(scoreParts[0]) || 0;
          var awayScore = parseInt(scoreParts[1]) || 0;
          return {
            type: e.type === 'GOAL' ? 'Goal' : (e.type === 'RED_CARD' ? 'Card' : e.type),
            detail: e.type,
            player: player.replace(' (o.g.)', ''),
            ownGoal: player.includes('(o.g.)'),
            team: team,
            elapsed: parseInt(e.time) || 0,
            extra: 0,
            score: e.score,
            homeScore: homeScore,
            awayScore: awayScore
          };
        }).filter(function(e) { return e.type === 'Goal' || e.type === 'Card'; });
        console.log('GOAL API events found:', rawEvents.length, 'for', fixtureId);
      }
    }

    // Fallback to API-Football
    if (rawEvents.length === 0 && FOOTBALL_API_KEY) {
      var eventsResult = await footballAPI('/fixtures/events?fixture=' + fixtureId);
      if (eventsResult && eventsResult.response) {
        rawEvents = eventsResult.response.map(function(e) {
          return {
            type: e.type === 'Goal' ? 'Goal' : (e.detail === 'Red Card' ? 'Card' : e.type),
            detail: e.detail,
            player: e.player && e.player.name,
            team: e.team && e.team.name,
            elapsed: e.time && e.time.elapsed || 0,
            extra: e.time && e.time.extra || 0
          };
        });
      }
    }

    // Sort chronologically
    var events = rawEvents
      .filter(function(e) { return e.type === 'Goal' || (e.type === 'Card' && (e.detail === 'Red Card' || e.detail === 'red_card')); })
      .sort(function(a, b) {
        return (a.elapsed + a.extra * 0.1) - (b.elapsed + b.extra * 0.1);
      });

    for (var i = 0; i < events.length; i++) {
      var e = events[i];
      var eventKey = fixtureId + '-' + e.elapsed + '-' + e.extra + '-' + (e.team || '') + '-' + (e.player || '') + '-' + e.type;

      var eventId = await tryInsertEvent(eventKey, fixtureId, e.elapsed, e.type, e.player, e.team);
      if (!eventId) continue;

      var event = {
        type: e.type,
        detail: e.detail,
        player: e.player,
        team: e.team,
        time: e.elapsed + (e.extra > 0 ? '+' + e.extra : '')
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

    // Only handle WatchParty commands — ignore AfriDesk responses
    if (payload.sender && payload.sender.type === 'agent_bot') return;

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
  if (req.method === 'GET' && req.url === '/reset-api-counter') { res.writeHead(200); res.end('Reset!'); resetAPICount(); return; }
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
