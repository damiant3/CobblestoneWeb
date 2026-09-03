// The arcade: one descriptor per classic game, driving that game's own wasm
// module. index.html renders these; apps/games/ar-verify.mjs grades them
// headlessly, which is why the descriptors live in a module and not inline
// in the page. A renderer that only works when a human is watching is a
// renderer nobody checks.
//
// TWO STATE CONTRACTS, and getting them backwards is silent corruption.
// TicTacToe threads the whole game through one i32, so the page may reset
// the module heap before every call. Every other game passes a HANDLE: the
// i32 IS a heap address, so the heap must NOT be reset between calls. It is
// reset when a new game starts, and only there. apps/games/build-wasm.ps1
// carries the census.
//
// There is no GC in these modules: they bump-allocate and free nothing, so
// every step of a long autoplay is permanent until the next reset. That is
// what `steps` bounds, and what makes `runs` (a whole game inside one call)
// the cheaper arm where the module offers one.

const RANK = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const SUIT = ['♠', '♥', '♦', '♣'];

export const card = c => c < 0 ? '--'
  : `${RANK[c % 13]}${SUIT[Math.floor(c / 13) % 4]}`;
export const red = c => c >= 0 && [1, 2].includes(Math.floor(c / 13) % 4);

const grid = (cols, cells) => ({ kind: 'grid', cols, cells });
const rows = r => ({ kind: 'rows', rows: r.filter(Boolean) });
// `i` is the index a click on this cell reports. Grid cells get their grid
// position by default; a row or column cell has no natural index, so a
// clickable one has to say what it stands for (a mancala pit, a spider
// column) or it is decoration.
const cell = (text, cls, i) => ({ text: text === 0 ? '0' : (text || ''), cls: cls || '', i });
const seq = n => [...Array(n).keys()];

// A hand as one row of card chips.
const hand = (n, at) => seq(n).map(at).map(c => cardCell(c));

export const cardCell = (c, extra) =>
  ({ text: card(c), cls: 'card' + (red(c) ? ' red' : '') + (extra ? ' ' + extra : '') });

// A hand read out of a "do you hold this card" test, which is how the
// trick-taking engines expose one. Sorted by suit then rank so it reads
// like a hand somebody is holding rather than deck order.
const held = (n, has) => {
  const cards = [];
  for (let c = 0; c < n; c++) if (has(c)) cards.push(c);
  cards.sort((a, b) => Math.floor(a / 13) - Math.floor(b / 13) || (a % 13) - (b % 13));
  return cards.length ? cards.map(c => cardCell(c)) : [cell('out', 'chip')];
};

const PLAYERS = ['P1', 'P2', 'P3', 'P4'];

// Poker.codex ranks hands 0 to 8, low to high.
const HANDS = ['high card', 'a pair', 'two pair', 'trips', 'a straight',
  'a flush', 'a full house', 'quads', 'a straight flush'];

// RoyalUr.codex, ur-is-rosette: step 4, 8 or 14.
const UR_ROSETTE = [4, 8, 14];

// Backgammon: current-player 0 is White and moves first, so that is you.
// White runs from point 24 down to 1, which puts its home board and its
// bear-off tray at the bottom right, where the player sitting there expects
// them. The bar and the tray are moves, so they get indices past the 24
// points rather than being crammed into them.
const BG_YOU = 0, BG_BAR = 100, BG_OFF = 101;
// Index of the Roll action in backgammon's `actions` list. The board draws
// that button itself, so the two have to agree on which one it is.
const BG_ROLL = 0;

// EVERY winner code in this file is taken from the engine's own
// format-*-result function, which is the only place the convention is
// written down, and they do NOT agree with each other: Othello and Connect
// Four number their players from one, Checkers and Backgammon and Pinochle
// from zero, and a draw is 0 in the first group and -1 in the second.
// Indexing a label array by a code from the wrong group is how a won game
// came out as "a draw" -- checkers winner 0 is SOUTH, not nobody.
const named = (code, map, fallback) =>
  Object.prototype.hasOwnProperty.call(map, code) ? map[code] : fallback;

