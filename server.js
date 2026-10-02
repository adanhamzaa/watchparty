const https = require('https');
const http = require('http');

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

// Subscriber database
// { conversationId: { teams: ['Arsenal'], language: 'sheng', active: true, phone: '254...' } }
var subscribers = {};
var matchPolling = {};
var lastEventIndex = {};
var commentaryHistory = {};

// ============= CHATWOOT =============
function sendChatwootMessage(conversationId, content) {
  return new Promise(function(resolve) {
    var body = JSON.stringify({ content: content, message_type: 'outgoing', private: false });
    var options = {
      hostname: CHATWOOT_URL, path: '/api/v1/accounts/1/conversations/' + conversationId + '/messages', method: 'POST',
      headers: { 'api_access_token': CHATWOOT_TOKEN, 'Content-Type': 'application/json', 'content-length': Buffer.byteLength(body) }
    };
    var req = https.request(options, function(res) { res.on('data', function(){}); res.on('end', resolve); });
    req.on('error', resolve);
    setTimeout(function() { req.destroy(); resolve(); }, 10000);
    req.write(body); req.end();
  });
}

// ============= HIGHLIGHTLY API =============
function highlightlyAPI(path) {
  return new Promise(function(resolve) {
    var options = {
      hostname: 'soccer.highlightly.net', path: path, method: 'GET',
      headers: { 'x-rapidapi-key': HIGHLIGHTLY_KEY, 'Content-Type': 'application/json' }
    };
    var req = https.request(options, function(res) {
      var d = '';
      res.on('data', function(c) { d += c; });
      res.on('end', function() { try { resolve(JSON.parse(d)); } catch(e) { resolve(null); } });
    });
    req.on('error', function() { resolve(null); });
    setTimeout(function() { req.destroy(); resolve(null); }, 10000);
    req.end();
  });
}

// ============= API-FOOTBALL (live goal detection) =============
function footballAPI(path) {
  return new Promise(function(resolve) {
    if (!FOOTBALL_API_KEY) { resolve(null); return; }
    var options = {
      hostname: 'v3.football.api-sports.io', path: path, method: 'GET',
      headers: { 'x-apisports-key': FOOTBALL_API_KEY }
    };
    var req = https.request(options, function(res) {
      var d = '';
      res.on('data', function(c) { d += c; });
      res.on('end', function() { try { resolve(JSON.parse(d)); } catch(e) { resolve(null); } });
    });
    req.on('error', function() { resolve(null); });
    setTimeout(function() { req.destroy(); resolve(null); }, 10000);
    req.end();
  });
}

// ============= SEARCH GOAL VIDEO =============
async function searchGoalVideo(event, homeTeam, awayTeam, fixtureId) {
  console.log('Searching video for:', homeTeam, 'vs', awayTeam);

  // Step 1 — Highlightly
  try {
    var hlResult = await highlightlyAPI('/matches/' + fixtureId + '/highlights');
    if (hlResult && Array.isArray(hlResult) && hlResult.length > 0) {
      var url = hlResult[0].url || hlResult[0].videoUrl || hlResult[0].embedUrl;
      if (url) { console.log('Highlightly video found!'); return url; }
    }
    var hlResult2 = await highlightlyAPI('/highlights?matchId=' + fixtureId);
    if (hlResult2 && hlResult2.data && hlResult2.data.length > 0) {
      var url2 = hlResult2.data[0].url || hlResult2.data[0].videoUrl;
      if (url2) { console.log('Highlightly video found (alt)!'); return url2; }
    }
    console.log('Highlightly: no video');
  } catch(e) { console.log('Highlightly video error:', e.message); }

  // Step 2 — ScoreBat backup
  try {
    var query = encodeURIComponent(homeTeam + ' ' + awayTeam);
    var sbResult = await new Promise(function(resolve) {
      var options = {
        hostname: 'www.scorebat.com', path: '/video-api/v3/feed/?token=free&q=' + query,
        method: 'GET', headers: { 'Accept': 'application/json' }
      };
      var req = https.request(options, function(res) {
        var d = '';
        res.on('data', function(c) { d += c; });
        res.on('end', function() { try { resolve(JSON.parse(d)); } catch(e) { resolve(null); } });
      });
      req.on('error', function() { resolve(null); });
      setTimeout(function() { req.destroy(); resolve(null); }, 10000);
      req.end();
    });
    if (sbResult && sbResult.response && sbResult.response.length > 0) {
      var sbVideo = sbResult.response[0];
      var sbUrl = sbVideo.videos && sbVideo.videos[0] && sbVideo.videos[0].embed;
      if (sbUrl) { console.log('ScoreBat video found!'); return sbUrl; }
    }
    console.log('ScoreBat: no video');
  } catch(e) { console.log('ScoreBat error:', e.message); }

  return null;
}

