import 'server-only';
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { LIST_LENGTHS, dedupeKey, toBallotText, toDisplayText, type ListLength } from '@/lib/engine';
import { isProfane } from './profanity';
import type { CategoryRow } from './repo';
import { categoryOption } from './view';
import {
  GenerationUnavailable,
  type CategoryGenerator,
  type GeneratedCategory,
} from './categoryGen';

/**
 * Custom categories (custom-category spec, Part A): the host types a name, the
 * server builds a dictionary for it, and the result is stored as an ordinary
 * category, so spell check, Surprise me, auto-fill and the Computer all work
 * unchanged (§7.1).
 *
 * Only profanity refuses a name (§3.1). Everything else is playable; a thin or
 * empty dictionary just means fewer suggestions (§4).
 */

type Sql = postgres.Sql | postgres.TransactionSql;

export const CUSTOM_NAME_MIN = 2;
export const CUSTOM_NAME_MAX = 24;
const ITEM_MAX = 30;
/** §8.3: the whole build, both requests. */
export const BUILD_BUDGET_MS = 30_000;
/** §8.3: builds that call the API, per game and per room per hour. */
export const BUILDS_PER_GAME = 3;
export const BUILDS_PER_HOUR = 10;
/** §3.1: "close" to a built-in is the spell-check threshold. */
const BUILTIN_SIMILARITY = 0.6;
/** §4.5: a custom category below the Small size requirement can borrow. */
export const BORROW_BELOW = 38;

// --- Names ----------------------------------------------------------------------------

export type NameCheck =
  | { ok: true; name: string; key: string }
  | { ok: false; message: string; code: 'too_short' | 'too_long' | 'profane' };

/** §3.1: length is an input rule; profanity is the only refusal. */
export function checkCategoryName(raw: string): NameCheck {
  const name = toDisplayText(raw);
  if (name.length < CUSTOM_NAME_MIN) return { ok: false, code: 'too_short', message: 'Give it at least 2 letters' };
  if (name.length > CUSTOM_NAME_MAX) return { ok: false, code: 'too_long', message: 'Keep it under 24 characters' };
  if (isProfane(name)) return { ok: false, code: 'profane', message: "Let's keep it friendly — try another" };
  const key = dedupeKey(name);
  if (key.length === 0) return { ok: false, code: 'too_short', message: 'Give it at least 2 letters' };
  return { ok: true, name, key };
}

