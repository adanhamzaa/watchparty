const https = require('https');
const http = require('http');
const fs = require('fs');

const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const HIGHLIGHTLY_KEY = process.env.HIGHLIGHTLY_API_KEY;
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const AZURE_KEY = process.env.AZURE_SPEECH_KEY;
const AZURE_REGION = process.env.AZURE_SPEECH_REGION || 'eastus';
const PORT = process.env.PORT || 3000;

// Subscriber database
// { chatId: { teams: ['Arsenal'], language: 'sheng', active: true } }
var subscribers = {};
var matchPolling = {};
var lastEventIndex = {};
var commentaryHistory = {}; // { fixtureId: ['commentary1', 'commentary2'] }
var videoFileIds = {}; // { videoUrl: telegramFileId } — reuse uploaded videos!

// ============= HIGHLIGHTLY API =============
function highlightlyAPI(path) {
  return new Promise(function(resolve) {
    var options = {
      hostname: 'soccer.highlightly.net',
      path: path,
      method: 'GET',
      headers: { 
        'x-api-key': HIGHLIGHTLY_KEY,
        'x-rapidapi-key': HIGHLIGHTLY_KEY,
        'Content-Type': 'application/json'
      }
    };
    var req = https.request(options, function(res) {
      var d = '';
      res.on('data', function(c) { d += c; });
      res.on('end', function() {
        try { resolve(JSON.parse(d)); }
        catch(e) { resolve(null); }
      });
    });
    req.on('error', function() { resolve(null); });
    setTimeout(function() { req.destroy(); resolve(null); }, 10000);
    req.end();
  });
}

// ============= TELEGRAM API =============
function telegramAPI(method, data) {
  return new Promise(function(resolve) {
    var body = JSON.stringify(data);
    var options = {
      hostname: 'api.telegram.org',
      path: '/bot' + TELEGRAM_TOKEN + '/' + method,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };
    var req = https.request(options, function(res) {
      var d = '';
      res.on('data', function(c) { d += c; });
      res.on('end', function() {
        try { resolve(JSON.parse(d)); }
        catch(e) { resolve(null); }
      });
    });
    req.on('error', function() { resolve(null); });
    req.write(body); req.end();
  });
}

function sendText(chatId, text) {
  return telegramAPI('sendMessage', { chat_id: chatId, text: text, parse_mode: 'HTML' });
}

function sendVoiceBuffer(chatId, audioBuffer) {
  return new Promise(function(resolve) {
    var boundary = 'boundary' + Date.now();
    var chatField = '--' + boundary + '\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n' + chatId + '\r\n';
    var header = '--' + boundary + '\r\nContent-Disposition: form-data; name="voice"; filename="commentary.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n';
    var footer = '\r\n--' + boundary + '--\r\n';
    var body = Buffer.concat([Buffer.from(chatField), Buffer.from(header), audioBuffer, Buffer.from(footer)]);
    var options = {
      hostname: 'api.telegram.org',
      path: '/bot' + TELEGRAM_TOKEN + '/sendVoice',
      method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': body.length }
    };
    var req = https.request(options, function(res) {
      var d = '';
      res.on('data', function(c) { d += c; });
      res.on('end', function() {
        try { resolve(JSON.parse(d)); }
        catch(e) { resolve(null); }
      });
    });
    req.on('error', function() { resolve(null); });
    req.write(body); req.end();
  });
}

function sendVideoUrl(chatId, videoUrl, caption) {
  return telegramAPI('sendVideo', { chat_id: chatId, video: videoUrl, caption: caption || '' });
}

