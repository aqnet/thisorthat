'use client';

import { useRef, useState } from 'react';
import {
  buildCustomCategory,
  cancelCustomCategory,
  confirmSetup,
  selectMode,
  playWithoutSuggestions,
} from '@/app/actions';
import { styles } from '@/components/game/ui';
import type { ListLength } from '@/lib/engine/constants';
import type { GameMode } from '@/lib/engine/types';
import type { CategoryOption, CustomCategoryResult } from '@/lib/game/snapshot';
import { MODE_INFO, MODE_ORDER } from '@/lib/game/modes';
import type { PhaseProps } from '../RoomClient';

/**
 * §7 Host Setup, with the mode step first (mode spec §3): mode, category,
 * list length, then a confirmation card that is the undo point. On a 45s
 * timeout the server keeps the selected mode, picks Random at the longest
 * length up to 10, and confirms on its own.
 *
 * Custom categories (custom-category spec §3): the host can type their own.
 * The server builds a dictionary for it, and the ready card says how much the
 * game can help. Only profanity refuses a name.
 */

type CustomStep =
  | { stage: 'naming'; text: string; error: string | null }
  | { stage: 'building'; name: string }
  | { stage: 'builtin'; name: string; category: CategoryOption }
  | { stage: 'failed'; name: string; message: string; canRetry: boolean }
  | { stage: 'ready'; result: Extract<CustomCategoryResult, { kind: 'ready' }> };

const CUSTOM_NAME_MAX = 24;
/** Custom-category spec §4.5: below this, a custom category can borrow. */
const MIN_SUGGESTION_ITEMS = 38;

