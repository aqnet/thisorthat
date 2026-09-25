import 'server-only';
import {
  ALLOWED_LENGTHS_BY_SIZE_CLASS,
  DISCONNECT_AFTER_MS,
  REQUIRED_DICTIONARY_SIZE,
  SHOWDOWN_ROUNDS,
  beatTheComputer,
  computerWon,
  leaderAfterEachRound,
  ownCardId,
  scoreMatchup,
  standings,
  topHuman,
  type ListLength,
  type Player,
  type SessionState,
  type SizeClass,
} from '@/lib/engine';
import type { CategoryRow } from './repo';
import type {
  CategoryOption,
  FunStat,
  RoomSnapshot,
  SnapshotCard,
  SnapshotGame,
  StandingRow,
} from '@/lib/game/snapshot';

/** The seat this auth identity holds in the room, if any. */
export function viewerSeat(state: SessionState, userId: string): Player | null {
  const mine = state.players.filter((p) => p.userId === userId);
  return mine.find((p) => p.leftAt === null) ?? mine[mine.length - 1] ?? null;
}

const SIZE_ORDER: SizeClass[] = ['small', 'medium', 'large'];

/**
 * §7: a category whose dictionary falls short of its size requirement is
 * capped at the next size down until it has grown. A category below even the
 * small requirement can't be offered at all.
 */
export function categoryOption(category: CategoryRow): CategoryOption | null {
  const declared = SIZE_ORDER.indexOf(category.sizeClass);
  for (let i = declared; i >= 0; i--) {
    const size = SIZE_ORDER[i];
    if (category.dictionarySize >= REQUIRED_DICTIONARY_SIZE[size]) {
      return { id: category.id, name: category.name, allowedLengths: [...ALLOWED_LENGTHS_BY_SIZE_CLASS[size]] };
    }
  }
  return null;
}

export function buildSnapshot(
  state: SessionState,
  userId: string,
  categories: CategoryRow[],
  now: number,
): RoomSnapshot {
  const seat = viewerSeat(state, userId);
  const isHost = seat !== null && state.hostPlayerId === seat.id;

  return {
    version: state.version,
    serverNow: now,
    roomCode: state.roomCode,
    status: state.status,
    phaseDeadline: state.phaseDeadline,
    pausedFrom: state.pausedFrom,
    hostPlayerId: state.hostPlayerId,
    relaxedTimers: state.relaxedTimers,
    me: seat
      ? { playerId: seat.id, isHost, queued: seat.queued, left: seat.leftAt !== null }
      : null,
    players: state.players.map((p) => ({
      id: p.id,
      name: p.name,
      colorSlot: p.colorSlot,
      isComputer: p.isComputer,
      isHost: state.hostPlayerId === p.id,
      queued: p.queued,
      left: p.leftAt !== null,
      connected: p.isComputer || (p.leftAt === null && now - p.lastSeenAt < DISCONNECT_AFTER_MS),
    })),
    categories:
      isHost && state.status === 'setup'
        ? categories.map(categoryOption).filter((c): c is CategoryOption => c !== null)
        : [],
    game: buildGame(state, seat, categories),
  };
}

function buildGame(state: SessionState, seat: Player | null, categories: CategoryRow[]): SnapshotGame | null {
  const game = state.game;
  if (!game) return null;

  const matchup = game.matchups.find((m) => m.roundNumber === game.currentRound) ?? null;
  const revealed = matchup?.status === 'revealed';
  const favoritesById = new Map(game.favorites.map((f) => [f.id, f]));
  const outcome = matchup && revealed ? scoreMatchup(matchup, game.favorites) : null;
  const topVotes = outcome ? Math.max(0, ...Object.values(outcome.votesByCard)) : 0;
  const myCard = matchup && seat ? ownCardId(matchup, seat.id, game.favorites) : null;

  const cards: SnapshotCard[] =
    matchup?.cards.map((card) => {
      const owners = card.ownerFavoriteIds.map((id) => favoritesById.get(id)).filter((f) => f !== undefined);
      const votes = outcome?.votesByCard[card.id] ?? 0;
      return {
        id: card.id,
        displayText: card.displayText,
        mine: card.id === myCard,
        ownerIds: revealed ? [...new Set(owners.map((f) => f.playerId))] : null,
        votes: revealed ? votes : null,
        winner: revealed && topVotes > 0 && votes === topVotes,
        auto: revealed && owners.some((f) => f.autoPicked),
      };
    }) ?? [];

  const playersById = new Map(state.players.map((p) => [p.id, p]));
  const rows: StandingRow[] = standings(state).map((row) => ({
    playerId: row.playerId,
    name: row.name,
    isComputer: row.isComputer,
    colorSlot: playersById.get(row.playerId)?.colorSlot ?? null,
    score: row.score,
    roundWins: row.roundWins,
    pct: row.pct,
    rank: row.rank,
    left: playersById.get(row.playerId)?.leftAt != null,
  }));

  let leadChange: string | null = null;
  if (state.status === 'matchup_reveal') {
    const leaders = leaderAfterEachRound(state);
    const latest = leaders[leaders.length - 1] ?? null;
    const previous = leaders.length >= 2 ? leaders[leaders.length - 2] : null;
    if (latest && latest !== previous) leadChange = latest;
  }

  const listLength = game.listLength;
  const categoryName = categories.find((c) => c.id === game.categoryId)?.name ?? null;

  return {
    number: game.number,
    categoryName,
    listLength,
    round: game.currentRound,
    totalRounds: listLength ?? 0,
    multiplier: matchup?.multiplier ?? 1,
    showdownRounds: listLength ? [...SHOWDOWN_ROUNDS[listLength as ListLength]] : [],
    endedEarly: game.endedEarly,
    myList: seat
      ? game.favorites
          .filter((f) => f.playerId === seat.id)
          .sort((a, b) => a.entryPosition - b.entryPosition)
          .map((f) => ({ id: f.id, displayText: f.displayText, surprise: f.surprisePicked, auto: f.autoPicked }))
      : [],
    mySubmitted: seat ? Boolean(game.submitted[seat.id]) : false,
    entryProgress: state.players
      .filter((p) => !p.isComputer && !p.queued && p.leftAt === null)
      .map((p) => ({
        playerId: p.id,
        count: game.favorites.filter((f) => f.playerId === p.id).length,
        submitted: Boolean(game.submitted[p.id]),
      })),
    cards,
    // Your own vote only. Nobody else's, not even after reveal (§14.5).
    myVote: matchup && seat ? (matchup.votes[seat.id] ?? null) : null,
    votedPlayerIds: matchup ? Object.keys(matchup.votes) : [],
    standings: rows,
    roundPoints: outcome?.points ?? null,
    leadChange,
    results: state.status === 'results' ? buildResults(state, rows) : null,
  };
}

