import 'server-only';
import {
  ALLOWED_LENGTHS_BY_SIZE_CLASS,
  DISCONNECT_AFTER_MS,
  LIST_LENGTHS,
  REQUIRED_DICTIONARY_SIZE,
  SHOWDOWN_ROUNDS,
  everyBallotHadThree,
  roundCount,
  beatTheComputer,
  computerWon,
  leaderAfterEachRound,
  computerPlays,
  crownHistory,
  isChampionCard,
  ownCardIds,
  publicChampionFavoriteIds,
  type Champion,
  type RoundCrown,
  scoreMatchup,
  standings,
  topHuman,
  type GameMode,
  type ListLength,
  type Player,
  type SessionState,
  type SizeClass,
} from '@/lib/engine';
import type { CategoryRow, CategoryUsage } from './repo';
import type {
  CategoryOption,
  CrownCallout,
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
 * §7, as changed by custom-category spec v0.5: every category offers 5, 10 and
 * 15. Its size class -- capped at the next size down while the dictionary is
 * short -- only sets `suggestedMax`, past which Setup warns that players may
 * run out of ideas. A built-in below even the small requirement can't be
 * offered at all.
 */
export function categoryOption(category: CategoryRow): CategoryOption | null {
  const option = (sized: readonly ListLength[]): CategoryOption => ({
    id: category.id,
    name: category.name,
    allowedLengths: [...LIST_LENGTHS],
    suggestedMax: Math.max(...sized) as ListLength,
    audience: category.audience,
    isCustom: category.isCustom,
    itemCount: category.dictionarySize,
    borrowSuggestionId: category.borrowSuggestionId ?? null,
  });
  // A custom category played without a build was never sized: learned items
  // (§5.4) shouldn't shrink what the host could pick before.
  if (category.isCustom && !category.generated) return option(LIST_LENGTHS);
  const declared = SIZE_ORDER.indexOf(category.sizeClass);
  for (let i = declared; i >= 0; i--) {
    const size = SIZE_ORDER[i];
    if (category.dictionarySize >= REQUIRED_DICTIONARY_SIZE[size]) {
      return option(ALLOWED_LENGTHS_BY_SIZE_CLASS[size]);
    }
  }
  // Custom-category spec §3.4: a custom category is never refused for being
  // thin. With some items it's capped at 5; with none, the game can't judge
  // its size, so the host picks any length.
  if (category.isCustom) return option(category.dictionarySize > 0 ? [5] : LIST_LENGTHS);
  return null;
}


/** Custom-category spec §3.5: the singular/plural a prompt uses, guessed when unset. */
export function labelsFor(category: Pick<CategoryRow, 'name' | 'singularLabel' | 'pluralLabel'>) {
  const lower = category.name.toLocaleLowerCase('en-US');
  return {
    singular: category.singularLabel ?? lower,
    plural: category.pluralLabel ?? (lower.endsWith('s') ? lower : `${lower}s`),
  };
}

/** How many built-in categories the setup screen shows as chips. */
export const TOP_CATEGORY_COUNT = 5;

/**
 * The most-played built-in categories for a mode, for the chips in setup.
 * Ties fall back to plays in either mode, then the default order, so a fresh
 * database still shows 5 sensible chips.
 */
export function topCategoryIds(categories: readonly CategoryRow[], usage: CategoryUsage, mode: GameMode): number[] {
  const plays = (id: number) => usage.get(id) ?? { pick_your_fav: 0, pick_and_fwd: 0 };
  return categories
    .filter((c) => !c.isCustom && categoryOption(c) !== null)
    .map((c, index) => ({ id: c.id, index, mode: plays(c.id)[mode], total: plays(c.id).pick_your_fav + plays(c.id).pick_and_fwd }))
    .sort((a, b) => b.mode - a.mode || b.total - a.total || a.index - b.index)
    .slice(0, TOP_CATEGORY_COUNT)
    .map((c) => c.id);
}

export function buildSnapshot(
  state: SessionState,
  userId: string,
  categories: CategoryRow[],
  now: number,
  /** The game's numeric seed: Pick and fwd's coin flips replay from it. */
  seed = 1,
  usage: CategoryUsage = new Map(),
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
    computerPlayer: state.computerPlayer,
    championReignCap: state.championReignCap,
    computerPlays: computerPlays(state),
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
    topCategoryIds:
      isHost && state.status === 'setup' && state.game
        ? topCategoryIds(categories, usage, state.game.mode)
        : [],
    game: buildGame(state, seat, categories, seed),
  };
}

