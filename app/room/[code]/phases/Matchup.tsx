'use client';

import { castVote, nextRound } from '@/app/actions';
import { PlayerDot, Scoreboard, styles } from '@/components/game/ui';
import { MODE_INFO } from '@/lib/game/modes';
import type { CrownCallout, RoomSnapshot, SnapshotCard } from '@/lib/game/snapshot';
import type { PhaseProps } from '../RoomClient';

function Header({ snap }: { snap: RoomSnapshot }) {
  const game = snap.game!;
  return (
    <p className={styles.eyebrow}>
      Round {game.round} of {game.totalRounds} · {game.categoryName}
      {game.mode === 'pick_and_fwd' ? ` · ${MODE_INFO.pick_and_fwd.name}` : ''}
    </p>
  );
}

/** §9.6: the showdown intro, plus the gap to the leader before the first one. */
function Showdown({ snap }: { snap: RoomSnapshot }) {
  const game = snap.game!;
  if (game.multiplier !== 2) return null;
  const first = game.round === game.showdownRounds[0];
  const leader = game.standings[0];
  const trailing = first
    ? game.standings.filter((r) => !r.isComputer && !r.left && leader && r.playerId !== leader.playerId && r.score < leader.score)
    : [];
  return (
    <div className={styles.showdown}>
      <p className={styles.title} style={{ fontSize: 34 }}>
        Final Showdown · ×2
      </p>
      {trailing.map((r) => (
        <p key={r.playerId} className={styles.cardMeta} style={{ margin: '6px 0 0' }}>
          {r.name} is {leader.score - r.score} behind — still in it
        </p>
      ))}
    </div>
  );
}

/**
 * Pick and fwd (mode spec §4.3): the champion's crown, reign and original
 * owner, shown openly -- that owner was revealed when it won.
 */
function ChampionTag({ card, snap }: { card: SnapshotCard; snap: RoomSnapshot }) {
  if (!card.champion) return null;
  const owners = card.champion.ownerIds
    .map((id) => snap.players.find((p) => p.id === id))
    .filter((p) => p !== undefined);
  return (
    <span className={styles.cardMeta}>
      👑 Champion{card.champion.reign > 1 ? ` ×${card.champion.reign}` : ''}
      {owners.length > 0 && ` · ${owners.map((p) => (p.isComputer ? 'Computer' : p.name)).join(' & ')}`}
    </span>
  );
}

/** Mode spec §4.4: what happened to the crown. */
function crownText(crown: CrownCallout): string {
  switch (crown.kind) {
    case 'defended':
      return `${crown.text} defends the crown! 👑 ×${crown.reign}`;
    case 'retired':
      return `${crown.text} retires undefeated.`;
    case 'coin_flip':
      return crown.dethroned
        ? `${crown.text} wins the coin flip and takes the crown from ${crown.dethroned}!`
        : `${crown.text} wins the coin flip.`;
    case 'new':
      return crown.dethroned ? `${crown.text} takes the crown from ${crown.dethroned}!` : `${crown.text} takes the crown! 👑`;
  }
}

/**
 * §9.3-§9.4: ALL CAPS cards with owners hidden. Your own card is shown but
 * disabled, and a vote locks on tap.
 */
export function Voting({ snap, room, roomCode }: PhaseProps) {
  const game = snap.game!;
  const me = snap.me!;
  const voted = game.myVote !== null;
  const waitingOn = snap.players.filter(
    (p) => !p.isComputer && !p.queued && !p.left && p.connected && !game.votedPlayerIds.includes(p.id),
  );

  return (
    <>
      <Header snap={snap} />
      <Showdown snap={snap} />
      <h1 className={styles.title}>{voted ? 'Vote locked ✓' : 'This or that?'}</h1>

      <div className={styles.ballot}>
        {game.cards.map((card) => (
          <button
            key={card.id}
            type="button"
            className={[
              styles.card,
              card.mine ? styles.cardMine : '',
              game.myVote === card.id ? styles.cardPicked : '',
              voted && game.myVote !== card.id ? styles.cardDimmed : '',
              card.champion ? styles.cardChampion : '',
            ].join(' ')}
            disabled={card.mine || voted || room.pending}
            onClick={() => room.act((t) => castVote(t, roomCode, card.id))}
            aria-label={card.mine ? `${card.displayText} (yours)` : `Vote for ${card.displayText}`}
          >
            <ChampionTag card={card} snap={snap} />
            <span>{card.displayText}</span>
            {card.mine && <span className={styles.cardMeta}>Yours</span>}
          </button>
        ))}
      </div>

      <p className={styles.body} style={{ textAlign: 'center', marginTop: 'auto' }}>
        {voted || me.left
          ? waitingOn.length
            ? `Waiting on ${waitingOn.map((p) => p.name).join(', ')}…`
            : 'Counting votes…'
          : game.withComputer
            ? "You can't vote for your own item. The Computer's card is in there somewhere."
            : "You can't vote for your own item."}
      </p>
    </>
  );
}

/** §9.5: counts, then owners; the round winner; a lead-change callout; the scoreboard. */
export function Reveal({ snap, room, roomCode, secondsLeft }: PhaseProps) {
  const game = snap.game!;
  const me = snap.me!;
  const players = new Map(snap.players.map((p) => [p.id, p]));
  const lead = game.leadChange ? players.get(game.leadChange) : null;
  const last = game.round >= game.totalRounds;

  return (
    <>
      <Header snap={snap} />
      <div className={styles.ballot}>
        {game.cards.map((card) => (
          <div
            key={card.id}
            className={[
              styles.card,
              card.winner ? styles.cardWinner : styles.cardDimmed,
              card.champion ? styles.cardChampion : '',
            ].join(' ')}
          >
            {card.champion && <span className={styles.cardMeta}>👑 Champion</span>}
            <span>{card.displayText}</span>
            <span className={styles.votes}>
              {card.votes} vote{card.votes === 1 ? '' : 's'}
            </span>
            <span className={styles.row} style={{ justifyContent: 'center' }}>
              {(card.ownerIds ?? []).map((id) => {
                const owner = players.get(id);
                return owner ? (
                  <span key={id} className={styles.row} style={{ gap: 4 }}>
                    <PlayerDot name={owner.name} colorSlot={owner.colorSlot} isComputer={owner.isComputer} />
                    <span className={styles.cardMeta}>
                      {owner.isComputer ? 'Computer' : owner.name}
                      {card.auto ? ' 🎲' : ''}
                    </span>
                  </span>
                ) : null;
              })}
            </span>
          </div>
        ))}
      </div>

      {game.crown && <div className={styles.callout}>{crownText(game.crown)}</div>}

      {lead && (
        <div className={styles.callout}>
          {lead.isComputer ? 'The Computer takes the lead!' : `${lead.name} takes the lead!`}
        </div>
      )}

      <Scoreboard rows={game.standings} meId={me.playerId} highlight={game.roundPoints} />

      <div style={{ marginTop: 'auto' }}>
        {me.isHost ? (
          <button
            type="button"
            className={styles.button}
            disabled={room.pending}
            onClick={() => room.act((t) => nextRound(t, roomCode))}
          >
            {last ? 'See results' : 'Next'} {secondsLeft !== null ? `(${secondsLeft})` : ''}
          </button>
        ) : (
          <p className={styles.body} style={{ textAlign: 'center' }}>
            {last ? 'Results' : 'Next round'} in {secondsLeft ?? '…'}s
          </p>
        )}
      </div>
    </>
  );
}