export function Setup({ snap, room, roomCode, secondsLeft }: PhaseProps) {
  const me = snap.me!;
  const mode = snap.game?.mode ?? 'pick_your_fav';
  const [pickingMode, setPickingMode] = useState(true);
  const [categoryId, setCategoryId] = useState<number | null>(null);
  // 5 is allowed for every category, so it's selected from the start.
  const [length, setLength] = useState<ListLength | null>(5);
  const [confirming, setConfirming] = useState(false);
  const [custom, setCustom] = useState<CustomStep | null>(null);
  const [spellCheck, setSpellCheck] = useState(true);
  // A custom category picked from its ready card, before the next snapshot lists it.
  const [extraOptions, setExtraOptions] = useState<CategoryOption[]>([]);
  // Cancel and Try another make any in-flight build's answer stale.
  const buildRun = useRef(0);
  // §4.5: the host's borrow choice per custom category; unset = the server's guess.
  const [borrowChoice, setBorrowChoice] = useState<Record<number, number | null>>({});

  if (!me.isHost) {
    const host = snap.players.find((p) => p.isHost);
    const building = snap.game?.buildingCategory;
    return (
      <section className={`${styles.stack} ${styles.center}`} style={{ flex: 1, justifyContent: 'center' }}>
        <h1 className={styles.title}>{host?.name ?? 'The host'} is choosing…</h1>
        {building ? (
          <p className={styles.body}>
            {host?.name ?? 'The host'} is building a custom category: <strong>{building}</strong>…
          </p>
        ) : (
          <p className={styles.body}>A game mode, a category, and how many items everyone lists.</p>
        )}
        <p className={styles.hint}>
          Mode so far: <strong>{MODE_INFO[mode].name}</strong>
        </p>
        {secondsLeft !== null && <p className={styles.hint}>Random pick in {secondsLeft}s if they can&apos;t decide.</p>}
      </section>
    );
  }

  // Mode spec §3a: the room's last mode is pre-selected; one tap moves on.
  if (pickingMode) {
    const choose = async (next: GameMode) => {
      if (next !== mode) {
        const result = await room.act((t) => selectMode(t, roomCode, next));
        if (!result.ok) return;
      }
      setPickingMode(false);
    };
    return (
      <>
        <h1 className={styles.title}>Pick a game mode</h1>
        <div className={styles.stack}>
          {MODE_ORDER.map((m) => (
            <button
              key={m}
              type="button"
              className={`${styles.modeCard} ${m === mode ? styles.modeCardActive : ''}`}
              disabled={room.pending}
              onClick={() => choose(m)}
              aria-pressed={m === mode}
            >
              <span className={styles.modeName}>{MODE_INFO[m].name}</span>
              <span className={styles.modePitch}>{MODE_INFO[m].pitch}</span>
            </button>
          ))}
        </div>
      </>
    );
  }

  const options = [...snap.categories, ...extraOptions.filter((e) => !snap.categories.some((c) => c.id === e.id))];
  const builtins = options.filter((c) => !c.isCustom);
  const canBorrow = (option: CategoryOption) => option.isCustom && option.itemCount < MIN_SUGGESTION_ITEMS;
  const borrowFor = (option: CategoryOption): number | null =>
    !canBorrow(option) ? null : option.id in borrowChoice ? borrowChoice[option.id] : option.borrowSuggestionId;
  const nameOf = (id: number | null) => builtins.find((c) => c.id === id)?.name ?? null;

  function borrowPicker(option: CategoryOption) {
    const chosen = borrowFor(option);
    return (
      <label className={styles.stack} style={{ gap: 6 }}>
        <span className={styles.eyebrow}>Borrow suggestions from</span>
        <select
          className={styles.input}
          value={chosen ?? ''}
          onChange={(e) =>
            setBorrowChoice((current) => ({ ...current, [option.id]: e.target.value ? Number(e.target.value) : null }))
          }
        >
          <option value="">None — players fill their own lists</option>
          {builtins.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
              {c.id === option.borrowSuggestionId ? ' (closest)' : ''}
            </option>
          ))}
        </select>
        <span className={styles.hint}>
          {chosen
            ? `The Computer, Surprise me and auto-fill use ${option.name} items first, then ${nameOf(chosen)}.`
            : option.itemCount > 0
              ? 'The Computer, Surprise me and auto-fill may run short.'
              : 'No suggestions: the Computer sits out and Surprise me is off.'}
        </span>
      </label>
    );
  }
  const category = options.find((c) => c.id === categoryId) ?? null;
  const lengths = category?.allowedLengths ?? [];

  function choose(option: CategoryOption) {
    setCategoryId(option.id);
    if (length && !option.allowedLengths.includes(length)) setLength(5);
  }

  function pickRandom() {
    const choice = randomOf(builtins);
    setCategoryId(choice.id);
    if (length && !choice.allowedLengths.includes(length)) setLength(5);
  }

  async function build(name: string, makeMyOwn = false) {
    const run = ++buildRun.current;
    setCustom({ stage: 'building', name });
    const result = await room.act((t) => buildCustomCategory(t, roomCode, name, makeMyOwn));
    if (run !== buildRun.current) return; // cancelled meanwhile
    if (!result.ok) {
      setCustom({ stage: 'naming', text: name, error: result.message });
      return;
    }
    showResult(result.result, name);
  }

  function showResult(result: CustomCategoryResult, name: string) {
    if (result.kind === 'builtin') setCustom({ stage: 'builtin', name, category: result.category });
    else if (result.kind === 'failed') setCustom({ stage: 'failed', name, message: result.message, canRetry: result.canRetry });
    else setCustom({ stage: 'ready', result });
  }

  async function withoutSuggestions(name: string) {
    const result = await room.act((t) => playWithoutSuggestions(t, roomCode, name));
    if (result.ok) showResult(result.result, name);
  }

  function pickCustom(option: CategoryOption) {
    setExtraOptions((current) => [...current.filter((c) => c.id !== option.id), option]);
    choose(option);
    setCustom(null);
  }

  if (confirming && category && length) {
    return (
      <section className={`${styles.stack} ${styles.center}`} style={{ flex: 1, justifyContent: 'center' }}>
        <p className={styles.eyebrow}>Ready?</p>
        <h1 className={styles.title}>
          {MODE_INFO[mode].name} · {category.name} · {length} items
        </h1>
        <p className={styles.body}>{length} rounds. No changing the category after this.</p>
        {nameOf(borrowFor(category)) && (
          <p className={styles.hint}>Topping up suggestions from {nameOf(borrowFor(category))}.</p>
        )}
        <button
          type="button"
          className={styles.button}
          disabled={room.pending}
          onClick={() =>
            room.act((t) =>
              confirmSetup(
                t,
                roomCode,
                category.id,
                length,
                mode,
                category.isCustom ? spellCheck : undefined,
                borrowFor(category),
              ),
            )
          }
        >
          Start
        </button>
        <button type="button" className={`${styles.button} ${styles.secondary}`} onClick={() => setConfirming(false)}>
          Back
        </button>
      </section>
    );
  }

  if (custom) {
    return customFlow();
  }

  // The most-played built-ins for this mode as chips; everything else in a dropdown.
  const top = snap.topCategoryIds
    .map((id) => options.find((c) => c.id === id))
    .filter((c): c is CategoryOption => c !== undefined);
  const rest = options.filter((c) => !top.includes(c));
  const groups: { label: string; items: CategoryOption[] }[] = [
    { label: 'Everyone', items: rest.filter((c) => !c.isCustom && c.audience === 'everyone') },
    { label: "Kids' favorites", items: rest.filter((c) => !c.isCustom && c.audience === 'kids') },
    { label: 'Your custom categories', items: rest.filter((c) => c.isCustom) },
  ].filter((g) => g.items.length > 0);
  const inDropdown = rest.some((c) => c.id === categoryId);

  return (
    <>
      <button type="button" className={styles.ghost} style={{ alignSelf: 'flex-start' }} onClick={() => setPickingMode(true)}>
        ← {MODE_INFO[mode].name}
      </button>
      <h1 className={styles.title}>Pick a category</h1>
      <section className={styles.stack} style={{ gap: 8 }}>
        <p className={styles.eyebrow}>Most played in {MODE_INFO[mode].name}</p>
        <div className={styles.row}>
          {top.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`${styles.chip} ${c.id === categoryId ? styles.chipActive : ''}`}
              onClick={() => choose(c)}
            >
              {c.name}
            </button>
          ))}
          <button type="button" className={styles.chip} onClick={pickRandom}>
            🎲 Random
          </button>
          <button type="button" className={styles.chip} onClick={() => setCustom({ stage: 'naming', text: '', error: null })}>
            ✏️ Custom
          </button>
        </div>
      </section>
      {groups.length > 0 && (
        <label className={styles.stack} style={{ gap: 8 }}>
          <span className={styles.eyebrow}>More categories</span>
          <select
            className={`${styles.input} ${inDropdown ? styles.selectActive : ''}`}
            value={inDropdown ? String(categoryId) : ''}
            onChange={(e) => {
              const picked = rest.find((c) => String(c.id) === e.target.value);
              if (picked) choose(picked);
            }}
            aria-label="More categories"
          >
            <option value="" disabled>
              Choose another category…
            </option>
            {groups.map((group) => (
              <optgroup key={group.label} label={group.label}>
                {group.items.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.isCustom ? `✏️ ${c.name}` : c.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
      )}

      <p className={styles.eyebrow}>Items per player</p>
      <div className={styles.row}>
        {([5, 10, 15] as const).map((l) => (
          <button
            key={l}
            type="button"
            className={`${styles.chip} ${l === length ? styles.chipActive : ''}`}
            disabled={category !== null && !lengths.includes(l)}
            onClick={() => setLength(l)}
          >
            {l}
          </button>
        ))}
      </div>
      {category && length && length > category.suggestedMax && (
        <p className={styles.hint}>
          {category.itemCount > 0 ? `${category.name} has ${category.itemCount} items — at ${length}` : `At ${length}`}, players may
          run out of ideas. Anyone whose list comes up short sits out some rounds.
        </p>
      )}
      {category && canBorrow(category) && borrowPicker(category)}
      {category?.isCustom && category.itemCount > 0 && (
        <SpellCheckSwitch on={spellCheck} onChange={setSpellCheck} />
      )}

      <button
        type="button"
        className={styles.button}
        style={{ marginTop: 'auto' }}
        disabled={!category || !length}
        onClick={() => setConfirming(true)}
      >
        {category && length ? `${category.name} · ${length} items` : 'Choose a category and length'}
      </button>
    </>
  );

  /** Custom-category spec §3.1-§3.6: name → build → ready card. */
  function customFlow() {
    const step = custom!;
    const back = (
      <button
        type="button"
        className={styles.ghost}
        style={{ alignSelf: 'flex-start' }}
        onClick={() => {
          buildRun.current += 1;
          setCustom(null);
        }}
      >
        ← Categories
      </button>
    );

    if (step.stage === 'naming') {
      return (
        <NameInput
          key={step.text + (step.error ?? '')}
          initial={step.text}
          error={step.error}
          back={back}
          pending={room.pending}
          onBuild={(name) => build(name)}
        />
      );
    }

    if (step.stage === 'building') {
      return (
        <section className={`${styles.stack} ${styles.center}`} style={{ flex: 1, justifyContent: 'center' }}>
          <p className={styles.eyebrow}>Custom category</p>
          <h1 className={styles.title}>Building {step.name}…</h1>
          <p className={`${styles.body} ${styles.building}`}>Finding things that belong, and checking every one.</p>
          <button
            type="button"
            className={`${styles.button} ${styles.secondary}`}
            onClick={() => {
              buildRun.current += 1;
              setCustom({ stage: 'naming', text: step.name, error: null });
              void room.act((t) => cancelCustomCategory(t, roomCode));
            }}
          >
            Cancel
          </button>
        </section>
      );
    }

    if (step.stage === 'builtin') {
      return (
        <section className={`${styles.stack} ${styles.center}`} style={{ flex: 1, justifyContent: 'center' }}>
          {back}
          <h1 className={styles.title}>
            We already have <strong>{step.category.name}</strong> — use it?
          </h1>
          <button type="button" className={styles.button} onClick={() => pickCustom(step.category)}>
            Use {step.category.name}
          </button>
          <button
            type="button"
            className={`${styles.button} ${styles.secondary}`}
            disabled={room.pending}
            onClick={() => build(step.name, true)}
          >
            Make my own
          </button>
        </section>
      );
    }

    if (step.stage === 'failed') {
      return (
        <section className={`${styles.stack} ${styles.center}`} style={{ flex: 1, justifyContent: 'center' }}>
          {back}
          <h1 className={styles.title}>{step.message}</h1>
          <p className={styles.body}>You can still play it — everyone just fills their own lists.</p>
          {step.canRetry && (
            <button type="button" className={styles.button} disabled={room.pending} onClick={() => build(step.name, true)}>
              Retry
            </button>
          )}
          <button
            type="button"
            className={`${styles.button} ${styles.secondary}`}
            disabled={room.pending}
            onClick={() => withoutSuggestions(step.name)}
          >
            Play without suggestions
          </button>
        </section>
      );
    }

    // §3.5: the ready card.
    const { result } = step;
    const option = result.category;
    const count = option.itemCount;
    const max = option.suggestedMax;
    const twoHumans = snap.players.filter((p) => !p.isComputer && !p.queued && !p.left).length < 3;
    return (
      <section className={styles.stack}>
        {back}
        <div className={styles.panel}>
          <p className={styles.eyebrow}>Custom category</p>
          <h1 className={styles.title} style={{ fontSize: 32 }}>
            ✏️ {option.name}
          </h1>
          <p className={styles.body}>
            {count === 0
              ? 'No suggestions'
              : `${count} items · best at ${max === 5 ? '5' : `up to ${max}`} per player`}
          </p>
          {result.examples.length > 0 && (
            <p className={styles.hint}>Examples: {result.examples.join(' · ')}</p>
          )}
          {canBorrow(option) && borrowPicker(option)}
          {canBorrow(option) && !borrowFor(option) && (
            <>
              <p className={styles.hint}>
                ⚠️ {count === 0 ? 'Players will need to fill their own lists.' : 'Players with short lists sit out some rounds.'}
              </p>
              {count === 0 && twoHumans && (
                <p className={styles.hint}>With 2 players and no Computer, rounds can tie. This game won&apos;t count for high scores.</p>
              )}
            </>
          )}
          {count > 0 && result.reused && <p className={styles.hint}>Already built — including what players added.</p>}
          {result.note && <p className={styles.hint}>{result.note}</p>}
          {count > 0 && <SpellCheckSwitch on={spellCheck} onChange={setSpellCheck} />}
        </div>
        <button type="button" className={styles.button} onClick={() => pickCustom(option)}>
          Use this category
        </button>
        <button
          type="button"
          className={`${styles.button} ${styles.secondary}`}
          onClick={() => setCustom({ stage: 'naming', text: '', error: null })}
        >
          Try another
        </button>
      </section>
    );
  }

}

/** 🎲 Random (§7). Outside the component: it only ever runs from a tap. */
function randomOf<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

/** Kept outside Setup so typing doesn't remount the field on every render. */
function NameInput({
  initial,
  error,
  back,
  pending,
  onBuild,
}: {
  initial: string;
  error: string | null;
  back: React.ReactNode;
  pending: boolean;
  onBuild: (name: string) => void;
}) {
  const [text, setText] = useState(initial);
  const trimmed = text.replace(/\s+/g, ' ').trim();
  // §3.1: length is an input rule, enforced as the host types.
  const lengthIssue =
    trimmed.length > CUSTOM_NAME_MAX ? 'Keep it under 24 characters' : trimmed.length > 0 && trimmed.length < 2 ? 'Give it at least 2 letters' : null;
  return (
    <form
      className={styles.stack}
      onSubmit={(e) => {
        e.preventDefault();
        if (!lengthIssue && trimmed.length >= 2 && !pending) onBuild(trimmed);
      }}
    >
      {back}
      <h1 className={styles.title}>Name a category</h1>
      <input
        className={styles.input}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="e.g. Board games"
        maxLength={40}
        autoFocus
        autoComplete="off"
        enterKeyHint="go"
        aria-label="Category name"
      />
      {(lengthIssue || error) && <p className={styles.error}>{lengthIssue ?? error}</p>}
      <p className={styles.hint}>Anything goes. The game suggests items where it can.</p>
      <button className={styles.button} disabled={pending || Boolean(lengthIssue) || trimmed.length < 2}>
        Build
      </button>
    </form>
  );
}

/** Custom-category spec §5.3: the host can switch "Did you mean…?" off. */
function SpellCheckSwitch({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <div className={styles.spread}>
      <span className={styles.body}>Spell check</span>
      <div className={styles.row}>
        <button type="button" className={`${styles.chip} ${on ? styles.chipActive : ''}`} aria-pressed={on} onClick={() => onChange(true)}>
          On
        </button>
        <button type="button" className={`${styles.chip} ${!on ? styles.chipActive : ''}`} aria-pressed={!on} onClick={() => onChange(false)}>
          Off
        </button>
      </div>
    </div>
  );
}
