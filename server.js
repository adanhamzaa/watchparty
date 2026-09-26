const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const FOOTBALL_API_KEY = process.env.FOOTBALL_API_KEY;
const CHATWOOT_URL = process.env.CHATWOOT_URL || 'chatwoot-production-5bb4.up.railway.app';
const CHATWOOT_TOKEN = process.env.CHATWOOT_TOKEN;
const PORT = process.env.PORT || 3000;

// Store active subscriptions and match state
var subscriptions = {}; // { conversationId: { team: 'Arsenal', fixtureId: 123, language: 'sheng', lastEventId: null } }
var matchPolling = {}; // { fixtureId: intervalId }

// Football API call
function footballAPI(path) {
  return new Promise(function(resolve) {
    var options = {
      hostname: 'v3.football.api-sports.io',
      path: path,
      method: 'GET',
      headers: { 'x-apisports-key': FOOTBALL_API_KEY }
    };
    var req = https.request(options, function(res) {
      var data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() {
        try { resolve(JSON.parse(data)); }
        catch(e) { resolve(null); }
      });
    });
    req.on('error', function() { resolve(null); });
    setTimeout(function() { req.destroy(); resolve(null); }, 10000);
    req.end();
  });
}

// Generate commentary using Claude
function generateCommentary(event, matchInfo, language) {
  return new Promise(function(resolve) {
    var langStyle = {
      'sheng': 'Pure Nairobi Sheng slang. Use words like: boss, moto, chana, safi, fala, rada, chizi, poa, kibao, msee, dawa, wueh, bana, noma. VERY energetic and street style! Keep under 50 words!',
      'swahili': 'Msisimko wa Kiswahili safi. Fasaha na ya kusisimua. Maneno mafupi mazuri. Chini ya maneno 50!',
      'somali': 'Somali football commentary. Passionate and energetic. Under 50 words!',
      'english': 'East African English with Nairobi personality. Fun and energetic. Under 50 words!'
    };

    var eventDesc = '';
    if (event.type === 'Goal') eventDesc = 'GOAL scored by ' + (event.player && event.player.name) + ' for ' + (event.team && event.team.name) + (event.assist && event.assist.name ? ', assisted by ' + event.assist.name : '') + ' at minute ' + event.time.elapsed;
    else if (event.type === 'Card') eventDesc = (event.detail || 'Card') + ' for ' + (event.player && event.player.name) + ' (' + (event.team && event.team.name) + ') at minute ' + event.time.elapsed;
    else if (event.type === 'subst') eventDesc = 'Substitution: ' + (event.assist && event.assist.name) + ' replaces ' + (event.player && event.player.name) + ' at minute ' + event.time.elapsed;
    else eventDesc = event.type + ' at minute ' + event.time.elapsed;

    var prompt = 'You are WatchParty AI — a passionate football commentator for East African fans.\n\nMatch: ' + matchInfo + '\nEvent: ' + eventDesc + '\n\nLanguage: ' + (langStyle[language] || langStyle['sheng']) + '\n\nGenerate EXCITING commentary. Use emojis! NO hashtags. Keep it short and punchy!';

    var body = JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 150,
      messages: [{ role: 'user', content: prompt }]
    });

    var options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body)
      }
    };

    var req = https.request(options, function(res) {
      var data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() {
        try {
          var result = JSON.parse(data);
          resolve(result.content && result.content[0] ? result.content[0].text : '');
        } catch(e) { resolve(''); }
      });
    });
    req.on('error', function() { resolve(''); });
    setTimeout(function() { req.destroy(); resolve(''); }, 15000);
    req.write(body);
    req.end();
  });
}