// ============= CLAUDE COMMENTARY =============
function generateCommentary(event, matchInfo, language, fixtureId) {
  return new Promise(function(resolve) {
    var personalities = ['Shocked and excited', 'Sarcastic banter', 'Calm analysis', 'Dramatic over-reaction', 'Funny rivalry teasing'];
    var personality = personalities[Math.floor(Math.random() * personalities.length)];
    var langPrompts = {
      'sheng': 'Write EXACTLY as a young Nairobi man SPEAKING to friends watching football. Natural Sheng. Short punchy sentences. Style: ' + personality,
      'swahili': 'Andika kama shabiki wa Nairobi. Kiswahili cha mtaani. Fupi na yenye nguvu. Style: ' + personality,
      'somali': 'Qor sida taageere Soomaali ah. Gaaban oo kulul. Style: ' + personality,
      'english': 'Write as excited East African fan. Casual natural English. Style: ' + personality
    };
    var eventDesc = '';
    if (event.type === 'Goal') eventDesc = 'GOAL! ' + (event.player || 'Player') + ' scored for ' + (event.team || 'team') + ' at minute ' + (event.time || '?');
    else if (event.type === 'Card') eventDesc = 'RED CARD! ' + (event.player || 'Player') + ' from ' + (event.team || 'team') + ' at minute ' + (event.time || '?');
    else eventDesc = event.type + ' at minute ' + (event.time || '?');
    var history = commentaryHistory[fixtureId] || [];
    var historyText = history.length > 0 ? ' Previous commentary (do not repeat): ' + history.slice(-3).join(' | ') : '';
    var prompt = 'Football: ' + matchInfo + '. Event: ' + eventDesc + historyText + '. ' + (langPrompts[language] || langPrompts['sheng']) + '. Under 60 words. Emojis! No hashtags!';
    var body = JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 150, messages: [{ role: 'user', content: prompt }] });
    var options = {
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }
    };
    var req = https.request(options, function(res) {
      var d = '';
      res.on('data', function(c) { d += c; });
      res.on('end', function() {
        try {
          var r = JSON.parse(d);
          var text = r.content && r.content[0] ? r.content[0].text : '';
          if (text && fixtureId) {
            if (!commentaryHistory[fixtureId]) commentaryHistory[fixtureId] = [];
            commentaryHistory[fixtureId].push(text.substring(0, 80));
            if (commentaryHistory[fixtureId].length > 10) commentaryHistory[fixtureId].shift();
          }
          resolve(text);
        } catch(e) { resolve(''); }
      });
    });
    req.on('error', function() { resolve(''); });
    setTimeout(function() { req.destroy(); resolve(''); }, 15000);
    req.write(body); req.end();
  });
}

// ============= SPOKEN SCRIPT FOR TTS =============
function generateSpokenScript(commentary, language) {
  return new Promise(function(resolve) {
    var prompt = 'Convert this football commentary to natural SPOKEN text for text-to-speech. Remove emojis. Keep energy. Short punchy sentences for ' + language + '. Return ONLY spoken text: ' + commentary;
    var body = JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 100, messages: [{ role: 'user', content: prompt }] });
    var options = {
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }
    };
    var req = https.request(options, function(res) {
      var d = '';
      res.on('data', function(c) { d += c; });
      res.on('end', function() {
        try { var r = JSON.parse(d); resolve(r.content && r.content[0] ? r.content[0].text : commentary); }
        catch(e) { resolve(commentary); }
      });
    });
    req.on('error', function() { resolve(commentary); });
    setTimeout(function() { req.destroy(); resolve(commentary); }, 10000);
    req.write(body); req.end();
  });
}