export const GAMES = [
  {
    id: 'tictactoe', name: 'Tic-Tac-Toe', cat: 'Board', icon: '❌',
    desc: 'Perfect play. The search reads every line to the end, so it has never lost one.',
    flat: true,
    boot: e => e.ttt_new(),
    // ttt_ai answers the NEXT PACKED BOARD, not a square. Reading it as a
    // move and feeding it to ttt_play returns the board unchanged, which
    // renders as a game that never starts.
    step: (e, h) => { const n = e.ttt_ai(h); return n === h ? null : n; },
    done: (e, h) => e.ttt_done(h) === 1,
    status: (e, h) => e.ttt_done(h) === 1
      ? named(e.ttt_winner(h), { 1: 'X takes it', 2: 'O takes it' },
        'A draw, which is the best anyone gets against a perfect search')
      : (e.ttt_cur(h) === 1 ? 'X to move (you)' : 'O to move'),
    // The drawn grid, the way it is on paper: no boxes, just the two
    // strokes each way, so the marks sit in the spaces.
    view: (e, h) => ({
      kind: 'grid', cols: 3, board: 'ttt',
      cells: seq(9).map(i => {
        const v = e.ttt_cell(h, i);
        return cell(['', '×', '○'][v], 'ttt big ' + ['', 'x', 'o'][v]
          + ' r' + Math.floor(i / 3) + ' c' + (i % 3));
      }),
    }),
    human: 1,
    turn: (e, h) => e.ttt_cur(h),
    // The pointer carries your mark and paints it into the square.
    ghost: (e, h, i) => e.ttt_cell(h, i) !== 0 ? null
      : { i, cls: 'ttt big x', text: '×', carry: 'mark' },
    // Tic-Tac-Toe is the one game whose state is a plain packed integer
    // rather than a heap address, so comparing before and after IS a valid
    // refusal test here. It is not valid for any other game in this file.
    move: (e, h, i) => {
      if (e.ttt_cell(h, i) !== 0) return null;
      const n = e.ttt_play(h, i);
      return n === h ? null : { handle: n };
    },
  },
  {
    id: 'royalur', name: 'Royal Game of Ur', cat: 'Board', icon: '\u{1F3DB}',
    desc: 'The oldest rules we can still play, from about 2600 BCE. Rosettes, captures, tetrahedral dice.',
    boot: e => e.ur_new(),
    // Takes the turn's roll from the driver when there is one, so a watcher
    // sees the number the move followed from instead of a second, unrelated
    // throw made inside the step.
    step: (e, h, r, roll) => {
      const n = (roll === null || roll === undefined) ? e.ur_roll(r()) : roll;
      const m = e.ur_ai(h, n);
      return { handle: m < 0 ? e.ur_pass(h) : e.ur_play(h, m, n), roll: null };
    },
    done: (e, h) => e.ur_done(h) === 1,
    // ur_piece and ur_scored take a ONE-BASED player: the wrapper reads
    // `if player == 1 then p1-pieces else p2-pieces`, so 0 falls to the else
    // and silently answers player 2. Passing 0 and 1 swapped the two sides
    // and labelled them backwards, and ur_cur is 1-based too, so adding one
    // to it named the wrong player on every turn.
    status: (e, h, s, sel, roll) => e.ur_done(h) === 1
      ? `Player ${e.ur_winner(h)} gets all seven home`
      : `Player ${e.ur_cur(h)} to move`
      + (roll !== null && roll !== undefined
        ? (roll === 0 ? ' · rolled 0, no move' : ` · rolled ${roll}`) : '')
      + ` · ${e.ur_scored(h, 1)}-${e.ur_scored(h, 2)} home · ${e.ur_moves(h)} moves`,
    // RoyalUr.codex: a path of 14 steps. 1-4 private start, 5-12 the shared
    // middle, 13-14 private exit, 15 scored, 0 not yet entered. Rosettes
    // are steps 4, 8 and 14, which is why they sit where they do below.
    //
    // The real board is three rows of eight with two squares missing from
    // each player's row. A player's four start squares run 4,3,2,1 to the
    // left so that step 4 meets step 5 at the same column, and the two exit
    // squares are 14,13 on the right, so the whole fourteen-step path is
    // continuous across the board rather than being a list of numbers.
    view: (e, h, s, sel, roll) => {
      const at = p => {
        const m = {};
        for (let i = 0; i < 7; i++) m[e.ur_piece(h, p, i)] = i;
        return m;
      };
      const p1 = at(1), p2 = at(2);
      const priv = [4, 3, 2, 1, null, null, 14, 13];
      const mid = [5, 6, 7, 8, 9, 10, 11, 12];
      const sqr = (step, owner) => {
        if (step === null) return { gap: true };
        const mine = owner === 1 ? p1 : owner === 2 ? p2 : null;
        let who = 0, idx;
        if (mine && mine[step] !== undefined) { who = owner; idx = mine[step]; }
        else if (owner === 0) {
          if (p1[step] !== undefined) { who = 1; idx = p1[step]; }
          else if (p2[step] !== undefined) { who = 2; }
        }
        const playable = who === 1 && roll ? e.ur_can(h, idx, roll) === 1 : false;
        return {
          step, who, rosette: UR_ROSETTE.includes(step),
          i: who === 1 ? idx : undefined, playable,
        };
      };
      const waiting = p => seq(7).filter(i => e.ur_piece(h, p, i) === 0);
      const w1 = waiting(1);
      return {
        kind: 'ur',
        top: priv.map(st => sqr(st, 2)),
        mid: mid.map(st => sqr(st, 0)),
        bottom: priv.map(st => sqr(st, 1)),
        trays: {
          youWaiting: w1.length, youHome: e.ur_scored(h, 1),
          themWaiting: waiting(2).length, themHome: e.ur_scored(h, 2),
          // Clicking the tray enters the next piece, so it needs to name one.
          enter: w1.length && roll ? w1.find(i => e.ur_can(h, i, roll) === 1) : undefined,
        },
        roll,
      };
    },
    human: 1,
    turn: (e, h) => e.ur_cur(h),
    // The die comes first: without this turn's roll a piece is not a move,
    // it is just a piece. beginTurn puts the number on the table and the
    // click then names which of the seven to advance by it.
    beginTurn: (e, h, rand) => e.ur_roll(rand()),
    move: (e, h, i, st) => {
      if (st.roll === null || st.roll === undefined) return null;
      if (st.roll === 0) return { handle: e.ur_pass(h) };
      return e.ur_can(h, i, st.roll) === 1 ? { handle: e.ur_play(h, i, st.roll) } : null;
    },
    actions: [{
      label: 'Pass', run: (e, h) => ({ handle: e.ur_pass(h) }),
    }],
  },
  {
    id: 'othello', name: 'Othello', cat: 'Board', icon: '●',
    desc: '8x8 Reversi. Outflank a line of discs and every one of them turns.',
    boot: e => e.ot_new(),
    step: (e, h) => { const m = e.ot_ai(h); return m < 0 ? null : e.ot_place(h, m); },
    done: (e, h) => e.ot_done(h) === 1,
    status: (e, h) => e.ot_done(h) === 1
      ? `${named(e.ot_winner(h), { 1: 'Black takes it', 2: 'White takes it' }, 'A draw')} · ${e.ot_black(h)}-${e.ot_white(h)}`
      : `${e.ot_player(h) === 1 ? 'Black' : 'White'} to move · ${e.ot_black(h)}-${e.ot_white(h)} · move ${e.ot_moves(h)}`,
    view: (e, h) => grid(8, seq(64).map(i =>
      cell('', 'felt ' + ['', 'disc black', 'disc white'][e.ot_cell(h, i)]
        + (e.ot_legal(h, i) === 1 ? ' hint' : '')))),
    human: 1,
    turn: (e, h) => e.ot_player(h),
    move: (e, h, i) => e.ot_legal(h, i) === 1 ? { handle: e.ot_place(h, i) } : null,
    ghost: (e, h, i) => e.ot_legal(h, i) === 1
      ? { i, cls: 'felt disc black', carry: 'disc black', flips: e.ot_flips(h, i) } : null,
  },
  {
    id: 'connect4', name: 'Connect Four', cat: 'Board', icon: '\u{1F534}',
    desc: 'The AI takes a win, blocks a loss, and otherwise favours the centre.',
    boot: e => e.c4_new(),
    step: (e, h) => { const m = e.c4_ai(h); return m < 0 ? null : e.c4_drop(h, m); },
    done: (e, h) => e.c4_done(h) === 1,
    status: (e, h) => e.c4_done(h) === 1
      ? (e.c4_winner(h) ? `${['', 'Red', 'Yellow'][e.c4_winner(h)]} connects four` : 'A full board and no line')
      : `${e.c4_cur(h) === 1 ? 'Red' : 'Yellow'} to drop`,
    // Row 0 is the top and a drop lands at row 5, so the grid renders in
    // index order and gravity already runs the way the eye expects.
    view: (e, h) => grid(7, seq(42).map(i =>
      cell('', 'felt ' + ['', 'disc red', 'disc yellow'][e.c4_cell(h, Math.floor(i / 7), i % 7)]
        + (e.c4_can(h, i % 7) === 1 ? ' hint' : '')))),
    human: 1,
    turn: (e, h) => e.c4_cur(h),
    move: (e, h, i) => e.c4_can(h, i % 7) === 1 ? { handle: e.c4_drop(h, i % 7) } : null,
    // Gravity is the mechanic here and nowhere else, so this is the only
    // game whose pieces arrive by falling.
    land: 'drop',
    // Hovering a column shows the chip where it would COME TO REST, not
    // under the pointer, because that is the question a player is asking.
    // `from` is how many rows it falls, which the page animates.
    ghost: (e, h, i) => {
      const c = i % 7;
      if (e.c4_can(h, c) !== 1) return null;
      const row = 5 - e.c4_height(h, c);
      return { i: row * 7 + c, cls: 'disc red', from: row + 1, carry: 'disc red' };
    },
  },
  {
    id: 'checkers', name: 'Checkers', cat: 'Board', icon: '⛀',
    desc: 'English draughts, king promotions, minimax opponent.',
    boot: e => e.ck_new(),
    step: (e, h) => { const m = e.ck_ai(h); return m < 0 ? null : e.ck_apply(h, m); },
    done: (e, h) => e.ck_done(h) === 1,
    // Checkers.codex: winner 0 is South, 1 is North, anything else a draw.
    status: (e, h) => e.ck_done(h) === 1
      ? named(e.ck_winner(h), { 0: 'You win: South takes it', 1: 'North takes it' },
        'Neither side can force it: a draw')
      : `${e.ck_turn(h) === 0 ? 'South (you)' : 'North'} to move · ${e.ck_moves(h)} legal`,
    // South is 1 and 2, sits on rows 5 to 7, and moves first, so the user is
    // South and is already at the bottom of the board as rendered.
    view: (e, h, s, sel) => grid(8, seq(64).map(i => {
      const dark = ((Math.floor(i / 8) + i % 8) % 2) === 1;
      const v = e.ck_cell(h, i);
      const dest = sel !== null && sel !== undefined && ckMove(e, h, sel, i) >= 0;
      // The piece is drawn, not typed. A '●' glyph renders at whatever size
      // the font feels like and sat tiny in the square.
      return cell('',
        (dark ? 'sq-dark ' : 'sq-light ') + ['', 'ckp s', 'ckp s k', 'ckp n', 'ckp n k'][v]
        + (i === sel ? ' picked' : '') + (dest ? ' hint' : ''));
    })),
    human: 0,
    turn: (e, h) => e.ck_turn(h),
    // A checker slides from where it was to where it went. It does not fall.
    land: 'slide',
    // A checkers move is a source and a destination, and the module names
    // moves by INDEX, so the page has to find the index whose from and to
    // match the two squares the user clicked.
    move: (e, h, i, st) => {
      if (st.sel === null || st.sel === undefined) {
        const owns = [1, 2].includes(e.ck_cell(h, i));
        return owns && ckFrom(e, h, i) ? { sel: i } : null;
      }
      if (i === st.sel) return { sel: null };
      const m = ckMove(e, h, st.sel, i);
      if (m >= 0) return { handle: e.ck_apply(h, m) };
      const owns = [1, 2].includes(e.ck_cell(h, i));
      return owns && ckFrom(e, h, i) ? { sel: i } : null;
    },
  },
  {
    id: 'go', name: 'Go', cat: 'Board', icon: '⚫',
    desc: '9x9 with area scoring and the Ko rule.',
    boot: e => e.go_new(),
    step: (e, h, r) => { const m = e.go_ai(h, r()); return m < 0 ? e.go_pass(h) : e.go_place(h, m); },
    done: (e, h) => e.go_done(h) === 1,
    status: (e, h) => {
      const b = e.go_score(h, 1), w = e.go_score(h, 2);
      return (e.go_done(h) === 1 ? `${b > w ? 'Black' : 'White'} leads the board` : `${e.go_cur(h) === 1 ? 'Black' : 'White'} to play`)
        + ` · B ${b} W ${w} · captures ${e.go_captures(h, 1)}/${e.go_captures(h, 2)}`;
    },
    view: (e, h) => grid(9, seq(81).map(i =>
      cell('', 'goban ' + ['', 'stone black', 'stone white'][e.go_cell(h, i)]))),
    human: 1,
    turn: (e, h) => e.go_cur(h),
    // Go exports no legality test, and a HANDLE CANNOT BE COMPARED to find
    // one: every call allocates a fresh state, so `place(h,i) === h` is
    // never true and a refused move reads as a move made. The board is the
    // only witness -- if the point does not hold your stone afterwards, the
    // rules refused it (occupied, ko, or self-capture).
    move: (e, h, i) => {
      if (e.go_cell(h, i) !== 0) return null;
      const me = e.go_cur(h);
      const n = e.go_place(h, i);
      return e.go_cell(n, i) === me ? { handle: n } : null;
    },
    actions: [{ label: 'Pass', run: (e, h) => ({ handle: e.go_pass(h) }) }],
    ghost: (e, h, i) => e.go_cell(h, i) !== 0 ? null
      : { i, cls: 'goban stone black', carry: 'stone black' },
  },
  {
    id: 'hexgame', name: 'Hex', cat: 'Board', icon: '⬢',
    desc: '11x11. Connect your two edges. A finished Hex board always has exactly one winner.',
    boot: e => e.hx_new(),
    step: (e, h) => { const m = e.hx_ai(h); return m < 0 ? null : e.hx_place(h, m); },
    done: (e, h) => e.hx_done(h) === 1,
    status: (e, h) => e.hx_done(h) === 1
      ? `Player ${e.hx_winner(h)} joins ${e.hx_winner(h) === 1 ? 'top to bottom' : 'left to right'} in ${e.hx_moves(h)} moves`
      : `Player ${e.hx_cur(h)} to place · ${e.hx_moves(h)} moves`,
    view: (e, h) => ({
      kind: 'hex', cols: 11,
      cells: seq(121).map(i => cell('', ['', 'p1', 'p2'][e.hx_cell(h, i)])),
    }),
    human: 1,
    turn: (e, h) => e.hx_cur(h),
    move: (e, h, i) => e.hx_can(h, i) === 1 ? { handle: e.hx_place(h, i) } : null,
    ghost: (e, h, i) => e.hx_can(h, i) === 1 ? { i, cls: 'p1', carry: 'hexchip' } : null,
  },
  {
    id: 'mancala', name: 'Mancala', cat: 'Board', icon: '\u{1F95C}',
    desc: 'Kalah: sowing, capture, and the extra turn that lands in your own store.',
    boot: e => e.mc_new(),
    step: (e, h) => { const m = e.mc_ai(h, 4); return m < 0 ? null : e.mc_move(h, m); },
    done: (e, h) => e.mc_done(h) === 1,
    status: (e, h) => {
      const s = e.mc_south(h), n = e.mc_north(h);
      return (e.mc_done(h) === 1 ? `${s > n ? 'South' : n > s ? 'North' : 'Nobody'} wins ${s}-${n}`
        : `${e.mc_turn(h) === 0 ? 'South' : 'North'} to sow · ${s}-${n}`);
    },
    // South is pits 0-5 and moves first, so the user is South and South is
    // the BOTTOM row. North's pits run 12 down to 7 so the two rows face
    // each other the way they do on a real board.
    // A carved board, not two lines of buckets: north's six pits above
    // south's six, a store at each end, stones drawn in the cup.
    view: (e, h) => ({
      kind: 'mancala',
      north: [12, 11, 10, 9, 8, 7].map(i => ({ n: e.mc_pit(h, i) })),
      south: [0, 1, 2, 3, 4, 5].map(i =>
        ({ n: e.mc_pit(h, i), i, legal: e.mc_legal(h, i) === 1 })),
      stores: { north: e.mc_north(h), south: e.mc_south(h) },
    }),
    human: 0,
    turn: (e, h) => e.mc_turn(h),
    move: (e, h, i) => e.mc_legal(h, i) === 1 ? { handle: e.mc_move(h, i) } : null,
  },
  {
    id: 'backgammon', name: 'Backgammon', cat: 'Board', icon: '\u{1F3B2}',
    desc: '24 points, the bar, and bearing off.',
    boot: e => e.bg_new(),
    // Backgammon.codex: "Dice are 2d6; doubles = 4 moves." bg_step spends
    // ONE die, so a turn is a queue of two, or four on a double, and the
    // page spends them one at a time so each checker is seen to move.
    beginTurn: (e, h, rand) => {
      const a = e.bg_die(rand()), b = e.bg_die(rand());
      return { dice: [a, b], queue: a === b ? [a, a, a, a] : [a, b], spent: [] };
    },
    step: (e, h, rand, roll) => {
      if (!roll || !roll.queue.length) return null;
      const die = roll.queue[0];
      const moved = e.bg_step(h, die);
      const rest = {
        dice: roll.dice, queue: roll.queue.slice(1), spent: roll.spent.concat(die),
      };
      // Turn over when the dice are spent.
      return rest.queue.length
        ? { handle: moved, roll: rest }
        : { handle: e.bg_endturn(moved), roll: null };
    },
    done: (e, h) => e.bg_done(h) === 1,
    // Backgammon.codex: winner 0 is White, 1 is Black. Indexing a label
    // array by that put an EMPTY name in front of "bears off last".
    status: (e, h) => e.bg_done(h) === 1
      ? `${named(e.bg_winner(h), { 0: 'White', 1: 'Black' }, 'Nobody')} bears off last`
      : `${e.bg_cur(h) === 0 ? 'White' : 'Black'} to move · off ${e.bg_off(h, 0)}/${e.bg_off(h, 1)} · bar ${e.bg_bar(h, 0)}/${e.bg_bar(h, 1)}`,
    // A real board, drawn by the page. The photographic one that used to
    // stand in for this is the one Damian called out as looking bad, so
    // backgammon is the one game here with no scene behind it and a board
    // built out of its own points instead.
    //
    // A point holds a signed count: positive is White, negative is Black.
    // The bottom row runs 12 down to 1 right to left and the top row 13 up
    // to 24, which is how a real board reads, and it puts the user's home
    // board at the bottom right.
    view: (e, h, s, sel, roll) => {
      const dice = roll ? roll.queue : [];
      const mine = e.bg_cur(h) === BG_YOU;
      // A point you could move FROM with any die still in hand, or, once
      // one is picked up, a point that die could land it on.
      const from = p => mine && dice.some(d => e.bg_can(h, p, d) === 1);
      const dieFor = (a, b) => BG_YOU === 0 ? a - b : b - a;
      const dest = p => {
        if (!mine || sel === null || sel === undefined) return false;
        const d = dieFor(sel, p);
        return dice.includes(d) && e.bg_can(h, sel, d) === 1;
      };
      const pt = p => ({
        n: e.bg_point(h, p), i: p,
        hint: sel === null || sel === undefined ? from(p) : dest(p),
        picked: p === sel,
      });
      return {
        kind: 'backgammon',
        top: seq(12).map(i => pt(i + 12)),
        bottom: seq(12).map(i => pt(11 - i)),
      // bg_bar and bg_off read `if player == 0 then white else black`, so
      // the players are 0 and 1. Asking for 1 and 2 answered BLACK twice
      // and White never, in both the bar and the tray.
      bar: [e.bg_bar(h, 0), e.bg_bar(h, 1)],
      off: [e.bg_off(h, 0), e.bg_off(h, 1)],
      // The dice sit on the side of whoever is throwing them: White on the
      // left, Black on the right. Spent dice grey out as they are used.
      dice: roll ? roll.dice : null,
      spent: roll ? roll.spent : [],
        thrower: e.bg_cur(h) === 0 ? 'w' : 'b',
        // The engine implements no doubling, so the cube is board furniture
        // sitting where an untouched cube sits. The rules panel says so
        // rather than leaving a control that would do nothing.
        cube: 64,
        // Entering from the bar and bearing off are moves too, so they are
        // clickable in their own right.
        // Your throw, offered in the middle of the board. The opponent
        // rolls its own as part of its turn, so this only ever shows on
        // your side of the game.
        showRoll: mine && !roll,
        barHint: mine && dice.some(d => e.bg_canenter(h, d) === 1),
        offHint: mine && sel !== null && sel !== undefined &&
          dice.some(d => e.bg_can(h, sel, d) === 1 &&
            (BG_YOU === 0 ? sel - d < 0 : sel + d >= 24)),
      };
    },
    human: BG_YOU,
    turn: (e, h) => e.bg_cur(h),
    land: 'slide',
    // You throw when you are ready. Rolling for you the moment the turn
    // arrives takes away the one thing that makes a dice game feel like one.
    manualRoll: true,
    actions: [
      {
        label: '\u{1F3B2} Roll',
        // Drawn on the board itself, in the middle where a real player
        // throws, so it is not up in the toolbar away from the game.
        inBoard: true,
        enabled: (e, h, roll) => !roll,
        run: (e, h, rand) => {
          const a = e.bg_die(rand()), b = e.bg_die(rand());
          return {
            handle: h,
            roll: { dice: [a, b], queue: a === b ? [a, a, a, a] : [a, b], spent: [] },
          };
        },
      },
      {
        label: 'No move, pass',
        enabled: (e, h, roll) => !!roll && roll.queue.every(d => e.bg_any(h, d) === 0),
        run: (e, h) => ({ handle: e.bg_endturn(h), roll: null }),
      },
    ],
    // BAR and OFF are moves in their own right, so they get indices of
    // their own rather than being squeezed into the twenty-four points.
    move: (e, h, i, st) => {
      const dice = st.roll ? st.roll.queue : [];
      if (!dice.length) return null;
      const spend = (d, handle) => {
        const q = dice.slice();
        q.splice(q.indexOf(d), 1);
        const spent = (st.roll.spent || []).concat(d);
        return q.length
          ? { handle, roll: { dice: st.roll.dice, queue: q, spent } }
          : { handle: e.bg_endturn(handle), roll: null };
      };
      if (i === BG_BAR) {
        // Deterministic rather than queue order, so the same click always
        // enters on the same point.
        const cands = dice.filter(x => e.bg_canenter(h, x) === 1).sort((a, b) => a - b);
        return cands.length ? spend(cands[0], e.bg_enter(h, cands[0])) : null;
      }
      if (i === BG_OFF) {
        if (st.sel === null || st.sel === undefined) return null;
        // SPEND THE DIE THE MOVE ACTUALLY USES. Bearing off a checker from
        // the three-point uses the three; a five also satisfies the test,
        // and taking the first die that happens to work spent the five and
        // left the three still owed -- so the next move looked like the
        // three being spent twice. Exact die first, then the smallest that
        // will do.
        const need = BG_YOU === 0 ? st.sel + 1 : 24 - st.sel;
        const cands = dice
          .filter(x => e.bg_can(h, st.sel, x) === 1 &&
            (BG_YOU === 0 ? st.sel - x < 0 : st.sel + x >= 24))
          .sort((a, b) => a - b);
        if (!cands.length) return null;
        const d = cands.includes(need) ? need : cands[0];
        return spend(d, e.bg_move(h, st.sel, d));
      }
      if (st.sel === null || st.sel === undefined) {
        return dice.some(d => e.bg_can(h, i, d) === 1) ? { sel: i } : null;
      }
      if (i === st.sel) return { sel: null };
      const want = BG_YOU === 0 ? st.sel - i : i - st.sel;
      if (dice.includes(want) && e.bg_can(h, st.sel, want) === 1) {
        return spend(want, e.bg_move(h, st.sel, want));
      }
      return dice.some(d => e.bg_can(h, i, d) === 1) ? { sel: i } : null;
    },
    steps: 600,
  },

  {
    id: 'game2048', name: '2048', cat: 'Puzzle', icon: '\u{1F522}',
    desc: 'Slide and merge on a 4x4 grid.',
    boot: (e, s) => e.g2_new(s),
    step: (e, h) => { const m = e.g2_ai(h); return m < 0 ? null : e.g2_move(h, m); },
    done: (e, h) => e.g2_done(h) === 1,
    status: (e, h) => `score ${e.g2_score(h)} · best tile ${e.g2_max(h)} · ${e.g2_moves(h)} moves`
      + (e.g2_done(h) === 1 ? ' · no move left' : ''),
    view: (e, h) => grid(4, seq(16).map(i => {
      const v = e.g2_cell(h, i);
      return cell(v || '', 'tile big t' + (v <= 2048 ? v : 'big'));
    })),
    solo: true,
    keys: { ArrowUp: 0, ArrowRight: 1, ArrowDown: 2, ArrowLeft: 3 },
    key: (e, h, d) => e.g2_can(h, d) === 1 ? e.g2_move(h, d) : null,
  },
  {
    id: 'life', name: "Conway's Life", cat: 'Puzzle', icon: '\u{1F9EC}',
    desc: '20x20 toroidal B3/S23. Nobody plays; it just goes.',
    boot: (e, s) => e.lf_new(s),
    step: (e, h) => e.lf_step(h),
    done: () => false,
    status: (e, h) => `${e.lf_alive(h)} alive`,
    view: (e, h) => grid(20, seq(400).map(i =>
      cell('', e.lf_cell(h, Math.floor(i / 20), i % 20) ? 'life on' : 'life off'))),
    steps: 300,
  },
  {
    id: 'minesweeper', name: 'Minesweeper', cat: 'Puzzle', icon: '\u{1F4A3}',
    desc: '9x9, ten mines. The AI only opens a square it can prove is safe.',
    boot: (e, s) => e.ms_new(s),
    step: (e, h) => { const m = e.ms_ai(h); return m < 0 ? null : e.ms_open(h, m); },
    done: (e, h) => e.ms_done(h) === 1,
    status: (e, h) => `${e.ms_count(h)} open · ${e.ms_hits(h)} mines hit · ${e.ms_moves(h)} moves`
      + (e.ms_done(h) === 1 ? (e.ms_won(h) === 1 ? ' · cleared' : ' · over') : ''),
    view: (e, h) => grid(9, seq(81).map(i => {
      const mine = e.ms_mine(h, i) === 1, shown = e.ms_shown(h, i) === 1;
      if (!shown) return cell(e.ms_done(h) === 1 && mine ? '\u{1F4A3}' : '', 'ms hidden');
      if (mine) return cell('\u{1F4A3}', 'ms boom');
      const a = e.ms_adj(h, i);
      return cell(a || '', 'ms open n' + a);
    })),
    solo: true,
    move: (e, h, i) => e.ms_shown(h, i) === 1 ? null : { handle: e.ms_open(h, i) },
    ghost: (e, h, i) => e.ms_shown(h, i) === 1 ? null : { i, cls: 'ms probe' },
  },
  {
    id: 'sudoku', name: 'Sudoku', cat: 'Puzzle', icon: '\u{1F9E9}',
    desc: 'A generated grid and a backtracking solver. One step solves it.',
    boot: (e, s) => e.sd_new(s),
    step: (e, h) => e.sd_first_empty ? e.sd_solve(h) : e.sd_solve(h),
    done: (e, h) => e.sd_empty(h) < 0,
    status: (e, h) => `${e.sd_givens(h)} givens · ${e.sd_iters(h)} iterations`
      + (e.sd_empty(h) < 0 ? ' · solved' : ' · unsolved'),
    view: (e, h) => grid(9, seq(81).map(i => {
      const v = e.sd_cell(h, i), r = Math.floor(i / 9), c = i % 9;
      const box = (Math.floor(r / 3) + Math.floor(c / 3)) % 2 ? ' shade' : '';
      return cell(v || '', 'sud' + box);
    })),
    steps: 2,
  },
  {
    id: 'mastermind', name: 'Mastermind', cat: 'Puzzle', icon: '\u{1F510}',
    desc: 'Four pegs. The solver keeps only codes consistent with every score so far.',
    boot: (e, s) => e.mm_new(s),
    step: (e, h) => e.mm_step(h),
    done: (e, h) => e.mm_done(h) === 1,
    status: (e, h) => `${e.mm_guesses(h)} guesses · ${e.mm_pool(h)} codes still possible`
      + (e.mm_solved(h) === 1 ? ` · cracked ${pegs(e, e.mm_secret(h))}` : ''),
    view: (e, h) => rows([
      ['Last guess', seq(4).map(i => cell(e.mm_digit(e.mm_guess(h), i), 'peg c' + e.mm_digit(e.mm_guess(h), i)))],
      ['Score', [cell(e.mm_blacks(h) + ' black', 'chip'), cell(e.mm_whites(h) + ' white', 'chip')]],
      e.mm_solved(h) === 1 && ['Secret', seq(4).map(i => cell(e.mm_digit(e.mm_secret(h), i), 'peg c' + e.mm_digit(e.mm_secret(h), i)))],
    ]),
  },
  {
    id: 'mahjong', name: 'Mahjong Solitaire', cat: 'Other', icon: '\u{1F004}',
    desc: 'Shanghai layout. Match free tiles until nothing free matches.',
    boot: (e, s) => e.mj_new(s),
    step: (e, h) => e.mj_step(h),
    done: (e, h) => e.mj_done(h) === 1,
    status: (e, h) => `${e.mj_matched(h)} pairs matched · ${e.mj_remaining(h)} tiles left`
      + (e.mj_stuck(h) === 1 ? ' · stuck' : ''),
    view: (e, h) => grid(18, seq(144).map(i => {
      const t = e.mj_tile(h, i);
      return t < 0 ? cell('', 'tile gone')
        : cell(e.mj_type(t), 'tile' + (e.mj_free(h, i) === 1 ? ' free' : ''));
    })),
  },
  {
    id: 'setgame', name: 'The Set Game', cat: 'Other', icon: '\u{1F0DF}',
    desc: 'Eighty-one cards, four attributes. A set is three cards where every attribute is all-same or all-different.',
    boot: (e, s) => e.sg_new(s),
    step: null,
    runs: (e, s) => `${e.sg_run(s)} sets found working through the deck`,
    done: () => true,
    status: (e, h) => `${e.sg_tabn(h)} on the table · ${e.sg_deckn(h)} in the deck · ${e.sg_sets(h)} sets present`,
    view: (e, h) => rows([['Tableau', seq(e.sg_tabn(h)).map(i => {
      const c = e.sg_tab(h, i);
      return cell(`${e.sg_number(c) + 1}${['●', '▲', '■'][e.sg_shape(c)]}`,
        'setcard s' + e.sg_color(c) + ' f' + e.sg_shading(c));
    })]]),
  },

  {
    id: 'blackjack', name: 'Blackjack', cat: 'Card', icon: '\u{1F0CF}',
    desc: 'Basic strategy against the dealer. Aces soften.',
    boot: (e, s) => e.bj_new(s),
    step: (e, h) => e.bj_auto(h),
    // bj_result is a COMPARISON of the two totals as they stand: 1 the
    // player, 0 a push, -1 the dealer. There is no "still in" among its
    // values, so indexing a label array by it read a loss as "still in" and
    // a push as "still in", and `> 0` read a loss as a hand not yet over.
    // Whether the hand is live is the page's business, not the module's:
    // the page owns the hit-or-stand flow.
    // Solo: the hand is live until the player stands or busts, and that is
    // page state, so the driver's `settled` flag carries it.
    done: (e, h, settled) => settled === true || e.bj_bust(h) === 1,
    status: (e, h, settled) => `you ${e.bj_pvalue(h)}${e.bj_psoft(h) === 1 ? ' soft' : ''} · dealer ${e.bj_dvalue(h)}`
      + (settled || e.bj_bust(h) === 1
        ? ' · ' + (e.bj_bust(h) === 1 ? 'bust, dealer takes it'
          : { 1: 'you win', 0: 'a push', '-1': 'dealer wins' }[e.bj_result(h)])
        : ' · hit or stand'),
    // Dealer above, you below, the way it sits on a table, and the winner
    // named against whoever took it rather than only in the status line.
    view: (e, h, settled) => {
      const over = settled || e.bj_bust(h) === 1;
      const res = e.bj_bust(h) === 1 ? -1 : e.bj_result(h);
      const mark = who => !over ? '' : res === 0 ? '  --  push'
        : (res === who ? '  --  WINNER' : '');
      return rows([
        // The hole card stays face down while the hand is live. That is the
        // rule, not decoration: showing it gives away the answer.
        [`Dealer ${e.bj_dvalue(h)}${mark(-1)}`, over
          ? hand(e.bj_dcount(h), i => e.bj_dcard(h, i))
          : [cardCell(e.bj_dcard(h, 0)), { text: '', cls: 'card back' }]],
        [`You ${e.bj_pvalue(h)}${e.bj_psoft(h) === 1 ? ' soft' : ''}${mark(1)}`,
        hand(e.bj_pcount(h), i => e.bj_pcard(h, i))],
      ]);
    },
    solo: true,
    // Hit and Stand belong under your own cards, not up with New Game.
    actionsInStage: true,
    actions: [
      { label: 'Hit', run: (e, h) => ({ handle: e.bj_hit(h), settled: false }) },
      { label: 'Stand', run: (e, h) => ({ handle: e.bj_stand(h), settled: true }) },
    ],
    steps: 2,
  },
  {
    id: 'war', name: 'War', cat: 'Card', icon: '\u{1F4A5}',
    desc: 'No choices at all, which is what makes it a good test: the deal and the bookkeeping are the only things to get wrong.',
    boot: (e, s) => e.wr_new(s),
    step: (e, h) => e.wr_round(h),
    done: (e, h) => e.wr_p1n(h) === 0 || e.wr_p2n(h) === 0,
    status: (e, h) => `${e.wr_p1n(h)} cards against ${e.wr_p2n(h)}`
      + (e.wr_p1n(h) === 0 ? ' · player 2 takes the deck'
        : e.wr_p2n(h) === 0 ? ' · player 1 takes the deck' : ''),
    // Nobody in a game of War can see their own hand, let alone the other
    // one, so laying all of it out face up was showing a thing that is not
    // on the table. Two face-down decks, and the two cards about to be
    // turned over between them.
    view: (e, h) => {
      const c1 = e.wr_p1n(h) > 0 ? e.wr_p1c(h, 0) : -1;
      const c2 = e.wr_p2n(h) > 0 ? e.wr_p2c(h, 0) : -1;
      const r1 = c1 < 0 ? -1 : e.wr_rank(c1), r2 = c2 < 0 ? -1 : e.wr_rank(c2);
      return {
        kind: 'war',
        left: { name: 'You', n: e.wr_p1n(h), card: c1, wins: r1 > r2 },
        right: { name: 'Player 2', n: e.wr_p2n(h), card: c2, wins: r2 > r1 },
        war: c1 >= 0 && c2 >= 0 && r1 === r2,
      };
    },
    runs: (e, s) => `player ${e.wr_winner(e.wr_run(s))} after ${e.wr_rounds(e.wr_run(s))} rounds`,
    steps: 1000,
  },
  {
    id: 'poker', name: 'Poker', cat: 'Card', icon: '\u{1F0A1}',
    desc: 'Five-card draw, nine hand ranks, and a wheel that counts as a straight.',
    boot: (e, s) => e.pk_play(s, 10),
    step: null,
    done: () => true,
    // Poker.codex: winner 1 is P1, 2 is P2, anything else a tie.
    status: (e, h) => `P1 ${e.pk_p1(h)} · P2 ${e.pk_p2(h)} over ${e.pk_played(h)} hands · `
      + named(e.pk_winner(h), { 1: 'player 1 ahead', 2: 'player 2 ahead' }, 'a tied session'),
    // The session result carries no cards, but the module will deal and
    // rank a hand on demand, so the page shows a real deal from the same
    // seed and the engine's own verdict on it. It is a hand from this
    // deck, not a replay of a hand the session played, and it says so.
    view: (e, h, s, sel, roll, seed) => {
      const deck = e.pk_deck(seed || 1);
      const five = i => seq(5).map(k => e.pk_card(deck, i * 5 + k));
      const line = i => {
        const c = five(i);
        return [...c.map(x => cardCell(x)),
        cell(HANDS[e.pk_rank(e.pk_hand(...c))] || '?', 'chip gold')];
      };
      return rows([
        ['Dealt from this seed', line(0)],
        ['And against it', line(1)],
        ['Session', [cell(e.pk_p1(h) + ' - ' + e.pk_p2(h), 'chip big')]],
      ]);
    },
  },
  {
    id: 'pokervariants', name: 'Poker Variants', cat: 'Card', icon: '\u{1F0AA}',
    desc: 'Stud, Baseball, Hi/Low Chicago and more, each with its own wild cards.',
    // pv_run is (variant, seed, players), not (seed, variant, players).
    boot: (e, s) => e.pv_run(s % 7, s, 4),
    step: null,
    done: () => true,
    status: (e, h) => `${e.pv_players(h)} players · ${e.pv_played(h)} hands · `
      + `P1 ${e.pv_p1(h)} P2 ${e.pv_p2(h)} · winner P${e.pv_winner(h)}`
      + (e.pv_special(h) ? ' · wild cards in play' : ''),
    // pv_best5c takes seven cards and answers the best five. The seven are
    // the page's, spread across the deck from the seed; the five are the
    // engine's choice and so is the ranking beside them.
    view: (e, h, s, sel, roll, seed) => {
      const seven = seq(7).map(k => ((seed || 1) * 7 + k * 11) % 52);
      const best = e.pv_best5c(...seven);
      const rank = e.pv_rank(e.pv_best5(...seven));
      return rows([
        ['Seven dealt', seven.map(c => cardCell(c))],
        ['The engine keeps', [...seq(5).map(k => cardCell(e.pv_cardat(best, k))),
        cell(HANDS[rank] || '?', 'chip gold')]],
        ['Session', [cell('P' + e.pv_winner(h), 'chip big')]],
      ]);
    },
  },
  {
    id: 'pinochle', name: 'Pinochle', cat: 'Card', icon: '\u{1F0DB}',
    desc: 'Forty-eight cards, two of every one of them, which is exactly the trap in scoring the melds.',
    boot: (e, s) => e.pn_new(s),
    step: null,
    done: () => true,
    // Pinochle.codex: 0 is Team0, 1 is Team1, anything else a tie.
    runs: (e, s) => named(e.pn_winner(e.pn_run(s)),
      { 0: 'team zero takes it', 1: 'team one takes it' }, 'tied'),
    status: (e, h) => `trump ${SUIT[e.pn_trump(h)]} · melds `
      + seq(4).map(p => e.pn_meld(h, p)).join(' / '),
    view: (e, h) => rows(seq(4).map(p =>
      [`Hand ${p + 1}`, hand(12, i => e.pn_card(h, p, i))])),
  },
  {
    id: 'bridge', name: 'Bridge', cat: 'Card', icon: '♠',
    desc: 'Four hands, high-card-point bidding, and a contract scored at the end.',
    boot: (e, s) => e.br_new(s),
    step: null,
    done: () => true,
    status: (e, h) => `contract ${e.br_contract(h)}${SUIT[e.br_trump(h)] || 'NT'} by ${PLAYERS[e.br_declarer(h)]}`
      + ` · ${e.br_nstricks(h)} tricks · ${e.br_made(h) === 1 ? 'made' : 'down'} · ${e.br_score(h)}`,
    view: (e, h) => rows(seq(4).map(p =>
      [`${PLAYERS[p]} (${e.br_hcp(h, p)} hcp)`, hand(e.br_count(h, p), i => e.br_card(h, p, i))])),
  },
  {
    id: 'crazyeights', name: 'Crazy Eights', cat: 'Card', icon: '\u{1F0A8}',
    desc: 'Match suit or rank. Eights are wild and name the suit.',
    boot: (e, s) => e.ce_new(s, 3),
    step: (e, h) => e.ce_step(h),
    done: (e, h) => e.ce_done(h) === 1,
    status: (e, h) => `pile ${card(e.ce_pile(h))}`
      + (e.ce_declared(h) >= 0 ? ` (called ${SUIT[e.ce_declared(h)]})` : '')
      + ` · ${named(e.ce_cur(h), PLAYERS, '?')} to play`
      + (e.ce_done(h) === 1
        ? ` · ${named(e.ce_winner(h), PLAYERS, 'nobody')} goes out` : ''),
    // ce_has answers whether a player holds a given card, so the hand can
    // be read out of the module a card at a time rather than reduced to a
    // number. A count is not a hand.
    view: (e, h) => rows([
      ['Pile', [cardCell(e.ce_pile(h))]],
      ...seq(e.ce_players(h)).map(p => [
        PLAYERS[p] + (p === e.ce_cur(h) ? ' to play' : ''),
        held(52, c => e.ce_has(h, p, c) === 1),
      ]),
    ]),
  },
  {
    id: 'gofish', name: 'Go Fish', cat: 'Card', icon: '\u{1F41F}',
    desc: 'Ask for a rank you hold; complete four of a kind to book it.',
    boot: (e, s) => e.gf_new(s, 3),
    step: (e, h) => e.gf_step(h),
    done: (e, h) => e.gf_done(h) === 1,
    status: (e, h) => `${e.gf_pile(h)} left in the pond · ${e.gf_total(h)} books made`,
    view: (e, h) => rows(seq(e.gf_players(h)).map(p => [
      `${PLAYERS[p]} · ${e.gf_books(h, p)} books`,
      held(52, c => e.gf_has(h, p, c) === 1),
    ])),
  },
  {
    id: 'spider', name: 'Spider Solitaire', cat: 'Card', icon: '\u{1F578}',
    desc: 'A hundred and four cards in ten columns. Build a king down to an ace in one suit and it flies away. One suit is a puzzle, four is a fight.',
    // One, two and four suits are the real game's whole difficulty range.
    // The count is baked into the deck the engine deals, not applied on top
    // of it, so every rule below -- runs, moves, completions -- follows.
    options: [{
      name: 'suits', label: 'Suits',
      values: [1, 2, 3, 4], labels: ['one', 'two', 'three', 'four'], def: 2,
    }],
    boot: (e, s, o) => e.sp_new(s, (o && o.suits) || 2),
    step: (e, h) => {
      const m = e.sp_sugg(h);
      if (m < 0) return e.sp_stockn(h) > 0 ? e.sp_deal(h) : null;
      return e.sp_move(h, e.sp_mfrom(m), e.sp_mstart(m), e.sp_mto(m));
    },
    done: (e, h) => e.sp_suits(h) === 8,
    won: (e, h) => e.sp_suits(h) === 8,
    status: (e, h) => {
      if (e.sp_suits(h) === 8) return `All eight runs away in ${e.sp_moves(h)} moves`;
      const empty = seq(10).filter(c => e.sp_coln(h, c) === 0).length;
      return `${e.sp_suits(h)} of 8 runs away · ${e.sp_moves(h)} moves`
        + ` · ${e.sp_stockn(h)} left in the stock`
        + (empty && e.sp_stockn(h) > 0
          ? ` · fill the empty column${empty > 1 ? 's' : ''} before you can deal` : '');
    },
    view: (e, h, s, sel, roll, seed, hint) => {
      // A hint SHOWS the move rather than making it. Being told the answer
      // and being played for are different things, and only one of them is
      // still your game.
      const hm = hint === undefined ? null : hint;
      return {
        kind: 'columns',
        stock: e.sp_stockn(h),
        suits: e.sp_suits(h),
        won: e.sp_suits(h) === 8,
        cols: seq(10).map(c => {
          const n = e.sp_coln(h, c);
          // The cards a move could pick up are the tail of the column that
          // forms a descending same-suit run, which is what sp_seqlen says.
          const runFrom = n > 0 ? n - e.sp_seqlen(h, c, n - 1) : n;
          if (!n) {
            return [cell('', 'card empty'
              + (hm && hm.to === c ? ' hintto' : '')
              + (sel !== null && sel !== undefined && sel !== c ? ' drop' : ''), c)];
          }
          return seq(n).map(i => {
            const v = e.sp_card(h, c, i);
            return cell(v < 0 ? '' : card(v),
              'card' + (red(v) ? ' red' : '') + (v < 0 ? ' facedown' : '')
              + (c === sel ? ' picked' : '')
              + (i >= runFrom ? ' movable' : '')
              + (hm && hm.from === c && i >= hm.start ? ' hintfrom' : '')
              + (hm && hm.to === c && i === n - 1 ? ' hintto' : ''), c);
          });
        }),
      };
    },
    solo: true,
    // A spider move is a source column, a start index inside it, and a
    // destination column. You pick two columns; the start is the top of the
    // source's longest legal sequence, which is what the engine's own
    // suggester uses too.
    move: (e, h, c, st) => {
      if (st.sel === null || st.sel === undefined) {
        return e.sp_coln(h, c) > 0 ? { sel: c } : null;
      }
      if (c === st.sel) return { sel: null };
      const from = st.sel;
      const n = e.sp_coln(h, from);
      for (let start = n - e.sp_seqlen(h, from, n - 1); start < n; start++) {
        if (e.sp_can(h, from, start, c) === 1) return { handle: e.sp_move(h, from, start, c) };
      }
      return e.sp_coln(h, c) > 0 ? { sel: c } : { sel: null };
    },
    // The engine's own suggester, decoded into the three numbers a move is
    // made of, so the page can point at it.
    hint: (e, h) => {
      const m = e.sp_sugg(h);
      if (m < 0) return null;
      return { from: e.sp_mfrom(m), start: e.sp_mstart(m), to: e.sp_mto(m) };
    },
    actions: [
      {
        label: 'Deal a row', run: (e, h) => ({ handle: e.sp_deal(h) }),
        // Spider deals onto EVERY column, so it may not deal while one
        // stands empty. Showing the button as available and then quietly
        // doing nothing is worse than showing it disabled.
        enabled: (e, h) => e.sp_stockn(h) > 0 &&
          !seq(10).some(c => e.sp_coln(h, c) === 0),
      },
    ],
    runs: (e, s) => `${e.sp_rsuits(e.sp_run(s))} of 8 runs in ${e.sp_rmoves(e.sp_run(s))} moves`,
    steps: 400,
  },
  {
    id: 'liarsdice', name: "Liar's Dice", cat: 'Dice', icon: '\u{1F3B2}',
    desc: 'Bid on dice you cannot see, and call the bluff when the count stops being plausible.',
    boot: (e, s) => e.ld_new(s, 4),
    step: (e, h) => e.ld_step(h),
    done: (e, h) => e.ld_done(h) === 1,
    status: (e, h) => (e.ld_bid(h) > 0 ? `bid ${e.ld_qty(h)} × ${e.ld_face(h)}` : 'no bid yet')
      + ` · ${e.ld_total(h)} dice on the table · ${e.ld_alivenum(h)} players alive`
      + (e.ld_done(h) === 1 ? ` · ${named(e.ld_winner(h), PLAYERS, 'nobody')} wins` : ''),
    view: (e, h) => rows(seq(e.ld_players(h)).map(p =>
      [PLAYERS[p] + (e.ld_alive(h, p) === 1 ? '' : ' (out)'),
      seq(e.ld_dice(h, p)).map(i => cell(e.ld_die(h, p, i), 'die'))])),
  },

  {
    id: 'battleship', name: 'Battleship', cat: 'Strategy', icon: '\u{1F6A2}',
    desc: '10x10, hunt and target. Both fleets are hidden until they are hit.',
    boot: (e, s) => e.bs_new(s),
    step: (e, h) => e.bs_step(h),
    done: (e, h) => e.bs_done(h) === 1,
    status: (e, h) => `P1 ${e.bs_hits(h, 0)} hits in ${e.bs_shots(h, 0)} shots · P2 ${e.bs_hits(h, 1)} in ${e.bs_shots(h, 1)}`
      + (e.bs_done(h) === 1 ? ` · player ${e.bs_winner(h)} wins` : ''),
    view: (e, h) => ({
      kind: 'pair', cols: 10, labels: ['Player 1 fires at', 'Player 2 fires at'],
      grids: [0, 1].map(p => seq(100).map(i => {
        const r = Math.floor(i / 10), c = i % 10;
        const t = e.bs_track(h, p, r, c);
        return cell(['', '·', '●'][t] || '', 'sea t' + t);
      })),
    }),
    steps: 400,
  },
  {
    id: 'risk', name: 'Risk', cat: 'Strategy', icon: '\u{1F30D}',
    desc: 'Twelve territories in four continents. The turn cap used to decide games nobody could see being decided.',
    boot: (e, s) => e.rk_new(s, 4),
    step: (e, h, r) => e.rk_turn(h, r()),
    done: (e, h) => e.rk_done(h) === 1,
    status: (e, h) => `turn ${e.rk_turnno(h)} · `
      + seq(e.rk_np(h)).map(p => `${PLAYERS[p]} ${e.rk_total(h, p)}`).join(' ')
      + (e.rk_done(h) === 1
        ? ` · ${named(e.rk_winner(h), PLAYERS, 'nobody')} takes the world`
        : ` · ${named(e.rk_cur(h), PLAYERS, '?')} to move`),
    view: (e, h) => grid(4, seq(12).map(i =>
      cell(`${e.rk_armies(h, i)}`, 'terr o' + e.rk_owner(h, i)))),
    steps: 400,
  },
  {
    id: 'monopoly', name: 'Monopoly', cat: 'Strategy', icon: '\u{1F3E0}',
    desc: 'Forty spaces, simplified: property changes hands, no houses.',
    boot: (e, s) => e.mo_new(s, 4),
    step: (e, h, r) => e.mo_step(h, r()),
    done: (e, h) => e.mo_done(h) === 1,
    // The engine ends on bankruptcy, which is rare without trading
    // (games-backlog GAME-8), so most sessions stop at the page's step
    // bound rather than at mo_cap. Saying "of 601" invented an ending.
    status: (e, h) => `turn ${e.mo_turn(h)} · `
      + seq(e.mo_players(h)).map(p => `${PLAYERS[p]} $${e.mo_cash(h, p)}`).join(' ')
      + (e.mo_done(h) === 1
        ? ` · ${named(e.mo_winner(h), PLAYERS, 'nobody')} bankrupts the rest`
        : ` · ${named(e.mo_richest(h), PLAYERS, '?')} richest`),
    view: (e, h) => grid(10, seq(40).map(i => {
      const owner = e.mo_owned(h, i) === 1 ? e.mo_owner(h, i) + 1 : 0;
      const here = seq(e.mo_players(h)).filter(p => e.mo_pos(h, p) === i);
      return cell(here.map(p => p + 1).join('') || '', 'space o' + owner);
    })),
    steps: 300,
  },
  {
    id: 'hexwar', name: 'Hex War', cat: 'Strategy', icon: '⚔',
    desc: 'Hex-and-counter with terrain and a combat results table.',
    boot: (e, s) => e.hw_new(s % 13, s),
    step: (e, h) => e.hw_step(h),
    done: (e, h) => e.hw_done(h) === 1,
    status: (e, h) => `turn ${e.hw_turn(h)} of ${e.hw_limit(h)} · side ${e.hw_active(h) + 1} · `
      + `VP ${e.hw_vp(h, 0)}-${e.hw_vp(h, 1)} · alive ${e.hw_alive(h, 0)}/${e.hw_alive(h, 1)}`
      + (e.hw_done(h) === 1 ? ` · side ${e.hw_winner(h) + 1} holds the field` : ''),
    view: (e, h) => {
      const w = e.hw_width(h), ht = e.hw_height(h);
      const at = {};
      for (let u = 0; u < e.hw_units(h); u++) {
        if (e.hw_dead(h, u) === 1) continue;
        at[e.hw_r(h, u) * w + e.hw_q(h, u)] = u;
      }
      return {
        kind: 'hex', cols: w,
        cells: seq(w * ht).map(i => {
          const u = at[i];
          return u === undefined
            ? cell('', 'terrain t' + e.hw_terrain(h, i))
            : cell(e.hw_str(h, u), 'unit o' + e.hw_owner(h, u));
        }),
      };
    },
    steps: 200,
  },
  {
    id: 'dotsandboxes', name: 'Dots and Boxes', cat: 'Other', icon: '▢',
    desc: 'Close a box and go again.',
    boot: (e, s) => e.dt_new(s),
    step: (e, h) => { const m = e.dt_ai(h); return m < 0 ? null : e.dt_place(h, m); },
    done: (e, h) => e.dt_done(h) === 1,
    status: (e, h) => `P1 ${e.dt_score(h, 0)} · P2 ${e.dt_score(h, 1)} · ${e.dt_moves(h)} moves`
      + (e.dt_done(h) === 1 ? ' · board full' : ''),
    view: (e, h) => {
      const cells = [];
      for (let gr = 0; gr < 7; gr++) for (let gc = 0; gc < 7; gc++) {
        if (gr % 2 === 0 && gc % 2 === 0) cells.push(cell('', 'dot'));
        else if (gr % 2 === 0) {
          const ei = (gr / 2) * 3 + ((gc - 1) / 2);
          cells.push(cell('', 'hedge ' + (e.dt_edge(h, ei) ? 'on' : 'off'), ei));
        } else if (gc % 2 === 0) {
          const ei = 12 + ((gr - 1) / 2) * 4 + gc / 2;
          cells.push(cell('', 'vedge ' + (e.dt_edge(h, ei) ? 'on' : 'off'), ei));
        } else {
          const b = e.dt_box(h, ((gr - 1) / 2) * 3 + ((gc - 1) / 2));
          cells.push(cell(b || '', 'boxcell o' + b));
        }
      }
      return grid(7, cells);
    },
    human: 1,
    turn: (e, h) => e.dt_cur(h),
    // The click reports the EDGE index the cell carries, not its position in
    // the 7x7 render: three quarters of that grid are dots and boxes, which
    // are not edges and are not moves.
    move: (e, h, i) => e.dt_can(h, i) === 1 ? { handle: e.dt_place(h, i) } : null,
    ghost: (e, h, i) => e.dt_can(h, i) === 1 ? { i, cls: 'edgeghost' } : null,
  },
  {
    id: 'rps', name: 'Rock Paper Scissors', cat: 'Other', icon: '✊',
    desc: 'One side plays its own history back at it, which is invisible to any score the two of them share.',
    boot: (e, s) => e.rp_new(s),
    step: (e, h) => e.rp_round(h),
    done: (e, h) => e.rp_w1(h) + e.rp_w2(h) + e.rp_ties(h) >= 20,
    status: (e, h) => `P1 ${e.rp_w1(h)} · P2 ${e.rp_w2(h)} · ties ${e.rp_ties(h)}`,
    view: (e, h) => rows([
      ['P1 threw', seq(3).map(i => cell(['✊', '✋', '✌'][i] + ' ' + e.rp_c1(h, i), 'chip'))],
      ['P2 threw', seq(3).map(i => cell(['✊', '✋', '✌'][i] + ' ' + e.rp_c2(h, i), 'chip'))],
    ]),
    steps: 20,
  },
];