// Azure TTS - FREE 500k chars/month
function textToSpeech(text, language) {
  return new Promise(function(resolve) {
    var AZURE_KEY = process.env.AZURE_SPEECH_KEY || '';
    var AZURE_REGION = process.env.AZURE_SPEECH_REGION || 'eastus';
    if (!AZURE_KEY) { resolve(null); return; }

    // Voice selection per language
    var voiceName = {
      'sheng': 'en-US-AriaNeural',
      'swahili': 'en-US-AriaNeural',
      'somali': 'en-US-AriaNeural',
      'english': 'en-US-AriaNeural'
    };

    // Clean text for TTS - remove emojis and markdown
    var cleanText = text
      .replace(/[\u{1F300}-\u{1F9FF}]/gu, '')
      .replace(/\*\*/g, '')
      .replace(/#\w+/g, '')
      .replace(/[🔥⚽🎙️😂💥🚀🔴⚪👑💰🎯🙌]/g, '')
      .trim();

    if (!cleanText || cleanText.length < 5) { resolve(null); return; }

    // Azure SSML
    var ssml = '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">';
    ssml += '<voice name="' + (voiceName[language] || 'sw-KE-ZuriNeural') + '">';
    ssml += '<prosody rate="1.2" pitch="+5%">';
    ssml += cleanText;
    ssml += '</prosody></voice></speak>';

    var options = {
      hostname: AZURE_REGION + '.tts.speech.microsoft.com',
      path: '/cognitiveservices/v1',
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': AZURE_KEY,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'audio-16khz-128kbitrate-mono-mp3',
        'Content-Length': Buffer.byteLength(ssml)
      }
    };

    var req = https.request(options, function(res) {
      var chunks = [];
      res.on('data', function(chunk) { chunks.push(chunk); });
      res.on('end', function() {
        if (res.statusCode === 200) {
          var audioBuffer = Buffer.concat(chunks);
          var filename = '/tmp/watchparty_' + Date.now() + '.mp3';
          fs.writeFileSync(filename, audioBuffer);
          console.log('Azure TTS success! File:', filename, 'Size:', audioBuffer.length);
          resolve(filename);
        } else {
          console.log('Azure TTS error:', res.statusCode, Buffer.concat(chunks).toString().substring(0, 200));
          resolve(null);
        }
      });
    });
    req.on('error', function(e) { console.log('Azure TTS error:', e.message); resolve(null); });
    setTimeout(function() { req.destroy(); resolve(null); }, 15000);
    req.write(ssml);
    req.end();
  });
}

// Send text message via Chatwoot
function sendMessage(conversationId, text) {
  return new Promise(function(resolve) {
    var body = JSON.stringify({ content: text, message_type: 'outgoing', private: false });
    var options = {
      hostname: CHATWOOT_URL,
      path: '/api/v1/accounts/1/conversations/' + conversationId + '/messages',
      method: 'POST',
      headers: { 'api_access_token': CHATWOOT_TOKEN, 'Content-Type': 'application/json', 'content-length': Buffer.byteLength(body) }
    };
    var req = https.request(options, function(res) {
      var data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() { resolve(true); });
    });
    req.on('error', resolve);
    req.write(body);
    req.end();
  });
}

// Send audio as attachment via Chatwoot
function sendAudioMessage(conversationId, audioFilePath) {
  return new Promise(function(resolve) {
    if (!fs.existsSync(audioFilePath)) { resolve(false); return; }
    var audioData = fs.readFileSync(audioFilePath);
    var boundary = 'boundary' + Date.now();
    var header = '--' + boundary + '\r\nContent-Disposition: form-data; name="attachments[]"; filename="commentary.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n';
    var footer = '\r\n--' + boundary + '--\r\n';
    var typeField = '--' + boundary + '\r\nContent-Disposition: form-data; name="message_type"\r\n\r\noutgoing\r\n';
    var body = Buffer.concat([
      Buffer.from(typeField),
      Buffer.from(header),
      audioData,
      Buffer.from(footer)
    ]);

    var options = {
      hostname: CHATWOOT_URL,
      path: '/api/v1/accounts/1/conversations/' + conversationId + '/messages',
      method: 'POST',
      headers: {
        'api_access_token': CHATWOOT_TOKEN,
        'Content-Type': 'multipart/form-data; boundary=' + boundary,
        'Content-Length': body.length
      }
    };

    var req = https.request(options, function(res) {
      var data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() {
        console.log('Audio send response:', data.substring(0, 200));
        // Clean up temp file
        try { fs.unlinkSync(audioFilePath); } catch(e) {}
        resolve(true);
      });
    });
    req.on('error', function(e) { console.log('Audio send error:', e.message); resolve(false); });
    req.write(body);
    req.end();
  });
}

