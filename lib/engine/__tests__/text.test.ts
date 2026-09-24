import { describe, it, expect } from 'vitest';
import { toBallotText, toDisplayText, dedupeKey, validateEntry, validateName } from '../text';

/**
 * §9.1: the caps are camouflage. If casing survived into the stored text, a
 * player who never capitalizes would be identifiable from their card.
 */
describe('§9.1 ballot normalization', () => {
  it('uppercases every input to the same card text', () => {
    for (const input of ['Mango', 'mango', 'MANGO', '  mAnGo  ']) {
      expect(toBallotText(input)).toBe('MANGO');
    }
  });

  it('collapses whitespace, straightens quotes and strips trailing punctuation', () => {
    expect(toBallotText('  grandma’s   lasagna!! ')).toBe("GRANDMA'S LASAGNA");
    expect(toBallotText('Really?!')).toBe('REALLY');
  });

  it('applies the steps in the order the spec fixes', () => {
    // Punctuation stripped after whitespace collapse, so no trailing space survives.
    expect(toBallotText('Mango !')).toBe('MANGO');
  });

  it('is idempotent, so re-normalizing stored text is safe', () => {
    const once = toBallotText(' the “best” mango!! ');
    expect(toBallotText(once)).toBe(once);
  });

  it('leaves spelling alone -- an accepted leak the spec names', () => {
    expect(toBallotText('pomegranite')).toBe('POMEGRANITE');
  });
});

describe('§8 own-list display text', () => {
  it('title-cases the private list', () => {
    expect(toDisplayText('  mango ')).toBe('Mango');
    expect(toDisplayText('new york city')).toBe('New York City');
  });

  it('keeps minor words lowercase unless they lead', () => {
    expect(toDisplayText('bed and breakfast')).toBe('Bed and Breakfast');
    expect(toDisplayText('the shining')).toBe('The Shining');
  });

  it('capitalizes across hyphens', () => {
    expect(toDisplayText('rom-com')).toBe('Rom-Com');
  });
});

describe('duplicate detection', () => {
  it('ignores case, spacing and punctuation', () => {
    expect(dedupeKey('Mango')).toBe(dedupeKey('  mango!! '));
    expect(dedupeKey("Grandma's Lasagna")).toBe(dedupeKey('GRANDMAS LASAGNA'));
  });

  it('keeps genuinely different items apart', () => {
    expect(dedupeKey('Mango')).not.toBe(dedupeKey('Mangos'));
  });
});

describe('§8 entry validation', () => {
  const noExisting = { existingKeys: new Set<string>() };

  it('states a reason for every rejection', () => {
    expect(validateEntry('   ', noExisting)).toMatchObject({ ok: false, reason: 'empty' });
    expect(validateEntry('x'.repeat(31), noExisting)).toMatchObject({ ok: false, reason: 'too_long' });
    expect(
      validateEntry('Mango', { existingKeys: new Set([dedupeKey('mango')]) }),
    ).toMatchObject({ ok: false, reason: 'duplicate', message: 'Already on your list' });
    expect(
      validateEntry('rude', { ...noExisting, isProfane: () => true }),
    ).toMatchObject({ ok: false, reason: 'profane' });
  });

  it('rejects punctuation-only entries that normalize to nothing', () => {
    expect(validateEntry('!!!', noExisting)).toMatchObject({ ok: false, reason: 'empty' });
  });

  it('returns both forms of an accepted entry', () => {
    const result = validateEntry('  pineapple ', noExisting);
    expect(result).toMatchObject({ ok: true, displayText: 'Pineapple', ballotText: 'PINEAPPLE' });
  });

  it('accepts exactly 30 characters and rejects 31', () => {
    expect(validateEntry('a'.repeat(30), noExisting).ok).toBe(true);
    expect(validateEntry('a'.repeat(31), noExisting).ok).toBe(false);
  });
});

describe('§5 name validation', () => {
  const free = { takenLower: new Set<string>() };

  it('blocks the Computer and its close variants', () => {
    for (const name of ['Computer', 'computer', 'C0mputer', 'The Computer', 'CPU', 'Bot', 'AI']) {
      expect(validateName(name, free)).toMatchObject({
        ok: false,
        reason: 'reserved',
        message: 'That name belongs to the Computer',
      });
    }
  });

  it('strips separators before matching, so punctuation cannot smuggle it through', () => {
    expect(validateName('C.P.U.', free)).toMatchObject({ reason: 'reserved' });
    expect(validateName('B-O-T', free)).toMatchObject({ reason: 'reserved' });
    expect(validateName('The Comp', free).ok).toBe(true); // genuinely different
  });

  it('rejects an over-long name on length, before considering the word list', () => {
    // Both rejections are correct; length is the more specific complaint.
    expect(validateName('c o m p u t e r', free)).toMatchObject({ reason: 'too_long' });
  });

  it('is case-insensitive about collisions', () => {
    expect(validateName('maya', { takenLower: new Set(['maya']) })).toMatchObject({
      reason: 'taken',
    });
  });

  it('caps names at 12 characters', () => {
    expect(validateName('a'.repeat(12), free).ok).toBe(true);
    expect(validateName('a'.repeat(13), free)).toMatchObject({ reason: 'too_long' });
  });
});