// Checkers names its legal moves by index, so both of these are searches
// over that list rather than geometry the page could work out for itself.
function ckMove(e, h, from, to) {
  for (let m = 0; m < e.ck_moves(h); m++) {
    if (e.ck_move_from(h, m) === from && e.ck_move_to(h, m) === to) return m;
  }
  return -1;
}
function ckFrom(e, h, from) {
  for (let m = 0; m < e.ck_moves(h); m++) if (e.ck_move_from(h, m) === from) return true;
  return false;
}

function sq(v) { return v < 0 ? 'home' : v === 0 ? 'off' : v; }
function point(v) {
  const n = Math.abs(v);
  return cell(n || '', 'pt ' + (v > 0 ? 'p1' : v < 0 ? 'p2' : 'empty'));
}
function pegs(e, code) { return seq(4).map(i => e.mm_digit(code, i)).join(''); }

export const CHESS = {
  id: 'chess', name: 'Chess', cat: 'Board', icon: '♟',
  desc: 'Full rules with castling, en passant and promotion. Not built yet, and the row stays honest until it is.',
};

// The module writes nothing and reads nothing. If it asks, that is a defect
// in the module, not a thing to satisfy quietly.
export const IMPORTS = {
  wasi_snapshot_preview1: {
    fd_write: () => { throw new Error('fd_write: a game module must not write'); },
    fd_read: () => { throw new Error('fd_read: a game module must not read'); },
  },
};