// Process match event and send commentary
async function processEvent(event, matchInfo, conversationId, language) {
  try {
    // Only process important events
    if (!['Goal', 'Card', 'subst'].includes(event.type)) return;

    console.log('Processing event:', event.type, 'for conversation:', conversationId);

    // Generate commentary
    var commentary = await generateCommentary(event, matchInfo, language);
    if (!commentary) return;

    console.log('Commentary generated:', commentary.substring(0, 80));

    // Send text first immediately
    var textMsg = '';
    if (event.type === 'Goal') textMsg = '⚽ ' + event.time.elapsed + '\' GOAL!\n' + (event.team && event.team.name) + '\n' + (event.player && event.player.name) + '\n\n' + commentary;
    else if (event.type === 'Card') textMsg = '🟨 ' + event.time.elapsed + '\' ' + (event.detail || 'CARD') + '\n' + (event.player && event.player.name) + '\n\n' + commentary;
    else textMsg = '🔄 ' + event.time.elapsed + '\' SUBSTITUTION\n\n' + commentary;

    await sendMessage(conversationId, textMsg);

    // Try to generate and send voice note if Google TTS key available
    if (process.env.AZURE_SPEECH_KEY) {
      var audioFile = await textToSpeech(commentary, language);
      if (audioFile) {
        await sendAudioMessage(conversationId, audioFile);
        console.log('Voice note sent!');
      }
    } else {
      console.log('No Azure TTS key — text only mode');
    }

  } catch(e) { console.log('Process event error:', e.message); }
}

// Poll match for new events
async function pollMatch(fixtureId, matchInfo, subscribers) {
  try {
    var result = await footballAPI('/fixtures/events?fixture=' + fixtureId);
    if (!result || !result.response) return;

    var events = result.response;

    // Check each subscriber for new events
    for (var convId in subscribers) {
      var sub = subscribers[convId];
      if (sub.fixtureId !== fixtureId) continue;

      var lastIndex = sub.lastEventIndex || 0;
      var newEvents = events.slice(lastIndex);

      for (var i = 0; i < newEvents.length; i++) {
        await processEvent(newEvents[i], matchInfo, convId, sub.language || 'sheng');
        sub.lastEventIndex = lastIndex + i + 1;
      }
    }
  } catch(e) { console.log('Poll error:', e.message); }
}