function buildResults(state: SessionState, rows: StandingRow[]) {
  const engineRows = standings(state);
  const top = topHuman(engineRows);
  return {
    computerWon: computerWon(engineRows),
    topHumanId: top?.playerId ?? null,
    beatComputerIds: beatTheComputer(engineRows),
    funStats: funStats(state, rows),
  };
}

/** §10 fun stats: cheap to compute from the match-up record, high replay value. */
function funStats(state: SessionState, rows: StandingRow[]): FunStat[] {
  const game = state.game!;
  const names = new Map(rows.map((r) => [r.playerId, r.name]));
  const computer = state.players.find((p) => p.isComputer);
  const favoritesById = new Map(game.favorites.map((f) => [f.id, f]));
  const stats: FunStat[] = [];

  let crowd: { text: string; votes: number; owners: string[] } | null = null;
  let gem: { text: string; votes: number; owners: string[] } | null = null;
  const computerVotes = new Map<string, number>();
  const agreement = new Map<string, number>();

  for (const matchup of game.matchups.filter((m) => m.status === 'revealed')) {
    const outcome = scoreMatchup(matchup, game.favorites);
    const top = Math.max(0, ...Object.values(outcome.votesByCard));
    for (const card of matchup.cards) {
      const votes = outcome.votesByCard[card.id] ?? 0;
      const owners = card.ownerFavoriteIds.map((id) => favoritesById.get(id)?.playerId ?? '');
      if (!crowd || votes > crowd.votes) crowd = { text: card.displayText, votes, owners };
      if (top > 0 && votes === top && (!gem || votes < gem.votes)) gem = { text: card.displayText, votes, owners };
    }
    const voters = Object.entries(matchup.votes);
    for (const [voter, cardId] of voters) {
      const card = matchup.cards.find((c) => c.id === cardId);
      const owned = card?.ownerFavoriteIds.some((id) => favoritesById.get(id)?.playerId === computer?.id);
      if (owned) computerVotes.set(voter, (computerVotes.get(voter) ?? 0) + 1);
    }
    for (let i = 0; i < voters.length; i++) {
      for (let j = i + 1; j < voters.length; j++) {
        if (voters[i][1] !== voters[j][1]) continue;
        const pair = [voters[i][0], voters[j][0]].sort().join('|');
        agreement.set(pair, (agreement.get(pair) ?? 0) + 1);
      }
    }
  }

  const ownerNames = (ids: string[]) => ids.map((id) => names.get(id) ?? '?').join(' & ');
  if (crowd && crowd.votes > 0) {
    stats.push({ label: 'Crowd Favorite', detail: `${crowd.text} (${ownerNames(crowd.owners)}) · ${crowd.votes} votes` });
  }
  if (gem && gem !== crowd) {
    stats.push({ label: 'Hidden Gem', detail: `${gem.text} (${ownerNames(gem.owners)}) won with ${gem.votes}` });
  }
  const twins = [...agreement.entries()].sort((a, b) => b[1] - a[1])[0];
  if (twins && twins[1] > 1) {
    stats.push({ label: 'Taste Twins', detail: `${ownerNames(twins[0].split('|'))} agreed ${twins[1]} times` });
  }
  const fooled = [...computerVotes.entries()].sort((a, b) => b[1] - a[1])[0];
  if (fooled) {
    stats.push({
      label: 'Fooled by the Computer',
      detail: `${names.get(fooled[0]) ?? '?'} backed its picks ${fooled[1]} time${fooled[1] === 1 ? '' : 's'}`,
    });
  }
  return stats;
}
