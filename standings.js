// Shared by the public page and the admin page: standings and playoff bracket maths.
// A match is a series of up to 3 games. First to 2 game wins takes the series.
// 2-0: winner 3 points, loser 0. 2-1: winner 2 points, loser 1.
(function (root) {
  const gamesOf = m => (Array.isArray(m.games) ? m.games : (m.as != null ? [{ as: m.as, bs: m.bs }] : [])).slice(0, 3);
  const valid = g => g && g.as != null && g.bs != null && g.as !== g.bs;

  // result of one series: wins of m.a (wa) and m.b (wb), the games that counted, and whether it is decided
  const state = m => {
    let wa = 0, wb = 0; const counted = [];
    for (const [i, g] of gamesOf(m).entries()) {
      if (wa >= 2 || wb >= 2) break;               // a 3rd game after a 2-0 result is ignored
      if (i === 2 && !(wa === 1 && wb === 1)) break; // game 3 only counts when the series is 1-1
      if (!valid(g)) continue;
      counted.push(g); g.as > g.bs ? wa++ : wb++;
    }
    return { wa, wb, counted, decided: wa >= 2 || wb >= 2, started: counted.length > 0 };
  };

  // rounds used by the playoff bracket: their matches never count in the regular-season standings
  const playoffRoundIds = D => {
    const b = D && D.bracket;
    return new Set(b ? [b.qf, b.sf, b.f].filter(Boolean) : []);
  };

  // standings. Matches in `exclude` rounds are left out of the table (but still counted in gamesPlayed/goals).
  function compute(D, exclude) {
    exclude = exclude || new Set();
    const S = Object.fromEntries(D.teams.map(t => [t.id, { t, sp: 0, sw: 0, sl: 0, mp: 0, mw: 0, ml: 0, gf: 0, ga: 0, pts: 0 }]));
    const h2h = {}; // h2h[x][y] = games x has won against y
    let gamesPlayed = 0, goals = 0;
    D.matches.forEach(m => {
      const A = S[m.a], B = S[m.b]; if (!A || !B) return;
      const st = state(m), skip = exclude.has(m.round);
      st.counted.forEach(g => {
        gamesPlayed++; goals += g.as + g.bs;
        if (skip) return;
        A.mp++; B.mp++; A.gf += g.as; A.ga += g.bs; B.gf += g.bs; B.ga += g.as;
        const [w, l, wid, lid] = g.as > g.bs ? [A, B, m.a, m.b] : [B, A, m.b, m.a];
        w.mw++; l.ml++;
        h2h[wid] = h2h[wid] || {}; h2h[wid][lid] = (h2h[wid][lid] || 0) + 1;
      });
      if (st.decided && !skip) {
        const aWon = st.wa >= 2, w = aWon ? A : B, l = aWon ? B : A, loserGames = aWon ? st.wb : st.wa;
        w.sw++; l.sl++; w.sp++; l.sp++;
        w.pts += loserGames === 0 ? 3 : 2; l.pts += loserGames === 0 ? 0 : 1;
      }
    });
    const pts = r => r.pts;
    // tiebreakers: points, then games won, then head-to-head games, then series won, goal difference, goals for
    const h2hWins = (r, group) => group.reduce((n, o) => o === r ? n : n + ((h2h[r.t.id] || {})[o.t.id] || 0) - ((h2h[o.t.id] || {})[r.t.id] || 0), 0);
    const rows = Object.values(S).sort((x, y) => pts(y) - pts(x) || (y.gf - y.ga) - (x.gf - x.ga) || y.gf - x.gf);
    const sorted = [];
    for (let i = 0; i < rows.length;) {
      let j = i; while (j < rows.length && pts(rows[j]) === pts(rows[i])) j++;
      const grp = rows.slice(i, j);
      grp.sort((x, y) => y.mw - x.mw || h2hWins(y, grp) - h2hWins(x, grp) || y.sw - x.sw || (y.gf - y.ga) - (x.gf - x.ga) || y.gf - x.gf);
      sorted.push(...grp); i = j;
    }
    return { S, sorted, gamesPlayed, goals };
  }

  // Playoff bracket for 8 teams, laid out like the league's picture:
  //   QF1 1v8, QF2 5v4, QF3 3v6, QF4 7v2 -> SF1 = W(QF1) v W(QF2), SF2 = W(QF3) v W(QF4) -> Final
  // Seeds follow the live standings unless the admin froze them (bracket.seeds has 8 team ids).
  const PAIRS = [[1, 8], [5, 4], [3, 6], [7, 2]];
  function bracket(D) {
    const b = D && D.bracket; if (!b) return null;
    const T = Object.fromEntries(D.teams.map(t => [t.id, t]));
    const exclude = playoffRoundIds(D);
    const { sorted } = compute(D, exclude);
    const frozen = Array.isArray(b.seeds) && b.seeds.length === 8;
    const seeds = frozen ? b.seeds.map(id => T[id] || null) : sorted.slice(0, 8).map(r => r.t);
    while (seeds.length < 8) seeds.push(null);
    const warnings = [];
    if (!frozen && D.teams.length < 8) warnings.push('Fewer than 8 teams exist, so some seeds are empty.');
    const stageRound = { qf: b.qf || '', sf: b.sf || '', f: b.f || '' };
    if (!stageRound.qf || !stageRound.sf || !stageRound.f) warnings.push('Choose a round for every stage (quarterfinals, semifinals, final) to show results.');

    const used = { qf: new Set(), sf: new Set(), f: new Set() };
    const make = (stage, name, A, B) => {
      const slot = { stage, name, a: A, b: B, match: null, wa: 0, wb: 0, winner: null, status: 'tbd' };
      const ta = A.team, tb = B.team;
      if (!ta || !tb) return slot;
      slot.status = 'unscheduled';
      const rid = stageRound[stage];
      if (!rid) return slot;
      const m = D.matches.find(x => x.round === rid && ((x.a === ta.id && x.b === tb.id) || (x.a === tb.id && x.b === ta.id)));
      if (!m) return slot;
      used[stage].add(m.id);
      const st = state(m), same = m.a === ta.id;
      slot.match = m;
      slot.wa = same ? st.wa : st.wb; slot.wb = same ? st.wb : st.wa;
      if (st.decided) { slot.status = 'final'; slot.winner = slot.wa > slot.wb ? ta : tb; }
      else if (st.started) slot.status = 'progress';
      return slot;
    };
    const seedSide = n => ({ team: seeds[n - 1], seed: n, from: '' });
    const winnerSide = slot => ({ team: slot.winner, seed: slot.winner ? seeds.indexOf(slot.winner) + 1 : 0, from: 'Winner of ' + slot.name });

    const qf = PAIRS.map((p, i) => make('qf', 'QF' + (i + 1), seedSide(p[0]), seedSide(p[1])));
    const sf = [make('sf', 'SF1', winnerSide(qf[0]), winnerSide(qf[1])), make('sf', 'SF2', winnerSide(qf[2]), winnerSide(qf[3]))];
    const final = make('f', 'Final', winnerSide(sf[0]), winnerSide(sf[1]));

    // results entered for a pairing that no longer exists (for example because seeds moved)
    const names = { qf: 'Quarterfinal', sf: 'Semifinal', f: 'Final' };
    ['qf', 'sf', 'f'].forEach(stage => {
      const rid = stageRound[stage]; if (!rid) return;
      const orphans = D.matches.filter(m => m.round === rid && !used[stage].has(m.id) && state(m).started).length;
      if (orphans) warnings.push(orphans + ' ' + names[stage].toLowerCase() + ' result' + (orphans > 1 ? 's do' : ' does') + ' not match the current pairings. The seeds may have moved: freeze the seeding or check the teams.');
    });
    return { published: b.published === true, frozen, seeds, qf, sf, final, champion: final.winner, warnings, stageRound };
  }

  root.EPS = { gamesOf, valid, state, playoffRoundIds, compute, bracket };
})(window);
