const https = require('https');
const http = require('http');

const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const FOOTBALL_API_KEY = process.env.FOOTBALL_API_KEY;
const PORT = process.env.PORT || 3000;

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

function generateCommentary(event, matchInfo, language) {
  return new Promise(function(resolve) {
    var langStyle = {
      'sheng': 'Pure Nairobi Sheng slang. Use: boss, moto, chana, safi, fala, rada, chizi, poa, kibao, msee, dawa. Very energetic street style!',
      'swahili': 'Formal exciting Swahili football commentary.',
      'somali': 'Somali language passionate football commentary.',
      'english': 'East African English with local personality.'
    };
    var prompt = 'You are a passionate football commentator for East African fans.\n\nMatch: ' + matchInfo + '\nEvent: ' + JSON.stringify(event) + '\n\nLanguage style: ' + (langStyle[language] || langStyle['sheng']) + '\n\nGenerate exciting commentary under 80 words. Use emojis! Be energetic!';
    var body = JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 200, messages: [{ role: 'user', content: prompt }] });
    var options = {
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }
    };
    var req = https.request(options, function(res) {
      var data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() {
        try { var result = JSON.parse(data); resolve(result.content && result.content[0] ? result.content[0].text : ''); }
        catch(e) { resolve(''); }
      });
    });
    req.on('error', function() { resolve(''); });
    setTimeout(function() { req.destroy(); resolve(''); }, 15000);
    req.write(body); req.end();
  });
}

var server = http.createServer(function(req, res) {

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200); res.end('WatchParty AI Running!'); return;
  }

  if (req.method === 'GET' && req.url === '/test') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    footballAPI('/status').then(function(result) {
      if (result && result.response) {
        res.end(JSON.stringify({ success: true, account: result.response.account.firstname, requests_today: result.response.requests.current, remaining: result.response.requests.limit_day - result.response.requests.current }));
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

  // EPL - try multiple seasons
  if (req.method === 'GET' && req.url === '/epl') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    footballAPI('/fixtures?league=39&season=2025&next=10').then(function(result) {
      if (result && result.response && result.response.length > 0) {
        var matches = result.response.map(function(m) {
          var date = new Date(m.fixture.date);
          return { fixture_id: m.fixture.id, home: m.teams.home.name, away: m.teams.away.name, date: date.toLocaleDateString('en-KE', { timeZone: 'Africa/Nairobi', weekday: 'long', day: 'numeric', month: 'long' }), time: date.toLocaleTimeString('en-KE', { timeZone: 'Africa/Nairobi', hour: '2-digit', minute: '2-digit' }) };
        });
        res.end(JSON.stringify({ season: 2025, epl_fixtures: matches, count: matches.length }));
      } else {
        // Try 2024
        footballAPI('/fixtures?league=39&season=2024&last=5').then(function(r2) {
          var matches = (r2 && r2.response || []).map(function(m) {
            return { fixture_id: m.fixture.id, home: m.teams.home.name, away: m.teams.away.name, date: new Date(m.fixture.date).toLocaleDateString('en-KE') };
          });
          res.end(JSON.stringify({ season: 2024, epl_fixtures: matches, count: matches.length, note: '2025 season not available on free tier' }));
        });
      }
    }); return;
  }

  // Live commentary for a specific match
  if (req.method === 'GET' && req.url.startsWith('/commentary/')) {
    var parts = req.url.split('/');
    var fixtureId = parts[2];
    var language = parts[3] || 'sheng';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    footballAPI('/fixtures/events?fixture=' + fixtureId).then(async function(result) {
      if (result && result.response && result.response.length > 0) {
        var matchResult = await footballAPI('/fixtures?id=' + fixtureId);
        var matchInfo = 'Football Match';
        if (matchResult && matchResult.response && matchResult.response[0]) {
          var m = matchResult.response[0];
          matchInfo = m.teams.home.name + ' vs ' + m.teams.away.name + ' - ' + m.league.name;
        }
        var events = result.response.slice(-3);
        var commentaries = [];
        for (var i = 0; i < events.length; i++) {
          var commentary = await generateCommentary(events[i], matchInfo, language);
          commentaries.push({ time: events[i].time.elapsed, type: events[i].type, player: events[i].player && events[i].player.name, team: events[i].team && events[i].team.name, commentary: commentary });
        }
        res.end(JSON.stringify({ fixture_id: fixtureId, language: language, match: matchInfo, commentaries: commentaries }));
      } else { res.end(JSON.stringify({ error: 'No events found for fixture ' + fixtureId })); }
    }); return;
  }

  // Demo commentary
  if (req.method === 'GET' && req.url.startsWith('/demo-commentary')) {
    var lang = req.url.includes('?lang=') ? req.url.split('?lang=')[1] : 'sheng';
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    var testEvent = { time: { elapsed: 23 }, type: 'Goal', team: { name: 'Arsenal' }, player: { name: 'Saka' }, assist: { name: 'Odegaard' }, detail: 'right foot shot' };
    generateCommentary(testEvent, 'Arsenal vs Man City - Premier League', lang).then(function(commentary) {
      res.end('WatchParty AI - ' + lang.toUpperCase() + ' Commentary\n\nMatch: Arsenal vs Man City\nEvent: GOAL by Saka (Arsenal) - Minute 23\n\n' + commentary);
    }); return;
  }

  // Live J-League commentary — use a live match from /live
  if (req.method === 'GET' && req.url.startsWith('/live-commentary')) {
    var lang2 = req.url.includes('?lang=') ? req.url.split('?lang=')[1] : 'sheng';
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    footballAPI('/fixtures?live=all').then(async function(result) {
      if (!result || !result.response || result.response.length === 0) {
        res.end('No live matches right now. Try again later!'); return;
      }
      var match = result.response[0];
      var fixtureId = match.fixture.id;
      var matchInfo = match.teams.home.name + ' vs ' + match.teams.away.name + ' - ' + match.league.name + ' (' + match.league.country + ')';
      var score = match.goals.home + '-' + match.goals.away;
      var minute = match.fixture.status.elapsed;
      var eventsResult = await footballAPI('/fixtures/events?fixture=' + fixtureId);
      var output = 'WatchParty AI - LIVE Commentary\n';
      output += 'Match: ' + matchInfo + '\n';
      output += 'Score: ' + score + ' | Minute: ' + minute + '\n';
      output += 'Language: ' + lang2.toUpperCase() + '\n\n';
      if (eventsResult && eventsResult.response && eventsResult.response.length > 0) {
        var events = eventsResult.response.slice(-3);
        for (var i = 0; i < events.length; i++) {
          var commentary = await generateCommentary(events[i], matchInfo, lang2);
          output += '--- Minute ' + events[i].time.elapsed + ': ' + events[i].type + ' ---\n';
          output += commentary + '\n\n';
        }
      } else {
        output += 'No events yet in this match!\n';
        var commentary = await generateCommentary({ time: { elapsed: minute }, type: 'Match Update', detail: 'Score is ' + score + ' at minute ' + minute }, matchInfo, lang2);
        output += commentary;
      }
      res.end(output);
    }); return;
  }

  res.writeHead(200);
  res.end('WatchParty AI Ready!\nEndpoints:\n/health\n/test\n/live\n/epl\n/demo-commentary?lang=sheng\n/live-commentary?lang=sheng\n/commentary/:fixture_id/:language');
});

server.listen(PORT, function() {
  console.log('WatchParty AI starting on port ' + PORT);
  console.log('WatchParty AI Ready!');
});