// ============= CLAUDE AI COMMENTARY =============
function generateCommentary(event, matchInfo, language, fixtureId) {
  return new Promise(function(resolve) {
    var personalities = ['Shocked and excited', 'Sarcastic banter', 'Calm analysis', 'Dramatic over-reaction', 'Funny rivalry teasing'];
    var personality = personalities[Math.floor(Math.random() * personalities.length)];

    var langPrompts = {
      'sheng': 'Write EXACTLY as a young Nairobi man SPEAKING to friends watching football. Natural Sheng flow — not a forced slang list. Short punchy sentences. Style: ' + personality,
      'swahili': 'Andika kama shabiki wa Nairobi anayeongea na marafiki. Kiswahili cha mtaani. Fupi na yenye nguvu. Style: ' + personality,
      'somali': 'Qor sida taageere Soomaali ah oo la hadlaya saaxiibbadiis. Gaaban oo kulul. Style: ' + personality,
      'english': 'Write as excited East African fan talking to friends. Casual natural English with local flavor. Style: ' + personality
    };

    var eventDesc = '';
    if (event.type === 'Goal') eventDesc = 'GOAL! ' + (event.player || 'Player') + ' scored for ' + (event.team || 'team') + ' at minute ' + (event.time || '?');
    else if (event.type === 'Card') eventDesc = 'RED CARD! ' + (event.player || 'Player') + ' (' + (event.team || 'team') + ') at minute ' + (event.time || '?');
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
    var cleanText = text.replace(/[\u{1F300}-\u{1F9FF}]/gu, '').replace(/\*\*/g, '').replace(/#\w+/g, '').replace(/[<>]/g, '').trim();
    if (!cleanText || cleanText.length < 5) { resolve(null); return; }
    var voice = language === 'english' ? 'en-US-AriaNeural' : 'sw-KE-RafikiNeural';
    var lang = language === 'english' ? 'en-US' : 'sw-KE';
    var ssml = '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="' + lang + '"><voice name="' + voice + '"><prosody rate="1.2" pitch="+5%">' + cleanText + '</prosody></voice></speak>';
    var options = {
      hostname: AZURE_REGION + '.tts.speech.microsoft.com',
      path: '/cognitiveservices/v1', method: 'POST',
      headers: { 'Ocp-Apim-Subscription-Key': AZURE_KEY, 'Content-Type': 'application/ssml+xml', 'X-Microsoft-OutputFormat': 'audio-16khz-128kbitrate-mono-mp3', 'User-Agent': 'WatchPartyAI', 'Content-Length': Buffer.byteLength(ssml) }
    };
    var req = https.request(options, function(res) {
      var chunks = [];
      res.on('data', function(c) { chunks.push(c); });
      res.on('end', function() {
        if (res.statusCode === 200) { resolve(Buffer.concat(chunks)); }
        else { console.log('Azure TTS error:', res.statusCode); resolve(null); }
      });
    });
    req.on('error', function() { resolve(null); });
    setTimeout(function() { req.destroy(); resolve(null); }, 15000);
    req.write(ssml); req.end();
  });
}

// ============= BROADCAST TO ALL SUBSCRIBERS =============
async function broadcastToSubscribers(event, matchInfo, homeTeam, awayTeam, fixtureId) {
  var relevantSubs = [];
  for (var chatId in subscribers) {
    var sub = subscribers[chatId];
    if (!sub.active) continue;
    var shouldNotify = false;
    if (sub.teams && sub.teams.includes('all')) {
      shouldNotify = true;
    } else if (sub.teams) {
      sub.teams.forEach(function(t) {
        if (homeTeam.toLowerCase().includes(t.toLowerCase()) || awayTeam.toLowerCase().includes(t.toLowerCase())) {
          shouldNotify = true;
        }
      });
    }
    if (shouldNotify) relevantSubs.push({ chatId: chatId, language: sub.language || 'sheng' });
  }

  if (relevantSubs.length === 0) return;
  console.log('Broadcasting to', relevantSubs.length, 'subscribers for', matchInfo);

  // Group by language — generate ONE commentary per language
  var languages = {};
  relevantSubs.forEach(function(s) {
    if (!languages[s.language]) languages[s.language] = [];
    languages[s.language].push(s.chatId);
  });

  for (var lang in languages) {
    var chatIds = languages[lang];
    
    // Generate ONE commentary for all subscribers of this language
    var commentary = await generateCommentary(event, matchInfo, lang, fixtureId);
    if (!commentary) continue;

    // Build text message
    var emoji = event.type === 'Goal' ? '⚽' : '🟥';
    var textMsg = emoji + ' <b>' + event.time + "' " + event.type.toUpperCase() + '!</b>\n';
    textMsg += '<b>' + (event.team || '') + '</b>\n';
    if (event.player) textMsg += event.player + '\n';
    textMsg += '\n' + commentary;

    // Generate ONE voice for all subscribers
    var audioBuffer = null;
    if (AZURE_KEY) {
      var spokenScript = await generateSpokenScript(commentary, lang);
      audioBuffer = await textToVoice(spokenScript || commentary, lang);
    }

    // Send to all subscribers of this language
    for (var i = 0; i < chatIds.length; i++) {
      var chatId = chatIds[i];
      try {
        await sendText(chatId, textMsg);
        if (audioBuffer) {
          var voiceResult = await sendVoiceBuffer(chatId, audioBuffer);
          console.log('Voice sent to:', chatId, voiceResult && voiceResult.ok ? 'OK' : 'FAILED');
        }
        // Small delay to avoid Telegram rate limits
        await new Promise(function(r) { setTimeout(r, 100); });
      } catch(e) { console.log('Send error for', chatId, ':', e.message); }
    }
    console.log('Broadcast complete for', lang, ':', chatIds.length, 'subscribers');
  }
}

// ============= POLL MATCHES =============
async function pollMatch(fixtureId, matchInfo, homeTeam, awayTeam) {
  try {
    // Check match status and get events
    var fixtureResult = await highlightlyAPI('/matches/' + fixtureId);
    if (!fixtureResult) return;
    
    var matchData = Array.isArray(fixtureResult) ? fixtureResult[0] : fixtureResult;
    if (!matchData) return;
    
    var status = matchData.state || matchData.status || matchData.matchState || '';
    if (['FT', 'AET', 'PEN', 'ABD', 'CANC', 'finished', 'ended'].includes(status)) {
      console.log('Match', fixtureId, 'finished - stopping polling');
      if (matchPolling[fixtureId]) { clearInterval(matchPolling[fixtureId]); delete matchPolling[fixtureId]; }
      return;
    }

    var events = matchData.events || matchData.matchEvents || [];
    if (!Array.isArray(events)) events = [];
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

// Start polling live matches
async function startPolling() {
  try {
    // Get today's date in YYYY-MM-DD format
    var today = new Date().toISOString().split('T')[0];
    var result = await highlightlyAPI('/matches?date=' + today + '&timezone=Africa/Nairobi&limit=50');
    if (!result || !Array.isArray(result)) {
      console.log('Highlightly response:', JSON.stringify(result).substring(0, 200));
      return;
    }
    // Filter only live matches
    var liveMatches = result.filter(function(m) {
      var state = m.state || m.status || m.matchState || '';
      return ['1H', '2H', 'HT', 'ET', 'P', 'LIVE', 'IN_PLAY', 'live', 'inplay'].includes(state);
    });
    console.log('Total matches today:', result.length, 'Live:', liveMatches.length);
    liveMatches.forEach(function(m) {
      var fixtureId = m.id || m.matchId;
      var homeTeam = m.homeTeam && m.homeTeam.name || 'Home';
      var awayTeam = m.awayTeam && m.awayTeam.name || 'Away';
      var matchInfo = homeTeam + ' vs ' + awayTeam;
      if (!matchPolling[fixtureId]) {
        matchPolling[fixtureId] = setInterval(function() {
          pollMatch(fixtureId, matchInfo, homeTeam, awayTeam);
        }, 60000);
        console.log('Polling:', matchInfo);
      }
    });
    console.log('Active polls:', Object.keys(matchPolling).length);
  } catch(e) { console.log('Start polling error:', e.message); }
}

// ============= HANDLE TELEGRAM COMMANDS =============
async function handleUpdate(update) {
  if (!update.message) return;
  var chatId = String(update.message.chat.id);
  var text = (update.message.text || '').trim();
  var firstName = update.message.from && update.message.from.first_name || 'Boss';

  console.log('Message from', chatId, ':', text.substring(0, 50));

  if (text === '/start') {
    await sendText(chatId, '🔥⚽ <b>WatchParty AI — Football in Sheng!</b>\n\nHabari ' + firstName + '! Karibu!\n\nGet live Sheng commentary for every goal and red card!\n\n<b>Commands:</b>\n/subscribe Arsenal sheng\n/subscribe ManCity swahili\n/subscribe all sheng — ALL matches!\n/live — Live matches now\n/status — Your subscriptions\n/stop — Unsubscribe\n\n<b>Languages:</b> sheng • swahili • somali • english\n\nLet\'s go! 🔥');
    return;
  }

  if (text === '/live') {
    var liveResult = await highlightlyAPI('/matches?status=live');
    if (!liveResult || !liveResult.matches || liveResult.matches.length === 0) {
      await sendText(chatId, '⚽ No live matches right now. Check back later!');
      return;
    }
    var msg = '⚽ <b>LIVE NOW:</b>\n\n';
    liveResult.matches.slice(0, 10).forEach(function(m) {
      var home = m.homeTeam && m.homeTeam.name || m.home || 'Home';
      var away = m.awayTeam && m.awayTeam.name || m.away || 'Away';
      var score = (m.score || m.goals || '? - ?');
      msg += '<b>' + home + '</b> vs <b>' + away + '</b> ' + score + '\n';
      if (m.league) msg += '<i>' + m.league + '</i>\n';
      msg += '\n';
    });
    await sendText(chatId, msg);
    return;
  }

  if (text === '/status') {
    var sub = subscribers[chatId];
    if (!sub || !sub.teams || sub.teams.length === 0) {
      await sendText(chatId, 'You are not subscribed!\n\nUse: /subscribe Arsenal sheng');
    } else {
      await sendText(chatId, '✅ <b>Your subscriptions:</b>\nTeams: ' + sub.teams.join(', ') + '\nLanguage: ' + sub.language + '\n\nUse /stop to unsubscribe.');
    }
    return;
  }

  if (text === '/stop') {
    delete subscribers[chatId];
    await sendText(chatId, '❌ Unsubscribed! Use /subscribe to rejoin anytime.');
    return;
  }

  if (text.startsWith('/subscribe')) {
    var parts = text.split(' ');
    var team = parts[1] || 'all';
    var lang = (parts[2] || 'sheng').toLowerCase();
    var validLangs = ['sheng', 'swahili', 'somali', 'english'];
    if (!validLangs.includes(lang)) lang = 'sheng';
    if (!subscribers[chatId]) subscribers[chatId] = { teams: [], language: lang, active: true };
    if (!subscribers[chatId].teams.includes(team)) subscribers[chatId].teams.push(team);
    subscribers[chatId].language = lang;
    subscribers[chatId].active = true;
    var teamDisplay = team === 'all' ? 'ALL matches' : team;
    await sendText(chatId, '✅ <b>Subscribed!</b>\n\nTeam: <b>' + teamDisplay + '</b>\nLanguage: <b>' + lang.toUpperCase() + '</b>\n\nYou will receive:\n🔥 Text commentary\n🎙️ Voice note (' + (AZURE_KEY ? 'Kenyan Swahili voice' : 'coming soon') + ')\n\nWaiting for next goal... ⚽');
    await startPolling();
    return;
  }

  await sendText(chatId, 'Use /start to see commands! ⚽\n\nOr type /subscribe Arsenal sheng to get started!');
}

// ============= HTTP SERVER =============
var server = http.createServer(async function(req, res) {

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200);
    res.end('WatchParty Telegram Bot Running!\nSubscribers: ' + Object.keys(subscribers).length + '\nActive polls: ' + Object.keys(matchPolling).length);
    return;
  }

  if (req.method === 'POST' && req.url === '/webhook') {
    var body = '';
    req.on('data', function(c) { body += c; });
    req.on('end', async function() {
      res.writeHead(200); res.end('OK');
      try { var update = JSON.parse(body); await handleUpdate(update); }
      catch(e) { console.log('Webhook error:', e.message); }
    });
    return;
  }

  res.writeHead(200);
  res.end('WatchParty AI Telegram Bot\nEndpoints: /health /webhook');
});

server.listen(PORT, async function() {
  console.log('WatchParty Telegram Bot starting on port ' + PORT);
  console.log('Voice enabled:', !!AZURE_KEY);
  console.log('Highlightly API:', !!HIGHLIGHTLY_KEY);

  // Set Telegram webhook
  if (TELEGRAM_TOKEN) {
    var webhookUrl = 'https://' + (process.env.RAILWAY_PUBLIC_DOMAIN || 'watchparty-production-d9f0.up.railway.app') + '/webhook';
    var result = await telegramAPI('setWebhook', { url: webhookUrl });
    console.log('Webhook:', result && result.ok ? 'SET ✅' : 'FAILED ❌');
  }

  // Poll live matches every 5 minutes
  setInterval(startPolling, 5 * 60 * 1000);
  await startPolling();

  console.log('WatchParty Telegram Bot Ready! 🔥⚽');
});
