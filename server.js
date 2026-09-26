const https = require('https');
const http = require('http');

const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const FOOTBALL_API_KEY = process.env.FOOTBALL_API_KEY;
const PORT = process.env.PORT || 3000;

// Call football API
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

// Generate Sheng commentary using Claude
function generateCommentary(event, matchInfo, language) {
  return new Promise(function(resolve) {
    var langStyle = {
      'sheng': 'Pure Nairobi Sheng slang. Use: boss, moto, chana, safi, fala, rada, chizi, poa, kibao, msee, dawa. Very energetic street style!',
      'swahili': 'Formal exciting Swahili football commentary.',
      'english': 'East African English with local personality and excitement.'
    };

    var prompt = 'You are a passionate football commentator for East African fans.\n\n';
    prompt += 'Match: ' + matchInfo + '\n';
    prompt += 'Event: ' + JSON.stringify(event) + '\n\n';
    prompt += 'Language style: ' + (langStyle[language] || langStyle['sheng']) + '\n\n';
    prompt += 'Generate exciting commentary under 80 words. Use emojis! Be energetic!';

    var body = JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 200,
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

var server = http.createServer(function(req, res) {

  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200);
    res.end('WatchParty AI Running!');
    return;
  }

  // Test API connection
  if (req.method === 'GET' && req.url === '/test') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    footballAPI('/status').then(function(result) {
      if (result && result.response) {
        res.end(JSON.stringify({
          success: true,
          account: result.response.account.firstname + ' ' + result.response.account.lastname,
          requests_today: result.response.requests.current,
          requests_limit: result.response.requests.limit_day,
          remaining: result.response.requests.limit_day - result.response.requests.current
        }));
      } else {
        res.end(JSON.stringify({ success: false, error: 'API connection failed', result: result }));
      }
    });
    return;
  }

  // Get live matches
  if (req.method === 'GET' && req.url === '/live') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    footballAPI('/fixtures?live=all').then(function(result) {
      if (result && result.response) {
        var matches = result.response.map(function(m) {
          return {
            fixture_id: m.fixture.id,
            home: m.teams.home.name,
            away: m.teams.away.name,
            score: m.goals.home + '-' + m.goals.away,
            minute: m.fixture.status.elapsed,
            league: m.league.name,
            country: m.league.country
          };
        });
        res.end(JSON.stringify({ live_matches: matches, count: matches.length }));
      } else {
        res.end(JSON.stringify({ live_matches: [], count: 0, message: 'No live matches or API error' }));
      }
    });
    return;
  }

  // Get EPL upcoming fixtures
  if (req.method === 'GET' && req.url === '/epl') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    footballAPI('/fixtures?league=39&season=2026&next=10').then(function(result) {
      if (result && result.response) {
        var matches = result.response.map(function(m) {
          var date = new Date(m.fixture.date);
          return {
            fixture_id: m.fixture.id,
            home: m.teams.home.name,
            away: m.teams.away.name,
            date: date.toLocaleDateString('en-KE', { timeZone: 'Africa/Nairobi', weekday: 'long', day: 'numeric', month: 'long' }),
            time: date.toLocaleTimeString('en-KE', { timeZone: 'Africa/Nairobi', hour: '2-digit', minute: '2-digit' })
          };
        });
        res.end(JSON.stringify({ epl_fixtures: matches, count: matches.length }));
      } else {
        res.end(JSON.stringify({ error: 'Could not fetch EPL fixtures', result: result }));
      }
    });
    return;
  }

  // Get match events and generate commentary
  if (req.method === 'GET' && req.url.startsWith('/commentary/')) {
    var parts = req.url.split('/');
    var fixtureId = parts[2];
    var language = parts[3] || 'sheng';
    res.writeHead(200, { 'Content-Type': 'application/json' });

    footballAPI('/fixtures/events?fixture=' + fixtureId).then(async function(result) {
      if (result && result.response && result.response.length > 0) {
        // Get match info
        var matchResult = await footballAPI('/fixtures?id=' + fixtureId);
        var matchInfo = 'Unknown Match';
        if (matchResult && matchResult.response && matchResult.response[0]) {
          var m = matchResult.response[0];
          matchInfo = m.teams.home.name + ' vs ' + m.teams.away.name + ' - ' + m.league.name;
        }

        // Generate commentary for last 3 events
        var events = result.response.slice(-3);
        var commentaries = [];
        for (var i = 0; i < events.length; i++) {
          var commentary = await generateCommentary(events[i], matchInfo, language);
          commentaries.push({
            time: events[i].time.elapsed,
            type: events[i].type,
            player: events[i].player && events[i].player.name,
            team: events[i].team && events[i].team.name,
            commentary: commentary
          });
        }
        res.end(JSON.stringify({ fixture_id: fixtureId, language: language, commentaries: commentaries }));
      } else {
        res.end(JSON.stringify({ error: 'No events found for fixture ' + fixtureId }));
      }
    });
    return;
  }

  // Test commentary with simulated match
  if (req.method === 'GET' && req.url.startsWith('/demo-commentary')) {
    var lang = req.url.includes('?lang=') ? req.url.split('?lang=')[1] : 'sheng';
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });

    var testEvent = { time: { elapsed: 23 }, type: 'Goal', team: { name: 'Arsenal' }, player: { name: 'Saka' }, assist: { name: 'Odegaard' }, detail: 'right foot shot' };
    var matchInfo = 'Arsenal vs Man City - Premier League';

    generateCommentary(testEvent, matchInfo, lang).then(function(commentary) {
      res.end('WatchParty AI Demo Commentary\n\nMatch: ' + matchInfo + '\nEvent: GOAL by Saka (Arsenal) at minute 23\nLanguage: ' + lang + '\n\n--- COMMENTARY ---\n\n' + commentary);
    });
    return;
  }

  res.writeHead(200);
  res.end('WatchParty AI - Endpoints: /health /test /live /epl /commentary/:fixture_id/:language /demo-commentary?lang=sheng');
});

server.listen(PORT, function() {
  console.log('WatchParty AI starting on port ' + PORT);
  if (!FOOTBALL_API_KEY) console.log('WARNING: No FOOTBALL_API_KEY set!');
  if (!ANTHROPIC_KEY) console.log('WARNING: No ANTHROPIC_KEY set!');
  console.log('WatchParty AI Ready!');
});