/** Trigram similarity, as pg_trgm computes it: words padded, lowercase, set overlap. */
export function trigramSimilarity(a: string, b: string): number {
  const grams = (text: string) => {
    const set = new Set<string>();
    for (const word of text.toLocaleLowerCase('en-US').split(/[^\p{L}\p{N}]+/u)) {
      if (!word) continue;
      const padded = `  ${word} `;
      for (let i = 0; i + 3 <= padded.length; i++) set.add(padded.slice(i, i + 3));
    }
    return set;
  };
  const left = grams(a);
  const right = grams(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/** §3.1: "We already have Fruit — use it?" The best built-in at or above the threshold. */
export function closestBuiltin(name: string, builtins: readonly CategoryRow[]): CategoryRow | null {
  let best: { row: CategoryRow; score: number } | null = null;
  for (const row of builtins) {
    const forms = [row.name, row.slug.replaceAll('-', ' '), row.singularLabel, row.pluralLabel].filter(
      (form): form is string => Boolean(form),
    );
    const score = Math.max(...forms.map((form) => trigramSimilarity(name, form)));
    if (score >= BUILTIN_SIMILARITY && (!best || score > best.score)) best = { row, score };
  }
  return best?.row ?? null;
}

// --- Borrowing (§4.5) ------------------------------------------------------------------

/** Built-in category id -> every active item name and alias in it. */
export type DictionaryIndex = Map<number, string[]>;

export async function loadDictionaryIndex(sql: Sql): Promise<DictionaryIndex> {
  const rows = await sql`
    select d.category_id, d.canonical_name as term
      from this_or_that.dictionary d
      join this_or_that.categories c on c.id = d.category_id
     where c.is_active and not c.is_custom and d.retired_at is null
    union all
    select d.category_id, a.alias
      from this_or_that.dictionary_aliases a
      join this_or_that.dictionary d on d.id = a.dictionary_id
      join this_or_that.categories c on c.id = d.category_id
     where c.is_active and not c.is_custom and d.retired_at is null`;
  const index: DictionaryIndex = new Map();
  for (const row of rows) {
    const id = row.category_id as number;
    index.set(id, [...(index.get(id) ?? []), row.term as string]);
  }
  return index;
}

/**
 * §4.5: the closest built-in to a custom name, by the spell-check similarity.
 * A category matches through its own name and labels ("Fruits" -> Fruit), or
 * through an item in its dictionary matching the name or one of its words
 * ("Pizza toppings" -> Meal, which holds "Pizza"). Null when nothing does.
 */
export function suggestBorrow(name: string, builtins: readonly CategoryRow[], index: DictionaryIndex): CategoryRow | null {
  const probes = [name, ...name.split(/\s+/).filter((word) => word.length >= 3)];
  let best: { row: CategoryRow; score: number; hits: number } | null = null;
  for (const row of builtins) {
    const forms = [row.name, row.singularLabel, row.pluralLabel].filter((f): f is string => Boolean(f));
    const nameScore = Math.max(...forms.map((form) => trigramSimilarity(name, form)));
    let itemScore = 0;
    let hits = 0;
    for (const term of index.get(row.id) ?? []) {
      const score = Math.max(...probes.map((probe) => trigramSimilarity(probe, term)));
      if (score >= BUILTIN_SIMILARITY) hits += 1;
      itemScore = Math.max(itemScore, score);
    }
    const score = Math.max(nameScore, itemScore);
    if (score < BUILTIN_SIMILARITY) continue;
    if (!best || score > best.score || (score === best.score && hits > best.hits)) best = { row, score, hits };
  }
  return best?.row ?? null;
}

// --- Filtering generated items (§3.3) ---------------------------------------------------

export interface CleanItem {
  name: string;
  aliases: string[];
  popular: boolean;
}

/**
 * Deterministic, after the model: trim, length, profanity, and duplicates by
 * key across names and aliases. The model's casing is kept ("iCarly",
 * "SpongeBob"); ballots are ALL CAPS anyway.
 */
export function filterGenerated(items: GeneratedCategory['items']): CleanItem[] {
  const tidy = (text: string) => text.replace(/\s+/g, ' ').trim();
  const usable = (text: string) => text.length > 0 && text.length <= ITEM_MAX && !isProfane(text) && dedupeKey(text) !== '';
  const seen = new Set<string>();
  const out: CleanItem[] = [];
  for (const item of items) {
    const name = tidy(item.name);
    if (!usable(name) || seen.has(dedupeKey(name))) continue;
    seen.add(dedupeKey(name));
    const aliases: string[] = [];
    for (const raw of item.aliases) {
      const alias = tidy(raw);
      if (!usable(alias) || seen.has(dedupeKey(alias))) continue;
      seen.add(dedupeKey(alias));
      aliases.push(alias);
    }
    out.push({ name, aliases, popular: item.popular });
  }
  return out;
}

/** §3.4: allowed lengths from the surviving count, stored with the row. */
export function allowedLengthsFor(itemCount: number): ListLength[] {
  if (itemCount >= 113) return [5, 10, 15];
  if (itemCount >= 75) return [5, 10];
  if (itemCount > 0) return [5];
  return [...LIST_LENGTHS];
}

// --- Storage ------------------------------------------------------------------------------

const CATEGORY_SELECT = `
  c.id, c.slug, c.name, c.size_class, c.allowed_lengths, c.audience, c.is_custom, c.generated,
  c.singular_label, c.plural_label,
  (select count(*)::int from this_or_that.dictionary d
    where d.category_id = c.id and d.retired_at is null) as dictionary_size`;

function toRow(r: Record<string, unknown>): CategoryRow {
  return {
    id: r.id as number,
    slug: r.slug as string,
    name: r.name as string,
    sizeClass: r.size_class as CategoryRow['sizeClass'],
    allowedLengths: r.allowed_lengths as ListLength[],
    dictionarySize: r.dictionary_size as number,
    audience: r.audience as CategoryRow['audience'],
    isCustom: r.is_custom as boolean,
    generated: r.generated as boolean,
    singularLabel: (r.singular_label as string | null) ?? null,
    pluralLabel: (r.plural_label as string | null) ?? null,
  };
}

/** §7.2: a name generated before, in any room, is reused with no API call. */
export async function findGenerated(sql: Sql, key: string): Promise<CategoryRow | null> {
  const rows = await sql.unsafe(
    `select ${CATEGORY_SELECT} from this_or_that.categories c
      where c.is_custom and c.generated and c.custom_key = $1`,
    [key],
  );
  return rows.length ? toRow(rows[0]) : null;
}

export async function attachToRoom(sql: Sql, sessionId: string, categoryId: number): Promise<void> {
  await sql`
    insert into this_or_that.session_categories (session_id, category_id)
    values (${sessionId}, ${categoryId})
    on conflict do nothing`;
  await sql`update this_or_that.categories set last_used_at = now() where id = ${categoryId}`;
}

/** Builds that called the API, for the §8.3 rate limits. */
export async function recentBuilds(sql: Sql, sessionId: string, gameStartedAt: number) {
  const [row] = await sql`
    select
      count(*) filter (where created_at > now() - interval '1 hour')::int as last_hour,
      count(*) filter (where created_at >= ${new Date(gameStartedAt).toISOString()}::timestamptz)::int as this_game
    from this_or_that.categories
    where is_custom and generated and created_by_session = ${sessionId}`;
  return { lastHour: row.last_hour as number, thisGame: row.this_game as number };
}

interface NewCategory {
  name: string;
  key: string;
  sessionId: string;
  generated: boolean;
  model: string | null;
  singular: string | null;
  plural: string | null;
  items: CleanItem[];
}

/**
 * Write a category and its dictionary in one transaction of its own -- never
 * under the room lock, which a 30s build must not hold (§9.2).
 *
 * Two rooms building the same name at once both reach here; the unique key
 * keeps one row, and the loser reuses the winner's.
 */
export async function storeCategory(sql: postgres.Sql, input: NewCategory): Promise<CategoryRow> {
  return sql.begin(async (tx) => {
    const lengths = allowedLengthsFor(input.items.length);
    const inserted = await tx.unsafe(
      `insert into this_or_that.categories
         (slug, name, size_class, allowed_lengths, is_active, is_custom, custom_key,
          singular_label, plural_label, generated, created_by_session, generator_model)
       values ($1, $2, 'large', $3::smallint[], false, true, $4, $5, $6, $7, $8, $9)
       on conflict (custom_key) where is_custom and generated do nothing
       returning id`,
      [
        `custom-${randomUUID()}`,
        input.name,
        lengths,
        input.key,
        input.singular,
        input.plural,
        input.generated,
        input.sessionId,
        input.model,
      ] as never[],
    );
    if (inserted.length === 0) {
      const existing = await findGenerated(tx, input.key);
      if (!existing) throw new Error('custom category vanished during a concurrent build');
      await attachToRoom(tx, input.sessionId, existing.id);
      return existing;
    }
    const categoryId = inserted[0].id as number;

    if (input.items.length) {
      await tx`
        insert into this_or_that.dictionary (category_id, canonical_name, popular_tier, player_originated)
        select ${categoryId}, r.name, r.popular, false
          from jsonb_to_recordset(${tx.json(input.items.map((i) => ({ name: i.name, popular: i.popular })))})
            as r(name text, popular boolean)
        on conflict do nothing`;
      const aliases = input.items.flatMap((i) => i.aliases.map((alias) => ({ alias, name: i.name })));
      if (aliases.length) {
        await tx`
          insert into this_or_that.dictionary_aliases (dictionary_id, alias)
          select d.id, r.alias
            from jsonb_to_recordset(${tx.json(aliases)}) as r(alias text, name text)
            join this_or_that.dictionary d on d.category_id = ${categoryId} and d.canonical_name = r.name
          on conflict do nothing`;
      }
    }
    await attachToRoom(tx, input.sessionId, categoryId);
    const [row] = await tx.unsafe(`select ${CATEGORY_SELECT} from this_or_that.categories c where c.id = $1`, [
      categoryId,
    ]);
    return toRow(row);
  });
}

/** §3.5: up to 3 examples, popular first, ALL CAPS like the ballots. */
export async function examplesFor(sql: Sql, categoryId: number): Promise<string[]> {
  const rows = await sql`
    select canonical_name from this_or_that.dictionary
     where category_id = ${categoryId} and retired_at is null
     order by popular_tier desc, random()
     limit 3`;
  return rows.map((r) => toBallotText(r.canonical_name));
}

// --- Generation ----------------------------------------------------------------------------

/**
 * §3.2-§3.3: generate, filter, relevance-check. Throws GenerationUnavailable
 * when the build can't finish in budget; the caller turns that into "Couldn't
 * find suggestions".
 */
export async function generateItems(
  generator: CategoryGenerator,
  name: string,
  budgetMs = BUILD_BUDGET_MS,
): Promise<{ singular: string | null; plural: string | null; items: CleanItem[] }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs);
  try {
    const generated = await generator.generate(name, controller.signal);
    let items = filterGenerated(generated.items);
    if (items.length > 0) {
      const drop = new Set(await generator.checkRelevance(name, items.map((i) => i.name), controller.signal));
      items = items.filter((item) => !drop.has(item.name));
    }
    // Keep a popular tier even when the model's picks were all filtered out.
    if (items.length > 0 && !items.some((i) => i.popular)) {
      items = items.map((item, index) => ({ ...item, popular: index < 20 }));
    }
    const label = (text: string | null) => (text && text.length <= 40 && !isProfane(text) ? text : null);
    return { singular: label(generated.singular), plural: label(generated.plural), items };
  } catch (error) {
    if (error instanceof GenerationUnavailable) throw error;
    console.error('custom category build failed', error);
    throw new GenerationUnavailable('failed');
  } finally {
    clearTimeout(timer);
  }
}

export { categoryOption };