function buildGame(
  state: SessionState,
  seat: Player | null,
  categories: CategoryRow[],
  seed: number,
): SnapshotGame | null {
  const game = state.game;
  if (!game) return null;

  const matchup = game.matchups.find((m) => m.roundNumber === game.currentRound) ?? null;
  const revealed = matchup?.status === 'revealed';
  const favoritesById = new Map(game.favorites.map((f) => [f.id, f]));
  const outcome = matchup && revealed ? scoreMatchup(matchup, game.favorites) : null;
  const topVotes = outcome ? Math.max(0, ...Object.values(outcome.votesByCard)) : 0;
  // A player can own two cards in Pick and fwd (the champion and a fresh one).
  const myCards = new Set(matchup && seat ? ownCardIds(matchup, seat.id, game.favorites) : []);

  const cards: SnapshotCard[] =
    matchup?.cards.map((card) => {
      const owners = card.ownerFavoriteIds.map((id) => favoritesById.get(id)).filter((f) => f !== undefined);
      const votes = outcome?.votesByCard[card.id] ?? 0;
      return {
        id: card.id,
        displayText: card.displayText,
        mine: myCards.has(card.id),
        ownerIds: revealed ? [...new Set(owners.map((f) => f.playerId))] : null,
        votes: revealed ? votes : null,
        winner: revealed && topVotes > 0 && votes === topVotes,
        auto: revealed && owners.some((f) => f.autoPicked),
        champion: isChampionCard(card)
          ? {
              reign: card.championReign!,
              ownerIds: [
                ...new Set(
                  (revealed ? card.ownerFavoriteIds : publicChampionFavoriteIds(card, matchup!.roundNumber, game.favorites))
                    .map((id) => favoritesById.get(id)?.playerId)
                    .filter((id): id is string => Boolean(id)),
                ),
              ],
            }
          : null,
      };
    }) ?? [];

  const crowns = crownHistory(game, seed);

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
  const category = categories.find((c) => c.id === game.categoryId) ?? null;
  const categoryName = category?.name ?? null;
  const labels = category ? labelsFor(category) : null;
  // §4.5: a short custom category can top up from a built-in.
  const borrowed = categories.find((c) => c.id === game.borrowCategoryId) ?? null;
  const suggestionPool = (category?.dictionarySize ?? 0) + (borrowed?.dictionarySize ?? 0);
  const rounds = roundCount(game);

  return {
    number: game.number,
    mode: game.mode,
    withComputer: game.withComputer,
    categoryName,
    listLength,
    round: game.currentRound,
    singularLabel: labels?.singular ?? null,
    pluralLabel: labels?.plural ?? null,
    isCustom: category?.isCustom ?? false,
    spellCheck: game.spellCheck,
    // Surprise me is hidden when there's nothing relevant to suggest (§6).
    hasDictionary: suggestionPool > 0,
    borrowedFrom: borrowed?.name ?? null,
    // §4.2: the timer can't fill a list the dictionary is smaller than.
    thin: Boolean(category && listLength && suggestionPool < listLength),
    buildingCategory: game.buildingCategory,
    totalRounds: rounds,
    multiplier: matchup?.multiplier ?? 1,
    // The double-points rounds as actually built: thin games can drop rounds (§4.1).
    showdownRounds:
      game.matchups.length > 0
        ? game.matchups.filter((m) => m.multiplier > 1).map((m) => m.roundNumber)
        : listLength
          ? [...SHOWDOWN_ROUNDS[listLength as ListLength]]
          : [],
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
    crown: state.status === 'matchup_reveal' ? crownCallout(crowns.find((c) => c.roundNumber === game.currentRound)) : null,
    results: state.status === 'results' ? buildResults(state, rows, crowns) : null,
  };
}

/** Mode spec §4.4: the crown callout for the round just revealed. */
function crownCallout(crown: RoundCrown | undefined): CrownCallout | null {
  if (!crown?.holder || crown.outcome === 'no_votes') return null;
  const { holder, previous } = crown;
  if (crown.retired) return { kind: 'retired', text: holder.displayText, reign: holder.reign, dethroned: null };
  if (crown.outcome === 'defended') return { kind: 'defended', text: holder.displayText, reign: holder.reign, dethroned: null };
  return {
    kind: crown.outcome === 'coin_flip' ? 'coin_flip' : 'new',
    text: holder.displayText,
    reign: holder.reign,
    dethroned: previous?.displayText ?? null,
  };
}

function buildResults(state: SessionState, rows: StandingRow[], crowns: RoundCrown[]) {
  const engineRows = standings(state);
  const top = topHuman(engineRows);
  // Without the Computer there's nobody to beat and no "Top Human" to name.
  const withComputer = state.game!.withComputer;
  return {
    computerWon: withComputer && computerWon(engineRows),
    topHumanId: withComputer ? (top?.playerId ?? null) : null,
    beatComputerIds: withComputer ? beatTheComputer(engineRows) : [],
    funStats: [...funStats(state, rows), ...crownStats(state, rows, crowns)],
    // Custom-category spec §4.4: why a finished game won't reach the boards.
    unrankedTwoCards: !state.game!.endedEarly && !everyBallotHadThree(state.game!),
  };
}

/** Mode spec §6: Longest Reign and Giant Slayer, Pick and fwd only. */
function crownStats(state: SessionState, rows: StandingRow[], crowns: RoundCrown[]): FunStat[] {
  const names = new Map(rows.map((r) => [r.playerId, r.name]));
  const byId = new Map(state.game!.favorites.map((f) => [f.id, f]));
  const ownerNames = (favoriteIds: string[]) =>
    [...new Set(favoriteIds.map((id) => byId.get(id)?.playerId).filter((id): id is string => !!id))]
      .map((id) => names.get(id) ?? '?')
      .join(' & ');

  // The highest reign any champion reached (the first to reach it, on a tie).
  let longest: { champion: Champion } | null = null;
  for (const crown of crowns) {
    if (!crown.holder) continue;
    if (!longest || crown.holder.reign > longest.champion.reign) longest = { champion: crown.holder };
  }
  if (!longest || longest.champion.reign < 2) return [];
  const stats: FunStat[] = [
    {
      label: 'Longest Reign',
      detail: `${longest.champion.displayText} (${ownerNames(longest.champion.favoriteIds)}) · ${longest.champion.reign} rounds`,
    },
  ];
  // Giant Slayer: the fresh card that took the crown from that champion.
  const slain = crowns.find(
    (c) =>
      (c.outcome === 'new' || c.outcome === 'coin_flip') &&
      c.previous?.displayText === longest!.champion.displayText &&
      c.previous.reign === longest!.champion.reign,
  );
  if (slain?.holder) {
    stats.push({
      label: 'Giant Slayer',
      detail: `${slain.holder.displayText} (${ownerNames(slain.holder.favoriteIds)}) ended ${longest.champion.displayText}'s reign`,
    });
  }
  return stats;
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