// THE DEFAULT IS THAT YOU ARE PLAYING, and you are player one. A game the
// visitor can take a turn in opens in 'play' mode with the human on move;
// 'watch' is the deliberate second choice. Games with no human move (War
// has no choices; Life has no players) are watch-only and say so.
//
// `human` and `turn` are in each GAME'S OWN convention, because those are
// the numbers its accessors answer -- Royal Ur counts players from one,
// Mancala from zero, and normalising them here is how the two get confused.
// --- rendering -----------------------------------------------------------
// This lives in the module, not in the page, so that ar-verify.mjs runs the
// SAME code the browser runs. Rendering kept in an inline <script> can only
// ever be syntax-checked, and a board that comes out blank is exactly the
// kind of defect a syntax check cannot see.
export const esc = s => String(s).replace(/[&<>"]/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// A card is DRAWN, never a picture. Painted court cards look like an
// illustration of a game rather than a game, they cannot be read at a
// glance in a ten-column tableau, and they carry a megabyte of art that a
// rank and a pip say better. Every card here is the same shape: index in
// the corner, suit through the middle.
function cardHtml(c, attr) {
  const cls = c.cls || '';
  if (cls.includes('back') || cls.includes('facedown')) return `<span class="${cls}"${attr}></span>`;
  const m = /^(10|[2-9AJQK])(.)$/.exec(c.text || '');
  if (!m) return `<span class="${cls}"${attr}>${esc(c.text)}</span>`;
  return `<span class="${cls}"${attr}><i>${esc(m[1])}</i>` +
    `<span class="suit">${esc(m[2])}</span></span>`;
}

const gcell = (c, i) =>
  `<div class="g ${c.cls}" data-i="${c.i === undefined ? i : c.i}">${esc(c.text)}</div>`;

function gridHtml(cols, cells, clickable, board) {
  const px = Math.max(15, Math.min(48, Math.floor(560 / cols)));
  return `<div class="grid n${cols}${board ? ' board-' + board : ''}` +
    `${clickable ? ' clickable' : ''}" ` +
    `style="grid-template-columns:repeat(${cols},${px}px)">` +
    cells.map(gcell).join('') + '</div>';
}

// A die face as real pips rather than a numeral.
const PIPS = [[], [4], [0, 8], [0, 4, 8], [0, 2, 6, 8], [0, 2, 4, 6, 8], [0, 2, 3, 5, 6, 8]];
function pips(n) {
  const on = PIPS[n] || [];
  let h = '';
  for (let i = 0; i < 9; i++) h += `<i${on.includes(i) ? ' class="on"' : ''}></i>`;
  return h;
}

// Stones drawn in the cup rather than a bare number. Past a handful they
// stop being countable by eye anyway, so the number carries it from there.
function stones(n) {
  let h = '<span class="mstones">';
  for (let i = 0; i < Math.min(n, 8); i++) h += '<i></i>';
  return h + '</span>';
}

function bgPoint(p, down, alt, style) {
  const v = p.n, n = Math.abs(v), who = v > 0 ? 'w' : 'b';
  let h = `<div class="pt${down ? ' dn' : ''}${alt ? ' alt' : ''}` +
    `${p.hint ? ' hint' : ''}${p.picked ? ' picked' : ''}" ` +
    `data-i="${p.i}" style="${style || ''}">`;
  for (let i = 0; i < Math.min(5, n); i++) h += `<div class="chk ${who}"></div>`;
  if (n > 5) h += `<div class="chk more">${n}</div>`;
  return h + '</div>';
}

export function renderHtml(v, clickable) {
  if (!v) return '';

  if (v.kind === 'grid') return gridHtml(v.cols, v.cells, clickable, v.board);

  if (v.kind === 'mancala') {
    const pit = (p, side) =>
      `<div class="mpit ${side}${p.legal ? ' hint' : ''}"` +
      (p.i === undefined ? '' : ` data-i="${p.i}"`) + `>` +
      `<span class="mcount">${p.n}</span>${stones(p.n)}</div>`;
    return '<div class="mboard">' +
      `<div class="mstore north"><span>N</span><b>${v.stores.north}</b></div>` +
      '<div class="mrows">' +
      '<div class="mrow">' + v.north.map(p => pit(p, 'north')).join('') + '</div>' +
      '<div class="mrow">' + v.south.map(p => pit(p, 'south')).join('') + '</div>' +
      '</div>' +
      `<div class="mstore south"><span>you</span><b>${v.stores.south}</b></div>` +
      '</div>';
  }

  if (v.kind === 'hex') {
    let h = `<div class="hex${clickable ? ' clickable' : ''}">`;
    for (let r = 0; r * v.cols < v.cells.length; r++) {
      h += `<div class="hexrow" style="margin-left:${r * 14}px">`;
      for (let c = 0; c < v.cols; c++) {
        const i = r * v.cols + c;
        if (i < v.cells.length) h += gcell(v.cells[i], i);
      }
      h += '</div>';
    }
    return h + '</div>';
  }

  if (v.kind === 'rows') {
    return `<div class="rows${clickable ? ' clickable' : ''}">` + v.rows.map(row => {
      const cells = row[1];
      return `<div class="rowline"><span class="rowlab">${esc(row[0])}</span>` +
        cells.map(c => {
          const attr = c.i === undefined ? '' : ` data-i="${c.i}"`;
          return (c.cls || '').includes('card') ? cardHtml(c, attr)
            : `<span class="${c.cls}"${attr}>${esc(c.text)}</span>`;
        }).join('') + '</div>';
    }).join('') + '</div>';
  }

  if (v.kind === 'columns') {
    const body = `<div class="cols${clickable ? ' clickable' : ''}${v.won ? ' won' : ''}">` +
      v.cols.map((col, ci) =>
        `<div class="col" data-i="${ci}">` +
        col.map(c => cardHtml(c, ` data-i="${c.i === undefined ? ci : c.i}"`)).join('') +
        '</div>').join('') + '</div>';
    return v.won ? body + '<div class="wonbanner">all eight runs away</div>' : body;
  }

  if (v.kind === 'pair') {
    return '<div class="pair">' + v.grids.map((cells, i) =>
      `<figure><figcaption>${esc(v.labels[i])}</figcaption>` +
      gridHtml(v.cols, cells, false) + '</figure>').join('') + '</div>';
  }

  if (v.kind === 'backgammon') {
    // EVERY cell is placed explicitly. The bar and the off-tray span all
    // three rows, and grid auto-placement does not reserve the columns they
    // will occupy for items that come later in source order -- so the
    // bottom row flowed into the bar's column and the whole board sheared
    // by one point. Naming the column and row of each cell is the fix.
    let h = '<div class="bgb">';
    v.top.forEach((p, i) => {
      h += bgPoint(p, false, i % 2 === 0, `grid-column:${i < 6 ? i + 1 : i + 2};grid-row:1`);
    });
    v.bottom.forEach((p, i) => {
      h += bgPoint(p, true, i % 2 === 1, `grid-column:${i < 6 ? i + 1 : i + 2};grid-row:3`);
    });
    // The bar is two halves, not one column spanning all three rows: White's
    // checkers centred in the top half, Black's in the bottom, so the middle
    // strip is left clear for the dice and the throw rather than being
    // overlapped by them.
    const barHalf = (n, who, row, hint) =>
      `<div class="bgbar${hint ? ' hint' : ''}"${hint ? ` data-i="${BG_BAR}"` : ''} ` +
      `style="grid-column:7;grid-row:${row}">` +
      (n ? `<div class="chk ${who}">${n > 1 ? n : ''}</div>` : '') + '</div>';
    h += barHalf(v.bar[0], 'w', 1, v.barHint) + barHalf(v.bar[1], 'b', 3, false);
    // The tray is two wells, one per side, each centred in its own half of
    // the board rather than three things stacked down one column. The count
    // sits under the checker instead of inside it, where it did not fit.
    const well = (n, who, row, hint) =>
      `<div class="bgoff${hint ? ' hint' : ''}"${hint ? ` data-i="${BG_OFF}"` : ''} ` +
      `style="grid-column:14;grid-row:${row}">` +
      `<span class="chk ${who}"></span><b>${n}</b><span class="lbl">off</span></div>`;
    // White bears off at the bottom, where White's home board is, and the
    // cube waits between the two trays: the middle of the bear-off zone.
    h += well(v.off[1], 'b', 1, false) +
      '<div class="bgcubewell" style="grid-column:14;grid-row:2">' +
      `<span class="bgcube" title="this engine implements no doubling">${v.cube}</span></div>` +
      well(v.off[0], 'w', 3, v.offHint);
    // The dice tray runs across the middle: White throws on the left half,
    // Black on the right, and a die that has been spent goes flat.
    // Each side throws its own dice: White's are white, Black's are black
    // with white pips.
    const die = (n, i) =>
      `<span class="bgdie ${v.thrower}` +
      `${v.spent.filter(x => x === n).length > i ? ' spent' : ''}">${pips(n)}</span>`;
    const tray = v.dice
      ? `<span class="bgdice">${v.dice.map((n, i) => die(n, i)).join('')}</span>` : '';
    // The middle of the board: dice on their thrower's side, and the throw
    // itself offered between them, where a player reaches to roll.
    const rollBtn = v.showRoll
      ? `<button class="bgroll" data-act="${BG_ROLL}">\u{1F3B2} Roll</button>` : '';
    h += '<div class="bgmid" style="grid-column:1 / 14;grid-row:2">' +
      `<span class="bghalf ${v.thrower === 'w' ? 'live' : ''}">${v.thrower === 'w' ? tray : ''}</span>` +
      rollBtn +
      `<span class="bghalf ${v.thrower === 'b' ? 'live' : ''}">${v.thrower === 'b' ? tray : ''}</span>` +
      '</div>';
    return h + '</div>';
  }

  if (v.kind === 'war') {
    const side = (s, which) =>
      `<div class="warside ${which}">` +
      `<div class="warcount">${s.n}</div>` +
      `<div class="wardeck${s.n ? '' : ' empty'}"><span>${s.name}</span></div>` +
      `<div class="warcard${s.wins ? ' takes' : ''}">` +
      (s.card < 0 ? '' : cardHtml(cardCell(s.card, 'flip'), '')) + '</div></div>';
    return '<div class="warboard">' + side(v.left, 'l') +
      `<div class="warmid">${v.war ? 'WAR' : 'vs'}</div>` +
      side(v.right, 'r') + '</div>';
  }

  if (v.kind === 'ur') {
    const sq = (c, row) => {
      if (c.gap) return '<div class="ursq gap"></div>';
      const cls = 'ursq' + (c.rosette ? ' rosette' : '') +
        (c.playable ? ' hint' : '') + ' row' + row;
      const attr = c.i === undefined ? '' : ` data-i="${c.i}"`;
      const piece = c.who ? `<i class="urp p${c.who}"></i>` : '';
      return `<div class="${cls}"${attr}><span class="urstep">${c.step}</span>${piece}</div>`;
    };
    const tray = (label, n, who) =>
      `<div class="urtray"><span>${label}</span><b class="urp p${who}">${n}</b></div>`;
    const t = v.trays;
    return '<div class="urwrap">' +
      '<div class="urside">' + tray('waiting', t.themWaiting, 2) + tray('home', t.themHome, 2) + '</div>' +
      '<div class="urboard">' +
      '<div class="urrow">' + v.top.map(c => sq(c, 2)).join('') + '</div>' +
      '<div class="urrow">' + v.mid.map(c => sq(c, 0)).join('') + '</div>' +
      '<div class="urrow">' + v.bottom.map(c => sq(c, 1)).join('') + '</div>' +
      '</div>' +
      '<div class="urside">' +
      `<div class="urtray${t.enter !== undefined ? ' hint' : ''}"` +
      (t.enter === undefined ? '' : ` data-i="${t.enter}"`) +
      `><span>waiting</span><b class="urp p1">${t.youWaiting}</b></div>` +
      tray('home', t.youHome, 1) + '</div>' +
      '</div>';
  }

  return '';
}

export function driver(game, exports) {
  let handle = null, seed = 1, rng = 1, settled = false, sel = null, roll = null;
  // Undo is nearly free here and it is worth saying why: a move does not
  // mutate the board, it answers a NEW one, so every position the game has
  // been in is still sitting in the module's heap, still valid, still
  // reachable by its handle. Undo is a stack of those. The one thing that
  // invalidates them is a heap reset, which only happens at a new game --
  // and a new game clears the stack anyway.
  let past = [];
  const remember = () => {
    past.push({ handle, settled, roll });
    if (past.length > 400) past.shift();
  };
  // Per-game choices the page offers, such as Spider's suit count.
  let opts = {};
  // The hint currently being shown, if the player asked for one.
  let shown = null;

  // THE LOW BITS HAVE TO BE GOOD HERE, and a plain LCG's are not.
  //
  // Rng.codex says it plainly: `rng-new` does not advance, it just stores
  // the seed, so `bg-wasm-die (seed) = rng-range (rng-new seed) 1 6` is
  // exactly `1 + (seed mod 6)`. The value handed in IS the die. And a
  // linear congruential generator carries entropy upward only -- its low
  // bit strictly alternates, which the chapter itself calls "the comb
  // 0101" -- so `mod 6`, which reads the bottom bits, cycled with a tiny
  // period. Backgammon threw doubles constantly and rolled the same number
  // four turns running.
  //
  // xorshift32 with a strong output finalizer instead, and shifted to stay
  // inside a positive i32 because these go across the wasm boundary as
  // signed integers, where a negative seed would make `rng-mod` answer a
  // negative die and the move would be silently refused.
  const rand = () => {
    rng ^= rng << 13; rng >>>= 0;
    rng ^= rng >>> 17;
    rng ^= rng << 5; rng >>>= 0;
    let x = rng;
    x ^= x >>> 16; x = Math.imul(x, 0x7feb352d) >>> 0;
    x ^= x >>> 15; x = Math.imul(x, 0x846ca68b) >>> 0;
    x ^= x >>> 16;
    return (x >>> 1);
  };
  const isDone = () => handle !== null && game.done(exports, handle, settled);

  const self = {
    game,
    mode: game.solo || game.click || game.move ? 'play' : 'watch',
    get handle() { return handle; },
    get exports() { return exports; },
    // The generator itself, so a grader can measure what the dice actually
    // do rather than take the driver's word for it.
    randForTest: rand,
    get settled() { return settled; },
    playable: !!(game.solo || game.click || game.move || game.keys),

    reset(s) {
      seed = s === undefined ? (Date.now() % 90000) + 1 : s;
      // xorshift32 is dead at zero, so it never starts there.
      rng = (seed >>> 0) || 0x9e3779b9;
      settled = false;
      sel = null;
      roll = null;
      past = [];
      shown = null;
      // A flat game may reset the heap freely; a handle game must NOT,
      // because the handle IS the address the reset would reclaim. Either
      // way a new game is the one safe moment to do it.
      if (exports.__heap_reset) exports.__heap_reset();
      handle = game.boot(exports, seed, opts);
      return handle;
    },

    // --- what the page may choose ---------------------------------------
    get opts() { return opts; },
    option(name, value) {
      opts = Object.assign({}, opts, { [name]: value });
      return opts;
    },

    // --- taking it back --------------------------------------------------
    canUndo() { return past.length > 0; },
    undo() {
      const prev = past.pop();
      if (!prev) return false;
      handle = prev.handle;
      settled = prev.settled;
      roll = prev.roll;
      sel = null;
      return true;
    },

    // Whose move it is, in the game's own numbering. null for solo games.
    turn() { return handle === null || !game.turn ? null : game.turn(exports, handle); },
    yourTurn() {
      if (handle === null || isDone()) return false;
      if (game.solo) return true;
      if (self.mode !== 'play' || !game.move) return false;
      return game.turn ? game.turn(exports, handle) === game.human : true;
    },

    step() {
      if (handle === null || isDone() || !game.step) return false;
      // A game whose turn opens with dice gets them BEFORE the step, so a
      // watcher sees the roll that the move follows from rather than only
      // the position it left behind. Never on YOUR turn in a game you throw
      // for yourself, though, or a stray step rolls and moves for you.
      if (game.beginTurn && roll === null &&
        !(game.manualRoll && self.mode === 'play' && self.yourTurn())) {
        roll = game.beginTurn(exports, handle, rand);
      }
      const out = game.step(exports, handle, rand, roll);
      if (out === null || out === undefined) return false;
      // A step may answer a bare handle, or a handle and what is left of
      // the turn: backgammon spends its dice one at a time.
      if (typeof out === 'object') {
        if (out.handle === null || out.handle === undefined) return false;
        handle = out.handle;
        if ('roll' in out) roll = out.roll;
      } else {
        handle = out;
      }
      return true;
    },

    // The human moves and the opponent answers. Without this a game "lets
    // you play" only in the sense that it accepts your move and then sits
    // there, which is what the arcade did before.
    //
    // A move is not always one click. Checkers and Spider need a source and
    // a destination, and Royal Ur needs the turn's roll before a piece means
    // anything, so `move` answers one of three things: {handle} for a move
    // that was made, {sel} to hold a selection and wait for the second
    // click, or null for a click the rules refuse.
    move(i) {
      if (!self.yourTurn() || !game.move) return false;
      const out = game.move(exports, handle, i, { sel, roll, rand });
      if (!out) return false;
      // A selection is not a move, and saying so is the difference between
      // a caller that can count moves and one that counts clicks. Picking a
      // piece up, and putting it back down, both answer 'select'.
      if (out.sel !== undefined) { sel = out.sel; return 'select'; }
      if (out.handle === null || out.handle === undefined) return false;
      remember();
      handle = out.handle;
      sel = null;
      // A hint is about the position it was asked in, so it does not
      // survive the move that answers it.
      shown = null;
      // A move may spend only PART of the turn. Royal Ur's roll is used up
      // by the move that follows it, but backgammon hands back what is left
      // of the dice, and clearing that unconditionally threw away three
      // quarters of a double and never ended the turn -- so one side played
      // the whole game while the other never got a move.
      roll = ('roll' in out) ? out.roll : null;
      if (out.settled) settled = true;
      return 'moved';
    },
    get sel() { return sel; },
    get roll() { return roll; },
    clearSel() { sel = null; },
    // Games whose turn opens with a die give the page the number first;
    // until it exists, no piece on the board means anything.
    beginTurn() {
      if (!game.beginTurn || roll !== null || isDone()) return roll;
      // A game that wants you to throw for yourself is not rolled for.
      if (game.manualRoll && self.mode === 'play' && self.yourTurn()) return null;
      roll = game.beginTurn(exports, handle, rand);
      return roll;
    },
    endTurn() { roll = null; sel = null; },
    // Let the opponent take its turns until the board is yours again. It is
    // bounded: an engine that never yields the turn would otherwise hang the
    // page, and that is a defect to see, not to spin on.
    reply(limit = 40) {
      if (self.mode !== 'play' || game.solo) return 0;
      let n = 0;
      while (n < limit && !isDone() && !self.yourTurn()) {
        if (!self.step()) break;
        n++;
      }
      return n;
    },

    act(index) {
      const a = game.actions && game.actions[index];
      if (!a || handle === null || isDone()) return false;
      const out = a.run(exports, handle, rand, roll);
      if (!out || out.handle === null || out.handle === undefined) return false;
      remember();
      handle = out.handle;
      // An action may also be what starts or ends a turn: rolling the dice
      // changes nothing on the board and everything about what you can do.
      if ('roll' in out) roll = out.roll;
      if (out.settled) settled = true;
      return true;
    },
    actions() {
      if (!game.actions || handle === null) return [];
      return game.actions.map((a, i) => ({
        label: a.label, index: i, inBoard: !!a.inBoard,
        enabled: !isDone() && (!a.enabled || a.enabled(exports, handle, roll)),
      }));
    },

    key(code) {
      if (handle === null || !game.key || !game.keys || isDone()) return false;
      const d = game.keys[code];
      if (d === undefined) return false;
      const next = game.key(exports, handle, d);
      if (next === null || next === undefined) return false;
      remember();
      handle = next;
      return true;
    },

    done() { return isDone(); },
    status() { return handle === null ? '' : game.status(exports, handle, settled, sel, roll, seed); },
    view() { return handle === null ? null : game.view(exports, handle, settled, sel, roll, seed, shown); },

    // A hint the page has asked to SEE. Held here rather than passed
    // through the view's positional arguments, where it landed in the slot
    // meant for the roll and quietly read as one.
    get hint() { return shown; },
    showHint() {
      shown = game.hint ? game.hint(exports, handle) : null;
      return shown;
    },
    clearHint() { shown = null; },
    runs() { return game.runs ? game.runs(exports, seed) : null; },
    seed: () => seed,
  };
  return self;
}