// ============= AZURE TTS =============
function textToVoice(text, language) {
  return new Promise(function(resolve) {
    if (!AZURE_KEY) { resolve(null); return; }
    var cleanText = text.replace(/[\u{1F300}-\u{1F9FF}]/gu, '').replace(/\*\*/g, '').replace(/#\w+/g, '').trim();
    if (!cleanText || cleanText.length < 5) { resolve(null); return; }
    var voice = language === 'english' ? 'en-US-AriaNeural' : 'sw-KE-RafikiNeural';
    var lang = language === 'english' ? 'en-US' : 'sw-KE';
    var ssml = '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="' + lang + '"><voice name="' + voice + '"><prosody rate="1.2" pitch="+5%">' + cleanText + '</prosody></voice></speak>';
    var options = {
      hostname: AZURE_REGION + '.tts.speech.microsoft.com', path: '/cognitiveservices/v1', method: 'POST',
      headers: { 'Ocp-Apim-Subscription-Key': AZURE_KEY, 'Content-Type': 'application/ssml+xml', 'X-Microsoft-OutputFormat': 'audio-16khz-128kbitrate-mono-mp3', 'User-Agent': 'WatchPartyAI', 'Content-Length': Buffer.byteLength(ssml) }
    };
    var req = https.request(options, function(res) {
      var chunks = [];
      res.on('data', function(c) { chunks.push(c); });
      res.on('end', function() {
        if (res.statusCode === 200) resolve(Buffer.concat(chunks));
        else { console.log('Azure TTS error:', res.statusCode); resolve(null); }
      });
    });
    req.on('error', function() { resolve(null); });
    setTimeout(function() { req.destroy(); resolve(null); }, 15000);
    req.write(ssml); req.end();
  });
}

// ============= SEND VOICE VIA CHATWOOT =============
function sendVoiceChatwoot(conversationId, audioBuffer) {
  return new Promise(function(resolve) {
    var boundary = 'boundary' + Date.now();
    var chatField = '--' + boundary + '\r\nContent-Disposition: form-data; name="content"\r\n\r\nVoice note\r\n';
    var header = '--' + boundary + '\r\nContent-Disposition: form-data; name="attachments[]"; filename="commentary.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n';
    var footer = '\r\n--' + boundary + '--\r\n';
    var body = Buffer.concat([Buffer.from(chatField), Buffer.from(header), audioBuffer, Buffer.from(footer)]);
    var options = {
      hostname: CHATWOOT_URL,
      path: '/api/v1/accounts/1/conversations/' + conversationId + '/messages',
      method: 'POST',
      headers: { 'api_access_token': CHATWOOT_TOKEN, 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': body.length }
    };
    var req = https.request(options, function(res) {
      var d = '';
      res.on('data', function(c) { d += c; });
      res.on('end', function() { console.log('Voice sent via Chatwoot:', res.statusCode); resolve(true); });
    });
    req.on('error', function(e) { console.log('Voice send error:', e.message); resolve(false); });
    req.write(body); req.end();
  });
}


// ============= ELEVENLABS TTS =============
function textToVoiceElevenLabs(text) {
  return new Promise(function(resolve) {
    if (!ELEVENLABS_KEY) { resolve(null); return; }
    var cleanText = text.replace(/[^\x00-\x7F]/g, '').replace(/\*\*/g, '').replace(/#\w+/g, '').trim();
    if (!cleanText || cleanText.length < 5) { resolve(null); return; }
    var body = JSON.stringify({ text: cleanText, model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.5, similarity_boost: 0.8, style: 0.3, use_speaker_boost: true } });
    var options = {
      hostname: 'api.elevenlabs.io',
      path: '/v1/text-to-speech/' + ELEVENLABS_VOICE_ID,
      method: 'POST',
      headers: { 'xi-api-key': ELEVENLABS_KEY, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg', 'Content-Length': Buffer.byteLength(body) }
    };
    var req = https.request(options, function(res) {
      var chunks = [];
      res.on('data', function(c) { chunks.push(c); });
      res.on('end', function() {
        if (res.statusCode === 200) { console.log('ElevenLabs voice generated!'); resolve(Buffer.concat(chunks)); }
        else { console.log('ElevenLabs error:', res.statusCode); resolve(null); }
      });
    });
    req.on('error', function(e) { resolve(null); });
    setTimeout(function() { req.destroy(); resolve(null); }, 20000);
    req.write(body); req.end();
  });
}

// ============= BROADCAST TO WHATSAPP SUBSCRIBERS =============
async function broadcastToSubscribers(event, matchInfo, homeTeam, awayTeam, fixtureId) {
  var relevantSubs = [];
  for (var convId in subscribers) {
    var sub = subscribers[convId];
    if (!sub.active) continue;
    var shouldNotify = false;
    if (!sub.teams || sub.teams.length === 0 || sub.teams.includes('all') || sub.teams.includes('all matches')) {
      shouldNotify = true;
    } else {
      sub.teams.forEach(function(t) {
        if (t && (homeTeam.toLowerCase().includes(t.toLowerCase()) || awayTeam.toLowerCase().includes(t.toLowerCase()))) shouldNotify = true;
      });
    }
    if (shouldNotify) relevantSubs.push({ convId: convId, language: sub.language || 'sheng' });
  }
  if (relevantSubs.length === 0) { console.log('No subscribers for this match'); return; }
  console.log('Broadcasting to', relevantSubs.length, 'WhatsApp subscribers');

  // Group by language
  var languages = {};
  relevantSubs.forEach(function(s) {
    if (!languages[s.language]) languages[s.language] = [];
    languages[s.language].push(s.convId);
  });

  for (var lang in languages) {
    var convIds = languages[lang];
    var commentary = await generateCommentary(event, matchInfo, lang, fixtureId);
    if (!commentary) continue;

    // Build text message
    var emoji = event.type === 'Goal' ? '⚽' : '🟥';
    var textMsg = emoji + ' ' + event.time + "' " + event.type.toUpperCase() + '!\n';
    textMsg += (event.team || '') + '\n';
    if (event.player) textMsg += event.player + '\n';
    textMsg += '\n' + commentary;

    // Generate voice — ElevenLabs first, Azure fallback
    var audioBuffer = null;
    var spokenScript = await generateSpokenScript(commentary, lang);
    var voiceText = spokenScript || commentary;
    if (ELEVENLABS_KEY) {
      audioBuffer = await textToVoiceElevenLabs(voiceText);
      if (!audioBuffer) console.log('ElevenLabs failed, trying Azure...');
    }
    if (!audioBuffer && AZURE_KEY) {
      audioBuffer = await textToVoice(voiceText, lang);
    }

    // Send to all subscribers of this language
    for (var i = 0; i < convIds.length; i++) {
      var convId = convIds[i];
      try {
        await sendChatwootMessage(convId, textMsg);
        if (audioBuffer) await sendVoiceChatwoot(convId, audioBuffer);
        await new Promise(function(r) { setTimeout(r, 500); });
      } catch(e) { console.log('Send error:', e.message); }
    }
    console.log('Broadcast complete for', lang, ':', convIds.length, 'subscribers');
  }

  // Search for video 10 minutes later
  var goalTime = Date.now();
  setTimeout(async function() {
    var videoUrl = await searchGoalVideo(event, homeTeam, awayTeam, fixtureId);
    if (videoUrl) {
      var delaySecs = Math.round((Date.now() - goalTime) / 1000);
      console.log('Video found! Delay:', delaySecs, 'seconds');
      var videoMsg = 'Watch the goal: ' + videoUrl;
      for (var convId in subscribers) {
        if (!subscribers[convId].active) continue;
        try { await sendChatwootMessage(convId, videoMsg); await new Promise(function(r) { setTimeout(r, 500); }); }
        catch(e) { console.log('Video send error:', e.message); }
      }
    } else { console.log('No video found after 10 minutes'); }
  }, 10 * 60 * 1000);
}

// ============= POLL LIVE MATCHES =============
async function pollMatch(fixtureId, matchInfo, homeTeam, awayTeam, source) {
  try {
    var events = [];
    var matchFinished = false;

    // Use API-Football for event detection (more reliable)
    if (source === 'api-football' && FOOTBALL_API_KEY) {
      var afFixture = await footballAPI('/fixtures?id=' + fixtureId);
      if (afFixture && afFixture.response && afFixture.response[0]) {
        var af = afFixture.response[0];
        var afStatus = af.fixture.status.short;
        if (['FT','AET','PEN','ABD','CANC'].includes(afStatus)) matchFinished = true;
        var afEvents = await footballAPI('/fixtures/events?fixture=' + fixtureId);
        if (afEvents && afEvents.response) {
          events = afEvents.response.map(function(e) {
            return {
              type: e.type === 'Goal' ? 'Goal' : (e.detail === 'Red Card' ? 'Card' : e.type),
              detail: e.detail,
              player: e.player && e.player.name,
              team: e.team && e.team.name,
              time: e.time && e.time.elapsed
            };
          });
        }
      }
    } else {
      // Highlightly fallback
      var fixtureResult = await highlightlyAPI('/matches/' + fixtureId);
      if (!fixtureResult) return;
      var matchData = Array.isArray(fixtureResult) ? fixtureResult[0] : fixtureResult;
      if (!matchData) return;
      var stateDesc = (matchData.state && matchData.state.description) || '';
      stateDesc = String(stateDesc).toLowerCase();
      if (stateDesc.includes('ended') || stateDesc.includes('finished') || stateDesc.includes('full time')) matchFinished = true;
      events = matchData.events || matchData.matchEvents || [];
      if (!Array.isArray(events)) events = [];
    }

    if (matchFinished) {
      console.log('Match', fixtureId, 'finished - stopping polling');
      if (matchPolling[fixtureId]) { clearInterval(matchPolling[fixtureId]); delete matchPolling[fixtureId]; }
      return;
    }
    var key = 'fixture_' + fixtureId;
    var lastIdx = lastEventIndex[key] || 0;
    var newEvents = events.slice(lastIdx);
    if (newEvents.length > 0) {
      lastEventIndex[key] = events.length;
      for (var i = 0; i < newEvents.length; i++) {
        var evt = newEvents[i];
        if (evt.type === 'Goal' || (evt.type === 'Card' && evt.detail === 'Red Card')) {
          await broadcastToSubscribers(evt, matchInfo, homeTeam, awayTeam, fixtureId);
        }
      }
    }
  } catch(e) { console.log('Poll error:', e.message); }
}

async function startPolling() {
  try {
    var liveMatches = [];

    // Step 1 — API-Football for live detection (primary)
    if (FOOTBALL_API_KEY) {
      var afResult = await footballAPI('/fixtures?live=all');
      if (afResult && afResult.response && afResult.response.length > 0) {
        afResult.response.forEach(function(m) {
          liveMatches.push({
            fixtureId: m.fixture.id,
            homeTeam: m.teams.home.name,
            awayTeam: m.teams.away.name,
            source: 'api-football'
          });
        });
        console.log('API-Football live matches:', liveMatches.length);
      }
    }

    // Step 2 — Highlightly as backup or additional matches
    var today = new Date().toISOString().split('T')[0];
    var hlResult = await highlightlyAPI('/matches?date=' + today + '&timezone=Africa/Nairobi&limit=50');
    var hlMatches = Array.isArray(hlResult) ? hlResult : (hlResult && hlResult.data ? hlResult.data : []);
    var hlLive = hlMatches.filter(function(m) {
      var desc = (m.state && m.state.description) || '';
      desc = String(desc).toLowerCase();
      return desc.includes('half') || desc.includes('extra') || desc.includes('live') || desc.includes('progress');
    });
    hlLive.forEach(function(m) {
      var fixtureId = m.id || m.matchId;
      var alreadyAdded = liveMatches.some(function(x) { return String(x.fixtureId) === String(fixtureId); });
      if (!alreadyAdded) {
        liveMatches.push({
          fixtureId: fixtureId,
          homeTeam: m.homeTeam && m.homeTeam.name || 'Home',
          awayTeam: m.awayTeam && m.awayTeam.name || 'Away',
          source: 'highlightly'
        });
      }
    });
    console.log('Total live matches (both APIs):', liveMatches.length);

    // Start polling each live match
    liveMatches.forEach(function(m) {
      if (!matchPolling[m.fixtureId]) {
        var fId = m.fixtureId; var home = m.homeTeam; var away = m.awayTeam;
        var info = home + ' vs ' + away;
        matchPolling[fId] = setInterval(function() { pollMatch(fId, info, home, away, m.source); }, 60000);
        console.log('Polling:', info, '(' + m.source + ')');
      }
    });
  } catch(e) { console.log('Start polling error:', e.message); }
}

// ============= HANDLE WHATSAPP SUBSCRIBE COMMANDS =============
async function handleIncomingWhatsApp(payload) {
  try {
    if (payload.event !== 'message_created' || payload.message_type !== 'incoming') return;
    var message = String(payload.content || '').trim().toLowerCase();
    var conversationId = payload.conversation && payload.conversation.id;
    var senderName = (payload.sender && payload.sender.name) || 'Fan';
    if (!message || !conversationId) return;

    console.log('WatchParty WhatsApp from', senderName, ':', message);

    // SUBSCRIBE command
    if (message.startsWith('subscribe') || message.startsWith('watchparty')) {
      var parts = message.replace('watchparty', '').replace('subscribe', '').trim().split(' ');
      var team = parts[0] || 'all';
      var lang = parts[1] || 'sheng';
      var validLangs = ['sheng', 'swahili', 'somali', 'english'];
      if (!validLangs.includes(lang)) lang = 'sheng';
      if (!subscribers[conversationId]) subscribers[conversationId] = { teams: [], language: lang, active: true };
      if (!subscribers[conversationId].teams.includes(team)) subscribers[conversationId].teams.push(team);
      subscribers[conversationId].language = lang;
      subscribers[conversationId].active = true;
      var teamDisplay = team === 'all' ? 'ALL matches' : team;
      var replyMsg = 'WatchParty AI imewashwa! Umejiunga na ' + teamDisplay + ' alerts kwa lugha ya ' + lang.toUpperCase() + '! Utapokea:\n- Text commentary\n- Voice note\n- Video highlights\n\nKama unataka kusimama text: STOP WATCHPARTY';
      if (lang === 'english') replyMsg = 'WatchParty AI activated! Subscribed to ' + teamDisplay + ' alerts in ' + lang.toUpperCase() + '! You will receive text, voice and video highlights. Text STOP WATCHPARTY to unsubscribe.';
      await sendChatwootMessage(conversationId, replyMsg);
      await startPolling();
      return;
    }

    // STOP command
    if (message.includes('stop watchparty') || message === 'stop') {
      delete subscribers[conversationId];
      await sendChatwootMessage(conversationId, 'WatchParty alerts zimesimamishwa. Text SUBSCRIBE ARSENAL SHENG kuanza tena!');
      return;
    }

    // STATUS command
    if (message === 'status' || message === 'hali') {
      var sub = subscribers[conversationId];
      if (!sub) {
        await sendChatwootMessage(conversationId, 'Bado hujajiunga! Text: SUBSCRIBE ARSENAL SHENG au SUBSCRIBE ALL SWAHILI');
      } else {
        await sendChatwootMessage(conversationId, 'Umejiunga! Timu: ' + sub.teams.join(', ') + ' | Lugha: ' + sub.language);
      }
      return;
    }

  } catch(e) { console.log('WhatsApp handler error:', e.message); }
}

// ============= HTTP SERVER =============
var server = http.createServer(function(req, res) {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200);
    res.end('WatchParty WhatsApp Running!\nSubscribers: ' + Object.keys(subscribers).length + '\nActive polls: ' + Object.keys(matchPolling).length);
    return;
  }

  if (req.method === 'GET' && req.url === '/poll-now') {
    res.writeHead(200); res.end('Polling now!');
    startPolling(); return;
  }

  if (req.method === 'POST' && req.url === '/webhook') {
    var body = '';
    req.on('data', function(c) { body += c; });
    req.on('end', async function() {
      res.writeHead(200); res.end('OK');
      try { var payload = JSON.parse(body); await handleIncomingWhatsApp(payload); }
      catch(e) { console.log('Webhook error:', e.message); }
    });
    return;
  }

  res.writeHead(200); res.end('WatchParty AI WhatsApp\n/health /poll-now /webhook');
});

server.listen(PORT, async function() {
  console.log('WatchParty WhatsApp starting on port ' + PORT);
  console.log('Voice enabled:', !!AZURE_KEY);
  console.log('Highlightly API:', !!HIGHLIGHTLY_KEY);

  // Poll live matches every 5 minutes
  setInterval(startPolling, 5 * 60 * 1000);
  await startPolling();

  console.log('WatchParty WhatsApp Ready!');
});
