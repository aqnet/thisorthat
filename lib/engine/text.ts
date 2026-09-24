/**
 * Entry and ballot text handling (spec §8 "Validation & normalization", §9.1).
 *
 * Two different forms of the same item, on purpose:
 *   - displayText  Title Case, shown only in the player's OWN private list.
 *   - ballotText   ALL CAPS, what everyone sees on a ballot card.
 *
 * The caps are camouflage, not styling. If casing survived into the payload,
 * "Ben never capitalizes" would identify Ben's card, so the uppercasing happens
 * here on the server before the text is stored or broadcast -- never in CSS.
 */

export const MAX_ITEM_LENGTH = 30;
export const MAX_NAME_LENGTH = 12;

/** Locale is pinned so a Turkish-locale server can't turn "I" into "İ". */
const UPPERCASE_LOCALE = 'en-US';

/** Names the Computer owns, so nobody can impersonate it (spec §5). */
const RESERVED_NAME_PATTERNS = [
  /^computer$/,
  /^the\s*computer$/,
  /^c[o0]mputer$/,
  /^cpu$/,
  /^bot$/,
  /^ai$/,
  /^robot$/,
];

/** Step 1: trim and collapse internal whitespace runs to one space. */
function collapseWhitespace(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

/** Step 2: straighten curly quotes so MANGO'S and MANGO’S aren't two items. */
function straightenQuotes(input: string): string {
  return input
    .replace(/[‘’‛ʼ]/g, "'")
    .replace(/[“”‟]/g, '"');
}

/** Step 3: strip trailing punctuation ("Mango!!" -> "Mango"). */
function stripTrailingPunctuation(input: string): string {
  return input.replace(/[!?.,;:\s]+$/g, '');
}

/**
 * The full ballot normalization from §9.1, in the order the spec fixes.
 * Order matters: stripping punctuation before collapsing whitespace would
 * leave "Mango !" as "Mango " rather than "Mango".
 */
export function toBallotText(input: string): string {
  const cleaned = stripTrailingPunctuation(straightenQuotes(collapseWhitespace(input)));
  return cleaned.toLocaleUpperCase(UPPERCASE_LOCALE);
}

/**
 * Title Case for the player's own list. Small words stay lowercase unless they
 * lead, so "Bed and Breakfast" doesn't read as "Bed And Breakfast".
 */
const MINOR_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in',
  'nor', 'of', 'on', 'or', 'the', 'to', 'up', 'vs', 'with',
]);

export function toDisplayText(input: string): string {
  const cleaned = stripTrailingPunctuation(straightenQuotes(collapseWhitespace(input)));
  const words = cleaned.split(' ');
  return words
    .map((word, index) => {
      const lower = word.toLocaleLowerCase(UPPERCASE_LOCALE);
      if (index > 0 && MINOR_WORDS.has(lower)) return lower;
      // Capitalize after internal punctuation too: "grandma's" -> "Grandma's",
      // but "rom-com" -> "Rom-Com".
      return lower.replace(/(^|[-\/])([a-zÀ-ɏ])/g, (_m, sep, ch: string) =>
        sep + ch.toLocaleUpperCase(UPPERCASE_LOCALE),
      );
    })
    .join(' ');
}

/** Case- and punctuation-insensitive key for duplicate detection within a list. */
export function dedupeKey(input: string): string {
  return toBallotText(input).replace(/[^A-Z0-9]/gi, '');
}

export type EntryRejection =
  | 'empty'
  | 'too_long'
  | 'duplicate'
  | 'profane';

/** Inline rejection copy from §8. Every rejection states its reason. */
export const ENTRY_REJECTION_COPY: Record<EntryRejection, string> = {
  empty: 'Type something first',
  too_long: 'Keep it under 30 characters',
  duplicate: 'Already on your list',
  profane: "Let's keep it friendly — try another",
};

export interface EntryValidationOk {
  ok: true;
  displayText: string;
  ballotText: string;
  key: string;
}

export interface EntryValidationError {
  ok: false;
  reason: EntryRejection;
  message: string;
}

export type EntryValidation = EntryValidationOk | EntryValidationError;

export interface ValidateEntryOptions {
  /** dedupeKey() of every item already on this player's list. */
  existingKeys: ReadonlySet<string>;
  /** Injected so the word list stays out of the pure engine. */
  isProfane?: (text: string) => boolean;
}

export function validateEntry(raw: string, options: ValidateEntryOptions): EntryValidation {
  const cleaned = collapseWhitespace(raw);
  if (cleaned.length === 0) {
    return { ok: false, reason: 'empty', message: ENTRY_REJECTION_COPY.empty };
  }

  const displayText = toDisplayText(cleaned);
  const ballotText = toBallotText(cleaned);

  // Measured on the stored form, which is what the DB constraint checks.
  if (displayText.length > MAX_ITEM_LENGTH || ballotText.length > MAX_ITEM_LENGTH) {
    return { ok: false, reason: 'too_long', message: ENTRY_REJECTION_COPY.too_long };
  }
  if (options.isProfane?.(cleaned)) {
    return { ok: false, reason: 'profane', message: ENTRY_REJECTION_COPY.profane };
  }

  const key = dedupeKey(cleaned);
  if (key.length === 0) {
    // Punctuation only, e.g. "!!!" -- nothing survives normalization.
    return { ok: false, reason: 'empty', message: ENTRY_REJECTION_COPY.empty };
  }
  if (options.existingKeys.has(key)) {
    return { ok: false, reason: 'duplicate', message: ENTRY_REJECTION_COPY.duplicate };
  }

  return { ok: true, displayText, ballotText, key };
}

export type NameRejection = 'empty' | 'too_long' | 'taken' | 'reserved' | 'profane';

export const NAME_REJECTION_COPY: Record<NameRejection, string> = {
  empty: 'Type a name first',
  too_long: 'Names are up to 12 characters',
  taken: "That name's taken — try another",
  reserved: 'That name belongs to the Computer',
  profane: "Let's keep it friendly — try another",
};

export function validateName(
  raw: string,
  options: { takenLower: ReadonlySet<string>; isProfane?: (text: string) => boolean },
): { ok: true; name: string } | { ok: false; reason: NameRejection; message: string } {
  const name = collapseWhitespace(raw);
  if (name.length === 0) {
    return { ok: false, reason: 'empty', message: NAME_REJECTION_COPY.empty };
  }
  if (name.length > MAX_NAME_LENGTH) {
    return { ok: false, reason: 'too_long', message: NAME_REJECTION_COPY.too_long };
  }

  // Compare with separators stripped so "C 0 m p u t e r" can't sneak through.
  const reservedKey = name.toLocaleLowerCase(UPPERCASE_LOCALE).replace(/[^a-z0-9]/g, '');
  if (RESERVED_NAME_PATTERNS.some((pattern) => pattern.test(reservedKey))) {
    return { ok: false, reason: 'reserved', message: NAME_REJECTION_COPY.reserved };
  }
  if (options.isProfane?.(name)) {
    return { ok: false, reason: 'profane', message: NAME_REJECTION_COPY.profane };
  }
  if (options.takenLower.has(name.toLocaleLowerCase(UPPERCASE_LOCALE))) {
    return { ok: false, reason: 'taken', message: NAME_REJECTION_COPY.taken };
  }

  return { ok: true, name };
}