var server = http.createServer(async function(req, res) {

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200); res.end('WatchParty AI Running! Subscriptions: ' + Object.keys(subscriptions).length); return;
  }

  if (req.method === 'GET' && req.url === '/test') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    footballAPI('/status').then(function(result) {
      if (result && result.response) {
        res.end(JSON.stringify({ success: true, requests_today: result.response.requests.current, remaining: result.response.requests.limit_day - result.response.requests.current, voice_enabled: !!process.env.AZURE_SPEECH_KEY }));
      } else { res.end(JSON.stringify({ success: false })); }
    }); return;
  }

  if (req.method === 'GET' && req.url === '/live') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    footballAPI('/fixtures?live=all').then(function(result) {
      var matches = (result && result.response || []).map(function(m) {
        return { fixture_id: m.fixture.id, home: m.teams.home.name, away: m.teams.away.name, score: m.goals.home + '-' + m.goals.away, minute: m.fixture.status.elapsed, league: m.league.name, country: m.league.country };
      });
      res.end(JSON.stringify({ live_matches: matches, count: matches.length }));
    }); return;
  }

  // Demo commentary - test text + voice
  if (req.method === 'GET' && req.url.startsWith('/demo-commentary')) {
    var lang = req.url.includes('?lang=') ? req.url.split('?lang=')[1] : 'sheng';
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    var testEvent = { time: { elapsed: 23 }, type: 'Goal', team: { name: 'Arsenal' }, player: { name: 'Saka' }, assist: { name: 'Odegaard' }, detail: 'right foot shot' };
    var commentary = await generateCommentary(testEvent, 'Arsenal vs Man City - Premier League', lang);
    var output = 'WatchParty AI - ' + lang.toUpperCase() + ' Commentary\n\n';
    output += 'Match: Arsenal vs Man City\n';
    output += 'Event: GOAL by Saka - Minute 23\n\n';
    output += commentary + '\n\n';
    if (process.env.AZURE_SPEECH_KEY) {
      var audioFile = await textToSpeech(commentary, lang);
      output += audioFile ? 'Voice note generated: ' + audioFile : 'Voice note failed!';
    } else {
      output += 'Voice note: Add AZURE_SPEECH_KEY to Railway variables!';
    }
    res.end(output); return;
  }

  // Live commentary test
  if (req.method === 'GET' && req.url.startsWith('/live-commentary')) {
    var lang2 = req.url.includes('?lang=') ? req.url.split('?lang=')[1] : 'sheng';
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    var liveResult = await footballAPI('/fixtures?live=all');
    if (!liveResult || !liveResult.response || liveResult.response.length === 0) {
      res.end('No live matches right now. Try again later!'); return;
    }
    var match = liveResult.response[0];
    var fixtureId = match.fixture.id;
    var matchInfo2 = match.teams.home.name + ' vs ' + match.teams.away.name + ' - ' + match.league.name;
    var score = match.goals.home + '-' + match.goals.away;
    var minute = match.fixture.status.elapsed;
    var eventsResult = await footballAPI('/fixtures/events?fixture=' + fixtureId);
    var output2 = 'WatchParty AI - LIVE Commentary\n';
    output2 += 'Match: ' + matchInfo2 + '\n';
    output2 += 'Score: ' + score + ' | Minute: ' + minute + '\n';
    output2 += 'Language: ' + lang2.toUpperCase() + '\n\n';
    if (eventsResult && eventsResult.response && eventsResult.response.length > 0) {
      var lastEvent = eventsResult.response[eventsResult.response.length - 1];
      var commentary2 = await generateCommentary(lastEvent, matchInfo2, lang2);
      output2 += 'Last event: ' + lastEvent.type + ' - Minute ' + lastEvent.time.elapsed + '\n\n';
      output2 += commentary2;
    } else {
      var updateEvent = { time: { elapsed: minute }, type: 'Goal', team: { name: match.teams.home.name }, player: { name: 'Player' }, detail: 'Score is ' + score };
      var commentary3 = await generateCommentary(updateEvent, matchInfo2, lang2);
      output2 += commentary3;
    }
    res.end(output2); return;
  }

  // Subscribe to match - send commentary to WhatsApp
  if (req.method === 'GET' && req.url.startsWith('/subscribe/')) {
    var parts = req.url.split('/');
    var convId = parts[2];
    var fixId = parseInt(parts[3]);
    var subLang = parts[4] || 'sheng';
    res.writeHead(200, { 'Content-Type': 'application/json' });

    // Get match info
    var matchResult = await footballAPI('/fixtures?id=' + fixId);
    if (!matchResult || !matchResult.response || matchResult.response.length === 0) {
      res.end(JSON.stringify({ error: 'Match not found' })); return;
    }

    var m = matchResult.response[0];
    var mInfo = m.teams.home.name + ' vs ' + m.teams.away.name + ' - ' + m.league.name;

    // Add subscription
    subscriptions[convId] = { fixtureId: fixId, language: subLang, lastEventIndex: 0, matchInfo: mInfo };

    // Start polling if not already
    if (!matchPolling[fixId]) {
      matchPolling[fixId] = setInterval(async function() {
        await pollMatch(fixId, mInfo, subscriptions);
      }, 30000); // Poll every 30 seconds
      console.log('Started polling match:', fixId);
    }

    // Send confirmation
    await sendMessage(convId, 'WatchParty AI activated! \n\nMatch: ' + mInfo + '\nLanguage: ' + subLang.toUpperCase() + '\n\nYou will receive ' + (process.env.AZURE_SPEECH_KEY ? 'voice notes' : 'text alerts') + ' for goals, cards and substitutions!\n\nReply with team name or "stop" to unsubscribe.');

    res.end(JSON.stringify({ success: true, message: 'Subscribed to ' + mInfo, language: subLang, voice: !!process.env.AZURE_SPEECH_KEY }));
    return;
  }

  res.writeHead(200);
  res.end('WatchParty AI Ready!\nEndpoints:\n/health\n/test\n/live\n/demo-commentary?lang=sheng\n/live-commentary?lang=sheng\n/subscribe/:conversationId/:fixtureId/:language');
});

server.listen(PORT, function() {
  console.log('WatchParty AI starting on port ' + PORT);
  console.log('Voice enabled:', !!process.env.AZURE_SPEECH_KEY);
  console.log('WatchParty AI Ready!');
});
