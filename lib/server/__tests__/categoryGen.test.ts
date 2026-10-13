/**
 * The custom-category generation service and its pure helpers, as unit tests
 * (custom-category spec §3.1-§3.4, §4.5, §8). The Anthropic SDK is mocked:
 * these check what we send and how we read what comes back, never the model.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({ parse: vi.fn(), options: [] as unknown[] }));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    beta = { messages: { parse: sdk.parse } };
    constructor(options: unknown) {
      sdk.options.push(options);
    }
  },
}));

import {
  CATEGORY_MODEL,
  FixtureCategoryGenerator,
  GenerationUnavailable,
  MAX_GENERATED_ITEMS,
  categoryGenerator,
  type CategoryGenerator,
} from '../categoryGen';
import {
  allowedLengthsFor,
  checkCategoryName,
  closestBuiltin,
  filterGenerated,
  generateItems,
  suggestBorrow,
  trigramSimilarity,
  type DictionaryIndex,
} from '../customCategory';
import type { CategoryRow } from '../repo';

const ENV_KEYS = ['THIS_OR_THAT_CATEGORY_GENERATOR', 'ANTHROPIC_API_KEY'] as const;
let savedEnv: Record<string, string | undefined>;
beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  sdk.parse.mockReset();
});
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function claude(): CategoryGenerator {
  delete process.env.THIS_OR_THAT_CATEGORY_GENERATOR;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  return categoryGenerator()!;
}

const reply = (parsed: unknown, stop_reason = 'end_turn') => ({ stop_reason, parsed_output: parsed });
const signal = () => new AbortController().signal;

describe('§8.1 choosing a generator', () => {
  it('uses the fixture for tests, none without a key, and Claude with one', () => {
    process.env.THIS_OR_THAT_CATEGORY_GENERATOR = 'fixture';
    expect(categoryGenerator()).toBeInstanceOf(FixtureCategoryGenerator);
    delete process.env.THIS_OR_THAT_CATEGORY_GENERATOR;
    delete process.env.ANTHROPIC_API_KEY;
    expect(categoryGenerator()).toBeNull();
    expect(claude().model).toBe(CATEGORY_MODEL);
  });
});

describe('§8.2 the Claude generator', () => {
  it('sends the name as delimited data, at low effort, with refusal fallbacks', async () => {
    sdk.parse.mockResolvedValue(reply({ singular: 'board game', plural: 'board games', items: [], popular: [], aliases: [] }));
    const abort = signal();
    await claude().generate('Board games', abort);
    const [params, options] = sdk.parse.mock.calls[0];
    expect(params).toMatchObject({
      model: CATEGORY_MODEL,
      messages: [{ role: 'user', content: '<category>Board games</category>' }],
      output_config: { effort: 'low' },
      fallbacks: 'default',
      betas: ['server-side-fallback-2026-07-01'],
    });
    expect(params.output_config.format).toBeDefined();
    expect(options).toEqual({ signal: abort });
  });

  it('matches popular picks and aliases back to items, ignoring case', async () => {
    sdk.parse.mockResolvedValue(
      reply({
        singular: 'board game',
        plural: 'board games',
        items: ['Catan', 'Ticket to Ride', 'Chess'],
        popular: ['catan', 'CHESS'],
        aliases: [
          { alias: 'Settlers of Catan', item: 'CATAN' },
          { alias: 'Catan Classic', item: 'catan' },
          { alias: 'TTR', item: 'Ticket to Ride' },
        ],
      }),
    );
    const generated = await claude().generate('Board games', signal());
    expect(generated).toEqual({
      singular: 'board game',
      plural: 'board games',
      items: [
        { name: 'Catan', aliases: ['Settlers of Catan', 'Catan Classic'], popular: true },
        { name: 'Ticket to Ride', aliases: ['TTR'], popular: false },
        { name: 'Chess', aliases: [], popular: true },
      ],
    });
  });

  it('caps the list and turns blank labels into "guess from the name"', async () => {
    const items = Array.from({ length: MAX_GENERATED_ITEMS + 20 }, (_, i) => `Item ${i}`);
    sdk.parse.mockResolvedValue(reply({ singular: '  ', plural: '', items, popular: [], aliases: [] }));
    const generated = await claude().generate('Things', signal());
    expect(generated.items).toHaveLength(MAX_GENERATED_ITEMS);
    expect(generated.singular).toBeNull();
    expect(generated.plural).toBeNull();
  });

  it('asks the relevance check about a numbered list and returns what to drop', async () => {
    sdk.parse.mockResolvedValue(reply({ drop: ['Tag'] }));
    expect(await claude().checkRelevance('Board games', ['Catan', 'Tag'], signal())).toEqual(['Tag']);
    expect(sdk.parse.mock.calls[0][0].messages[0].content).toBe(
      '<category>Board games</category>\n\n<items>\n1. Catan\n2. Tag\n</items>',
    );
  });

  it.each([
    ['a refusal', reply(null, 'refusal'), 'refused'],
    ['running out of tokens', reply({ drop: [] }, 'max_tokens'), 'failed'],
    ['an unparseable answer', reply(null), 'failed'],
  ])('reports %s as a build that did not run', async (_label, response, reason) => {
    sdk.parse.mockResolvedValue(response);
    await expect(claude().checkRelevance('X', ['Y'], signal())).rejects.toMatchObject({ reason });
  });

  it('reports request errors and aborts as a failed build, never a crash', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    sdk.parse.mockRejectedValue(new Error('overloaded'));
    await expect(claude().generate('X', signal())).rejects.toBeInstanceOf(GenerationUnavailable);
    const controller = new AbortController();
    controller.abort();
    await expect(claude().generate('X', controller.signal)).rejects.toMatchObject({ reason: 'failed' });
    quiet.mockRestore();
  });
});

describe('§3.1 category names', () => {
  it('tidies the name and refuses only profanity, with length as an input rule', () => {
    expect(checkCategoryName('  board   games ')).toMatchObject({ ok: true, name: 'Board Games', key: 'BOARDGAMES' });
    expect(checkCategoryName('x')).toMatchObject({ ok: false, code: 'too_short' });
    expect(checkCategoryName('!!')).toMatchObject({ ok: false, code: 'too_short' });
    expect(checkCategoryName('a'.repeat(25))).toMatchObject({ ok: false, code: 'too_long' });
    expect(checkCategoryName('a'.repeat(24))).toMatchObject({ ok: true });
    expect(checkCategoryName('fuck lists')).toMatchObject({ ok: false, code: 'profane' });
    expect(checkCategoryName('Things in my fridge')).toMatchObject({ ok: true });
  });

  it('measures trigram similarity the way pg_trgm does', () => {
    expect(trigramSimilarity('Fruit', 'fruit')).toBe(1);
    expect(trigramSimilarity('Fruits', 'Fruit')).toBeGreaterThanOrEqual(0.6);
    expect(trigramSimilarity('abc', 'xyz')).toBe(0);
    expect(trigramSimilarity('', 'xyz')).toBe(0);
  });
});

const row = (id: number, name: string, extra: Partial<CategoryRow> = {}): CategoryRow => ({
  id, slug: name.toLowerCase().replace(/\W+/g, '-'), name, sizeClass: 'large', allowedLengths: [5, 10, 15],
  dictionarySize: 140, audience: 'everyone', isCustom: false, generated: false,
  singularLabel: null, pluralLabel: null, ...extra,
});
const builtins = [
  row(1, 'Fruit'),
  row(2, 'Meal'),
  row(3, 'Candy', { singularLabel: 'candy', pluralLabel: 'candies' }),
  row(4, 'Toy'),
  row(5, 'Pet'),
];

describe('§3.1 / §4.5 the closest built-in', () => {
  it('suggests a built-in by its name or labels', () => {
    expect(closestBuiltin('Fruits', builtins)?.name).toBe('Fruit');
    expect(closestBuiltin('candies', builtins)?.name).toBe('Candy');
    expect(closestBuiltin('Board games', builtins)).toBeNull();
  });

  it('finds a borrow source through the items in its dictionary', () => {
    const index: DictionaryIndex = new Map([
      [2, ['Pizza', 'Tacos', 'Ramen']],
      [4, ['Lego', 'Squishmallows', 'Pizza Oven Toy']],
    ]);
    expect(suggestBorrow('Pizza toppings', builtins, index)?.name).toBe('Meal');
    expect(suggestBorrow('Squishmallow', builtins, index)?.name).toBe('Toy');
    expect(suggestBorrow('Fruits', builtins, index)?.name).toBe('Fruit');
    // Category names match the whole custom name, never a single word: a wrong
    // pre-selection is worse than none, and "Pet peeves" aren't pets.
    expect(suggestBorrow('Pet peeves', builtins, index)).toBeNull();
    expect(suggestBorrow('Fruit salads', builtins, index)).toBeNull();
    expect(suggestBorrow('Qwzx plorbs', builtins, index)).toBeNull();
  });
});

describe('§3.3 filtering generated items', () => {
  it('drops long, profane and duplicate items, by name and by alias', () => {
    const items = filterGenerated([
      { name: '  Catan  ', aliases: ['Settlers   of Catan', 'catan!'], popular: true },
      { name: 'CATAN', aliases: [], popular: false },
      { name: 'Settlers of Catan', aliases: [], popular: false },
      { name: 'x'.repeat(31), aliases: [], popular: false },
      { name: 'Shit Happens', aliases: [], popular: false },
      { name: 'Chess', aliases: ['a'.repeat(31), 'Chess'], popular: false },
      { name: '!!!', aliases: [], popular: false },
    ]);
    expect(items).toEqual([
      { name: 'Catan', aliases: ['Settlers of Catan'], popular: true },
      { name: 'Chess', aliases: [], popular: false },
    ]);
  });

  it('suggests lengths from the surviving count (§3.4)', () => {
    expect(allowedLengthsFor(0)).toEqual([5, 10, 15]);
    expect(allowedLengthsFor(1)).toEqual([5]);
    expect(allowedLengthsFor(74)).toEqual([5]);
    expect(allowedLengthsFor(75)).toEqual([5, 10]);
    expect(allowedLengthsFor(112)).toEqual([5, 10]);
    expect(allowedLengthsFor(113)).toEqual([5, 10, 15]);
  });
});

describe('§3.2-§3.3 a whole build', () => {
  const generator = (overrides: Partial<CategoryGenerator>): CategoryGenerator => ({
    model: 'test',
    generate: async () => ({ singular: 'thing', plural: 'things', items: [] }),
    checkRelevance: async () => [],
    ...overrides,
  });

  it('drops what the relevance check flags, and keeps a popular tier', async () => {
    const built = await generateItems(
      generator({
        generate: async () => ({
          singular: 'board game',
          plural: 'board games',
          items: ['Catan', 'Tag', 'Chess'].map((name) => ({ name, aliases: [], popular: false })),
        }),
        checkRelevance: async () => ['Tag'],
      }),
      'Board games',
    );
    expect(built.items.map((i) => i.name)).toEqual(['Catan', 'Chess']);
    // None came back popular, so the first items stand in for the cold-start tier.
    expect(built.items.every((i) => i.popular)).toBe(true);
  });

  it('skips the relevance check when nothing survived, and drops unusable labels', async () => {
    const checkRelevance = vi.fn(async () => []);
    const built = await generateItems(
      generator({ generate: async () => ({ singular: 'x'.repeat(41), plural: 'shits', items: [] }), checkRelevance }),
      'Nonsense',
    );
    expect(checkRelevance).not.toHaveBeenCalled();
    expect(built).toEqual({ singular: null, plural: null, items: [] });
  });

  it('gives up when the whole build runs past its budget', async () => {
    const slow = generator({
      generate: (_name, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new GenerationUnavailable('failed')));
        }),
    });
    await expect(generateItems(slow, 'Board games', 20)).rejects.toMatchObject({ reason: 'failed' });
  });

  it('turns an unexpected error into a failed build', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = generator({
      generate: async () => {
        throw new TypeError('boom');
      },
    });
    await expect(generateItems(broken, 'Board games')).rejects.toMatchObject({ reason: 'failed' });
    quiet.mockRestore();
  });
});
